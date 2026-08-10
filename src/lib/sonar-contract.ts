// The shape of a Sonar finding, agreed once. The other half of
// `comment-contract.ts`; the same rules apply — types only, every field
// measured, every absence explained.
//
// Evidence: §5 and §7–§11 of `docs/research/comments-sonar-inventory.md`.
// 58 SonarCloud calls across eight projects and four analysers.

// ---------------------------------------------------------------------------
// Which Sonar project a pull request belongs to.
// ---------------------------------------------------------------------------

/**
 * A pull request's Sonar coordinates, recovered from an ADO status — no
 * configuration anywhere.
 *
 * The status's `targetUrl` is
 * `https://sonarcloud.io/dashboard?id=<projectKey>&pullRequest=<prId>`, and the
 * `pullRequest` key is the ADO `pullRequestId` verbatim.
 *
 * **A repository can have more than one of these.** `context.name` was either
 * the bare `quality gate` or `quality_gate_<projectKey>`, and the multi-project
 * repositories posted several statuses — so this is a list per pull request, not
 * a field. A findings panel that assumes one project silently drops the others'
 * issues.
 */
export interface SonarProjectRef {
  readonly projectKey: string
  /** ADO's own `pullRequestId`, as a string, because that is how Sonar echoes it back. */
  readonly pullRequest: string
  /** The dashboard link from the ADO status, for the one "open in SonarCloud" affordance. */
  readonly dashboardUrl: string
}

/**
 * Who posts the Sonar statuses and the Sonar comment threads.
 *
 * The bridge between the two halves of this round: an ADO thread is Sonar's when
 * `comments[0].author.id` equals this. There is no marker property — the bot's
 * threads carry only `Microsoft.TeamFoundation.Discussion.UniqueID`, nothing
 * naming Sonar.
 *
 * **The caveat that has to travel with this type:** the identity behind every
 * sampled Sonar status was a general-purpose automation account ("QA
 * Automation"), not a Sonar-specific one. If that account ever comments as
 * itself, its comment is misfiled as a robot's. Detection by author identity is
 * the best available signal, not a reliable one.
 */
export interface SonarAuthorship {
  readonly identityId: string
  readonly displayName: string
}

// ---------------------------------------------------------------------------
// Severity, in the taxonomy that is actually authoritative.
// ---------------------------------------------------------------------------

/**
 * MQR severity. Present on every sampled issue under `impacts[]`.
 *
 * The legacy `severity` (`BLOCKER`…`INFO`) and `type` (`CODE_SMELL`…) fields
 * still arrive on every issue and are unreliable — the map's note stands, and
 * `type` has additionally been **removed from the `rules` API's field list**, so
 * asking for it there 400s the whole request.
 */
export type SonarSeverity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export type SoftwareQuality = 'SECURITY' | 'RELIABILITY' | 'MAINTAINABILITY'

export interface SonarImpact {
  readonly softwareQuality: SoftwareQuality
  readonly severity: SonarSeverity
}

/**
 * An issue's live state.
 *
 * **The API's default is not "open".** `issues/search` with no status filter
 * returns `FIXED` and `CLOSED` issues alongside open ones — measured: a pull
 * request reporting `total: 3` had three issues, all of them fixed. The first
 * probe pass read a `total: 0` as "a clean pull request" when it meant "no
 * issues in any state". Anything that means open must say
 * `issueStatuses=OPEN,CONFIRMED,ACCEPTED`, and this type exists so that the
 * filter is visible in the code rather than assumed.
 */
export type IssueStatus = 'OPEN' | 'CONFIRMED' | 'FALSE_POSITIVE' | 'ACCEPTED' | 'FIXED'

// ---------------------------------------------------------------------------
// Triaging an issue.
// ---------------------------------------------------------------------------

