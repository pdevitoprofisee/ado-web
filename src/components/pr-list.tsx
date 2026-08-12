import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Alert02Icon,
  AlertDiamondIcon,
  Cancel01Icon,
  Clock01Icon,
  GitCommitIcon,
  GitMergeConflictIcon,
  GitMergeIcon,
  HourglassIcon,
  LinkSquare02Icon,
  Message01Icon,
  MessageDone01Icon,
  RefreshIcon,
  ReloadIcon,
  Tick02Icon,
  UserCheck01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { Avatar } from '@/components/avatar'
import { useCommand } from '@/commands/command-provider'
import { voteWord } from '@/lib/people'
import { groupByRepository } from '@/lib/pr-grouping'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'

import type { ResolveCallout } from '@/lib/pipeline-callout'
import type { RequeueRow } from '@/lib/requeue'
import type { HydrationResult } from '@/server/hydrate'
import type { PullRequestRow, RowReviewer } from '@/server/inbox'

// A list of pull requests as every page draws it — the inbox's two sections and
// the history page's one — plus the keyboard selection that runs across whatever
// sections a page put on screen. Split out of the routes so the list can be
// tested on its own: a route's only other job is fetching.

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
]
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })

/** Age is the column you triage on, so it is relative, not a date. */
export function age(iso: string, now: number = Date.now()): string {
  const elapsed = Date.parse(iso) - now
  if (Number.isNaN(elapsed)) return ''

  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) return relative.format(Math.round(elapsed / ms), unit)
  }

  return 'just now'
}

