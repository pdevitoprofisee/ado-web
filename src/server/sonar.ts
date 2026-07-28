import { createHash } from 'node:crypto'

import { serviceDetail } from './connection-test'
import { readSonarCredential } from './credentials'
import { SECTION_ORDER, SONAR_BACKOFF_MS, SONAR_PAGE_SIZE } from '../lib/sonar-contract'

import type { AdoClient, QueryValue } from './ado-client'
import type { SonarCredential } from './credentials'
import type { PullRequestRef } from './pull-request'
import type {
  GateCondition,
  GateStatus,
  IssueStatus,
  QualityGate,
  RuleGroup,
  RuleSection,
  SonarFinding,
  SonarImpact,
  SonarProjectRef,
  SonarReport,
  SonarRule,
  SonarSeverity,
  SonarTextRange,
} from '../lib/sonar-contract'

// Server-only. Everything the app knows about SonarCloud.
//
// Two reasons this is not `ado-client.ts` with a different base URL. Sonar's
// throttling is a bare 429 with **no rate-limit headers of any kind** (19
// response headers examined, not one about a limit, a retry or a quota), so
// there is no budget to track and nothing to read — the gate below is a stop
// rather than the accounting `RateLimit` does. And CORS is refused outright by
// sonarcloud.io (preflight 405, "no plans to enable"), so the browser could
// never make these calls even with a token, which it is never given.
//
// What T-022 settled, so nothing below re-derives it (§5, §7–§11 of
// `docs/research/comments-sonar-inventory.md`):
//
//   - `issues/search` **includes FIXED and CLOSED by default**. A pull request
//     answering `total: 3` had three issues and zero open ones. `issueStatuses`
//     is not a refinement here, it is the difference between findings and
//     history.
//   - Every `rules` request needs `organization`; without it both `show` and
//     `search` answer 400 `The 'organization' parameter is missing`. And an
//     illegal entry in `f=` — `type`, which SonarCloud has removed — 400s the
//     whole request instead of being ignored.
//   - `qualitygates/project_status` is deprecated (2025-09-16) and still answers
//     200 with the display shape. Its documented replacement,
//     `measures/component`, 404s on the MQR metric names, hides `new_*` values
//     under `periods[0].value` and ships `quality_gate_details` as a JSON
//     *string*. **When the deprecated endpoint stops answering**, switch to
//     `measures/component` with `metricKeys=new_reliability_rating,
//     new_security_rating,new_maintainability_rating,
//     new_security_hotspots_reviewed` plus `alert_status`, and re-derive the
//     comparator and threshold from the parsed `quality_gate_details`.

const SONAR = 'https://sonarcloud.io'

/** Sonar answered a probe in 145–1177 ms; this is a network ceiling, not a budget. */
const TIMEOUT_MS = 30_000

/**
 * The only `genre` a Sonar status carries, and the only reliable half of the
 * status: `context.name` is **either** the bare `quality gate` **or**
 * `quality_gate_<projectKey>` depending on the repository, so matching on the
 * name would find some projects and miss others.
 */
const SONAR_GENRE = 'SonarCloud'

/**
 * What "open" has to say out loud. See the header — the default is not this.
 *
 * `FALSE_POSITIVE` and `FIXED` are deliberately absent: an issue somebody has
 * already triaged away is not a finding to review. `ACCEPTED` is here because
 * accepting an issue is a decision about the debt, not a claim it is gone.
 */
const OPEN_STATUSES = 'OPEN,CONFIRMED,ACCEPTED'

/**
 * The rule fields, and it is a subset of a list measured to answer 200.
 *
 * `type` is the trap: it is gone from SonarCloud and its presence 400s the whole
 * request. `mdDesc` is left out because it came back **byte-identical** to
 * `htmlDesc` on all three rules that had a description — there is no markdown
 * path to prefer, only a second copy of the same HTML. `severity` is left out
 * because the legacy severity is unreliable and `impacts` is authoritative.
 */
const RULE_FIELDS = 'name,lang,langName,impacts,cleanCodeAttribute,descriptionSections,htmlDesc,sysTags'

/** Worst first. The MQR severity, which is the one `impacts[]` speaks. */
const SEVERITY_ORDER: readonly SonarSeverity[] = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