/**
 * Every workflow transition `api/issues/do_transition` accepts.
 *
 * All twelve, verbatim from the live descriptor
 * (`api/webservices/list?include_internals=true`), because the API rejects
 * anything else and a union is the cheapest place to be told so. Only the four in
 * `SONAR_TRANSITIONS` are offered — see the note there.
 *
 * The `resolveas*` and `resetastoreview` values belong to security hotspots,
 * which are a different endpoint's business (`hotspots/search`) and are not in
 * this app's findings list at all.
 */
export type SonarTransition =
  | 'confirm'
  | 'unconfirm'
  | 'reopen'
  | 'resolve'
  | 'falsepositive'
  | 'close'
  | 'wontfix'
  | 'accept'
  | 'resolveasreviewed'
  | 'resolveassafe'
  | 'resolveasacknowledged'
  | 'resetastoreview'

/**
 * One offered transition: the word for it, and what it means for the ADO thread.
 *
 * **`thread` is why this table exists rather than a label map.** Triaging in
 * SonarCloud and resolving the comment ADO shows a reviewer are two writes to two
 * services, and the second one's status is a judgement about the first: accepting
 * an issue and calling it a false positive are both `wontFix` — the code is not
 * changing — while confirming one leaves the conversation open on purpose. Only
 * this file knows both halves, so the mapping lives here and neither the panel
 * nor the server function re-decides it.
 *
 * `wontFix` and not `fixed` for both, and the census agrees: 4 of the 7 sampled
 * Sonar threads had been closed as `wontFix` by hand. `fixed` claims the code
 * changed, which is the one thing a transition never does.
 */
export interface SonarResolution {
  readonly transition: SonarTransition
  readonly label: string
  /**
   * The ADO thread status to write after Sonar accepts, or `null` to leave the
   * thread alone.
   */
  readonly thread: 'wontFix' | 'active' | null
}

/**
 * The transitions this app offers, and deliberately not all twelve.
 *
 * Sonar returns `accept` and `wontfix` together on every issue that allows
 * either, because `wontfix` is the old name for the same decision. Offering both
 * would be two buttons that do one thing, so only `accept` is here.
 *
 * `resolve` is absent for a different reason: it claims the code is fixed, and
 * Sonar decides that itself on the next analysis — an issue resolved by hand
 * while the code still triggers it simply reopens. A button whose effect the next
 * pipeline run undoes is worse than no button.
 *
 * `close`, `unconfirm` and the hotspot transitions are absent because nothing in
 * this panel is in a state that allows them.
 */
export const SONAR_TRANSITIONS: readonly SonarResolution[] = [
  { transition: 'accept', label: 'Accept', thread: 'wontFix' },
  { transition: 'falsepositive', label: 'False positive', thread: 'wontFix' },
  { transition: 'confirm', label: 'Confirm', thread: null },
  { transition: 'reopen', label: 'Reopen', thread: 'active' },
]

/**
 * What resolving one finding asks for.
 *
 * `comment` is Sonar's optional rationale. Nothing sends one yet — the panel has
 * buttons and no composer — but the parameter is on the endpoint and a reviewer
 * accepting an issue without saying why is a poor audit trail, so the field is
 * here for the composer to fill rather than added later by widening a validator.
 */
export interface SonarResolveRequest {
  readonly issueKey: string
  readonly transition: SonarTransition
  readonly comment?: string
}

/**
 * How resolving one finding went — in two answers, because it was two writes.
 *
 * **Neither field implies the other.** `transitioned` is Sonar's verdict and the
 * one that moves the quality gate; `thread` is what happened to the ADO comment
 * afterwards. A transition that landed and a thread PATCH that failed is the
 * interesting case: the finding *is* triaged, the conversation is still open, and
 * collapsing that into one boolean would either hide a real failure or report a
 * successful triage as a failure.
 *
 * `thread: 'none'` is not a failure. Most findings have no ADO thread — Sonar's
 * comments are capped at 50 per pull request — and `confirm` deliberately leaves
 * the thread alone.
 */