/** `title` for the mouse, `sr-only` for everything else; the icon carries neither. */
function Badge({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-0.5" title={label}>
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * The rich half of a row.
 *
 * Fixed width and `overflow-hidden`, always rendered — that is the whole trick
 * behind upgrading a row without moving the ones under it. An empty cell of the
 * right size is reserved before the data exists, so badges appear *into* the
 * layout rather than growing it.
 */
function Rich({ row, result }: { row: PullRequestRow; result: HydrationResult | undefined }) {
  const checks = result?.ok === true ? result.data.checks : null
  const ready = result?.ok === true && result.data.readyToMerge

  // `failedBuilds` is a subset of `failed`, so this is everything else that broke.
  const failedOther = checks === null ? 0 : checks.failed - checks.failedBuilds

  // One pen per meaning, and the counts in mono because they are figures: at
  // 8rem wide this column is read as a row of coloured marks, so the colour has
  // to be the message. Red is something wrong, amber is something unfinished,
  // teal is something done, navy is something to look at.
  //
  // 8rem and not the 6rem it started at, because the unmet-policy badge became
  // two. `overflow-hidden` with `justify-end` clips from the *left*, so a row
  // holding every badge at once would have dropped the conflict mark — the one
  // badge here that is free and the one that matters most.
  return (
    <span className="text-muted-foreground flex w-32 shrink-0 items-center justify-end gap-1 overflow-hidden font-mono text-xs tabular-nums">
      {/* Free from the list call, so it is the one badge that never waits. */}
      {row.conflicted ? (
        <Badge label="Merge conflicts">
          <HugeiconsIcon icon={GitMergeConflictIcon} size={12} className="text-destructive" aria-hidden />
        </Badge>
      ) : null}

      {/* Amber, not red: the pull request is not in trouble, our data is. */}
      {result?.ok === false ? (
        <Badge label={`Could not load: ${result.error}`}>
          <HugeiconsIcon icon={Alert02Icon} size={12} className="text-pen-amber" aria-hidden />
        </Badge>
      ) : null}

      {/* The strongest claim this column makes, and the only badge that is about
          what to *do* rather than what happened: nothing we can see is stopping
          this from merging.

          It has to be told apart from the teal tick beside it, which says the
          much weaker "the checks that ran, passed" — so it is a different
          silhouette, not a second tick in a different weight, and the tick is
          suppressed below while this is showing. Two teal marks in a column this
          narrow would read as one emphatic thing rather than two different facts.

          The same teal pen as that tick, though, rather than a colour of its
          own: this column already spends red, amber, teal and navy, and a fifth
          would leave it with no palette left. The merge glyph is also the
          conflict badge's shape in the other pen, which is the right pairing —
          they answer the same question, opposite ways. */}
      {ready ? (
        <Badge label="Ready to merge">
          <HugeiconsIcon icon={GitMergeIcon} size={12} className="text-pen-green" aria-hidden />
        </Badge>
      ) : null}

      {checks && checks.failed > 0 ? (
        /* Split by kind, exactly the way the unmet-policy badge below is, and for
           the same reason one level down the scale: ADO reports a broken build
           and a reviewer who pressed Reject under one status pair, and "2 checks
           failed" does not say whether to go and read a pipeline or go and talk
           to somebody. See `policy-kind.ts` for why the settings decide this.

           **The build is the one mark in this column that is filled, and that is
           the whole point.** Red was already spent here three ways — the conflict
           glyph, the reset glyph, and this — so hue could not make a broken build
           louder than the two marks beside it. Fill against outline can, the way
           marker against pen can on the reviewer faces, and a filled shape is
           read before any of the linework around it. It costs about 12px of the
           128, which this column has since the failure branch and the waiting
           branch are exclusive.

           A build first, and not because more is broken: a rejection is already
           written on the row as a red ring on that reviewer's face, and a build
           that broke is written nowhere else. */
        <>
          {checks.failedBuilds > 0 ? (
            <Badge label={`${checks.failedBuilds} build ${checks.failedBuilds === 1 ? 'check' : 'checks'} failed`}>
              {/* `prof-badge--red` carries the pen, so the glyph takes no colour
                  of its own — and the measurements are `Outcome`'s, not
                  `.prof-badge`'s own 4px/10px, which would stand taller than
                  every other row on the page. */}
              <span className="prof-badge prof-badge--red gap-0.5 px-1.5 py-0.5 text-2xs leading-none">
                <HugeiconsIcon icon={AlertDiamondIcon} size={12} aria-hidden />
                {checks.failedBuilds}
              </span>
            </Badge>
          ) : null}
          {failedOther > 0 ? (
            <Badge label={`${failedOther} ${failedOther === 1 ? 'check' : 'checks'} failed`}>
              <HugeiconsIcon icon={Cancel01Icon} size={12} className="text-destructive" aria-hidden />
              {failedOther}
            </Badge>
          ) : null}
        </>
      ) : checks && checks.running > 0 ? (
        <Badge label={`${checks.running} checks running`}>
          <HugeiconsIcon icon={Clock01Icon} size={12} className="text-pen-amber" aria-hidden />
          {checks.running}
        </Badge>
      ) : checks && checks.waiting > 0 ? (
        /* Both in the same amber pen as the clock above, because it is the same
           "not finished" news — but neither is a clock, because a clock says
           wait and this will resolve itself. `queued` is ADO's word for an
           expired build, a build nobody queued, and a reviewer who has not
           voted, and none of those clear up on their own. Ranked under the clock
           so a pull request with one build running and four policies unmet reads
           as running: that is the one of the two that is about to change.

           Two glyphs and not one, because a single count answered the wrong
           question. "Three policies unmet" does not say whether to go and ask
           somebody or to go and press a button, and those are the only two
           things a reviewer can do about it. The face is the half a person
           clears and the hourglass is the half a machine clears; the split comes
           from the policy settings, per `policy-kind.ts`, so the badge and the
           checklist it links to cannot disagree.

           The face is first because it is the actionable half. Either can be
           absent, and a row where every unmet policy is one kind draws one
           badge — which is the same shape this column had before.

           The hourglass keeps the plain label it always had rather than gaining
           "build": its half is comment requirements and work item links too, and
           the plain wording reads correctly whether or not the face is beside
           it. */
        <>
          {checks.waitingOnPeople > 0 ? (
            <Badge label={`${checks.waitingOnPeople} reviewer policies not satisfied yet`}>
              <HugeiconsIcon icon={UserCheck01Icon} size={12} className="text-pen-amber" aria-hidden />
              {checks.waitingOnPeople}
            </Badge>
          ) : null}
          {checks.waiting > checks.waitingOnPeople ? (
            <Badge label={`${checks.waiting - checks.waitingOnPeople} policies not satisfied yet`}>
              <HugeiconsIcon icon={HourglassIcon} size={12} className="text-pen-amber" aria-hidden />
              {checks.waiting - checks.waitingOnPeople}
            </Badge>
          ) : null}
        </>
      ) : checks && checks.passed > 0 && !ready ? (
        // Not while the ready mark is up: it already implies this, and says more.
        <Badge label="All checks passed">
          <HugeiconsIcon icon={Tick02Icon} size={12} className="text-pen-green" aria-hidden />
        </Badge>
      ) : null}

      {result?.ok === true && result.data.unresolved > 0 ? (
        <Badge label={`${result.data.unresolved} unresolved comments`}>
          <HugeiconsIcon icon={Message01Icon} size={12} className="text-ink" aria-hidden />
          {result.data.unresolved}
        </Badge>
      ) : null}

      {result?.ok === true && result.data.approvalReset ? (
        <Badge label="A push reset your approval">
          <HugeiconsIcon icon={RefreshIcon} size={12} className="text-destructive" aria-hidden />
        </Badge>
      ) : null}
    </span>
  )
}

/**
 * What a closed pull request has instead of a rich cell.
 *
 * It sits in `Rich`'s box, at `Rich`'s width, because a closed PR never
 * hydrates: check state and comment counts are news about work you might still
 * act on, and there is none here. Reserving `Rich`'s width for badges that will
 * never arrive would leave a hole in every row of the page, so the one thing
 * history *does* have to say goes in it.
 *
 * Teal for landed, red for not. On this page the only question a row answers is
 * "did it ship", so the two answers take the two pens the eye already reads as
 * yes and no — red here is not "something is wrong", it is "this did not land".
 * Set to the same measurements as the `draft` pill above rather than to
 * `.prof-badge`'s own 12px/10px, which would make a history row taller than an
 * inbox row.
 */
function Outcome({ closed }: { closed: NonNullable<PullRequestRow['closed']> }) {
  return (
    <span className="flex w-32 shrink-0 items-center justify-end overflow-hidden">
      <span
        className={cn(
          'prof-badge tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase',
          closed.outcome === 'completed' ? 'prof-badge--teal' : 'prof-badge--red',
        )}
      >
        {closed.outcome}
      </span>
    </span>
  )
}

/**
 * How many faces a row draws before it starts counting instead.
 *
 * Three, because the live org runs small review panels once the teams are set
 * aside: 23 of the 150 reviewers measured across 30 pull requests were people.
 * A fourth slot would be reserved on every row of the page to be used by almost
 * none of them.
 */
const FACES = 3

/**
 * Which pen rings a face. `VOTE_TONES` in `pr-detail.tsx` reads the same scale
 * the same way — both approvals teal, because this says one thing: is this
 * person standing between the branch and the target.
 *
 * **The approvals are drawn in marker, and the other votes are not.** Colour
 * alone failed here, and only for the approvals: `--pen-green` is `#00897a` and
 * `--line-strong` is `#105270`, so at pen weight an approved face and a face
 * with no vote are two dark blue-green circles and the eye cannot separate them
 * across a table. `--pen-amber` and `--pen-red` do not have that problem, so
 * they keep pen weight — which leaves thickness carrying one fact, "somebody
 * said yes", and thickness is read before hue. 2.5px is `--stroke-marker`,
 * written literally the way `button.tsx` writes `border-[1.5px]`, because a
 * `length:` arbitrary value is not a Tailwind v4 form.
 *
 * No vote keeps `.prof-avatar`'s own outline. It is the state most reviewers are
 * in on most pull requests, so it is the one that must not draw the eye.
 */
const VOTE_RINGS = new Map<number, string>([
  [10, 'border-[2.5px] border-pen-green'],
  [5, 'border-[2.5px] border-pen-green'],
  [-5, 'border-pen-amber'],
  [-10, 'border-destructive'],
])

/**
 * Who is on the review, as faces.
 *
 * **Teams are dropped, and that is the whole design.** 127 of the 150 reviewers
 * measured on this org are groups, so a column that drew every reviewer would be
 * a row of identical group glyphs on most pull requests — and a group is not
 * somebody you can go and ask. The detail page lists them in full, one click
 * away, which is where a question about a team belongs.
 *
 * Overlapped rather than spaced: the column has to hold three faces in the width
 * a truncated name would have taken, and a review panel is read as a cluster
 * rather than counted. The order is ADO's, so a vote cast between two polls
 * changes a ring and never moves a face.
 */
function Faces({ reviewers }: { reviewers: readonly RowReviewer[] }) {
  const people = reviewers.filter((reviewer) => !reviewer.isContainer)
  const shown = people.slice(0, FACES)
  const rest = people.length - shown.length

  // Rendered even when empty, for `Rich`'s reason: the box is reserved so that a
  // row with reviewers and a row without are the same shape.
  return (
    <span
      // `self-center` because the row is `items-baseline` and these are blobs.
      // A circle sitting on a text baseline hangs below the line.
      className="hidden w-14 shrink-0 items-center self-center md:flex"
      title={people.length === 0 ? undefined : people.map((one) => one.displayName).join(', ')}
    >
      {shown.map((reviewer, at) => (
        <Avatar
          key={reviewer.id}
          href={reviewer.avatarHref}
          name={reviewer.displayName}
          // The overlap is stated by index rather than by a `:not(:first-child)`
          // selector, because `Avatar` takes one class string and nothing else.
          className={cn('size-4 text-2xs', at > 0 && '-ml-1', VOTE_RINGS.get(reviewer.vote))}
        />
      ))}
      {rest > 0 ? <span className="annotation ml-0.5">+{rest}</span> : null}
      {/* The faces are `aria-hidden` by `Avatar`'s own contract, and here there
          is no name written beside them to read instead. */}
      <span className="sr-only">
        {people.length === 0
          ? 'No reviewers'
          : `Reviewers: ${people.map((one) => `${one.displayName} (${voteWord(one.vote)})`).join(', ')}`}
      </span>
    </span>
  )
}

/**
 * A row Azure DevOps sent both of its GUIDs for, and so the only kind a write can
 * be aimed at. Exported because a page that acts on a row has to hold one.
 */
export type AddressableRow = PullRequestRow & { projectId: string; repositoryId: string }

/** Whether the detail route can address this PR: it is keyed by the two GUIDs. */
function addressable(row: PullRequestRow): row is AddressableRow {
  return row.projectId !== null && row.repositoryId !== null
}

/**
 * A control in this table that changes something, rather than going somewhere.
 *
 * Two rows carry one — the Azure Pipelines callout a row can close, and the build
 * policy a row can run again — and both are drawn only where the act applies, so
 * most rows have neither and the button's presence is itself the news.
 *
 * A plain `<button>` and not `Button` from `ui/`, for the same reason the Azure
 * DevOps link beside it is a plain `<a>`: these are 14px glyphs in the gutter of a
 * dense row, and a variant's padding and border would make one of them a control
 * and the other a mark. The same green hover on both, because what they have in
 * common is the thing worth marking: this one writes.
 *
 * A failure is drawn *on the button* — red glyph, message in the `title` — rather
 * than as text in the row. `Rich` reserves its width so a badge cannot move the
 * rows under it, and an error message wide enough to read would move all of them.
 * The message still reaches a screen reader, once, through the alert beside it.
 */
function RowAction({
  icon,
  label,
  run,
}: {
  icon: IconSvgElement
  label: string
  run: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <button
        type="button"
        // Busy is disabled here rather than merely announced: each of these
        // writes is a sequence of one call per thread or per policy, and a second
        // press would start that sequence again over what the first is doing.
        disabled={busy}
        aria-busy={busy || undefined}
        title={error ?? label}
        onClick={() => {
          setBusy(true)
          setError(null)
          void run()
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            )
            .finally(() => setBusy(false))
        }}
        className={cn(
          'flex shrink-0 items-center rounded-sm px-2 disabled:opacity-50',
          error === null ? 'text-muted-foreground hover:text-pen-green' : 'text-destructive',
        )}
      >
        <HugeiconsIcon icon={icon} size={14} aria-hidden />
        <span className="sr-only">{label}</span>
      </button>
      {error === null ? null : (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </>
  )
}

function Row({
  row,
  result,
  isSelected = false,
  onResolveCallout,
  onRequeue,
  onMerge,
}: {
  row: PullRequestRow
  result: HydrationResult | undefined
  isSelected?: boolean
  onResolveCallout?: ResolveCallout
  onRequeue?: RequeueRow
  onMerge?: (row: AddressableRow) => void
}) {
  // Every other column is truncated or hidden at narrow widths, so the
  // accessible name has to carry what the eye might not get — including the
  // outcome, which is otherwise a coloured pill and a relative date.
  const label = `${row.project}/${row.repository} · ${row.author}${row.viaTeam ? ` · via ${row.viaTeam}` : ''}${row.closed ? ` · ${row.closed.outcome}${row.closed.at ? ` ${row.closed.at.slice(0, 10)}` : ''}` : ''}`
  // `rounded-sm` on the link, not just on the row: this is the element the
  // keyboard focuses all day, and Prof's focus ring is a box-shadow that follows
  // whatever radius it finds. On a square link it would be a square ring.
  const columns = 'flex min-w-0 flex-1 items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-sm'
  // Empty on a plain row, on a closed one, and on a row whose hydration failed —
  // all three read the same way here, which is the point of asking the hydration
  // rather than the row.
  const callouts = result?.ok === true ? result.data.pipelineThreads : []
  const requeueable = result?.ok === true ? result.data.requeueIds : []
  const mergeable = result?.ok === true && result.data.readyToMerge
  const body = (
    <>
      <span className="text-muted-foreground w-14 shrink-0 text-right font-mono text-xs tabular-nums">
        {row.id}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {/* Amber is the waiting pen, and a draft is a pull request waiting on its
            own author. Sized to stay inside the row's line box so a draft row is
            not taller than its neighbours. */}
        {row.isDraft ? (
          <span className="prof-badge prof-badge--amber tracking-label mr-1.5 px-1.5 py-0.5 text-2xs leading-none uppercase">
            draft
          </span>
        ) : null}
        {row.title}
      </span>
      {/* Repository and branch are identifiers, so they are set in mono; the
          author is a person and stays in the prose face. */}
      <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-xs sm:block sm:max-w-40">
        {row.repository}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate text-xs md:block md:max-w-32">
        {row.author}
      </span>
      {/* Next to the author, because the pair is the whole question a triage
          pass asks of a row: who wrote it, and who is on the hook to read it. */}
      <Faces reviewers={row.reviewers} />
      <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-xs lg:block lg:max-w-28">
        →{row.targetBranch}
      </span>
      {row.closed ? <Outcome closed={row.closed} /> : <Rich row={row} result={result} />}
      {/* The same column, measuring the thing you triage on. On an open PR that
          is how long it has been waiting; on a closed one it is how long ago it
          stopped, and its creation date is trivia. The exact date goes in the
          `title`, because a history page is the one place someone asks for it. */}
      <span
        className="text-muted-foreground w-16 shrink-0 text-right font-mono text-xs tabular-nums"
        title={row.closed?.at || undefined}
      >
        {age(row.closed ? row.closed.at : row.createdAt)}
      </span>
    </>
  )

  return (
    <li
      // How `useHydration` finds this row in the DOM to measure whether it is
      // above the fold, and how the selection finds it to focus it.
      data-pr-id={row.id}
      aria-current={isSelected ? true : undefined}
      className={cn(
        // Neighbours on one sheet: a quiet drawn division between rows, and the
        // teal wash only where the eye is. The wash is deliberately not a sunken
        // grey — a selected row is the row you are reading, not a hole in the
        // list. No transition on it either: `j`/`k` move the selection faster
        // than a settle would finish, and a trailing highlight lies about where
        // the cursor is.
        'border-border flex border-b last:border-b-0',
        isSelected ? 'bg-accent rounded-sm' : 'hover:bg-accent/50 hover:rounded-sm',
      )}
    >
      {addressable(row) ? (
        <>
          <Link
            to="/pr/$projectId/$repositoryId/$prId"
            params={{
              projectId: row.projectId,
              repositoryId: row.repositoryId,
              prId: String(row.id),
            }}
            className={columns}
            title={label}
          >
            {body}
          </Link>
          {onResolveCallout !== undefined && callouts.length > 0 ? (
            <RowAction
              icon={MessageDone01Icon}
              label={
                callouts.length === 1
                  ? 'Resolve the Azure Pipelines comment'
                  : `Resolve ${callouts.length} Azure Pipelines comments`
              }
              run={() => onResolveCallout(row, callouts)}
            />
          ) : null}
          {/* `ReloadIcon` and not the `RefreshIcon` in the badge column, which
              already means "a push reset your approval" on these same rows. */}
          {onRequeue !== undefined && requeueable.length > 0 ? (
            <RowAction
              icon={ReloadIcon}
              label={
                requeueable.length === 1
                  ? 'Requeue the build policy'
                  : `Requeue ${requeueable.length} build policies`
              }
              run={() => onRequeue(row, requeueable)}
            />
          ) : null}
          {/* Not a `RowAction`: this one writes nothing on its own. It opens the
              page's merge dialog, where the commit message is written and the
              real answer to "may this merge" is asked of the pull request — so
              there is no busy state and no failure to draw here.

              `GitCommitIcon` rather than the `GitMergeIcon` the badge column
              already spends on the ready state, and a squash is one commit. */}
          {onMerge !== undefined && mergeable ? (
            <button
              type="button"
              title={`Squash and merge !${row.id}`}
              onClick={() => onMerge(row)}
              className="text-muted-foreground hover:text-pen-green flex shrink-0 items-center rounded-sm px-2"
            >
              <HugeiconsIcon icon={GitCommitIcon} size={14} aria-hidden />
              <span className="sr-only">Squash and merge</span>
            </button>
          ) : null}
          {/* Demoted, not removed: this app replaces the ADO tab for reading a
              PR, and there will always be something only ADO can do. */}
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            title={`Open !${row.id} in Azure DevOps`}
            className="text-muted-foreground hover:text-teal-600 flex shrink-0 items-center rounded-sm px-2"
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={14} aria-hidden />
            <span className="sr-only">Open in Azure DevOps</span>
          </a>
        </>
      ) : (
        // ADO answered without the GUIDs, so there is no internal address for
        // this row. Its own click goes where it always went rather than to a
        // route that cannot be built.
        <a href={row.url} target="_blank" rel="noreferrer" className={columns} title={label}>
          {body}
        </a>
      )}
    </li>
  )
}

/** A row's primary link, found the same way `use-hydration.ts` finds its row. */
const linkOf = (id: number): HTMLElement | null =>
  document.querySelector(`[data-pr-id="${id}"] a`)

/**
 * Keyboard selection over a page's sections as one list.
 *
 * Takes them concatenated in the order they are read, because `j` off the end of
 * "Mine" lands on the top of "Assigned to me" — which neither section can know
 * on its own. The selection is a PR id rather than an index, so a poll that
 * reorders or drops rows cannot quietly move it to a different pull request.
 */
export function useInboxSelection(rows: readonly PullRequestRow[]): number | null {
  const [selected, setSelected] = useState<number | null>(null)
  const navigate = useNavigate()

  const move = (step: number) => {
    if (rows.length === 0) return
    const at = rows.findIndex((row) => row.id === selected)
    if (at === -1) {
      setSelected((step > 0 ? rows[0] : rows[rows.length - 1]).id)
      return
    }
    setSelected(rows[Math.min(Math.max(at + step, 0), rows.length - 1)].id)
  }

  useCommand('nav.next', () => move(1))
  useCommand('nav.previous', () => move(-1))
  useCommand('nav.open', () => {
    const row = rows.find((one) => one.id === selected)
    if (row === undefined) return
    if (!addressable(row)) {
      window.open(row.url, '_blank', 'noreferrer')
      return
    }

    void navigate({
      to: '/pr/$projectId/$repositoryId/$prId',
      params: {
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        prId: String(row.id),
      },
    })
  })
  // Escape means "never mind" in a list: there is no row-level state to back out
  // of, so it drops the selection rather than navigating anywhere.
  useCommand('nav.back', () => {
    if (selected === null) return
    const focused = linkOf(selected)
    setSelected(null)
    if (document.activeElement === focused) focused?.blur()
  })

  // Moving focus, not just painting a highlight: it is what puts the row in
  // front of a screen reader, and it scrolls the row into view for free.
  useEffect(() => {
    if (selected === null) return
    const row = linkOf(selected)
    row?.focus()
    // Absent in jsdom, and the selection is still correct without it.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return selected
}

export function PullRequestSection({
  title,
  rows,
  empty,
  total,
  grouped = false,
  hydration,
  listRef,
  selectedId,
  onResolveCallout,
  onRequeue,
  onMerge,
}: {
  title: string
  rows: readonly PullRequestRow[]
  /** A node, not a string, so a filtered-to-zero section can set the query in mono. */
  empty: ReactNode
  /**
   * How many rows there were before a search narrowed them. Omitted when nothing
   * is filtering, which is not the same as passing `rows.length` — the heading
   * says "3 of 9" only when the two genuinely differ.
   */
  total?: number
  /** Whether to break the section into one sheet per repository. */
  grouped?: boolean
  /** All optional so a section still renders standalone, plain, in a test. */
  hydration?: (row: PullRequestRow) => HydrationResult | undefined
  listRef?: (element: HTMLUListElement | null) => (() => void) | undefined
  /** The inbox-wide selection; at most one section holds it at a time. */
  selectedId?: number | null
  /**
   * Given, a row that carries an Azure Pipelines callout draws a button to close
   * it. Omitted — on the history page, and in a standalone test — no row does.
   */
  onResolveCallout?: ResolveCallout
  /**
   * Given, a row with a build policy to run again draws a button that runs it.
   * Omitted on the same two grounds as `onResolveCallout` — a closed pull request
   * has no policy left to requeue.
   */
  onRequeue?: RequeueRow
  /**
   * Given, a row the table calls ready to merge draws a button that asks the page
   * to open its merge dialog. The row itself writes nothing — `readyToMerge` is
   * the inbox's weaker "worth opening to merge", and the dialog reads the pull
   * request before it offers the write.
   */
  onMerge?: (row: AddressableRow) => void
}) {
  const of = total !== undefined && total !== rows.length ? total : null
  const list = (subset: readonly PullRequestRow[]) => (
    // The list is a sheet raised off the desk. `p-1` is the gutter that keeps a
    // washed row's organic corners — and its focus ring — off the box's own
    // edge, which `overflow-hidden` would have clipped instead.
    //
    // `listRef` is a ref callback that adds to a set, so grouping handing it N
    // lists instead of one costs nothing: hydration measures rows across all of
    // them exactly as it measured them across the page's two sections.
    <ul ref={listRef} className="sketch-box sketch-box--quiet p-1">
      {subset.map((row) => (
        <Row
          key={row.id}
          row={row}
          result={hydration?.(row)}
          isSelected={row.id === selectedId}
          onResolveCallout={onResolveCallout}
          onRequeue={onRequeue}
          onMerge={onMerge}
        />
      ))}
    </ul>
  )

  return (
    <section className="w-full" aria-label={title}>
      {/* Labelled because the flex gap is whitespace only to the eye — the
          accessible name would otherwise run together as "Mine3". `.annotation`
          then carries the whole visual style, so the section names read as the
          labels on a drawing rather than as headings competing with the title. */}
      <h2
        aria-label={`${title}, ${rows.length}${of === null ? '' : ` of ${of}`} pull requests`}
        className="annotation flex items-baseline gap-2"
      >
        {title}
        <span className="tabular-nums">
          {of === null ? rows.length : `${rows.length} of ${of}`}
        </span>
      </h2>
      {/* A drawn rule instead of the list's top border. It is 6px tall, which is
          where the margins went: a 1px line needed none. */}
      <div className="sketch-rule mt-1 mb-1.5" aria-hidden />
      {rows.length === 0 ? (
        // An empty section is a state, not an absence, so it gets a box of its
        // own — quiet, because there is nothing here worth outlining in ink.
        <p className="sketch-box sketch-box--quiet text-muted-foreground px-3 py-2 text-sm">
          {empty}
        </p>
      ) : grouped ? (
        <div className="flex flex-col gap-3">
          {groupByRepository(rows).map((group) => (
            <div key={group.key}>
              {/* A step below the section label and set in mono, because the
                  section names a part of your day and this names an identifier —
                  the same distinction the row makes between its title and its
                  repository column. Labelled for the same reason the section
                  heading is: the gap before the count is whitespace only to the
                  eye.

                  The repository name alone, with the project kept on the `title`
                  for the one case that needs it — two projects holding a
                  repository of the same name. The rows below say which project
                  they are in either way. */}
              <h3
                aria-label={`${group.label}, ${group.rows.length} pull requests`}
                className="annotation mb-1 flex items-baseline gap-2 font-mono normal-case"
                title={group.key}
              >
                {group.label}
                <span className="tabular-nums">{group.rows.length}</span>
              </h3>
              {list(group.rows)}
            </div>
          ))}
        </div>
      ) : (
        list(rows)
      )}
    </section>
  )
}
