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
 * This is also the bound that keeps a pathological repository from hanging the
 * panel: 20 sequential requests at 145–1177 ms each is the worst case, and it only
 * happens on a project with more than 9 500 open findings.
 */
export const SONAR_MAX_PAGES = 20

/**
 * The most findings this app can ever show for one project, and it cannot be
 * defeated — only admitted, which is what `SonarTruncation` is for.
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