export interface SonarResolveResult {
  readonly transitioned: boolean
  /** `null` when the transition itself failed. */
  readonly status: IssueStatus | null
  /** `'updated'` and not `'resolved'`, because reopening writes to a thread too. */
  readonly thread: 'updated' | 'none' | 'failed'
  /** Why the transition failed, or `null`. Never carries a token. */
  readonly error: string | null
  /** Why the thread PATCH failed, when `thread` is `'failed'`. */
  readonly threadError: string | null
}

// ---------------------------------------------------------------------------
// Findings.
// ---------------------------------------------------------------------------

/**
 * Where in a file an issue is.
 *
 * `textRange` was present on **every** sampled issue, open or fixed. `line` was
 * present on all 4 open ones and **absent on all 3 fixed** ones — so the field
 * a fixed issue drops is exactly the one an anchor would naively read. Where
 * both existed, `line === textRange.startLine` on 4 of 4.
 *
 * **Anchor on `startLine`.** Not on `line`, which is a duplicate that sometimes
 * is not there.
 */
export interface SonarTextRange {
  readonly startLine: number
  readonly endLine: number
  readonly startOffset: number | null
  readonly endOffset: number | null
}

/**
 * One issue, as the findings panel needs it.
 *
 * `path` is derived, not sent: the API gives `component` as
 * `<projectKey>:<path>` and the response's `components[]` block carries the
 * `path` separately. A project-level issue has no `:` and therefore no file —
 * none were sampled, but the type allows `null` because a panel that assumes a
 * path will crash on the first one rather than skip it.
 *
 * The diff wants a leading slash and Sonar sends none, so `path` is normalised
 * to ADO's form on the way through. One side normalises; the comparison is then
 * plain equality.
 */
export interface SonarFinding {
  readonly key: string
  readonly rule: string
  readonly message: string
  /** Leading-slash, ADO-form, or `null` for an issue that is not about a file. */
  readonly path: string | null
  readonly textRange: SonarTextRange | null
  readonly status: IssueStatus
  readonly impacts: readonly SonarImpact[]
  readonly cleanCodeAttributeCategory: string | null
  /** Sonar's own estimate, e.g. `"20min"`. Displayed verbatim; nothing parses it. */
  readonly effort: string | null
  readonly tags: readonly string[]
  /** Deep link into SonarCloud for this one issue. */
  readonly url: string
  /**
   * The transitions Sonar says this issue allows, right now, for this token.
   *
   * **Read this, never a fixed list.** The array is per-issue and empty is a real
   * measured state: one sampled issue came back with `"transitions": []` and
   * `"actions": ["comment"]`. It also narrows as an issue moves — an accepted
   * issue stops offering `accept`. Buttons drawn from a constant would offer
   * writes the API then refuses.
   *
   * Empty also means "no permission". `accept`, `wontfix` and `falsepositive`
   * need **Administer Issues** on the project, and Sonar leaves them out of this
   * array for a token that only has Browse rather than listing them and
   * answering 403.
   */
  readonly transitions: readonly SonarTransition[]
}

/**
 * Findings grouped by rule, count descending — the shape the panel renders.
 *
 * The grouping is done where the data is fetched rather than in the component,
 * because "count descending" is a fact about the whole list and a component
 * that groups is a component that re-groups on every render.
 */
export interface RuleGroup {
  readonly rule: string
  /** From the rules API, or `null` when it would not describe the rule — see `SonarRule`. */
  readonly name: string | null
  /** The worst impact among the group's findings, for the badge. */
  readonly severity: SonarSeverity | null
  readonly findings: readonly SonarFinding[]
}

/**
 * A project whose findings are in the report but not all of them.
 *
 * **Not a failure, which is why this is not `SonarReport.failed`.** Those two
 * lists answer different questions — `failed` is "which project did we lose",
 * this is "which project's list is short" — and a project can be in this one
 * while every finding it did answer with renders normally. Filing a truncation as
 * a failure would make the panel say it could not read a project whose findings
 * are on the screen.
 *
 * Both reasons it happens are real. `issues/search` will not page past
 * `SONAR_ISSUE_CEILING` issues, and a request can fail on page 3 with pages 1 and
 * 2 already in hand — the second is the one worth keeping partials for, and the
 * one that must not read as "that was the end of the list".
 */
