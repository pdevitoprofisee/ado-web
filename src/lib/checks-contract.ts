// The shape of a pull request's checks: what ran, how it went, which step broke,
// what the log said, and which tests failed. Types only — this file imports
// nothing, and must not import from `src/server/*` or pull in a client, so that
// the server and the UI can agree on a shape without either owning it.
//
// Evidence: `docs/research/checks-inventory.md`. 176 Azure DevOps calls, every
// one a GET, against the live `Profisee` org — 286 pull-request statuses, 150
// policy evaluations, 14 builds, 440 timeline records, 44 logs on one build and
// 28 failed test results.
//
// The house rule from `sonar-contract.ts` holds: every field was measured, and
// every field whose shape was a surprise carries the number that surprised us.

// ---------------------------------------------------------------------------
// How a pull request reaches a build at all.
// ---------------------------------------------------------------------------

/**
 * The link from a check to the build behind it.
 *
 * **Statuses are a dead end for this.** Of 286 sampled `pullRequests/{id}/statuses`,
 * **0** carried a build id anywhere — only 42 had a `targetUrl` at all and every
 * one of those pointed at `sonarcloud.io/dashboard`. The `codecoverage` genre
 * (244 of 286 statuses) posts a description and nothing else. So a status can be
 * drawn as a verdict and never as a build.
 *
 * `policy/evaluations` is the **only** route from a pull request to a build in
 * this org, via `context.buildId` — present on 27 of 150 evaluations, always a
 * `number`.
 *
 * `isNotCurrent` is `context.buildIsNotCurrent`: the build ran against a merge
 * commit that is no longer the tip. Measured `true` on 2 of 27, so it is rare
 * and worth saying out loud when it happens — a green check on a stale build is
 * the one that misleads a reviewer.
 */
export interface BuildLink {
  readonly buildId: number
  readonly definitionId: number
  /** `context.buildDefinitionName`, e.g. `platform (common)`. The only human name available here. */
  readonly definitionName: string
  readonly startedAt: string
  readonly isNotCurrent: boolean
}

/**
 * ADO's evaluation vocabulary, as `policy/evaluations` returns it.
 *
 * Observed across 150 evaluations: `approved` ×103 · `queued` ×35 ·
 * `rejected` ×10 · `running` ×2. `broken` and `notApplicable` are documented and
 * were **never seen**, which is why they are in the union and why nothing should
 * branch on their absence.
 */
export type EvaluationStatus =
  | 'approved'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'broken'
  | 'notApplicable'

/**
 * One row of the checks panel — a policy evaluation, a status, or both.
 *
 * Two sources, one row type, because a reviewer does not care which service
 * posted a verdict. `build` is what separates them: a policy evaluation for a
 * build policy has one, a status never does.
 *
 * **A pull request can hold several build policies.** Measured: 20 of 23 PRs had
 * one, 2 had three, 1 had five, across 18 distinct `buildDefinitionId`s. A panel
 * that renders "the build" for a PR is wrong on 3 of 23 of them.
 *
 * `id` is `configuration.id` for an evaluation and `context.genre/name` for a
 * status, because neither `name` alone is unique — the same probe found two
 * "Minimum number of reviewers" rows on one PR (see `Policy` in
 * `src/server/pull-request.ts`, which learned this first).
 */
export interface CheckSummary {
  readonly id: string
  readonly name: string
  readonly status: EvaluationStatus
  /** `configuration.isBlocking` and *not yet satisfied*. A status has no such field — 0/286 carried `isBlocking`. */
  readonly blocking: boolean
  /** The build this check is about, or `null` for a reviewer, comment or work-item policy. */
  readonly build: BuildLink | null
  /** A SonarCloud dashboard link or a build's web URL. 42/286 statuses had one; the rest had none. */
  readonly url: string | null
  /** `evaluationId`, or `null` when re-running is not an act — see `RequeueRequest`. */
  readonly requeueId: string | null
}

// ---------------------------------------------------------------------------
// The build itself.
// ---------------------------------------------------------------------------

