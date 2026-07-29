import {
  LOG_CACHE_MS,
  LOG_TAIL_LINES,
  MAX_FAILED_TESTS,
  STACK_TRACE_CHARS,
  isFailingStep,
} from '../lib/checks-contract'

import type { AdoClient } from './ado-client'
import type { PullRequestRef } from './pull-request'
import type {
  BuildLink,
  BuildResult,
  BuildRetryRequest,
  BuildRun,
  BuildStatus,
  CheckDetail,
  CheckFailure,
  CheckSummary,
  ChecksErrors,
  ChecksReport,
  EvaluationStatus,
  FailedTest,
  LogSlice,
  RecordResult,
  RecordState,
  StageRetryRequest,
  TestRunSummary,
  TimelineIssue,
  TimelineNode,
} from '../lib/checks-contract'

// Server-only. Why a pull request's build failed, in two sizes.
//
// The split is the whole design and it is decided by bytes. Drawing the checks
// list needs the policy evaluations (one call, 27 of 150 of them carry a
// `context.buildId`) and one `build/builds/{id}` per *distinct* build behind
// them — 1 + N calls, and N was 1 on 20 of 23 sampled pull requests, 3 on two of
// them and 5 on one. Everything that explains a failure is an order of magnitude
// larger: a timeline is 9.7–69.1 KB (median ~20 KB), the logs collection another
// 10.4 KB, and a failed-test list ran to 191.0 KB on one run. Fetching that for
// five policies to draw five rows is the 24-calls-where-6-will-do that
// `CheckDetail`'s own doc comment refuses. So `loadChecksReport` is the page and
// `loadCheckDetail` is the click.
//
// **Statuses are not read here at all.** Of 286 sampled `pullRequests/{id}/statuses`,
// 0 carried a build id, 244 were `codecoverage` descriptions, and all 42 that had
// a `targetUrl` pointed at SonarCloud — which has its own panel. And the
// non-build policy evaluations are dropped rather than rendered as check rows:
// `pr-detail.tsx`'s Policies section already draws them from this same endpoint,
// and a second checklist repeating "Minimum number of reviewers" is noise.
//
// **The cache is keyed on a build, not on a commit.** `pr-cache.ts` keys on a
// commit id, which is a statement that a pull request has not moved.
// `build.status === 'completed'` is a stronger thing: not a hint that this data
// is still fresh but a guarantee that it will never change again. So everything
// under a completed build is cached, nothing under a build in any other state is
// cached at all, and the `build/builds/{id}` read that decides which case we are
// in is itself never cached — it is the validity token, and a cached token
// answers its own question.

/**
 * `policy/evaluations` is preview-only: plain `7.1` is a 400 reading "the
 * -preview flag must be supplied", measured. Duplicated from `pull-request.ts`
 * and `hydrate.ts`, which both already hold their own copy — importing it would
 * pull a whole route's worth of module into a file that shares nothing else with
 * it. Every other endpoint below takes the client's default `7.1`, including
 * both build writes.
 */
const POLICY_VERSION = '7.1-preview.1'

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Nothing failed. Spelled once, because four fields is enough to typo. */
const NO_ERRORS: ChecksErrors = { checks: null, builds: null, timeline: null, tests: null }

/**
 * A section that failed and a section that is empty are different answers, so
 * each one runs for its value *or* its message and never for a throw.
 *
 * The same shape as `pull-request.ts`'s `section`, which is not exported;
 * copied rather than lifted somewhere shared for that file's stated reason, and
 * because it matters more here — this panel fans out across the policy, build,
 * log and test APIs, and a test service having a bad afternoon must not hide a
 * failing step whose log read fine.
 */
interface Section<T> {
  readonly data: T
  readonly error: string | null
}

async function section<T>(load: () => Promise<T>, empty: T): Promise<Section<T>> {
  try {
    return { data: await load(), error: null }
  } catch (error) {
    return { data: empty, error: message(error) }
  }
}

/**
 * Parallel work of different shapes, through the client's gate and concurrency
 * limit rather than around it. Copied from `pull-request.ts` for the same reason
 * `section` is; the cast is the price of a heterogeneous tuple.
 */
