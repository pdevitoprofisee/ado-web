import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { RuleDetail } from './rule-detail'
import { fileAnchor } from '@/lib/file-anchor'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'
import type {
  GateStatus,
  QualityGate,
  RuleGroup,
  SonarFinding,
  SonarReport,
  SonarRule,
  SonarSeverity,
} from '@/lib/sonar-contract'

// What Sonar says about a pull request, on the page.
//
// Findings come from the Sonar API and not from ADO's threads because ADO caps
// Sonar's comments at 50 (note 5) — so on exactly the pull requests where this
// panel matters, the thread version of it is structurally incomplete.
//
// **The seam.** This component takes its data as props and fetches nothing. The
// integrator wires `report` to `src/server/sonar-fn.ts` (T-027's file, which does
// not exist yet) and `rules` to the one batched `rules/search?rule_keys=` call
// that describes every rule in the pull request. Everything else here —
// grouping, count order, the worst impact — is already decided server-side,
// because "count descending" is a fact about the whole list and a component that
// groups is a component that re-groups on every render.

/**
 * "There are none" and "we could not find out" are different facts.
 *
 * Copies of `pr-detail.tsx`'s pair rather than imports of them: they are private
 * to that module today, and this panel is not allowed to reach into it. Worth
 * lifting into one shared place the first time a third section wants them.
 */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

