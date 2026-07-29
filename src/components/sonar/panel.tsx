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

/**
 * The same chip `pr-detail.tsx` gives the little words that qualify a row.
 *
 * Deliberately the same mark and not an import: that one is private to that
 * module, this one takes an arbitrary tone string rather than one named tone, and
 * the note above `Empty` already says what to do the first time a third section
 * wants any of this. `.annotation` carries the type — tiny mono, uppercase,
 * 0.08em tracking, secondary ink — which is what the hand-rolled
 * `text-[10px] uppercase` was reaching for, and the 1.5px pen in construction ink
 * is Prof's weight for a mark that qualifies a row without outdrawing it.
 */
function Chip({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span
      // `shrink-0` because every use of this is a flex item beside text that is
      // allowed to give way: a chip that shrinks wraps "not in this diff" into
      // four lines and takes the row's height with it.
      className={cn(
        'annotation ml-1.5 shrink-0 rounded-sm border-[1.5px] px-1',
        tone ?? 'border-ink-150',
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
 *
 * **Three bands for five severities, and the alpha is gone from the strokes.**
 * Prof has five pens and a five-step scale is what they look like they are for,
 * but only three of them can carry 11px type on paper: `--pen-red` measures
 * 4.65:1 on the app's sheet, ink 7.9 and secondary ink 4.9, while `--pen-amber`
 * manages 3.39 and `--pen-green` 4.01. Both clear the 3:1 a stroke or an icon
 * owes — `pr-detail` draws its status icons in exactly those two pens — and
 * neither clears the 4.5 a word owes. Buying a fourth step by making "medium"
 * unreadable is not a scale, it is a decoration, and the chip prints the severity
 * as a word anyway: "blocker" and "high" do not need different colours to be
 * told apart, they need to both be red.
 */
const SEVERITY_TONE: Record<SonarSeverity, string> = {
  BLOCKER: 'text-destructive border-destructive',
  HIGH: 'text-destructive border-destructive',
  MEDIUM: 'text-ink border-ink-150',
  LOW: 'text-muted-foreground border-ink-150',
  INFO: 'text-muted-foreground border-ink-150',
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
    // A failed gate is the most consequential sentence on this page, so it is the
    // one place in the panel that gets drawn: the red pen around it and a hatched
    // bar down its margin, built the way `ui/alert.tsx` builds the same mark. A
    // passing gate stays a bare line of text and takes no room, which is the whole
    // reason the passing conditions are not rendered either.
    //
    // No `bg-pen-red-tint` wash under it, tempting as it is. `--pen-red` measures
    // 4.65:1 on this sheet and 4.08 on its own tint, and the failing rows below
    // print their actual values in that pen — the wash would take the numbers the
    // gate exists to show from clearing AA to failing it. The hatch does the
    // shouting; the pen stays readable.
    //
    // `.sketch-underline` under the verdict word was the other candidate and is
    // one mark too many: the bar already says "look here", and an 8px underline
    // inside a bordered block is a second voice saying the same thing.
    <div
      className={cn(
        'w-full',
        gate.status === 'ERROR' &&
          'border-destructive relative overflow-hidden rounded-lg border-[1.5px] py-2 pr-2.5 pl-4 before:absolute before:inset-y-0 before:left-0 before:w-1.5 before:bg-[image:var(--hatch-red)]',
      )}
    >
      <p className="text-sm">
        Quality gate{' '}
        <span className={cn(gate.status === 'ERROR' ? 'text-destructive font-medium' : undefined)}>
          {GATE_WORDS[gate.status]}
        </span>
      </p>
      {failing.length === 0 ? null : (
        // No box of its own: it is already inside one. Rows divided by the line at
        // full strength — `/60` was tuned against a dark app and is nothing at all
        // against warm paper — and not by `.sketch-rule`, which costs 6px a
        // boundary and would double the height of a four-condition gate.
        <ul aria-label="Failing conditions" className="mt-1 w-full">
          {failing.map((condition) => (
            <li
              key={condition.metricKey}
              className="border-border flex items-baseline gap-2 border-b px-2 py-1 text-sm last:border-b-0"
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
 * The one message a whole group shares, or `null` when its rows differ.
 *
 * Sonar's message is per-issue, but for a great many rules it is a constant: all
 * four `external_roslyn:IDE0058` findings on one measured pull request read
 * "Expression value is never used", and printing that sentence four times down a
 * squeezed column spends the panel's width saying nothing. Said once, the
 * occurrences get to be what they actually are — a list of places.
 *
 * Two or more, because a lone finding has nothing to share the message with:
 * hoisting it would move one sentence up by one line and cost a branch.
 */
function sharedMessage(findings: readonly SonarFinding[]): string | null {
  if (findings.length < 2) return null

  const [first, ...rest] = findings

  return rest.every((finding) => finding.message === first.message) ? first.message : null
}

/**
 * `directory/name:line`, with the directory giving way and never the name.
 *
 * The rule the file list and the diff header already follow: the end of a
 * 90-column path is the part that says which file this is. Worth stating because
 * the row before this made the whole path `shrink-0` and the message beside it
 * `flex-1 min-w-0` — so on a real ADO path (three directories, `.Tests` in the
 * middle) the path took the row and the sentence wrapped one word per line.
 */
function Locator({ path, line }: { path: string; line: number | null }) {
  const cut = path.lastIndexOf('/')

  return (
    <>
      <span className="text-muted-foreground truncate">{path.slice(0, cut + 1)}</span>
      <span className="shrink-0">
        {path.slice(cut + 1)}
        {line === null ? null : `:${line}`}
      </span>
    </>
  )
}

/**
 * One occurrence: where it is, and the two links out of it.
 *
 * Three shapes, because the data has three: a finding on a file this pull request
 * changed, which is a jump; a finding on a file it did not, which says so rather
 * than scrolling nowhere; and a finding with no file at all, which is a
 * project-level issue — none were sampled, but the contract allows `null` and a
 * panel that assumes a path crashes on the first one instead of skipping it.
 *
 * **The message is a line of its own, not a column.** Two facts of unrelated
 * length — a path and an English sentence — cannot share a row without one of
 * them being crushed, and which one loses is decided by whichever happens to be
 * longer today. Stacked, the path gets the width it needs and the sentence gets
 * the rest of the line; when the group hoists the message above the list, the
 * line simply is not drawn and the row is the compact place-link it should have
 * been all along.
 */
function FindingRow({
  finding,
  changedPaths,
  showMessage,
  onJump,
}: {
  finding: SonarFinding
  changedPaths: ReadonlySet<string>
  /** `false` when the group prints the message once above the list. */
  showMessage: boolean
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
    <li className="border-border border-b px-2 py-1 last:border-b-0">
      {showMessage ? <p className="text-sm">{finding.message}</p> : null}
      {/* Mono for the whole line: it is a path, a duration and a destination —
          every one of them a figure rather than prose. */}
      <div className="flex items-baseline gap-2 font-mono text-xs">
        {path === null || label === null ? (
          <span className="text-muted-foreground min-w-0 flex-1 font-sans">project-level</span>
        ) : changedPaths.has(path) ? (
          // `aria-label` and not the split text: the name is exactly `path:line`
          // for a screen reader and for a test, and an accessible name assembled
          // from two spans is at the mercy of where the accname algorithm decides
          // to put a space. `rounded-sm` so the global focus ring traces sketch
          // corners rather than boxing the filename.
          <button
            type="button"
            onClick={() => onJump({ path, line })}
            aria-label={label}
            title={label}
            className="flex min-w-0 flex-1 items-baseline rounded-sm text-left underline underline-offset-4"
          >
            <Locator path={path} line={line} />
          </button>
        ) : (
          <span title={label} className="text-muted-foreground flex min-w-0 flex-1 items-baseline">
            <Locator path={path} line={line} />
            {/* Sonar analysed a path this pull request did not change, or the line
                drifted after the last push (note 6). Either way there is no panel
                to scroll to, and saying so beats a click that appears broken. */}
            <Chip>not in this diff</Chip>
          </span>
        )}
        {/* Sonar's own estimate, verbatim — nothing parses `"20min"`. */}
        {finding.effort === null ? null : (
          <span className="text-muted-foreground shrink-0">{finding.effort}</span>
        )}
        <a
          href={finding.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground shrink-0 font-sans underline underline-offset-4"
        >
          SonarCloud
        </a>
      </div>
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

  const shared = sharedMessage(group.findings)

  // `name` is null for a rule Sonar's repository does not hold —
  // `external_roslyn:CA1861` was requested and simply not returned, because
  // externally-imported analyser rules are not in it. Then the message every
  // finding agrees on is the best title available: "Expression value is never
  // used" is what `external_roslyn:IDE0058` means, and a reader who has to expand
  // the group to learn that has been told the key twice and the fact once. The
  // bare key stays as the last resort — hiding the group would hide findings the
  // analyser actually reported.
  const title = group.name ?? shared ?? group.rule

  return (
    <li className="border-border border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        // `hover:bg-muted` stays, and deliberately does not become the teal wash
        // the toggles use. Teal means "this is the one you picked"; a pointer
        // resting on a row has picked nothing yet, and spending the accent on
        // hover would leave selection with nothing left to say.
        className="hover:bg-muted flex w-full items-baseline gap-2 px-2 py-1 text-left text-sm"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 self-center" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 self-center" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          {title}
          {/* Only when it is not already the title: a group titled by its own key
              would otherwise print the key twice. */}
          {title === group.rule ? null : (
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
          {/* The message once, when every finding agrees on it and the header is
              not already showing it. A named rule and its message are two
              different sentences — "Methods should not have too many parameters"
              against "Method has 8 parameters, which is greater than the 7
              authorized" — and the second is the one with the number in it. */}
          {shared === null || shared === title ? null : <p className="text-sm">{shared}</p>}
          {/* A sunken well, not a fourth outline. This list is already inside the
              open group, which is inside the panel's bordered list — one more box
              and the occurrences of a rule would be a box in a box in a box.
              Prof's answer to "nested and secondary" is the paper going down a
              step rather than another pen going round it, so: `bg-muted`, the
              sketch radius, and the rows keep their own dividers. */}
          <ul aria-label={`${title} occurrences`} className="bg-muted w-full rounded-lg">
            {group.findings.map((finding) => (
              <FindingRow
                key={finding.key}
                finding={finding}
                changedPaths={changedPaths}
                showMessage={shared === null}
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
        // `.annotation` is exactly what the four utilities here were reaching for
        // — mono at `--text-2xs`, medium, uppercase, 0.08em tracking — and it is
        // what every other section heading in the app now uses, so this matches
        // `Section` in `pr-detail.tsx` rather than approximating it. Ink instead
        // of secondary ink because a section's name is structure, not a caption.
        //
        // The `normal-case` on the project links below still wins: `.annotation`
        // lives in `@layer components` and a utility outranks the whole layer.
        className="annotation text-ink mb-1 flex items-baseline gap-2"
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
          // The panel's one outline, at Prof's construction weight: 1.5px of the
          // quiet line around a sketch-md corner. `rounded-md` was a mechanical
          // 6px, and `/60` on the stroke was tuned against a dark app — on warm
          // paper it thins the only edge this list has to nearly nothing.
          <ul aria-label="Findings by rule" className="border-border w-full rounded-lg border-[1.5px]">
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
