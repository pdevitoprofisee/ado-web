import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  HelpCircleIcon,
  MinusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useState } from 'react'

import { BuildDetail } from './detail'
import { Empty, Failed } from '@/components/notes'
import { useChecks } from '@/lib/checks'
import { cn } from '@/lib/utils'

import type { IconSvgElement } from '@hugeicons/react'
import type { BuildRun, CheckSummary, EvaluationStatus } from '@/lib/checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// Why the build failed, on the page.
//
// The Policies checklist above this already says *that* a build policy is not
// met. This panel is the next question, and the one the app exists for: which
// step broke, what it printed, and which tests went red. Nothing here repeats the
// checklist's verdicts for their own sake — a row is only worth drawing because it
// can be opened.
//
// **This component fetches its own data**, unlike `SonarPanel` beside it, which
// takes a report as props. The difference is the second read: opening a row costs
// five or six ADO calls and up to 200 KB, so the fetch has to happen where the
// disclosure is, and a panel that owned half its reads and was handed the other
// half would be harder to follow than one that owns both. The wiring is therefore
// one line — `<ChecksPanel prRef={prRef} />` — and no plumbing in the route.

/**
 * ADO's evaluation vocabulary in English, the checklist's wording.
 *
 * `queued` is "not yet met" and not "queued" for `POLICY_WORDS`' reason: on a
 * build policy it means the policy is unsatisfied, which is not the same as a
 * build waiting for an agent — and 35 of 150 sampled evaluations said it.
 */
const STATUS_WORDS: Record<EvaluationStatus, string> = {
  approved: 'passed',
  rejected: 'failed',
  queued: 'not yet met',
  running: 'running',
  broken: 'broken',
  notApplicable: 'not applicable',
}

function Glyph({ icon, className }: { icon: IconSvgElement; className: string }) {
  return <HugeiconsIcon icon={icon} size={14} className={cn('shrink-0', className)} aria-hidden />
}

/**
 * The verdict as a mark, drawn the way the policy checklist draws it.
 *
 * Deliberately the same four glyphs and the same pens: a reviewer reads the
 * checklist and this panel in one glance, and two vocabularies for one fact would
 * be two things to learn. **The colour is never the only channel** — the word is
 * printed at the end of every row, and the glyph differs in shape as well as in
 * pen.
 */
function StatusIcon({ status }: { status: EvaluationStatus }) {
  switch (status) {
    case 'approved':
      return <Glyph icon={Tick02Icon} className="text-pen-green" />
    case 'rejected':
    case 'broken':
      return <Glyph icon={Cancel01Icon} className="text-destructive" />
    case 'queued':
    case 'running':
      return <Glyph icon={Clock01Icon} className="text-pen-amber" />
    case 'notApplicable':
      return <Glyph icon={MinusSignIcon} className="text-ink-300" />
    default:
      return <Glyph icon={HelpCircleIcon} className="text-muted-foreground" />
  }
}

/**
 * `9m 25s`, from milliseconds.
 *
 * The 14 sampled builds ran 31 s to 875 s, so both halves are needed and neither
 * is ever hours. Seconds are kept under a minute because "0m" for a 31-second
 * build reads as a build that did not run.
 */
export function duration(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)

  return minutes === 0 ? `${total}s` : `${minutes}m ${total % 60}s`
}

/** What a build says about itself in the row's right-hand column. */
function buildWords(build: BuildRun): string {
  if (build.status !== 'completed') return build.status === 'inProgress' ? 'running' : build.status
  if (build.result === null) return 'finished'

  return build.result
}

/**
 * Whether a row opens itself.
 *
 * Opening a row is not a render, it is a request — five or six ADO calls and up to
 * 200 KB — so a panel that opened all five build policies on mount would spend
 * thirty calls drawing a list. But a build that failed is the one thing this whole
 * panel exists to explain, and making the reader click to find out which step broke
 * is making them ask twice. So: the ones with news open, and the rest stay one line.
 *
 * A passing build is therefore never fetched at all, and neither is a `notStarted`
 * one — a queued build has an empty timeline and nothing to say.
 */
const opensItself = (build: BuildRun): boolean =>
  build.status === 'inProgress' || (build.status === 'completed' && build.result !== 'succeeded')

/**
 * One check: its verdict, and — when it has a build — what happened inside it.
 *
 * The open state is seeded once, on the render where the row first appears, and is
 * the reader's from then on: a poll that turns a running build into a failed one
 * must not reopen a row somebody has just closed.
 */
