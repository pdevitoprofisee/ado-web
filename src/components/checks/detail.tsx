import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, LinkSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useId, useState } from 'react'

import { duration } from './panel'
import { LOG_TAIL_LINES, STACK_TRACE_CHARS } from '@/lib/checks-contract'
import { useCheckDetail, useRequeueCheck, useRetryBuild } from '@/lib/checks'

import type { ReactNode } from 'react'
import type { Rerun } from '@/lib/checks'
import type {
  BuildRun,
  CheckSummary,
  FailedTest,
  LogSlice,
  TestRunSummary,
  TimelineNode,
} from '@/lib/checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// What happened inside one build: the step that broke, what it printed, which
// tests went red, and the three ways to run it again.
//
// Everything here is deliberately narrow. The timeline of a real build holds 20 to
// 40 records and this draws **one** of them, because 34 records on the sampled
// build said `failed` and only 10 were answers — the rest were the Stage, Phase
// and Job containers reporting their children's verdict. The whole tree is in
// `CheckDetail.timeline` and is not rendered: a reviewer opening a failed check is
// asking "what broke", and a 40-row tree answers "everything, four times over".
//
// The log is a tail and not a page, the tests are the failures and never the
// passes, and both say what they left out.

/** A local copy, for the reason `panel.tsx` states. */
function Failed({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 py-1 text-sm">
      <HugeiconsIcon icon={Alert02Icon} size={14} className="shrink-0" aria-hidden />
      {children}
    </p>
  )
}

/**
 * One way to run this again: a control, or the reason there isn't one.
 *
 * A disabled control with no reason beside it is a dead end — the reader is left
 * to guess whether the app is broken or the act is impossible. So the reason is
 * always rendered and is the button's accessible description, and every one of
 * them names something measured rather than "not available".
 */
function Control({
  label,
  rerun,
  reason,
}: {
  label: string
  /** `null` when this granularity cannot act here at all. */
  rerun: Rerun | null
  /** Why it is disabled, or `null` when it is not. */
  reason: string | null
}) {
  const id = useId()
  const disabled = reason !== null || rerun === null || rerun.pending

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <button
        type="button"
        onClick={() => rerun?.ask()}
        disabled={disabled}
        aria-describedby={reason === null ? undefined : id}
        className="text-muted-foreground hover:text-primary self-start text-2xs underline decoration-[1.5px] underline-offset-[3px] disabled:no-underline disabled:opacity-60"
      >
        {rerun?.pending === true ? `${label}…` : label}
      </button>
      {reason === null ? null : (
        <p id={id} className="text-muted-foreground text-2xs">
          {reason}
        </p>
      )}
      {rerun?.error == null ? null : (
        <p className="text-destructive text-2xs">Azure DevOps refused it: {rerun.error}</p>
      )}
    </div>
  )
}

/**
 * The three granularities, in the order they get coarser.
 *
 * **Only the first one has ever been sent to Azure DevOps.** Requeueing a policy
 * is the write `pull-request.ts` already ships and the checklist already performs;
 * retrying a build and retrying a stage are new, written from Microsoft's
 * reference, and unproven — the stored token was only ever proved to hold
 * `vso.build`, so a 403 on the middle one is a realistic first answer and is why
 * `Control` prints what ADO said verbatim.
 *
 * Stage retry ships disabled. `UpdateStageParameters` addresses a stage by its
 * `identifier`, and a sweep of ten pipelines in this organisation found **zero**
 * whose identifier was anything but `__default` — retrying the only stage is
 * retrying the build, so the control would be a second button doing the middle
 * one's job under a different name. It is drawn rather than omitted because the
 * reason is worth reading once, and because the next organisation this app is
 * pointed at may well declare stages.
 */
function Rerun({
  prRef,
  check,
  build,
}: {
  prRef: PullRequestRef
  check: CheckSummary
  build: BuildRun
}) {
  const requeue = useRequeueCheck(prRef, check)
  const retry = useRetryBuild(prRef, prRef.projectId, build.id)

  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      <Control
        label="Requeue the policy"
        rerun={requeue}
        reason={
          check.requeueId !== null
            ? null
            : check.status === 'running'
              ? 'Requeueing cancels the build that is running, which is the answer you are waiting for.'
              : check.status === 'approved'
                ? 'This policy already passed on the current commit.'
                : 'Azure DevOps offers no evaluation to requeue for this check.'
        }
      />
      <Control
        label="Retry the build"
        rerun={retry}
        reason={
          build.status === 'completed'
            ? null
            : 'This build has not finished. There is nothing to retry until it does.'
        }
      />
      <Control
        label="Retry the stage"
        rerun={null}
        reason={'Every pipeline in this organisation declares one stage, __default, so retrying it would retry the whole build.'}
      />
    </div>
  )
}