/**
 * `build.status`. Every one of the 14 detailed builds said `completed`, so the
 * other four come from the documented list and from §6b's `statusFilter` sweep,
 * which found 5 `inProgress` and 1 `notStarted` build live in the project.
 * `cancelling` and `postponed` returned zero builds and are carried unproven.
 */
export type BuildStatus = 'none' | 'inProgress' | 'completed' | 'cancelling' | 'postponed' | 'notStarted'

/**
 * `build.result`. Observed: `failed` ×8 · `succeeded` ×6 of 14.
 * `canceled` and `partiallySucceeded` were never seen and must still render —
 * `canceled` in particular is what a requeue is documented to do to the build it
 * replaces.
 */
export type BuildResult = 'canceled' | 'failed' | 'none' | 'partiallySucceeded' | 'succeeded'

/**
 * One build run, as the panel needs it.
 *
 * **`result` and `finishTime` are absent on a build that has not finished.** Not
 * null — absent. Measured on the 6 unfinished builds: `result` present 0/6,
 * `finishTime` present 0/6, and `queuePosition` (which the documentation
 * suggests) present 0/6 as well. So there is no progress number to show for a
 * queued build; only that it is queued.
 *
 * Durations of the 14 sampled builds ran from **31 s to 875 s** (median ~9 min),
 * which is the interval any "re-run and wait" affordance has to survive.
 */
export interface BuildRun {
  readonly id: number
  /** `buildNumber`, e.g. `1.0.0.59`. Not the id, and not unique across definitions. */
  readonly number: string
  readonly status: BuildStatus
  /** `null` until the build finishes. */
  readonly result: BuildResult | null
  readonly queuedAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** `reason` — `pullRequest` on 14/14 of the sample, but a manual re-queue reports otherwise. */
  readonly reason: string
  /** `_links.web.href`. Present on 14/14, alongside `self`, `sourceVersionDisplayUri`, `timeline` and `badge`. */
  readonly webUrl: string
}

// ---------------------------------------------------------------------------
// The timeline — what ran inside the build.
// ---------------------------------------------------------------------------

/**
 * `record.type`. Observed across 440 records: `Task` ×366 · `Job` ×25 ·
 * `Phase` ×21 · `Checkpoint` ×14 · `Stage` ×14.
 *
 * The string is left open because the service adds record types (`Container`,
 * `Variable`) that this org's pipelines do not use, and an unknown type should
 * render as a row rather than crash the tree.
 */
export type TimelineType = 'Stage' | 'Phase' | 'Job' | 'Task' | 'Checkpoint' | (string & {})

/**
 * `record.state`. `completed` on **440/440** records of finished builds — the
 * other two only appear mid-run, where one in-progress build's timeline gave
 * `completed` ×10 · `pending` ×6 · `inProgress` ×4.
 */
export type RecordState = 'pending' | 'inProgress' | 'completed'

/**
 * `record.result`. Observed on finished builds: `succeeded` ×361 ·
 * `skipped` ×45 · `failed` ×34. `abandoned` and `canceled` are documented and
 * unobserved.
 *
 * **`null` is normal, not exceptional.** On the in-progress build, 10 of 20
 * records had `result: null` while still running.
 */
export type RecordResult = 'succeeded' | 'succeededWithIssues' | 'failed' | 'canceled' | 'skipped' | 'abandoned'

/**
 * One error or warning a step reported.
 *
 * **`issues` is an absent key, not an empty array** — present on only 27 of 440
 * records. Anything that reads `record.issues.length` crashes on 413 records out
 * of 440, so this contract normalises it to `[]` on the way through and the field
 * below is not optional.
 *
 * 95 issues were sampled: `type` `warning` ×75 · `error` ×20; `category` `Code`
 * ×62 · `General` ×24 · `null` ×9; messages 26–456 characters. `data` always
 * carried `logFileLineNumber` (a **string**, e.g. `"45"`), and 62 of 95 also
 * carried `sourcepath`/`linenumber`/`columnnumber`/`code` — which is enough to
 * jump from a compiler error to the diff, and is the only place that mapping
 * exists.
 */