async function fanOutTuple<T extends readonly unknown[]>(
  client: AdoClient,
  tasks: { readonly [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  const done = await client.fanOut(
    tasks as unknown as ReadonlyArray<() => Promise<unknown>>,
    (run) => run(),
  )

  return done as unknown as T
}

// ---------------------------------------------------------------------------
// The cache.
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly at: number
  readonly value: unknown
}

/**
 * Per-client, not per-process, and deliberately not a table.
 *
 * `adoClient()` hands back one client per credential fingerprint and rebuilds it
 * when the PAT or the org changes, so keying the cache on the client object
 * means a credential change invalidates it for free — the idiom `hydrate.ts` and
 * `resolveViewer` already use. A SQLite table would need a migration in a file
 * this change does not own, and would outlive the only thing that makes the
 * entries safe to keep: that the build they describe is finished.
 */
const caches = new WeakMap<AdoClient, Map<string, CacheEntry>>()

const buildKey = (projectId: string, buildId: number): string => `${projectId}/${buildId}`

/**
 * Read through, but only for a build that will never change again.
 *
 * `cacheable` is `build.status === 'completed'` and nothing else. A failure is
 * not cached, because a throw never reaches the `set` — an hour is a long time
 * to remember that the timeline API was briefly unwell.
 */
async function cached<T>(
  client: AdoClient,
  key: string,
  cacheable: boolean,
  load: () => Promise<T>,
): Promise<T> {
  if (!cacheable) return load()

  let store = caches.get(client)
  if (store === undefined) {
    store = new Map()
    caches.set(client, store)
  }

  const hit = store.get(key)
  if (hit !== undefined && Date.now() - hit.at < LOG_CACHE_MS) return hit.value as T

  const value = await load()
  store.set(key, { at: Date.now(), value })

  return value
}

/**
 * Forget one build.
 *
 * Called after both retry writes because it is unknown whether a retry mints a
 * new build id or reuses the old one — §10b. If it reuses it, a cached timeline
 * would show the previous attempt's failure under a build that is running again,
 * which is the one wrong answer this cache could give.
 */
export function clearBuildCache(client: AdoClient, projectId: string, buildId: number): void {
  const store = caches.get(client)
  if (store === undefined) return

  const prefix = `${buildKey(projectId, buildId)}/`
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}

// ---------------------------------------------------------------------------
// The checks list.
// ---------------------------------------------------------------------------

interface AdoEvaluationContext {
  readonly buildId?: number
  readonly buildDefinitionId?: number
  readonly buildDefinitionName?: string
  readonly buildIsNotCurrent?: boolean
  readonly buildStartedUtc?: string
}

interface AdoEvaluation {
  /** This evaluation of this policy on this pull request — what the requeue route addresses. */
  readonly evaluationId?: string
  readonly status?: string
  readonly context?: AdoEvaluationContext | null
  readonly configuration?: {
    readonly id?: number | string
    readonly isBlocking?: boolean
    readonly isEnabled?: boolean
    readonly type?: { readonly displayName?: string }
    readonly settings?: {
      readonly buildDefinitionId?: number
      readonly displayName?: string | null
    }
  }
}

const SATISFIED: ReadonlySet<string> = new Set(['approved', 'notApplicable'])

const KNOWN_STATUS: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'queued',
  'running',
  'broken',
  'notApplicable',
])

/**
 * `EvaluationStatus` is closed, so an unrecognised word becomes `broken` rather
 * than being passed through — the one value in the union that means "ADO said
 * something we have no case for", and unsatisfied, which errs toward showing a
 * row as still blocking. All 150 sampled evaluations were in the known set.
 */
const evaluationStatus = (raw: string | undefined): EvaluationStatus =>
  KNOWN_STATUS.has(raw ?? '') ? (raw as EvaluationStatus) : 'broken'

/**
 * The build behind an evaluation, or `null` when there is not one yet.
 *
 * `null` is a real state and not only a non-build policy: a build policy sits in
 * `queued` with `context: null` for the interval between the push and the queue,
 * and drawing that row as "no build" beats inventing a build id for it.
 */
function toBuildLink(context: AdoEvaluationContext | null | undefined): BuildLink | null {
  const buildId = context?.buildId
  if (typeof buildId !== 'number') return null

  return {
    buildId,
    // Both ids were present on 27 of 27 evaluations that had a build; the
    // settings copy is the fallback because it is the same number by
    // definition. Nothing interpolates this into a path.
    definitionId: context?.buildDefinitionId ?? 0,
    definitionName: context?.buildDefinitionName ?? 'Build',
    startedAt: context?.buildStartedUtc ?? '',
    isNotCurrent: context?.buildIsNotCurrent === true,
  }
}

/**
 * Whether re-running this policy is an act, restating `requeueTarget` in
 * `pull-request.ts` — which is not exported. Four lines and one rule: a running
 * policy is refused because requeueing cancels the build it is running, so the
 * button that looks most useful mid-build is the one that destroys the answer
 * you are waiting for.
 */
function requeueTarget(evaluation: AdoEvaluation, status: EvaluationStatus): string | null {
  const id = evaluation.evaluationId
  if (typeof id !== 'string' || id === '' || status === 'running') return null

  const stale = evaluation.context?.buildIsNotCurrent === true

  return SATISFIED.has(status) && !stale ? null : id
}