const ISSUE_STATUSES: ReadonlySet<string> = new Set([
  'OPEN',
  'CONFIRMED',
  'FALSE_POSITIVE',
  'ACCEPTED',
  'FIXED',
])

const GATE_STATUSES: ReadonlySet<string> = new Set(['OK', 'ERROR', 'NONE'])

/** A response SonarCloud refused. `detail` is Sonar's own `errors[0].msg`, redacted. */
export class SonarError extends Error {
  /** `null` when the request never got a response at all. */
  readonly status: number | null
  readonly detail: string | null

  constructor(status: number | null, message: string, detail: string | null = null) {
    super(detail ? `${message} (${detail})` : message)
    this.name = 'SonarError'
    this.status = status
    this.detail = detail
  }
}

export class SonarNotConnectedError extends Error {
  constructor() {
    super('SonarCloud is not connected yet.')
    this.name = 'SonarNotConnectedError'
  }
}

export interface SonarClient {
  /** `path` is api-relative: `api/issues/search`. */
  get<T>(path: string, params?: Record<string, QueryValue>): Promise<T>
}

export interface SonarClientOptions {
  /** Overridable so a test does not have to wait two minutes to prove the gate. */
  readonly backoffMs?: number
}

/**
 * Everything Sonar says about one pull request, plus the rules it says it with.
 *
 * `SonarReport` carries only a rule's `name`, which is all the group header
 * needs; the panel's rule *detail* is the same batched call's other half, and
 * throwing it away here would mean fetching it again per rule the moment
 * somebody expands one. One call, both consumers.
 */
export interface SonarPullRequestReport {
  readonly report: SonarReport
  /** Only the rules SonarCloud would describe. A skipped key is simply absent. */
  readonly rules: readonly SonarRule[]
}

/** The two fields of an ADO status this module reads. */
export interface AdoStatus {
  readonly context?: { readonly name?: string; readonly genre?: string } | null
  readonly targetUrl?: string
}

interface SonarComponent {
  readonly key?: string
  /** Present on a file component (`qualifier: FIL`), absent on the project itself. */
  readonly path?: string
}

interface SonarIssue {
  readonly key?: string
  readonly rule?: string
  readonly message?: string
  readonly component?: string
  /** MQR. The legacy `status` says `CLOSED` where this says `FIXED`. */
  readonly issueStatus?: string
  readonly textRange?: {
    readonly startLine?: number
    readonly endLine?: number
    readonly startOffset?: number
    readonly endOffset?: number
  }
  readonly impacts?: readonly { readonly softwareQuality?: string; readonly severity?: string }[]
  readonly cleanCodeAttributeCategory?: string
  readonly effort?: string
  readonly tags?: readonly string[]
  /**
   * The organization, on every issue — which is how the `rules` call gets its
   * mandatory parameter with no configuration anywhere. See `loadIssues`.
   */
  readonly organization?: string
}

interface SonarIssuesResponse {
  readonly total?: number
  readonly issues?: readonly SonarIssue[]
  readonly components?: readonly SonarComponent[]
}

interface SonarRuleResponse {
  readonly rules?: readonly {
    readonly key?: string
    readonly name?: string
    readonly lang?: string
    readonly langName?: string
    readonly impacts?: readonly { readonly softwareQuality?: string; readonly severity?: string }[]
    readonly cleanCodeAttribute?: string
    readonly descriptionSections?: readonly {
      readonly key?: string
      readonly content?: string
      readonly context?: { readonly key?: string; readonly displayName?: string } | null
    }[]
    readonly htmlDesc?: string
    readonly sysTags?: readonly string[]
  }[]
}