export interface TimelineIssue {
  readonly type: 'error' | 'warning'
  readonly category: string | null
  readonly message: string
  /** The line in *the log*, not in the source file. ADO sends it as a string; parsed here. */
  readonly logLine: number | null
  /** Set on 62 of 95 sampled issues: the file the error is about. */
  readonly sourcePath: string | null
  readonly sourceLine: number | null
}

/**
 * A pointer at a step's log. Fetching it is a second call, and an expensive one.
 *
 * **Not every record has one.** `log` was present on 408 of 440 records; the 14
 * `Stage` and 14 `Checkpoint` records had **none at all**, so the tree's top
 * level is never expandable and the leaves always are.
 *
 * `lineCount` comes from the build's `logs` collection, not from the timeline —
 * two different endpoints, joined on this id. Worth joining: the largest log on
 * the sampled build was **2727 lines** and the 44 logs together were **7792
 * lines**, which is why nothing fetches them all.
 */
export interface LogRef {
  readonly id: number
  /** `null` when the `logs` collection has not been read. `type` was `Container` on 44/44. */
  readonly lineCount: number | null
}

/**
 * One node of the build timeline, ready to render.
 *
 * `children` rather than the wire's flat `records` + `parentId`, because the wire
 * form is unrenderable: 440/440 `parentId`s resolve within the same response, but
 * only after a full pass. Built once on the server.
 *
 * **Do not infer depth from `type`.** The common shape is
 * Stage → Phase → Job → Task (362 of 440 records sat at depth 3), but the sample
 * also held 4 `Job` records at depth **0** and 4 `Task` records at depth **1**.
 * A renderer that assumes four levels loses those eight rows.
 *
 * `percentComplete` and `currentOperation` are deliberately absent from this
 * type. `currentOperation` was `null` on **440/440** finished records *and* on
 * 0-of-20 in-progress ones — the field never says anything. `percentComplete` was
 * non-null on 8 in-flight records only, which is not enough to draw a bar with.
 */
export interface TimelineNode {
  /** A GUID. Stable within one build; not stable across a retry. */
  readonly id: string
  readonly type: TimelineType
  readonly name: string
  readonly state: RecordState
  readonly result: RecordResult | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** Milliseconds, derived from the two above. `null` while a record is still running. */
  readonly durationMs: number | null
  readonly log: LogRef | null
  readonly errorCount: number
  readonly warningCount: number
  /** Normalised from an absent key — see `TimelineIssue`. */
  readonly issues: readonly TimelineIssue[]
  readonly children: readonly TimelineNode[]
  /**
   * True for the record that actually broke, false for the ones that merely
   * contain it — see `isFailingStep` for what that means and why it matters.
   */
  readonly isFailingStep: boolean
}

/**
 * Whether a failed record is *the* failure or just an ancestor of one.
 *
 * This is the single most load-bearing measurement in the round. Of 34 records
 * with `result: 'failed'` across 14 timelines, only **10** were leaves, and all
 * ten agreed on every signal: `type: 'Task'` ×10, a `log` ×10, `errorCount > 0`
 * ×10, `issues` non-empty ×10. The other 24 were the containers —
 * `Job` ×8 · `Phase` ×8 · `Stage` ×8 — every one of them `failed` with
 * **`errorCount: 0`** and no issues of its own.
 *
 * So a panel that lists failed records shows four rows per failure and only one
 * of them is the answer. Leaf-ness alone would do, but `errorCount > 0` is the
 * cheaper test and was never once wrong on the sample.
 */
export const isFailingStep = (node: {
  readonly result: RecordResult | null
  readonly errorCount: number
  readonly children: readonly unknown[]
}): boolean => node.result === 'failed' && node.errorCount > 0 && node.children.length === 0

// ---------------------------------------------------------------------------
// The log slice.
// ---------------------------------------------------------------------------