/**
 * The build policies, as rows.
 *
 * `settings.buildDefinitionId` and not `type.displayName === 'Build'`, for
 * `pull-request.ts`'s reason: the display name is display text and collides,
 * the settings are data and do not.
 */
export function toChecks(
  evaluations: readonly AdoEvaluation[],
  org: string,
  projectId: string,
): CheckSummary[] {
  return evaluations
    .filter((evaluation) => evaluation.configuration?.settings?.buildDefinitionId !== undefined)
    .map((evaluation, index) => {
      const configuration = evaluation.configuration
      const status = evaluationStatus(evaluation.status)
      const build = toBuildLink(evaluation.context)

      return {
        id: String(configuration?.id ?? index),
        // `context.buildDefinitionName` is the only human name on this route;
        // a policy that has not built yet has only its own display name.
        name:
          build?.definitionName ??
          configuration?.settings?.displayName?.trim() ??
          configuration?.type?.displayName ??
          'Build',
        status,
        blocking:
          configuration?.isBlocking === true &&
          configuration.isEnabled !== false &&
          !SATISFIED.has(status),
        build,
        url:
          build === null
            ? null
            : `https://dev.azure.com/${encodeURIComponent(org)}/${projectId}/_build/results?buildId=${build.buildId}`,
        requeueId: requeueTarget(evaluation, status),
      }
    })
}