/**
 * The step that actually broke, and what it said about the source.
 *
 * `sourcePath`/`sourceLine` were on 62 of 95 sampled issues and are the only place
 * a mapping from a compiler error to a file exists — printed rather than linked,
 * because the anchor scheme is per-file and this panel cannot promise the diff tab
 * is showing.
 */
function FailingStep({ step }: { step: TimelineNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        <span className="text-muted-foreground annotation mr-2">broke at</span>
        {step.name}
        {step.durationMs === null ? null : (
          <span className="text-muted-foreground font-mono text-2xs"> {duration(step.durationMs)}</span>
        )}
      </p>
      {step.issues.length === 0 ? null : (
        <ul aria-label="Errors and warnings" className="flex flex-col gap-0.5">
          {step.issues.map((issue, index) => (
            // No id on an issue — the wire form has none — so the index is the key.
            // The list is rebuilt whole on every read and never reordered.
            <li key={index} className="text-sm">
              <span className={issue.type === 'error' ? 'text-destructive' : 'text-pen-amber'}>
                {issue.type}
              </span>{' '}
              {issue.message}
              {issue.sourcePath === null ? null : (
                <span className="text-muted-foreground font-mono text-2xs">
                  {' '}
                  {issue.sourcePath}
                  {issue.sourceLine === null ? null : `:${issue.sourceLine}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Which step a build that has not finished is on.
 *
 * The **deepest** `inProgress` record, not the first: the one in-progress timeline
 * sampled read `completed` ×10 · `pending` ×6 · `inProgress` ×4, and those four are
 * one chain — Stage, Phase, Job, Task — all saying `inProgress` at the same moment.
 * The Stage's name is the pipeline's own and says nothing; the innermost one is the
 * answer to "what is it doing".
 *
 * Neither progress field is read, for the reason `TimelineNode` gives: 8 in-flight
 * records carried a `percentComplete` and the rest did not, and `currentOperation`
 * was `null` on every record ever sampled.
 */
export function runningStep(nodes: readonly TimelineNode[]): TimelineNode | null {
  for (const node of nodes) {
    if (node.state !== 'inProgress') continue

    return runningStep(node.children) ?? node
  }

  return null
}

/**
 * Where the rest of a log is.
 *
 * A link and not a "load more". The panel shows a window of at most 200 lines out
 * of a log that ran to 2727 on the sampled build, and Azure DevOps' own log viewer
 * pages the remainder better than a `<pre>` inside a tab can — so the honest
 * control is the one that leaves. `view=logs` is the build page's log tab; the
 * separator is asked for rather than assumed because `_links.web.href` is a URL we
 * were handed, not one we built.
 */
const logsUrl = (build: BuildRun): string =>
  `${build.webUrl}${build.webUrl.includes('?') ? '&' : '?'}view=logs`

/**
 * Whether lines were withheld.
 *
 * Not `lines.length < totalLines`, which is the obvious rule and is wrong: the two
 * counts disagree by one on a log nothing was withheld from at all — `lineCount`
 * said 47 and the JSON body held 46, because the text form ends in a newline. So
 * the question asked is "was a window applied", and a window is 200 lines: a slice
 * that filled one and belongs to a longer log is a slice with a remainder.
 * `truncated` catches every window that does not start at line 0; this catches the
 * one that does, which happens when the error was reported above the tail.
 */
export const partial = (log: LogSlice): boolean =>
  log.truncated ||
  (log.totalLines !== null &&
    log.lines.length >= LOG_TAIL_LINES &&
    log.totalLines > log.lines.length)

/**
 * What a log slice is showing, said out loud.
 *
 * The one thing this must never do is imply the whole log. A tail is a tail: the
 * largest log on the sampled build was 2727 lines, this fetches 200 of them, and
 * "showing the last 200 of 2727" is the difference between a reader scrolling up
 * for the cause and a reader concluding there wasn't one.
 */
export function logCaption(log: LogSlice): string {
  const shown = log.lines.length

  if (!log.truncated) {
    return log.totalLines === null ? `${shown} lines` : `all ${log.totalLines} lines`
  }
  if (log.totalLines !== null && log.firstLine + shown >= log.totalLines) {
    return `the last ${shown} of ${log.totalLines} lines`
  }

  const first = log.firstLine + 1
  const last = log.firstLine + shown
  const total = log.totalLines === null ? '' : ` of ${log.totalLines}`

  return `lines ${first}–${last}${total}`
}

function Log({ log, build }: { log: LogSlice; build: BuildRun }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="annotation">
        log <span className="normal-case">{logCaption(log)}</span>
      </p>
      {log.lines.length === 0 ? (
        // A log id that does not exist answers 200 with an empty body, and so does
        // a start line past the end. There is no error to report here, only an
        // emptiness to say out loud.
        <p className="text-muted-foreground text-sm">
          Azure DevOps returned nothing for this step&rsquo;s log.
        </p>
      ) : (
        // A `<pre>` that scrolls sideways inside the panel rather than one that
        // takes the page with it: build logs carry 200-column MSBuild lines.
        <pre className="bg-muted max-h-80 w-full overflow-auto rounded-lg p-2 font-mono text-2xs leading-relaxed">
          {log.lines.join('\n')}
        </pre>
      )}
      {/* Only when there is more, and after the log rather than before it: the
          caption already said how much is missing, and a reader who has finished
          the tail is the one who wants the rest. */}
      {partial(log) ? (
        <a
          href={logsUrl(build)}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-primary flex items-center gap-1 self-start text-2xs underline decoration-[1.5px] underline-offset-[3px]"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={12} aria-hidden />
          the whole log in Azure DevOps
        </a>
      ) : null}
    </div>
  )
}

/**
 * One failed test: the name, then the message and the trace once opened.
 *
 * Shut, because 25 stack traces are 25 screens. The message is the signal —
 * `failureType` was `None` on 28 of 28 sampled results, so there is no category to
 * group by and nothing to say about a failure except what it said.
 */
function TestRow({ test }: { test: FailedTest }) {
  const [open, setOpen] = useState(false)
  const panelId = `failed-test-${test.id}`

  return (
    <li className="border-border border-b last:border-b-0">
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{test.name}</span>
        {test.durationMs === null ? null : (
          <span className="text-muted-foreground shrink-0 font-mono text-2xs">
            {duration(test.durationMs)}
          </span>
        )}
      </button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-1 px-2 pb-2">
          {test.assembly === null ? null : (
            <p className="text-muted-foreground font-mono text-2xs">{test.assembly}</p>
          )}
          <p className="text-sm">{test.errorMessage}</p>
          <p className="annotation">
            stack trace{' '}
            <span className="normal-case">
              first {STACK_TRACE_CHARS} characters, and Azure DevOps had already cut it at 4000
            </span>
          </p>
          <pre className="bg-muted max-h-64 w-full overflow-auto rounded-lg p-2 font-mono text-2xs">
            {test.stackTrace}
          </pre>
          <a
            href={test.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary flex items-center gap-1 self-start text-2xs underline decoration-[1.5px] underline-offset-[3px]"
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={12} aria-hidden />
            open in Azure DevOps
          </a>
        </div>
      ) : null}
    </li>
  )
}

/**
 * The failures, and how many of them are not on the screen.
 *
 * **Failed tests only.** A run's passes are never rendered — the sampled build had
 * 39 of them and they are not what anyone opened this for — and the count comes
 * from subtraction, because a run carries `totalTests`, `passedTests`,
 * `notApplicableTests` and `incompleteTests` and no failure count at all.
 *
 * A failed result costs about 7 KB, so the server fetches at most 25 of them. The
 * true total is on the run, and saying "25 of 28" is the whole reason it is
 * carried separately.
 */
function FailedTests({ runs, tests }: { runs: readonly TestRunSummary[]; tests: readonly FailedTest[] }) {
  const total = runs.reduce((sum, run) => sum + run.failed, 0)

  if (total === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <p className="annotation">
        failed tests <span className="tabular-nums">{total}</span>
        {tests.length < total ? (
          <span className="normal-case"> — showing {tests.length}</span>
        ) : null}
      </p>
      <ul aria-label="Failed tests" className="sketch-box sketch-box--quiet w-full">
        {tests.map((test) => (
          <TestRow key={test.id} test={test} />
        ))}
      </ul>
      {runs.map((run) => (
        <a
          key={run.id}
          href={run.webUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-primary self-start text-2xs underline decoration-[1.5px] underline-offset-[3px]"
        >
          {run.name} in Azure DevOps
        </a>
      ))}
    </div>
  )
}

/**
 * One build, opened.
 *
 * The re-run controls are drawn before the detail arrives and stay drawn if it
 * never does: "this build failed and I cannot tell you why" is exactly the moment
 * someone wants to run it again.
 */
export function BuildDetail({
  prRef,
  check,
  build,
}: {
  prRef: PullRequestRef
  check: CheckSummary
  build: BuildRun
}) {
  // Only a build that is still going is worth re-asking about, and the hook stops
  // polling the moment its own answer says `completed`.
  const state = useCheckDetail(prRef.projectId, build.id, build.status !== 'completed')
  const detail = state.detail
  // Asked of the detail's own build and not the row's: the list is a poll behind,
  // and a step that says it is running under a build the detail already calls
  // finished is the one sentence here that could be a lie.
  const running =
    detail === null || detail.build.status === 'completed' ? null : runningStep(detail.timeline)

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 pt-1">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <a
          href={build.webUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-primary flex items-center gap-1 text-2xs underline decoration-[1.5px] underline-offset-[3px]"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={12} aria-hidden />
          build {build.number}
        </a>
        {/* A green check on a build that ran against a merge commit which is no
            longer the tip is the one verdict that misleads a reviewer. Measured on
            2 of 27 evaluations, so it is rare and worth saying. */}
        {check.build?.isNotCurrent === true ? (
          <span className="text-pen-amber text-2xs">
            This build ran on an earlier version of the branch.
          </span>
        ) : null}
      </div>

      <Rerun prRef={prRef} check={check} build={build} />

      {/* `notFound` is asked *before* `error`, and the order is the point: a 404
          sets both — `checks-fn.ts` fills in the message as well as the flag — so
          asking about the error first would print "Azure DevOps answered 404" at a
          reader who is owed "that build has been deleted". The specific fact wins. */}
      {state.notFound ? (
        <p className="text-muted-foreground text-sm">
          Azure DevOps no longer has this build. Retention deletes them.
        </p>
      ) : state.error !== null ? (
        <Failed>Could not read this build. {state.error}</Failed>
      ) : state.pending || detail === null ? (
        <p className="text-muted-foreground text-xs">Reading the build…</p>
      ) : (
        <>
          {/* Four sections that fail independently, so a lost log never costs the
              reader the failing step and a bad afternoon at the test service never
              hides either. */}
          {detail.errors.timeline === null ? null : (
            <Failed>Could not read this build&rsquo;s timeline. {detail.errors.timeline}</Failed>
          )}
          {/* Both of the first two render even when `errors.timeline` is set —
              that field also carries a log that would not read, and a lost log is
              no reason to withhold a step that arrived intact. The guard sits below
              them, where it belongs: it is only the *absence* of a step that cannot
              be reported honestly when the tree never loaded. */}
          {detail.failingStep !== null ? (
            <FailingStep step={detail.failingStep} />
          ) : running !== null ? (
            // Plain text and not a live region: this line is re-rendered every time
            // the poll comes back, and a politeness announcement every few seconds
            // would talk over the reader it is meant to help. Nothing here takes
            // focus either — the row that was opened keeps it.
            <p className="text-sm">
              <span className="text-muted-foreground annotation mr-2">running</span>
              {running.name}
            </p>
          ) : detail.errors.timeline !== null ? null : detail.build.status !== 'completed' ? (
            <p className="text-muted-foreground text-sm">
              No step has started yet. Azure DevOps says this build is {detail.build.status}.
            </p>
          ) : build.result === 'failed' ? (
            <p className="text-muted-foreground text-sm">
              Azure DevOps reported no failing step — the build failed before or after its steps ran.
            </p>
          ) : null}

          {detail.log === null ? null : <Log log={detail.log} build={build} />}

          {detail.errors.tests === null ? null : (
            <Failed>Could not read this build&rsquo;s tests. {detail.errors.tests}</Failed>
          )}
          <FailedTests runs={detail.testRuns} tests={detail.failedTests} />
        </>
      )}
    </div>
  )
}