/**
 * The lines of one step's log, as fetched.
 *
 * **The response format depends on the `Accept` header**, and `ado-client.ts`
 * already sends `Accept: application/json` on every call — which turns the log
 * into `{"count":46,"value":["<line>", …]}`, a JSON array of lines. Under
 * `text/plain` (or a wildcard `Accept`) the very same URL returns 3884 bytes of
 * raw text instead — the header, not the URL, decides the format. Both
 * work; the JSON form is what this app will get by default and needs no
 * splitting, so this type mirrors it. Note the counts differ by one (46 vs 47
 * text lines) because the text form ends with a trailing newline.
 *
 * `startLine` / `endLine` are inclusive line numbers: `startLine=0&endLine=20`
 * returned **21** lines and 1737 bytes of the 3884-byte log.
 *
 * **A log id that does not exist answers `200` with an empty body**, not 404 —
 * and so does a `startLine` past the end. There is no error to catch here, only
 * an emptiness to notice.
 */
export interface LogSlice {
  readonly logId: number
  /** Without the leading ISO timestamp, which 46 of 47 sampled lines carried and none of them needed. */
  readonly lines: readonly string[]
  /** The line number `lines[0]` came from, so a "load more" knows where it is. */
  readonly firstLine: number
  /** `lineCount` from the `logs` collection, when known, so the UI can say "showing the last 200 of 2727". */
  readonly totalLines: number | null
  /** True when `firstLine > 0` — i.e. there is earlier output that was not fetched. */
  readonly truncated: boolean
}

/**
 * How many lines of a failing step's log to fetch first.
 *
 * A real failing step's whole log was **3884 bytes / 47 lines**, fetched in
 * 144 ms — small enough that the tail is the whole thing. But logs on the same
 * build ran to **2727 lines / 21024 bytes**, so the tail has to be a slice and
 * not a promise. 200 lines covers the observed failing step nine times over and
 * caps the worst case at roughly 17 KB.
 *
 * The error's own position is known independently — `TimelineIssue.logLine` — so
 * a fetch can be centred on it rather than on the end when it is outside this
 * window.
 */
export const LOG_TAIL_LINES = 200

/**
 * Log responses are **`cache-control: no-cache`, `expires: -1`** — measured on
 * every log call. A finished build's log will never change, so caching it is this
 * app's decision to make and not the service's; this is how long for.
 */
export const LOG_CACHE_MS = 3_600_000

// ---------------------------------------------------------------------------
// Failed tests.
// ---------------------------------------------------------------------------

/**
 * A build's test run, from `test/runs?buildUri=vstfs:///Build/Build/{buildId}`.
 *
 * That URI form is the working route and the `buildUri` query is what makes it
 * work. **`testresults/resultsbybuild?buildId=` 404s on `dev.azure.com`** — 8 of
 * 8 attempts, "Page not found". It answers 200 only on the separate
 * `vstmr.dev.azure.com` host, which is a second base URL for one endpoint's sake
 * and not worth adopting while `test/runs` answers.
 *
 * **There is no `failedTests` field.** The run carries `totalTests`,
 * `passedTests`, `notApplicableTests`, `incompleteTests` and `unanalyzedTests`,
 * and the failure count has to be derived by subtraction — which is how the probe
 * found the only 4 runs with failures among 100. A run reporting
 * `totalTests: 40 / passedTests: 39 / notApplicableTests: 1` has **zero**
 * failures, not one.
 *
 * `build` is **not** on the run object: 0 of 100 runs listed by date carried one.
 * The build id is only recoverable by having asked with it, or from the individual
 * results, which do carry `build.id` (28/28).
 */
export interface TestRunSummary {
  readonly id: number
  /** `VSTest_TestResults_194571` — the build id is embedded, but not as a field. */
  readonly name: string
  readonly state: string
  readonly total: number
  readonly passed: number
  readonly notApplicable: number
  readonly incomplete: number
  /** Derived: `total − passed − notApplicable − incomplete`. Never sent. */
  readonly failed: number
  /** `webAccessUrl`, for the one "open in ADO" link. */
  readonly webUrl: string
}