export interface SonarTruncation {
  readonly projectKey: string
  /** How many findings the report actually carries for this project. */
  readonly fetched: number
  /**
   * Sonar's own count of matching issues, so the panel can say how short the list
   * is. `null` when no page that answered carried one.
   */
  readonly total: number | null
  /**
   * Why the list stops, or `null` when it stopped at the API's own ceiling —
   * which is arithmetic rather than something going wrong. A message here is the
   * request that ended the paging loop, and the difference between "backed off"
   * and "finished" lives in it.
   */
  readonly message: string | null
}

/** Everything Sonar says about one pull request. */
export interface SonarReport {
  readonly projects: readonly SonarProjectRef[]
  readonly groups: readonly RuleGroup[]
  readonly gate: QualityGate | null
  /**
   * A project whose issues could not be read, paired with why.
   *
   * Partial failure is the normal case for a multi-project repository: one
   * project's token scope or analysis can fail while the others answer. A panel
   * that shows four projects' findings and silently omits the fifth is worse
   * than one that says which one it lost.
   *
   * A project that answered *some* pages before failing is not here — it is in
   * `truncated`, because its findings are in the report.
   */
  readonly failed: readonly { readonly projectKey: string; readonly message: string }[]
  /** A project whose findings are here but incomplete. See `SonarTruncation`. */
  readonly truncated: readonly SonarTruncation[]
}

// ---------------------------------------------------------------------------
// The quality gate.
// ---------------------------------------------------------------------------

export type GateStatus = 'OK' | 'ERROR' | 'NONE'

/**
 * One failing (or passing) gate condition.
 *
 * From `qualitygates/project_status`, which is **deprecated since 2025-09-16 and
 * still answers 200** — measured, not assumed. The map's advice to prefer
 * `measures/component` came with metric names that do not exist on Cloud (they
 * 404 with "The following metric keys are not found"), and the endpoint that
 * does work has two traps of its own: `new_*` metrics arrive under
 * `periods[0].value` rather than `value`, and `quality_gate_details` is a JSON
 * **string** that has to be parsed. The deprecated endpoint hands over exactly
 * this shape with none of that, so it stays until it stops answering.
 */
export interface GateCondition {
  readonly metricKey: string
  readonly comparator: string
  readonly errorThreshold: string
  readonly actualValue: string
  readonly status: GateStatus
}

export interface QualityGate {
  readonly status: GateStatus
  /** Failing conditions first — the panel shows those and hides the rest. */
  readonly conditions: readonly GateCondition[]
}

// ---------------------------------------------------------------------------
// Rule detail.
// ---------------------------------------------------------------------------

/**
 * One section of a rule's description.
 *
 * **The order the API returns these in is not stable.** Two calls for
 * `javascript:S4036` in the same probe run gave
 * `root_cause, how_to_fix, resources, introduction` and
 * `resources, introduction, root_cause, how_to_fix`. The renderer must impose
 * its own order — see `SECTION_ORDER` — or the same rule reads differently
 * depending on which call filled the cache.
 *
 * `content` is **HTML**, not markdown. `mdDesc` and `htmlDesc` came back
 * byte-identical on all three rules that had them, so there is no markdown path
 * to prefer: whatever renders this has to sanitise HTML.
 */
export interface RuleSection {
  readonly key: string
  readonly content: string
  /** Set when a section is language- or framework-specific. */
  readonly context: { readonly key: string; readonly displayName: string } | null
}

/**
 * The order a rule reads in, imposed rather than received.
 *
 * Introduction, then what is wrong, then how to fix it, then where to read more.
 * A section key the API invents later is not dropped — it sorts to the end.
 */
export const SECTION_ORDER: readonly string[] = [
  'introduction',
  'root_cause',
  'assess_the_problem',
  'how_to_fix',
  'resources',
]