function CheckRow({
  prRef,
  check,
  build,
  loadFailure,
}: {
  prRef: PullRequestRef
  check: CheckSummary
  /** The build behind this check, or `null` when there is none or it would not load. */
  build: BuildRun | undefined
  /** What went wrong reading *this* row's build, or `null`. */
  loadFailure: string | null
}) {
  const [open, setOpen] = useState(() => build !== undefined && opensItself(build))
  const panelId = `check-detail-${check.id}`

  // Only when both ends are known: `finishTime` is *absent* on a build that has
  // not finished (0 of 6 measured), so there is no elapsed time to show for one
  // that is still going — only that it is going.
  const ran =
    build?.startedAt == null || build.finishedAt == null
      ? null
      : duration(Date.parse(build.finishedAt) - Date.parse(build.startedAt))

  const title = (
    <>
      <StatusIcon status={check.status} />
      <span className="min-w-0 flex-1 truncate">
        {check.name}
        {build === undefined ? null : (
          // The build number, not the id: `1.0.0.84` is what the pipeline calls
          // this run and what a colleague will quote at you. Mono because it is a
          // figure.
          <span className="text-muted-foreground font-mono text-2xs"> {build.number}</span>
        )}
      </span>
      {ran === null ? null : (
        <span className="text-muted-foreground shrink-0 font-mono text-2xs">{ran}</span>
      )}
      <span className="text-muted-foreground w-28 shrink-0 text-right font-mono text-2xs">
        {build === undefined ? STATUS_WORDS[check.status] : buildWords(build)}
      </span>
    </>
  )

  return (
    <li className="border-border border-b last:border-b-0">
      {build === undefined ? (
        // Nothing to open: either the policy has not queued a build yet (measured
        // on 35 of 150 evaluations) or its build would not load, which is said
        // underneath rather than swallowed.
        <div className="flex items-baseline gap-2 px-2 py-1 text-sm">{title}</div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="hover:bg-muted flex w-full items-baseline gap-2 px-2 py-1 text-left text-sm"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            size={14}
            className="shrink-0 self-center"
            aria-hidden
          />
          {title}
        </button>
      )}

      {loadFailure === null ? null : (
        <p className="text-destructive px-2 pb-1 text-2xs">
          Could not read this check&rsquo;s build. {loadFailure}
        </p>
      )}

      {/* Mounted only while open, which is what makes the second read on demand:
          the detail's `useQuery` lives inside this component. */}
      {open && build !== undefined ? (
        <div id={panelId} className="px-2 pb-2">
          <BuildDetail prRef={prRef} check={check} build={build} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * The pull request's build checks, and why any of them failed.
 *
 * Build policies only. Statuses are not in here at all — 0 of 286 sampled
 * statuses carried a build id, so a status can be drawn as a verdict and never as
 * a build, and the Policies checklist above already draws verdicts. Non-build
 * policies are dropped server-side for the same reason.
 */
export function ChecksPanel({ prRef }: { prRef: PullRequestRef }) {
  const checks = useChecks(prRef)

  // The whole app is disconnected, and the page above this has already said so in
  // a place with room to explain it.
  if (!checks.connected) return null

  const failures = new Map(checks.failed.map((failure) => [failure.checkId, failure.message]))
  // The count is a claim, so it is only made when the read that produces it
  // happened: "Checks 0" printed beside "could not read the build policies" reads as
  // a pull request with no policies on it, which is the opposite of what is known.
  const counted = checks.error === null && checks.errors.checks === null

  return (
    <section className="w-full" aria-label="Checks">
      <h2
        aria-label={counted ? `Checks, ${checks.checks.length}` : undefined}
        className="annotation text-ink mb-1.5 flex items-baseline gap-2"
      >
        Checks
        {counted ? <span className="tabular-nums">{checks.checks.length}</span> : null}
      </h2>

      <div className="flex w-full flex-col gap-2">
        {/* Failed → Empty → content, the order every section on this page reads
            in. `errors.checks` is the policy call itself having failed, which is
            the one failure that leaves nothing to draw. */}
        {checks.error !== null ? (
          <Failed>Could not read the checks on this pull request. {checks.error}</Failed>
        ) : checks.errors.checks !== null ? (
          <Failed>Could not read the build policies. {checks.errors.checks}</Failed>
        ) : checks.pending ? (
          <p className="text-muted-foreground text-xs">Reading the builds…</p>
        ) : checks.checks.length === 0 ? (
          <Empty>No build policy has run on this pull request.</Empty>
        ) : (
          <>
            {/* Every build read failing is a fact about the build API, not about
                any one row — the rows say their own piece as well. */}
            {checks.errors.builds === null ? null : (
              <Failed>Could not read any of this pull request&rsquo;s builds.</Failed>
            )}
            <ul aria-label="Build checks" className="sketch-box sketch-box--quiet w-full">
              {checks.checks.map((check) => (
                <CheckRow
                  key={check.id}
                  prRef={prRef}
                  check={check}
                  build={check.build === null ? undefined : checks.builds.get(check.build.buildId)}
                  loadFailure={failures.get(check.id) ?? null}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