/**
 * One failed test, from `test/runs/{runId}/results?outcomes=Failed`.
 *
 * `outcomes=Failed` **filters server-side and agrees with the client-side count**
 * — checked both ways on four runs. `outcomes=NoSuchOutcome` is a 400, so the
 * value is validated and cannot be passed through from a URL.
 *
 * **`failureType` is useless.** `None` on 28 of 28 failed results. The signal is
 * `errorMessage` (28/28) and `stackTrace` (28/28).
 *
 * **`detailsToInclude=None` does not trim the payload.** The same run answered
 * 191.0 KB either way, with `errorMessage` and `stackTrace` present on all 28
 * results. There is no cheap variant of this call — see `MAX_FAILED_TESTS`.
 *
 * `durationInMs` was present on only 23 of 28.
 */
export interface FailedTest {
  readonly id: number
  /** `testCaseTitle` — the method name. `testCase.name` was identical on the sample. */
  readonly name: string
  /** `automatedTestStorage`, e.g. `profisee.platform.testing.analytics.integration.dll`. */
  readonly assembly: string | null
  readonly errorMessage: string
  /** Truncated — see `STACK_TRACE_CHARS`. */
  readonly stackTrace: string
  readonly durationMs: number | null
  /** `test/Runs/{runId}/Results/{id}` on the web, for the full detail. */
  readonly url: string
}

/**
 * The most failed results to fetch and hold for one build.
 *
 * A failed result costs **6985 bytes** — 28 of them came to **191.0 KB** on one
 * run, and one run in the sample had 179 tests. Twenty-five failures is already
 * more than a reviewer reads, and 25 × 7 KB is a page-sized payload rather than a
 * quarter-megabyte one. The count is reported separately (`TestRunSummary.failed`)
 * so a truncated list can still say how many it truncated.
 */
export const MAX_FAILED_TESTS = 25

/**
 * How much of a stack trace to keep.
 *
 * **ADO truncates at exactly 4000 characters** — 8 of the 28 sampled traces were
 * 4000 characters on the nose, which is a server-side cap and not a coincidence.
 * So the string is already incomplete when it arrives; this constant is smaller
 * on purpose, because the first frames are the ones that name the test and the
 * rest is framework noise. Nothing should present a stack trace as complete.
 */
export const STACK_TRACE_CHARS = 1200

// ---------------------------------------------------------------------------
// The whole report, and what it lost on the way.
// ---------------------------------------------------------------------------

/**
 * A section that could not be read, and why.
 *
 * `null` is the good case, and an empty result is *not* an error — the same rule
 * as `SectionErrors` in `src/server/pull-request.ts`. It matters more here than
 * anywhere else in the app, because this panel fans out across four services:
 * the policy API, the build API, the test API and (per failing step) the log API.
 * A build whose timeline 404s must not take the checks list down with it, and a
 * test service that is having a bad afternoon must not hide a failing step whose
 * log read fine.
 */
export interface ChecksErrors {
  readonly checks: string | null
  readonly builds: string | null
  readonly timeline: string | null
  readonly tests: string | null
}

/**
 * One check that failed to *load* — as opposed to one that failed.
 *
 * Per check rather than one page-level message, for `SonarReport.failed`'s
 * reason: a pull request holds up to five build policies, and "we could not read
 * that one" belongs against the row it is about. `checkId` is `CheckSummary.id`.
 */
export interface CheckFailure {
  readonly checkId: string
  readonly message: string
}

/** Everything the checks panel draws for one pull request. */
export interface ChecksReport {
  readonly checks: readonly CheckSummary[]
  /** Keyed by `BuildLink.buildId`. A check whose build is missing here failed to load — see `failed`. */
  readonly builds: readonly BuildRun[]
  readonly errors: ChecksErrors
  readonly failed: readonly CheckFailure[]
}

/**
 * The detail behind one check, fetched when a row is opened rather than with the
 * page.
 *
 * Separate from `ChecksReport` because of what it costs: a timeline is 9.7–69.1 KB
 * (median ~20 KB) and a failed-test list is up to 191 KB, and a pull request can
 * have five build policies. Fetching all of that to draw a list of five rows
 * would be 24 calls where 6 will do.
 */