async function loadEvaluations(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<readonly CheckSummary[]> {
  const response = await client.get<{ value?: readonly AdoEvaluation[] }>(
    `${ref.projectId}/_apis/policy/evaluations`,
    {
      artifactId: `vstfs:///CodeReview/CodeReviewId/${ref.projectId}/${ref.id}`,
      'api-version': POLICY_VERSION,
    },
  )

  return toChecks(response.value ?? [], client.org, ref.projectId)
}

/**
 * What the checks panel draws with the page.
 *
 * The build reads fan out through the client rather than `Promise.all`, and they
 * fan out over *distinct* build ids: two policies pointing at the same build is
 * one call, not two.
 *
 * A build that will not load costs its rows their detail and nothing else —
 * `failed` carries one entry per affected check, the way `SonarReport.failed`
 * does, because "we could not read that one" belongs against the row it is
 * about. `errors.builds` is reserved for the case where *every* build read
 * failed: one build failing is that row's problem, all of them failing is the
 * build API's, and a reader can tell those apart.
 *
 * `errors.timeline` and `errors.tests` are always `null` here. Neither endpoint
 * is touched until a row is opened, and a `null` that means "not attempted" is
 * the same `null` as "fine" only because an empty result is not an error.
 */
export async function loadChecksReport(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<ChecksReport> {
  const checks = await section<readonly CheckSummary[]>(() => loadEvaluations(client, ref), [])

  const buildIds = [
    ...new Set(
      checks.data
        .map((check) => check.build?.buildId)
        .filter((id): id is number => id !== undefined),
    ),
  ]

  const attempts = await client.fanOut(buildIds, async (buildId) => {
    try {
      return { buildId, build: await readBuild(client, ref.projectId, buildId), error: null }
    } catch (error) {
      return { buildId, build: null, error: message(error) }
    }
  })

  const builds = attempts
    .map((attempt) => attempt.build)
    .filter((build): build is BuildRun => build !== null)

  const lost = attempts.filter((attempt) => attempt.build === null)

  const failed: CheckFailure[] = lost.flatMap((attempt) =>
    checks.data
      .filter((check) => check.build?.buildId === attempt.buildId)
      .map((check) => ({ checkId: check.id, message: attempt.error ?? 'The build did not load.' })),
  )

  return {
    checks: checks.data,
    builds,
    errors: {
      ...NO_ERRORS,
      checks: checks.error,
      builds: buildIds.length > 0 && builds.length === 0 ? (lost[0]?.error ?? null) : null,
    },
    failed,
  }
}

// ---------------------------------------------------------------------------
// The build.
// ---------------------------------------------------------------------------

interface AdoBuild {
  readonly id?: number
  readonly buildNumber?: string
  readonly status?: string
  readonly result?: string
  readonly queueTime?: string
  readonly startTime?: string
  readonly finishTime?: string
  readonly reason?: string
  readonly _links?: { readonly web?: { readonly href?: string } }
}

const BUILD_STATUS: ReadonlySet<string> = new Set([
  'none',
  'inProgress',
  'completed',
  'cancelling',
  'postponed',
  'notStarted',
])

const BUILD_RESULT: ReadonlySet<string> = new Set([
  'canceled',
  'failed',
  'none',
  'partiallySucceeded',
  'succeeded',
])

/**
 * One build, and the answer to whether anything about it may be kept.
 *
 * An unrecognised `status` becomes `none`, which reads as "no status" and — more
 * to the point — is not `completed`, so a word nobody wrote a case for can never
 * make something cacheable. `result` and `finishTime` are *absent* rather than
 * null on a build that has not finished (0 of 6 unfinished builds carried
 * either), which is why both are read defensively and why there is no progress
 * number here to show: `queuePosition` was absent on all 6 too.
 */
export function toBuildRun(raw: AdoBuild, org: string, projectId: string, buildId: number): BuildRun {
  const id = raw.id ?? buildId

  return {
    id,
    number: raw.buildNumber ?? String(id),
    status: BUILD_STATUS.has(raw.status ?? '') ? (raw.status as BuildStatus) : 'none',
    result: BUILD_RESULT.has(raw.result ?? '') ? (raw.result as BuildResult) : null,
    queuedAt: raw.queueTime ?? '',
    startedAt: raw.startTime ?? null,
    finishedAt: raw.finishTime ?? null,
    reason: raw.reason ?? '',
    // `_links.web.href` was present on 14 of 14; the fallback is the same route
    // ADO's own link uses, because the REST `url` is not somewhere to send a
    // reader.
    webUrl:
      raw._links?.web?.href ??
      `https://dev.azure.com/${encodeURIComponent(org)}/${projectId}/_build/results?buildId=${id}`,
  }
}

async function readBuild(client: AdoClient, projectId: string, buildId: number): Promise<BuildRun> {
  const raw = await client.get<AdoBuild>(`${projectId}/_apis/build/builds/${buildId}`)

  return toBuildRun(raw, client.org, projectId, buildId)
}

// ---------------------------------------------------------------------------
// The timeline.
// ---------------------------------------------------------------------------

interface AdoIssue {
  readonly type?: string
  readonly category?: string | null
  readonly message?: string
  readonly data?: Record<string, string | undefined> | null
}

interface AdoRecord {
  readonly id?: string
  readonly parentId?: string | null
  readonly type?: string
  readonly name?: string
  readonly state?: string
  readonly result?: string | null
  readonly startTime?: string | null
  readonly finishTime?: string | null
  readonly log?: { readonly id?: number } | null
  readonly errorCount?: number
  readonly warningCount?: number
  readonly order?: number | null
  /** Absent on 413 of 440 records. Not empty — absent. */
  readonly issues?: readonly AdoIssue[]
}

interface AdoLogRef {
  readonly id?: number
  readonly lineCount?: number
}

const RECORD_STATE: ReadonlySet<string> = new Set(['pending', 'inProgress', 'completed'])

const RECORD_RESULT: ReadonlySet<string> = new Set([
  'succeeded',
  'succeededWithIssues',
  'failed',
  'canceled',
  'skipped',
  'abandoned',
])

/** ADO sends `logFileLineNumber` and `linenumber` as strings, e.g. `"45"`. */
function digits(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)

  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * The keys are lower-cased and the useful ones are in `data`.
 *
 * `sourcepath`, `linenumber` and `columnnumber` — not `sourcePath` — on 62 of 95
 * sampled issues, which is the only mapping there is from a compiler error to a
 * line of the diff. Camel-casing the lookup silently loses all 62.
 */
function toIssue(raw: AdoIssue): TimelineIssue {
  return {
    type: raw.type === 'error' ? 'error' : 'warning',
    category: raw.category ?? null,
    message: raw.message ?? '',
    logLine: digits(raw.data?.logFileLineNumber),
    sourcePath: raw.data?.sourcepath ?? null,
    sourceLine: digits(raw.data?.linenumber),
  }
}

const duration = (from: string | null | undefined, to: string | null | undefined): number | null => {
  if (typeof from !== 'string' || typeof to !== 'string') return null
  const ms = Date.parse(to) - Date.parse(from)

  return Number.isFinite(ms) ? ms : null
}

interface Shell {
  readonly record: AdoRecord
  readonly children: Shell[]
}

/**
 * The wire's flat `records` + `parentId`, as a tree.
 *
 * `isFailingStep` needs `children.length`, so it cannot be decided in the same
 * pass that reads a record — the shells are linked first and the nodes are
 * frozen second. `order` sorts the children because the array's own order is not
 * pipeline order, and `seen` guards a parent cycle: 440 of 440 sampled
 * `parentId`s resolved cleanly, and the one shape that would hang this function
 * is cheaper to refuse than to trust.
 *
 * `lineCounts` comes from the build's separate `logs` collection, joined on the
 * log id. Empty is allowed and means the collection was not read.
 */
export function buildTimeline(
  records: readonly AdoRecord[],
  lineCounts: ReadonlyMap<number, number> = new Map(),
): TimelineNode[] {
  const shells = new Map<string, Shell>()
  for (const record of records) {
    if (typeof record.id === 'string') shells.set(record.id, { record, children: [] })
  }

  const roots: Shell[] = []
  for (const shell of shells.values()) {
    const parent =
      typeof shell.record.parentId === 'string' ? shells.get(shell.record.parentId) : undefined
    if (parent === undefined || parent === shell) roots.push(shell)
    else parent.children.push(shell)
  }

  const order = (shell: Shell): number => shell.record.order ?? 0
  const seen = new Set<Shell>()

  const finalise = (shell: Shell): TimelineNode => {
    seen.add(shell)
    const record = shell.record
    const children = [...shell.children]
      .filter((child) => !seen.has(child))
      .sort((a, b) => order(a) - order(b))
      .map(finalise)
    const logId = record.log?.id
    const errorCount = record.errorCount ?? 0
    const result = RECORD_RESULT.has(record.result ?? '')
      ? (record.result as RecordResult)
      : null

    return {
      id: record.id ?? '',
      type: record.type ?? 'Task',
      name: record.name ?? '',
      state: RECORD_STATE.has(record.state ?? '') ? (record.state as RecordState) : 'completed',
      result,
      startedAt: record.startTime ?? null,
      finishedAt: record.finishTime ?? null,
      durationMs: duration(record.startTime, record.finishTime),
      log:
        typeof logId === 'number'
          ? { id: logId, lineCount: lineCounts.get(logId) ?? null }
          : null,
      errorCount,
      warningCount: record.warningCount ?? 0,
      // The absent key, normalised. `record.issues.length` throws on 413 of 440.
      issues: (record.issues ?? []).map(toIssue),
      children,
      isFailingStep: isFailingStep({ result, errorCount, children }),
    }
  }

  return roots.sort((a, b) => order(a) - order(b)).map(finalise)
}

/**
 * The step that actually broke, first in pipeline order.
 *
 * Of 34 records reporting `failed`, only 10 were leaves; the other 24 were the
 * `Job`/`Phase`/`Stage` containers holding them, every one with `errorCount: 0`.
 * Two of the eight failed builds had *two* failing leaves, so this returns the
 * first and the tree still marks the rest — hoisting one is a convenience for
 * the panel, not a claim that there is only one.
 */
export function findFailingStep(nodes: readonly TimelineNode[]): TimelineNode | null {
  for (const node of nodes) {
    if (node.isFailingStep) return node
    const inner = findFailingStep(node.children)
    if (inner !== null) return inner
  }

  return null
}

interface Tree {
  readonly nodes: readonly TimelineNode[]
  readonly failingStep: TimelineNode | null
}

const EMPTY_TREE: Tree = { nodes: [], failingStep: null }

/**
 * The timeline and the logs collection, in parallel.
 *
 * Two calls where one would draw the tree, because `lineCount` exists only on
 * the `logs` collection and without it the log slice has no window to ask for —
 * "the last 200 lines" is a `startLine`, and a `startLine` needs to know where
 * the end is. It costs 10.4 KB next to the timeline's ~20, it rides along
 * instead of after, and on a finished build both are kept for an hour.
 */
async function loadTree(client: AdoClient, projectId: string, buildId: number): Promise<Tree> {
  const base = `${projectId}/_apis/build/builds/${buildId}`

  const [timeline, logs] = await fanOutTuple<
    [{ records?: readonly AdoRecord[] }, { value?: readonly AdoLogRef[] }]
  >(client, [
    () => client.get<{ records?: readonly AdoRecord[] }>(`${base}/timeline`),
    () => client.get<{ value?: readonly AdoLogRef[] }>(`${base}/logs`),
  ])

  const lineCounts = new Map<number, number>()
  for (const log of logs.value ?? []) {
    if (typeof log.id === 'number' && typeof log.lineCount === 'number') {
      lineCounts.set(log.id, log.lineCount)
    }
  }

  const nodes = buildTimeline(timeline.records ?? [], lineCounts)

  return { nodes, failingStep: findFailingStep(nodes) }
}

// ---------------------------------------------------------------------------
// The log slice.
// ---------------------------------------------------------------------------

interface LogWindow {
  readonly startLine: number | null
  readonly endLine: number | null
}

/**
 * Which slice of a log to ask for.
 *
 * The tail is the default and the error's own line beats it. `TimelineIssue.logLine`
 * says where the failure was reported, and a build whose last 200 lines are
 * upload chatter would otherwise show none of it — so when the error sits before
 * the tail, the window is centred on it instead. `startLine`/`endLine` are
 * inclusive: `0`–`20` returned 21 lines.
 *
 * `null` means "ask for the whole thing": either the log fits in the window
 * anyway, or its length is unknown and the tail has to be taken after the fact.
 * ADO's line number is 1-based against the text form while the JSON `value`
 * array is 0-based, and half a window either side absorbs the difference — which
 * is why this does not try to correct for it.
 */
export function logWindow(totalLines: number | null, errorLine: number | null): LogWindow {
  if (totalLines === null || totalLines <= LOG_TAIL_LINES) return { startLine: null, endLine: null }

  const tail = totalLines - LOG_TAIL_LINES
  if (errorLine !== null && errorLine < tail) {
    const start = Math.max(0, errorLine - Math.floor(LOG_TAIL_LINES / 2))

    return { startLine: start, endLine: start + LOG_TAIL_LINES - 1 }
  }

  return { startLine: tail, endLine: null }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/

/** 46 of 47 sampled lines carried one and none of them needed it. */
const strip = (line: string): string => line.replace(TIMESTAMP, '')

/**
 * The bytes of a log, as lines, whichever form ADO chose to send.
 *
 * **The `Accept` header decides the format, and the query string overrides it.**
 * `ado-client.ts` sends `Accept: application/json` on every call, which turns a
 * whole log into `{"count":46,"value":[…lines…]}` — but the same URL with
 * `startLine` answers `text/plain` regardless, measured. So this reads the
 * content type rather than the request it made, which is also why the fetch goes
 * through `getBytes`: `get` ends in `response.json()`, and a log id that does not
 * exist answers **200 with an empty body**, which would arrive here as a
 * `SyntaxError` about JSON rather than as the emptiness it is.
 */
export function decodeLog(bytes: Uint8Array | null, contentType: string | null): string[] {
  if (bytes === null || bytes.length === 0) return []

  const text = new TextDecoder().decode(bytes)

  if ((contentType ?? '').includes('json')) {
    try {
      const parsed = JSON.parse(text) as { value?: readonly string[] }

      return (parsed.value ?? []).map(strip)
    } catch {
      // Content type said JSON and the body was not. Falling through to lines
      // shows the reader whatever arrived instead of nothing at all.
    }
  }

  const lines = text.split(/\r?\n/)
  // The text form ends with a trailing newline — which is the whole reason the
  // JSON count (46) and the text line count (47) disagreed on the same log.
  if (lines[lines.length - 1] === '') lines.pop()

  return lines.map(strip)
}

/**
 * A ceiling on a log body, for the one fetch that has no window.
 *
 * When `lineCount` is unknown — the `logs` collection did not read — there is no
 * `startLine` to ask for and the whole log arrives, however long it is. The 44 logs
 * on the sampled build were 7792 lines and 21 KB at the largest, so a megabyte is
 * far past anything measured and still small enough to hold.
 *
 * `Content-Length` is what this is checked against, and a log that declares none
 * slips through — the same hole `blob.ts` notes. It is the declared-size case that
 * is worth closing, because that is the one where the cost is known in advance.
 */
const MAX_LOG_BYTES = 1_000_000

/**
 * The failing step's log, windowed.
 *
 * Cached per window rather than per log, because the window is part of the
 * answer: a slice starting at line 2527 is not the slice starting at 0, and a
 * "load more" that reuses the first one silently shows the wrong lines.
 */
async function loadLog(
  client: AdoClient,
  projectId: string,
  buildId: number,
  log: { readonly id: number; readonly lineCount: number | null },
  window: LogWindow,
): Promise<LogSlice> {
  const response = await client.getBytes(
    `${projectId}/_apis/build/builds/${buildId}/logs/${log.id}`,
    { startLine: window.startLine ?? undefined, endLine: window.endLine ?? undefined },
    { maxBytes: MAX_LOG_BYTES },
  )

  // `bytes` is null only for the refusal, and it has to be told apart from the
  // empty body a missing log id answers with — otherwise a log too large to read
  // would be drawn as a step that printed nothing, which is the opposite fact.
  if (response.bytes === null) {
    throw new Error(
      `This step's log is ${Math.round((response.size ?? 0) / 1000)} kB, too large to show here.`,
    )
  }

  const lines = decodeLog(response.bytes, response.contentType)

  // Only reachable when `lineCount` was unknown and the whole log came back
  // longer than the window: the tail is taken here instead of by the service.
  const overflow = window.startLine === null ? Math.max(0, lines.length - LOG_TAIL_LINES) : 0

  return {
    logId: log.id,
    lines: lines.slice(overflow),
    firstLine: window.startLine ?? overflow,
    totalLines: log.lineCount ?? lines.length,
    truncated: (window.startLine ?? overflow) > 0,
  }
}

// ---------------------------------------------------------------------------
// Failed tests.
// ---------------------------------------------------------------------------

interface AdoTestRun {
  readonly id?: number
  readonly name?: string
  readonly state?: string
  readonly totalTests?: number
  readonly passedTests?: number
  readonly notApplicableTests?: number
  readonly incompleteTests?: number
  readonly webAccessUrl?: string
}

interface AdoTestResult {
  readonly id?: number
  readonly testCaseTitle?: string
  readonly automatedTestStorage?: string
  readonly errorMessage?: string
  readonly stackTrace?: string
  readonly durationInMs?: number
  readonly testRun?: { readonly id?: string }
}

/**
 * A run's failure count, by subtraction.
 *
 * **There is no `failedTests` field.** `total − passed − notApplicable − incomplete`
 * is the only way to it, and getting it wrong is not a rounding error: a run
 * reporting 40 total, 39 passed and 1 not-applicable has **zero** failures, and
 * reading "40 − 39" as one would send this module off to fetch a 106 KB result
 * list to display nothing. Clamped at zero because `unanalyzedTests` exists and
 * is not in the subtraction.
 */
export function toTestRun(raw: AdoTestRun): TestRunSummary {
  const total = raw.totalTests ?? 0
  const passed = raw.passedTests ?? 0
  const notApplicable = raw.notApplicableTests ?? 0
  const incomplete = raw.incompleteTests ?? 0

  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    state: raw.state ?? '',
    total,
    passed,
    notApplicable,
    incomplete,
    failed: Math.max(0, total - passed - notApplicable - incomplete),
    webUrl: raw.webAccessUrl ?? '',
  }
}

/**
 * One failed test, trimmed on the way out.
 *
 * The stack trace is cut to `STACK_TRACE_CHARS` here rather than in the panel so
 * that the bytes never cross to the browser — and it was already incomplete when
 * it arrived, ADO having truncated 8 of 28 sampled traces at exactly 4000
 * characters. `failureType` is not read at all: `None` on 28 of 28.
 */
function toFailedTest(raw: AdoTestResult, org: string, projectId: string, runId: number): FailedTest {
  const id = raw.id ?? 0

  return {
    id,
    name: raw.testCaseTitle ?? '',
    assembly: raw.automatedTestStorage ?? null,
    errorMessage: raw.errorMessage ?? '',
    stackTrace: (raw.stackTrace ?? '').slice(0, STACK_TRACE_CHARS),
    durationMs: raw.durationInMs ?? null,
    // The run's own `webAccessUrl` is `_TestManagement/Runs?runId=…&_a=runCharts`,
    // so this is that route with the result selected. The `resultId` deep link is
    // documented but unverified; the worst it can do is land on the run.
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${projectId}/_TestManagement/Runs?runId=${runId}&_a=resultSummary&resultId=${id}`,
  }
}

interface Tests {
  readonly runs: readonly TestRunSummary[]
  readonly failedTests: readonly FailedTest[]
}

const EMPTY_TESTS: Tests = { runs: [], failedTests: [] }

/**
 * The build's test runs, and the failures inside them.
 *
 * `test/runs?buildUri=vstfs:///Build/Build/{id}` is the route that works;
 * `testresults/resultsbybuild?buildId=` 404s on `dev.azure.com` on 8 of 8
 * attempts and answers only on a second host, which is not worth a second base
 * URL. A run with no derived failures is never asked for its results — that one
 * subtraction is what keeps a green build's detail at two calls instead of a
 * 106 KB one.
 *
 * `$top` rides along because a probe measured it accepted (200, not the 400 that
 * `outcomes=NoSuchOutcome` earns) — but it was never seen limiting anything, so
 * the cap is also applied here. Whichever of the two works, the browser gets 25.
 */
async function loadTests(client: AdoClient, projectId: string, buildId: number): Promise<Tests> {
  const response = await client.get<{ value?: readonly AdoTestRun[] }>(
    `${projectId}/_apis/test/runs`,
    { buildUri: `vstfs:///Build/Build/${buildId}` },
  )

  const runs = (response.value ?? []).map(toTestRun)
  const failing = runs.filter((run) => run.failed > 0)

  const results = await client.fanOut(failing, async (run) => {
    const page = await client.get<{ value?: readonly AdoTestResult[] }>(
      `${projectId}/_apis/test/runs/${run.id}/results`,
      { outcomes: 'Failed', $top: MAX_FAILED_TESTS },
    )

    return (page.value ?? []).map((raw) => toFailedTest(raw, client.org, projectId, run.id))
  })

  return { runs, failedTests: results.flat().slice(0, MAX_FAILED_TESTS) }
}

// ---------------------------------------------------------------------------
// One check, in full.
// ---------------------------------------------------------------------------

export interface CheckDetailTarget {
  readonly projectId: string
  readonly buildId: number
}

/**
 * Everything behind one row, fetched when it is opened.
 *
 * The build read comes first and alone, and it is allowed to throw: `CheckDetail.build`
 * is not optional, there is nothing to draw without it, and it is the read that
 * decides whether any of the rest may be kept. Nothing else is allowed to throw —
 * the timeline and the test runs each fail on their own, in parallel, into their
 * own field of `ChecksErrors`.
 *
 * The log is the one section without an error field of its own, so a log that
 * will not read reports as a timeline error *when the timeline itself was fine*.
 * It cannot be folded into the timeline's own load: a failed log read would then
 * cost the reader the tree that says which step to look at, which is the more
 * useful half.
 */
export async function loadCheckDetail(
  client: AdoClient,
  target: CheckDetailTarget,
): Promise<CheckDetail> {
  const build = await readBuild(client, target.projectId, target.buildId)

  // The whole cache rule, in one line. `completed` is a guarantee that nothing
  // below will ever change again; every other status — `inProgress`,
  // `notStarted`, `cancelling`, `postponed` — is a build that is still moving,
  // and a moving build's timeline must not be remembered for an hour.
  const settled = build.status === 'completed'
  const key = buildKey(target.projectId, target.buildId)

  const [tree, tests] = await fanOutTuple<[Section<Tree>, Section<Tests>]>(client, [
    () =>
      section(
        () => cached(client, `${key}/tree`, settled, () => loadTree(client, target.projectId, target.buildId)),
        EMPTY_TREE,
      ),
    () =>
      section(
        () => cached(client, `${key}/tests`, settled, () => loadTests(client, target.projectId, target.buildId)),
        EMPTY_TESTS,
      ),
  ])

  const step = tree.data.failingStep
  const log = step?.log ?? null
  const errorLine = step?.issues.find((issue) => issue.type === 'error')?.logLine ?? null

  const window = log === null ? null : logWindow(log.lineCount, errorLine)

  const slice =
    log === null || window === null
      ? { data: null, error: null }
      : await section<LogSlice | null>(
          () =>
            cached(client, `${key}/log/${log.id}/${window.startLine ?? 'all'}`, settled, () =>
              loadLog(client, target.projectId, target.buildId, log, window),
            ),
          null,
        )

  return {
    build,
    timeline: tree.data.nodes,
    failingStep: step,
    log: slice.data,
    testRuns: tests.data.runs,
    failedTests: tests.data.failedTests,
    errors: {
      ...NO_ERRORS,
      timeline: tree.error ?? slice.error,
      tests: tests.error,
    },
  }
}

// ---------------------------------------------------------------------------
// Re-running. **Neither of these has been sent.**
// ---------------------------------------------------------------------------

/**
 * Retry a whole build.
 *
 * `PATCH build/builds/{buildId}?retry=true` with the client's default
 * `api-version=7.1` — this route needs no preview suffix; its read accepted
 * `7.1`, `6.0` and even `2.0`.
 *
 * **Unproven, three ways.** The body is a `Build` with every field optional, so
 * `{}` is a guess at the minimum. The scope is `vso.build_execute` and the
 * stored PAT is only known to hold `vso.build`, so a 403 is a live possibility
 * and has to surface as itself. And it is unknown whether a retry mints a new
 * build id or reuses the old one — which is why the cache for this build is
 * dropped either way, since a reused id with a remembered timeline would show
 * the previous attempt's failure under a build that is running again.
 *
 * No retry on the request itself and none added: `write` makes one attempt, and
 * ADO throttles by delaying a complete 200, so a second attempt is a second
 * build on somebody's branch.
 */
export async function retryBuild(client: AdoClient, request: BuildRetryRequest): Promise<void> {
  await client.write('PATCH', `${request.projectId}/_apis/build/builds/${request.buildId}`, {}, {
    retry: true,
  })

  clearBuildCache(client, request.projectId, request.buildId)
}

/**
 * Retry one stage.
 *
 * `UpdateStageParameters` has exactly two fields at 7.1 and both are sent.
 * `stageRefName` is the `Stage` record's `identifier`, not its `name` — and this
 * organisation has no stage to point it at: 10 pipelines swept, `identifier`
 * `__default` on 14 of 14 sampled builds, `attempt` 1 on 440 of 440 records.
 *
 * Written because the ticket asks for the granularity and it is four lines;
 * shipped disabled in the panel, with that reason stated, because a button whose
 * only possible argument is `__default` is a button that retries the whole
 * build while claiming to retry part of it. ADO answers this one with no body at
 * all, so a caller learns nothing from the reply and must re-read the timeline.
 */
export async function retryStage(client: AdoClient, request: StageRetryRequest): Promise<void> {
  await client.write(
    'PATCH',
    `${request.projectId}/_apis/build/builds/${request.buildId}/stages/${request.stageRefName}`,
    { state: 'retry', forceRetryAllJobs: request.forceRetryAllJobs },
  )

  clearBuildCache(client, request.projectId, request.buildId)
}