/**
 * A rule, as the app describes it.
 *
 * Measured: `rules/search?rule_keys=a,b,c` returns every requested rule with
 * full descriptions in **one** call — 3 rules, 28.0 KB, 392 ms — and
 * `rules/show` returned nothing about a description that the batched form did
 * not. So one call per pull request, never one per rule.
 *
 * **`organization` is mandatory.** Every `rules` request without it answers 400
 * `The 'organization' parameter is missing`. This is what made the endpoint look
 * dead for a whole probe pass.
 *
 * **A rule can be undescribable.** `external_roslyn:CA1861` was requested and
 * simply not returned — externally-imported analyser rules are not in Sonar's
 * rule repository. Unknown keys are skipped rather than erroring, so a rule the
 * analyser reported and a rule that does not exist look identical: the panel
 * falls back to the bare key, and `RuleGroup.name` is `null`.
 */
export interface SonarRule {
  readonly key: string
  readonly name: string
  readonly language: string | null
  readonly impacts: readonly SonarImpact[]
  readonly cleanCodeAttribute: string | null
  /** Ordered by `SECTION_ORDER`. Empty when the rule has only the single-blob description. */
  readonly sections: readonly RuleSection[]
  /** The whole description as one HTML blob, for a rule with no sections. */
  readonly html: string | null
  readonly tags: readonly string[]
}

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

/**
 * The most issues one `issues/search` call will return.
 *
 * A hard ceiling, not a suggestion: `ps=501` and `ps=1000` both answer 400
 * `'ps' value (501) must be less than 500`. So this is the page size *and* the
 * maximum page size — there is no larger value to ask for, and a paging loop is
 * the only way past it.
 *
 * Shared with the `rules/search` call, which sends it as a plain limit on a single
 * request rather than as a page size. That call is bounded by the number of
 * *distinct rules* in a pull request, which no sampled repository put anywhere
 * near 500, so it stays one call and this constant stays one number.
 */
export const SONAR_PAGE_SIZE = 500

/**
 * The most pages of findings one project will be asked for.
 *
 * **Arithmetic, not policy.** On `issues/search`, `p * ps` cannot exceed 10 000,
 * so at the maximum page size the twenty-first page is a 400 — page 20 is where
 * the API stops, whatever the loop would like. `SONAR_ISSUE_CEILING` is the same
 * fact counted in issues.
 *
 * Where the two halves come from is worth knowing, because they are not equally
 * checked here. The `ps` cap is in the probe table verbatim (`ps=501` → 400). The
 * `p * ps` cap is T-038's reconnaissance and Sonar's own documented limit, and no
 * probe in `docs/research/` sends a `p` at all — so if a page 21 ever answers 200,
 * this is the number to re-measure rather than the one to trust.
 *
 * This is also the bound that keeps a pathological repository from hanging the
 * panel: the two `issues/search` calls that were timed took 615 ms and 788 ms, so
 * 20 of them sequentially is the worst case — and it is only reached on a project
 * with more than 9 500 open findings.
 */
export const SONAR_MAX_PAGES = 20

/**
 * The most findings this app can ever show for one project, and it cannot be
 * defeated — only admitted, which is what `SonarTruncation` is for.
 *
 * The same number showed up as a `total`: a project's main branch answered
 * `total: 10000` exactly, which is the ceiling and almost certainly the count
 * being clamped to it rather than a coincidence. Harmless for the paging loop —
 * it stops there anyway — but it does mean a `total` of exactly this is a floor
 * and not a count.
 */
export const SONAR_ISSUE_CEILING = SONAR_PAGE_SIZE * SONAR_MAX_PAGES

/**
 * How long to wait after a Sonar 429, in milliseconds.
 *
 * **SonarCloud sends no rate-limit headers at all** — 19 response headers
 * examined, not one mentioning a limit, a retry or a quota. There is no
 * `Retry-After` to read and no budget to watch, so a 429 is the entire signal
 * and the only safe response is to stop asking for a while. Minutes, not the
 * seconds ADO's `Retry-After` usually names.
 */
export const SONAR_BACKOFF_MS = 120_000