interface SonarGateResponse {
  readonly projectStatus?: {
    readonly status?: string
    readonly conditions?: readonly {
      readonly status?: string
      readonly metricKey?: string
      readonly comparator?: string
      readonly errorThreshold?: string
      readonly actualValue?: string
    }[]
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

export function createSonarClient(
  credential: SonarCredential,
  { backoffMs = SONAR_BACKOFF_MS }: SonarClientOptions = {},
): SonarClient {
  /** Epoch ms before which this client will not send. Zero means open. */
  let closedUntil = 0

  async function get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    // Not a sleep. A 429 backs off for *minutes* (there is no `Retry-After` to
    // shorten it with), and a request that waits two minutes inside a page load
    // is a hung page — so the gate refuses instead, the caller records the
    // project as failed, and the reader gets an answer now with a reason in it.
    const wait = closedUntil - Date.now()
    if (wait > 0) {
      throw new SonarError(
        429,
        `SonarCloud rate-limited this token. Not asking again for another ${Math.ceil(wait / 1000)} seconds.`,
      )
    }

    const url = new URL(`${SONAR}/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }

    let response: Response
    try {
      response = await fetch(url.toString(), {
        // Bearer, not Basic, and only a *personal* token can read issues
        // (`connection-test.ts` tests exactly this).
        headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' },
        // Same reason as note 4 on the ADO side: following a redirect would
        // forward the Authorization header to a host we did not choose.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      // Fixed text, never `cause.message` — the "no string derived from a
      // credential reaches the client" rule is only enforceable mechanically.
      throw new SonarError(
        null,
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `SonarCloud did not answer within ${TIMEOUT_MS / 1000} seconds.`
          : 'Could not reach SonarCloud. Check the network, a VPN, or a proxy.',
      )
    }

    if (response.status === 429) {
      closedUntil = Date.now() + backoffMs
      // Leaving a body unread holds the connection open until it is collected.
      await response.body?.cancel()

      throw new SonarError(
        429,
        `SonarCloud rate-limited this token. It sends no rate-limit headers, so there is nothing to read and no retry that would be informed — backing off for ${Math.round(backoffMs / 60_000)} minutes.`,
      )
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SonarError(response.status, 'SonarCloud redirected instead of answering, which is how a rejected token can arrive.')
    }
    if (!response.ok) {
      throw new SonarError(
        response.status,
        `SonarCloud answered ${response.status}.`,
        await serviceDetail(response, credential.token),
      )
    }

    return (await response.json()) as T
  }

  return { get }
}

/**
 * One client per token, for the length of the process — the same reasoning as
 * `ado.ts`, and here it is the back-off that depends on it: the gate is state
 * *inside* the client, so a client rebuilt per request would walk straight back
 * into the 429 the last one earned.
 */
let cached: { readonly fingerprint: string; readonly client: SonarClient } | null = null

/** Hashed, so the process holds exactly one copy of the token — the one in the client. */
const fingerprintOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/** Throws `SonarNotConnectedError` when no Sonar token is stored. */
export function sonarClient(): SonarClient {
  const credential = readSonarCredential()
  if (credential === null) throw new SonarNotConnectedError()

  const fingerprint = fingerprintOf(credential.token)
  if (cached?.fingerprint !== fingerprint) {
    cached = { fingerprint, client: createSonarClient(credential) }
  }

  return cached.client
}

// ---------------------------------------------------------------------------
// Which Sonar projects a pull request has — from ADO, with no configuration.
// ---------------------------------------------------------------------------

/**
 * `https://sonarcloud.io/dashboard?id=<projectKey>&pullRequest=<prId>` and
 * nothing else.
 *
 * The host is checked rather than assumed: `projectKey` is interpolated into
 * sonarcloud.io requests below, and a status pointing somewhere else — a
 * self-hosted SonarQube, which this module does not speak to — should yield no
 * project rather than a project queried against the wrong server.
 */
function projectRef(targetUrl: string | undefined): SonarProjectRef | null {
  if (typeof targetUrl !== 'string') return null

  let url: URL
  try {
    url = new URL(targetUrl)
  } catch {
    return null
  }
  if (url.hostname !== 'sonarcloud.io') return null

  const projectKey = url.searchParams.get('id')
  const pullRequest = url.searchParams.get('pullRequest')
  if (projectKey === null || projectKey === '' || pullRequest === null || pullRequest === '') {
    return null
  }

  return { projectKey, pullRequest, dashboardUrl: targetUrl }
}

/**
 * Every Sonar project this pull request has, deduplicated by key.
 *
 * Two facts do the work here. A repository can map to **several** Sonar
 * projects — !24804 posted `quality_gate_profisee_platform_reactlibrary`
 * alongside its build statuses, and the multi-project repositories post one
 * status each — so this returns a list and the caller queries all of it. And a
 * project posts its status *again* on each iteration: !24804 carried six
 * `SonarCloud` statuses, !24798 two, all for one project. Deduplicating is what
 * keeps a six-update pull request from making six identical issues calls.
 *
 * Later statuses win, because a re-analysed pull request posts a fresh status
 * rather than editing the old one.
 */
export function sonarProjects(statuses: readonly AdoStatus[]): readonly SonarProjectRef[] {
  const found = new Map<string, SonarProjectRef>()

  for (const status of statuses) {
    if (status.context?.genre !== SONAR_GENRE) continue

    const ref = projectRef(status.targetUrl)
    if (ref !== null) found.set(ref.projectKey, ref)
  }

  return [...found.values()]
}

/**
 * The statuses call, which is this module's only ADO request.
 *
 * It goes through `AdoClient` like everything else — the throttle gate and note
 * 4's redirect handling are properties of the transport, and a call that skips
 * them is a call that can read a sign-in page as an empty status list.
 */
export async function loadSonarProjects(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<readonly SonarProjectRef[]> {
  const result = await client.get<{ value?: readonly AdoStatus[] }>(
    `${ref.projectId}/_apis/git/repositories/${ref.repositoryId}/pullRequests/${ref.id}/statuses`,
  )

  return sonarProjects(result.value ?? [])
}

// ---------------------------------------------------------------------------
// Findings.
// ---------------------------------------------------------------------------

const impacts = (
  raw: readonly { readonly softwareQuality?: string; readonly severity?: string }[] | undefined,
): readonly SonarImpact[] =>
  (raw ?? [])
    .filter(
      (impact): impact is { softwareQuality: string; severity: SonarSeverity } =>
        typeof impact.softwareQuality === 'string' &&
        SEVERITY_ORDER.includes(impact.severity as SonarSeverity),
    )
    .map((impact) => ({
      softwareQuality: impact.softwareQuality as SonarImpact['softwareQuality'],
      severity: impact.severity,
    }))

/**
 * `textRange`, never `line`.
 *
 * `line` was present on 4/4 open issues and **absent on 3/3 fixed** ones, while
 * `textRange` was present on all 7 — so the field a naive anchor reads is
 * exactly the field the API drops. Where both existed they agreed on 4 of 4,
 * which is why there is nothing to reconcile: `line` carries no information
 * `startLine` does not.
 */
function textRange(raw: SonarIssue['textRange']): SonarTextRange | null {
  if (raw === undefined || typeof raw.startLine !== 'number') return null

  return {
    startLine: raw.startLine,
    endLine: typeof raw.endLine === 'number' ? raw.endLine : raw.startLine,
    startOffset: typeof raw.startOffset === 'number' ? raw.startOffset : null,
    endOffset: typeof raw.endOffset === 'number' ? raw.endOffset : null,
  }
}

/**
 * `component` → the path the changed-file list uses.
 *
 * Two steps, and both are needed. The `components[]` block is the authority —
 * it carries `path` as its own field, so nothing has to guess where the project
 * key stops. But it only describes components the response mentions, so the
 * split on the first `:` stays as a fallback rather than as the primary
 * reading: `profisee_rest-api:Gateway.Api/Services/Portal/AccountsService.cs`
 * has exactly one, and a project key cannot contain one.
 *
 * Then the leading slash, because ADO's `filePath` and `item.path` both arrive
 * with one and Sonar sends none. One side normalises; the comparison is then
 * plain equality rather than a helper every call site has to remember.
 */
function findingPath(component: string | undefined, paths: ReadonlyMap<string, string>): string | null {
  if (component === undefined || component === '') return null

  const known = paths.get(component)
  const colon = component.indexOf(':')
  const raw = known ?? (colon === -1 ? null : component.slice(colon + 1))
  // A project-level issue has no file. None were sampled; the panel must not
  // crash on the first one.
  if (raw === null || raw === '') return null

  return raw.startsWith('/') ? raw : `/${raw}`
}

/**
 * A deep link to one issue. **Constructed, not measured** — the probes were API
 * calls only and never visited a UI URL, so this is the documented shape rather
 * than an observed one. `SonarProjectRef.dashboardUrl` is the measured link, and
 * it is the one to fall back on if this ever lands somewhere unhelpful.
 */
const issueUrl = (project: SonarProjectRef, key: string): string => {
  const url = new URL(`${SONAR}/project/issues`)
  url.searchParams.set('id', project.projectKey)
  url.searchParams.set('pullRequest', project.pullRequest)
  url.searchParams.set('open', key)

  return url.toString()
}

interface ProjectIssues {
  readonly findings: readonly SonarFinding[]
  /**
   * Sonar's organization, read off the issues rather than configured. Every
   * issue carries it, and the `rules` call cannot be made without it.
   */
  readonly organization: string | null
}

async function loadIssues(client: SonarClient, project: SonarProjectRef): Promise<ProjectIssues> {
  const response = await client.get<SonarIssuesResponse>('api/issues/search', {
    // `componentKeys`, not `components`: the latter answers 400 on Cloud
    // ("At least one of the following parameters must be specified…"), which is
    // a confusing way to be told the parameter name is wrong.
    componentKeys: project.projectKey,
    pullRequest: project.pullRequest,
    issueStatuses: OPEN_STATUSES,
    // One page. The ceiling is hard — `ps=501` answers 400 `'ps' value (501)
    // must be less than 500` — and 500 is well past the 300 findings this
    // project exists for. A pull request with more than 500 open findings is
    // knowingly unhandled rather than accidentally so.
    ps: SONAR_PAGE_SIZE,
    // What produced the `components[]` block `findingPath` reads. Measured 200
    // on every probe pass that asked for it.
    additionalFields: '_all',
  })

  const paths = new Map<string, string>()
  for (const component of response.components ?? []) {
    if (typeof component.key === 'string' && typeof component.path === 'string') {
      paths.set(component.key, component.path)
    }
  }

  const findings = (response.issues ?? [])
    .filter((issue): issue is SonarIssue & { key: string; rule: string } =>
      typeof issue.key === 'string' && typeof issue.rule === 'string',
    )
    .map((issue) => ({
      key: issue.key,
      rule: issue.rule,
      message: issue.message ?? '',
      path: findingPath(issue.component, paths),
      textRange: textRange(issue.textRange),
      // We asked for open statuses, so a missing or unrecognised one is Sonar
      // answering something we did not model — reported as `OPEN` because that
      // is what the filter means, not because the field was believed.
      status: (ISSUE_STATUSES.has(issue.issueStatus ?? '') ? issue.issueStatus : 'OPEN') as IssueStatus,
      impacts: impacts(issue.impacts),
      cleanCodeAttributeCategory: issue.cleanCodeAttributeCategory ?? null,
      effort: issue.effort ?? null,
      tags: issue.tags ?? [],
      url: issueUrl(project, issue.key),
    }))

  const organization = (response.issues ?? []).find(
    (issue) => typeof issue.organization === 'string' && issue.organization !== '',
  )?.organization

  return { findings, organization: organization ?? null }
}

/** Worst impact in the group, for the badge. `null` when nothing declared one. */
function worstSeverity(findings: readonly SonarFinding[]): SonarSeverity | null {
  let worst: number | null = null

  for (const finding of findings) {
    for (const impact of finding.impacts) {
      const rank = SEVERITY_ORDER.indexOf(impact.severity)
      if (rank !== -1 && (worst === null || rank < worst)) worst = rank
    }
  }

  return worst === null ? null : SEVERITY_ORDER[worst]
}

/**
 * Grouped by rule, count descending — done here rather than in a component
 * because "count descending" is a fact about the whole list, and a component
 * that groups is a component that re-groups on every render.
 *
 * Ties break on the rule key. Insertion order would work too, but it is really
 * *fetch* order, so two projects answering in a different sequence would
 * reorder a panel that had not changed.
 */
function toGroups(
  findings: readonly SonarFinding[],
  names: ReadonlyMap<string, string>,
): readonly RuleGroup[] {
  const byRule = new Map<string, SonarFinding[]>()

  for (const finding of findings) {
    const group = byRule.get(finding.rule)
    if (group === undefined) byRule.set(finding.rule, [finding])
    else group.push(finding)
  }

  return [...byRule.entries()]
    .map(([rule, group]) => ({
      rule,
      // `null`, not the key: `external_roslyn:CA1861` was requested and simply
      // not returned, because externally-imported analyser rules are not in
      // Sonar's rule repository. The panel shows the bare key; this layer does
      // not invent a name for it.
      name: names.get(rule) ?? null,
      severity: worstSeverity(group),
      findings: group,
    }))
    .sort((a, b) => b.findings.length - a.findings.length || a.rule.localeCompare(b.rule))
}

// ---------------------------------------------------------------------------
// Rules.
// ---------------------------------------------------------------------------

/** `SECTION_ORDER` first, then anything the API invents later, in arrival order. */
function sections(
  raw: NonNullable<SonarRuleResponse['rules']>[number]['descriptionSections'],
): readonly RuleSection[] {
  const rank = (key: string): number => {
    const index = SECTION_ORDER.indexOf(key)

    return index === -1 ? SECTION_ORDER.length : index
  }

  return (raw ?? [])
    .flatMap((section, index) => {
      if (typeof section.key !== 'string') return []

      const context = section.context
      const ordered: { readonly index: number; readonly section: RuleSection } = {
        index,
        section: {
          key: section.key,
          content: section.content ?? '',
          context:
            typeof context?.key === 'string'
              ? { key: context.key, displayName: context.displayName ?? '' }
              : null,
        },
      }

      return [ordered]
    })
    // Arrival order breaks a tie, so two sections the API invents later keep the
    // sequence it sent them in.
    .sort((a, b) => rank(a.section.key) - rank(b.section.key) || a.index - b.index)
    .map(({ section }) => section)
}

/**
 * Every rule in the pull request, in **one** call.
 *
 * `rule_keys` plural: the singular `rule_key` is not an error, it answers
 * `total: 0`, so the wrong parameter reads as "no such rules" rather than as a
 * mistake. 100 keys in one request cost 177–425 ms, so there is no batching
 * threshold worth writing.
 *
 * Unknown keys are skipped rather than erroring, which is why the caller works
 * from what came back instead of from what it asked for.
 */
async function loadRules(
  client: SonarClient,
  organization: string,
  keys: readonly string[],
): Promise<readonly SonarRule[]> {
  const response = await client.get<SonarRuleResponse>('api/rules/search', {
    rule_keys: keys.join(','),
    // Mandatory. Without it every `rules` request answers 400 `The
    // 'organization' parameter is missing`, which made the endpoint look dead
    // for an entire probe pass.
    organization,
    f: RULE_FIELDS,
    ps: SONAR_PAGE_SIZE,
  })

  return (response.rules ?? []).flatMap((rule) => {
    if (typeof rule.key !== 'string') return []

    const parsed: SonarRule = {
      key: rule.key,
      name: rule.name ?? rule.key,
      // `langName` is the readable one (`C#`); `lang` is the analyser's own
      // (`cs`), kept as the fallback rather than the choice.
      language: rule.langName ?? rule.lang ?? null,
      impacts: impacts(rule.impacts),
      cleanCodeAttribute: rule.cleanCodeAttribute ?? null,
      sections: sections(rule.descriptionSections),
      html: rule.htmlDesc ?? null,
      tags: rule.sysTags ?? [],
    }

    return [parsed]
  })
}

// ---------------------------------------------------------------------------
// The quality gate.
// ---------------------------------------------------------------------------

const gateStatus = (raw: string | undefined): GateStatus =>
  // Anything unrecognised becomes `NONE` rather than being cast into the union:
  // Sonar's old `WARN` is gone, and reporting an unknown verdict as a pass or a
  // failure would be inventing an answer.
  GATE_STATUSES.has(raw ?? '') ? (raw as GateStatus) : 'NONE'

/** Stable partition. A failing condition is what the panel leads with. */
const failingFirst = (conditions: readonly GateCondition[]): readonly GateCondition[] => [
  ...conditions.filter((condition) => condition.status !== 'OK'),
  ...conditions.filter((condition) => condition.status === 'OK'),
]

async function loadGate(client: SonarClient, project: SonarProjectRef): Promise<QualityGate> {
  const response = await client.get<SonarGateResponse>('api/qualitygates/project_status', {
    projectKey: project.projectKey,
    pullRequest: project.pullRequest,
  })

  const conditions = (response.projectStatus?.conditions ?? []).map((condition) => ({
    metricKey: condition.metricKey ?? '',
    comparator: condition.comparator ?? '',
    errorThreshold: condition.errorThreshold ?? '',
    // Strings on the wire — `"100.0"` for a percentage, `"1"` for a rating —
    // and displayed verbatim. Parsing them would only lose the formatting Sonar
    // already chose.
    actualValue: condition.actualValue ?? '',
    status: gateStatus(condition.status),
  }))

  return { status: gateStatus(response.projectStatus?.status), conditions: failingFirst(conditions) }
}

/**
 * Several projects, one gate, because `SonarReport.gate` is one gate.
 *
 * A repository with two Sonar projects has two verdicts and the contract has
 * room for one, so they merge: any `ERROR` makes the whole thing an `ERROR` —
 * the pull request is blocked either way — and the conditions concatenate with
 * the failing ones first. What is lost is *which project* a condition came from,
 * and `GateCondition` has no field for it; on the sampled repositories every
 * multi-project pull request had exactly one Sonar status, so this is a
 * correctness floor rather than an everyday display.
 */
function mergeGates(gates: readonly QualityGate[]): QualityGate | null {
  if (gates.length === 0) return null

  const status: GateStatus = gates.some((gate) => gate.status === 'ERROR')
    ? 'ERROR'
    : gates.some((gate) => gate.status === 'OK')
      ? 'OK'
      : 'NONE'

  return { status, conditions: failingFirst(gates.flatMap((gate) => [...gate.conditions])) }
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const backedOff = (error: unknown): boolean =>
  error instanceof SonarError && error.status === 429

/**
 * Everything Sonar says about one pull request: two calls per project, then one
 * for every rule in all of them.
 *
 * **Sequential on purpose**, which is the one place this differs from the ADO
 * side's fan-out. The 429 gate only protects anything if the next request has
 * not already left, and Sonar gives no budget to spend concurrency against —
 * four calls at 300–800 ms each is a cost worth paying for a back-off that
 * actually holds.
 *
 * A project that fails is named in `failed` rather than throwing the report
 * away: partial failure is the normal case for a multi-project repository, and a
 * panel that shows three projects and silently omits the fourth is worse than
 * one that says what it lost.
 */
export async function loadSonarReport(
  client: SonarClient,
  projects: readonly SonarProjectRef[],
): Promise<SonarPullRequestReport> {
  const findings: SonarFinding[] = []
  const gates: QualityGate[] = []
  const failed: { projectKey: string; message: string }[] = []
  let organization: string | null = null

  for (const project of projects) {
    let lostToBackOff = false

    try {
      const issues = await loadIssues(client, project)
      findings.push(...issues.findings)
      organization ??= issues.organization
    } catch (error) {
      failed.push({ projectKey: project.projectKey, message: message(error) })
      lostToBackOff = backedOff(error)
    }

    // The gate is asked for even when the issues failed — they are two
    // independent answers and a gate is useful without a finding list. The one
    // exception is a back-off, where the client is closed to every further
    // request and asking would only manufacture a second identical failure.
    if (lostToBackOff) continue

    try {
      gates.push(await loadGate(client, project))
    } catch (error) {
      failed.push({
        projectKey: project.projectKey,
        message: `the quality gate could not be read: ${message(error)}`,
      })
    }
  }

  const keys = [...new Set(findings.map((finding) => finding.rule))]
  // No organization means no `rules` call: it is mandatory, and sending the
  // request without it would spend a round trip to be told so. With no findings
  // there is nothing to describe anyway.
  const rules =
    organization === null || keys.length === 0
      ? []
      : await loadRules(client, organization, keys).catch(() => [])
  const names = new Map(rules.map((rule) => [rule.key, rule.name]))

  return {
    report: {
      projects,
      groups: toGroups(findings, names),
      gate: mergeGates(gates),
      failed,
    },
    // A failed rules call costs names and descriptions, not findings — so it is
    // swallowed above rather than added to `failed`, which is per project and
    // this call is not.
    rules,
  }
}