export interface CheckDetail {
  readonly build: BuildRun
  /** Roots of the timeline tree. 18 of 440 records had `parentId: null`, so there can be several. */
  readonly timeline: readonly TimelineNode[]
  /** The one leaf `isFailingStep` picked out, hoisted so the panel does not have to walk the tree to find it. */
  readonly failingStep: TimelineNode | null
  /** The failing step's log tail, when there is a failing step and its log read. */
  readonly log: LogSlice | null
  readonly testRuns: readonly TestRunSummary[]
  /** Capped at `MAX_FAILED_TESTS`; the true count is on each `TestRunSummary`. */
  readonly failedTests: readonly FailedTest[]
  readonly errors: ChecksErrors
}

// ---------------------------------------------------------------------------
// Re-running something. **None of this was sent.**
// ---------------------------------------------------------------------------

/**
 * Ask ADO to run a build policy again.
 *
 * `PATCH policy/evaluations/{evaluationId}?api-version=7.1-preview.1`, bodyless —
 * the shape `requeueEvaluation()` in `src/server/pull-request.ts` already ships.
 * The preview suffix is not optional: plain `7.1` on this route is a **400** with
 * "The -preview flag must be supplied", measured.
 *
 * **Unproven.** Every pull request in this organisation belongs to a colleague and
 * this request would start a build on their branch, so it was not sent. Microsoft's
 * reference documents an empty request body while its prose says the operation
 * works "by setting the `PolicyEvaluationRecord.Status` field to Queued", and only
 * a live attempt can say which is true. A first attempt must also record whether
 * the returned record already carries the *new* `context.buildId` or still points
 * at the cancelled run — if the latter, the UI has to poll rather than trust the
 * reply.
 *
 * Documented side effect, which is why `requeueTarget()` refuses a `running`
 * policy: requeueing cancels any build currently running for it. Expect a
 * `result: 'canceled'` build to appear — a value 14 of 14 sampled builds never
 * showed.
 */
export interface RequeueRequest {
  readonly projectId: string
  readonly evaluationId: string
}

/**
 * Retry a whole build.
 *
 * `PATCH build/builds/{buildId}?retry=true&api-version=7.1` — plain `7.1`, no
 * preview suffix; this route's *read* accepted `7.1`, `6.0` and even `2.0`.
 *
 * **Unproven, twice over.** The body is a `Build` object with every field
 * optional, so the minimal form (`{}`, or `{ id }`) is a guess. And the scope is
 * `vso.build_execute`, which the stored PAT may not hold — the probe only proved
 * `vso.build` by reading. Worst, it is unknown whether a retry mints a **new**
 * build id or reuses the old one, which decides whether the checks panel can
 * detect that anything happened: the row's identity is `context.buildId`.
 */
export interface BuildRetryRequest {
  readonly projectId: string
  readonly buildId: number
}

/**
 * Retry one stage.
 *
 * `PATCH build/builds/{buildId}/stages/{stageRefName}?api-version=7.1` with
 * `{ "state": "retry", "forceRetryAllJobs": false }` — `UpdateStageParameters` has
 * exactly those two fields at 7.1. `stageRefName` is the timeline `Stage`
 * record's `identifier`, not its `name`.
 *
 * **Unproven and, measured, nearly pointless here.** Ten distinct pipelines were
 * swept and **0** declared a stage whose `identifier` was anything but
 * `__default`; `attempt` was `1` on 440/440 records and `previousAttempts` was
 * empty on all of them. Stage retry is a real API with nothing in this org to
 * point it at, so it is the last granularity phase 5 should build, not the first.
 */
export interface StageRetryRequest {
  readonly projectId: string
  readonly buildId: number
  /** The `Stage` record's `identifier`. `__default` on 14 of 14 sampled builds. */
  readonly stageRefName: string
  readonly forceRetryAllJobs: boolean
}