function Failed({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 px-2 py-1.5 text-sm">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  )
}

function Chip({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={cn(
        'ml-1.5 rounded border px-1 text-[10px] uppercase',
        tone ?? 'text-muted-foreground border-border',
      )}
    >
      {children}
    </span>
  )
}

/**
 * Where a click on a finding wants the page to go.
 *
 * `line` is carried even though the default handler cannot use it: the anchor
 * scheme is per-file, and a line-level anchor would be a promise this panel
 * cannot keep. Sonar's line numbers drift from the diff when the branch was
 * pushed to after analysis (note 6), so the honest destination is the file
 * panel, with the line printed on the row that got you there.
 */
export interface SonarJump {
  readonly path: string
  readonly line: number | null
}

/**
 * The default jump: move the page to the file's diff panel.
 *
 * Found by id rather than held as a ref, the same way the file tree does it —
 * the panels are somebody else's children. `scrollIntoView` is optional-chained
 * because jsdom does not implement it, and a missing scroll is not worth a thrown
 * click.
 *
 * **This only lands somewhere when a diff tab is already showing.** The tab strip
 * belongs to `pr-detail.tsx`, so the integrator passes an `onJump` that selects
 * the changes tab and then calls this — which is the whole of the wiring.
 */
export function scrollToFinding(jump: SonarJump): void {
  document.getElementById(fileAnchor(jump.path))?.scrollIntoView?.({ block: 'start' })
}

/**
 * The MQR severities, worst first in tone.
 *
 * `impacts[]` is the authoritative taxonomy — the legacy `severity` and `type`
 * fields still arrive on every issue and are unreliable, and `type` has been
 * removed from the `rules` API's field list outright. The group's badge is the
 * worst impact among its findings, computed where the grouping happens.
 */
const SEVERITY_TONE: Record<SonarSeverity, string> = {
  BLOCKER: 'text-destructive border-destructive/60',
  HIGH: 'text-destructive border-destructive/60',
  MEDIUM: 'text-foreground border-border',
  LOW: 'text-muted-foreground border-border',
  INFO: 'text-muted-foreground border-border',
}

function SeverityBadge({ severity }: { severity: SonarSeverity | null }) {
  // Null when no finding in the group carried an impact. No badge rather than an
  // invented one: "unknown severity" and "low severity" are not the same claim.
  if (severity === null) return null

  return <Chip tone={SEVERITY_TONE[severity]}>{severity.toLowerCase()}</Chip>
}

const GATE_WORDS: Record<GateStatus, string> = {
  OK: 'passed',
  ERROR: 'failed',
  NONE: 'not configured',
}

/** Sonar's comparators, as the symbol the threshold reads with. */
const COMPARATORS: Record<string, string> = {
  GT: '>',
  LT: '<',
  GTE: '≥',
  LTE: '≤',
  EQ: '=',
  NE: '≠',
}

/**
 * The quality gate, and only the conditions that are stopping it.
 *
 * Passing conditions are hidden, not collapsed. The passing gate measured in §5
 * had four of them and every one read `1` against a threshold of `1` — a table
 * that says nothing, above the findings list, on the pull requests where there is
 * nothing to do. What a failing condition is worth is the pair of numbers, so
 * those are what the row is.
 */
function GateSummary({ gate }: { gate: QualityGate }) {
  const failing = gate.conditions.filter((condition) => condition.status !== 'OK')

  return (
    <div className="w-full">
      <p className="text-sm">
        Quality gate{' '}
        <span className={cn(gate.status === 'ERROR' ? 'text-destructive font-medium' : undefined)}>
          {GATE_WORDS[gate.status]}
        </span>
      </p>
      {failing.length === 0 ? null : (
        <ul aria-label="Failing conditions" className="border-border/60 mt-1 w-full rounded-md border">
          {failing.map((condition) => (
            <li
              key={condition.metricKey}
              className="border-border/60 flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0"
            >
              {/* The metric key with its underscores opened out, not a lookup
                  table: the key set is open (`new_*` variants arrive as the gate
                  is edited) and a missing entry would render blank. */}
              <span className="min-w-0 flex-1">{condition.metricKey.replace(/_/g, ' ')}</span>
              <span className="text-destructive shrink-0 tabular-nums">{condition.actualValue}</span>
              <span className="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">
                {COMPARATORS[condition.comparator] ?? condition.comparator} {condition.errorThreshold}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One occurrence.
 *
 * Three shapes, because the data has three: a finding on a file this pull request
 * changed, which is a jump; a finding on a file it did not, which says so rather
 * than scrolling nowhere; and a finding with no file at all, which is a
 * project-level issue — none were sampled, but the contract allows `null` and a
 * panel that assumes a path crashes on the first one instead of skipping it.
 */
function FindingRow({
  finding,
  changedPaths,
  onJump,
}: {
  finding: SonarFinding
  changedPaths: ReadonlySet<string>
  onJump: (jump: SonarJump) => void
}) {
  // A local binding, not `finding.path`, so the narrowing survives into the
  // click handler below.
  const path = finding.path
  // `textRange.startLine`, never `line`: `line` was present on all 4 open issues
  // and absent on all 3 fixed ones, so the field a naive anchor reads is the one
  // the API drops.
  const line = finding.textRange === null ? null : finding.textRange.startLine
  const label = path === null ? null : line === null ? path : `${path}:${line}`

  return (
    <li className="border-border/60 flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0">
      {path === null || label === null ? (
        <span className="text-muted-foreground shrink-0 text-xs">project-level</span>
      ) : changedPaths.has(path) ? (
        <button
          type="button"
          onClick={() => onJump({ path, line })}
          className="shrink-0 font-mono text-xs underline underline-offset-4"
        >
          {label}
        </button>
      ) : (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {label}
          {/* Sonar analysed a path this pull request did not change, or the line
              drifted after the last push (note 6). Either way there is no panel
              to scroll to, and saying so beats a click that appears broken. */}
          <Chip>not in this diff</Chip>
        </span>
      )}
      <span className="min-w-0 flex-1">{finding.message}</span>
      {/* Sonar's own estimate, verbatim — nothing parses `"20min"`. */}
      {finding.effort === null ? null : (
        <span className="text-muted-foreground shrink-0 text-xs">{finding.effort}</span>
      )}
      <a
        href={finding.url}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground shrink-0 text-xs underline underline-offset-4"
      >
        SonarCloud
      </a>
    </li>
  )
}

/**
 * One rule, its count, and — once opened — where it fired and what it means.
 *
 * Shut by default, unlike the file tree's directories. The pull request this
 * project exists for reportedly has 300 Sonar findings; a panel that opens every
 * group renders 300 rows and a rule description each above the diff, and the
 * question the panel answers first is "which rules, how many", not "where".
 */
function GroupRow({
  group,
  rule,
  changedPaths,
  onJump,
}: {
  group: RuleGroup
  /** The rule's description, when Sonar would give one. */
  rule: SonarRule | undefined
  changedPaths: ReadonlySet<string>
  onJump: (jump: SonarJump) => void
}) {
  const [open, setOpen] = useState(false)

  // `name` is null for a rule Sonar's repository does not hold —
  // `external_roslyn:CA1861` was requested and simply not returned, because
  // externally-imported analyser rules are not in it. The bare key is a worse
  // title and a real one; hiding the group would hide findings the analyser
  // actually reported.
  const title = group.name ?? group.rule

  return (
    <li className="border-border/60 border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:bg-muted flex w-full items-baseline gap-2 px-2 py-1 text-left text-sm"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 self-center" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 self-center" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          {title}
          {/* Only when it is not already the title: a group whose name we do not
              have would otherwise print the key twice. */}
          {group.name === null ? null : (
            <span className="text-muted-foreground font-mono text-xs"> {group.rule}</span>
          )}
        </span>
        <SeverityBadge severity={group.severity} />
        <span className="w-8 shrink-0 text-right text-xs tabular-nums">
          {group.findings.length}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-2 pb-2">
          <ul aria-label={`${title} occurrences`} className="border-border/60 w-full rounded-md border">
            {group.findings.map((finding) => (
              <FindingRow
                key={finding.key}
                finding={finding}
                changedPaths={changedPaths}
                onJump={onJump}
              />
            ))}
          </ul>
          {rule === undefined ? (
            <Empty>
              Sonar has no description for {group.rule}. Rules imported from another analyser are
              not in its rule repository.
            </Empty>
          ) : (
            <RuleDetail rule={rule} />
          )}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Everything Sonar says about this pull request, or nothing at all.
 *
 * **Nothing at all is a real state.** A pull request with no SonarCloud status
 * has no Sonar project to ask about, and the panel renders `null` rather than an
 * empty section or an error — most pull requests in this org are in that
 * position, and a permanent "no findings" heading on all of them is noise the
 * page cannot afford above a merge banner.
 */
export function SonarPanel({
  report,
  rules = [],
  changedPaths,
  onJump = scrollToFinding,
}: {
  /**
   * `sonarReport({...})` from `src/server/sonar-fn.ts`. `null` when the pull
   * request has no SonarCloud status — which is not a failure and not an empty
   * report.
   */
  report: SonarReport | null
  /**
   * The rules the batched `rules/search?rule_keys=` call described. An array
   * rather than a `Map` because it crosses a server-function boundary as JSON,
   * and a `Map` does not survive that.
   */
  rules?: readonly SonarRule[]
  /**
   * The paths in the diff the reader is looking at, exactly as ADO spells them —
   * leading slash and all. `SonarFinding.path` is normalised to the same form on
   * the server, so this is plain set membership rather than a comparison.
   */
  changedPaths: ReadonlySet<string>
  /**
   * Where a finding's `file:line` sends the page. Defaults to scrolling to the
   * file's diff panel, which only lands when a diff tab is already showing —
   * see `scrollToFinding`.
   */
  onJump?: (jump: SonarJump) => void
}) {
  const described = useMemo(() => new Map(rules.map((rule) => [rule.key, rule])), [rules])

  if (report === null || report.projects.length === 0) return null

  const total = report.groups.reduce((sum, group) => sum + group.findings.length, 0)

  return (
    <section className="w-full" aria-label="Sonar">
      <h2
        aria-label={`Sonar, ${total}`}
        className="text-muted-foreground mb-1 flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase"
      >
        Sonar
        <span className="tabular-nums">{total}</span>
        {/* One link per project, because a repository can map to several Sonar
            projects and each has its own dashboard. */}
        <span className="ml-auto flex items-baseline gap-2 normal-case">
          {report.projects.map((project) => (
            <a
              key={project.projectKey}
              href={project.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-4"
            >
              {project.projectKey}
            </a>
          ))}
        </span>
      </h2>

      <div className="flex w-full flex-col gap-3">
        {/* Named, one by one. Partial failure is the normal case for a
            multi-project repository — one project's scope or analysis fails while
            the others answer — and a panel that shows four projects' findings and
            silently omits the fifth is worse than one that says which it lost. */}
        {report.failed.length === 0 ? null : (
          <ul aria-label="Projects Sonar could not read" className="w-full">
            {report.failed.map((failure) => (
              <li key={failure.projectKey}>
                <Failed>
                  Could not read {failure.projectKey}&rsquo;s findings. {failure.message}
                </Failed>
              </li>
            ))}
          </ul>
        )}

        {/* The gate and the findings degrade independently: a failed gate call
            leaves the findings list intact, and vice versa. A pull request with a
            Sonar status has a gate, so `null` here is the call having failed. */}
        {report.gate === null ? (
          <Failed>Could not read the quality gate for this pull request.</Failed>
        ) : (
          <GateSummary gate={report.gate} />
        )}

        {report.groups.length === 0 ? (
          <Empty>No open findings. Sonar reported nothing on this pull request.</Empty>
        ) : (
          <ul aria-label="Findings by rule" className="border-border/60 w-full rounded-md border">
            {report.groups.map((group) => (
              <GroupRow
                key={group.rule}
                group={group}
                rule={described.get(group.rule)}
                changedPaths={changedPaths}
                onJump={onJump}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
