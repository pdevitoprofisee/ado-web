import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Alert02Icon,
  AlertDiamondIcon,
  BotIcon,
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

import type { MouseEvent, ReactNode } from 'react'
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

/**
 * `title` for the mouse, `sr-only` for everything else; the icon carries neither.
 *
 * The count is a prop rather than a child, and the slot it sits in is reserved on
 * the badges that have no count. That is what puts the glyphs on one grid when
 * you read the column downward: the badge nearest the column's right edge ends in
 * a digit on one row and in a glyph on the next, so without the slot those two
 * glyphs sit a character apart.
 *
 * `filled` is the red build pill, which carries its own count inside its fill and
 * so takes no slot. It is the one mark here that is a shape rather than a line,
 * and its edge is what the eye lines up.
 */
function Badge({
  label,
  count,
  filled = false,
  children,
}: {
  label: string
  count?: number
  filled?: boolean
  children: ReactNode
}) {
  return (
    <span className="flex items-center gap-0.5" title={label}>
      {children}
      {/* `min-w` and not `w`: a two-digit count is rare and must not be clipped. */}
      {filled ? null : <span className="min-w-2 text-left">{count}</span>}
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

  // `pipelineThreads` is counted *inside* `unresolved` on purpose (see
  // `hydrate.ts`), so what is left over is what people wrote. Clamped, because
  // the two are counted by different rules: `unresolved` drops every identity
  // that posted a status on this pull request, and the pipeline list does not,
  // so on a pull request where Azure Pipelines did both the bot half can be the
  // larger number.
  const fromBots = result?.ok === true ? result.data.pipelineThreads.length : 0
  const fromPeople = result?.ok === true ? Math.max(0, result.data.unresolved - fromBots) : 0

  const commentLabel =
    fromPeople === 0
      ? `${fromBots} Azure Pipelines comments`
      : fromBots === 0
        ? `${fromPeople} unresolved comments`
        : `${fromPeople} unresolved comments, and ${fromBots} from Azure Pipelines`

  // One pen per meaning, and the counts in mono because they are figures: at
  // 9rem wide this column is read as a row of coloured marks, so the colour has
  // to be the message. Red is something wrong, amber is something unfinished,
  // teal is something done, navy is something to look at.
  //
  // 9rem and not the 8rem it grew to, because every badge now reserves a digit's
  // worth of space whether it counts anything or not — see `Badge`, which is what
  // lines the glyphs up down the column. The widest row this column can draw is
  // the conflict mark, both failure badges, the comment count and the reset mark,
  // which comes to 142px. `overflow-hidden` with `justify-end` clips from the
  // *left*, so at 8rem that row would have dropped the conflict mark — the one
  // badge here that is free and the one that matters most.
  return (
    <span className="text-muted-foreground flex w-36 shrink-0 items-center justify-end gap-1 overflow-hidden font-mono text-xs tabular-nums">
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
           144, which this column has since the failure branch and the waiting
           branch are exclusive.

           A build first, and not because more is broken: a rejection is already
           written on the row as a red ring on that reviewer's face, and a build
           that broke is written nowhere else. */
        <>
          {checks.failedBuilds > 0 ? (
            <Badge
              label={`${checks.failedBuilds} build ${checks.failedBuilds === 1 ? 'check' : 'checks'} failed`}
              filled
            >
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
            <Badge
              label={`${failedOther} ${failedOther === 1 ? 'check' : 'checks'} failed`}
              count={failedOther}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} className="text-destructive" aria-hidden />
            </Badge>
          ) : null}
        </>
      ) : checks && checks.running > 0 ? (
        <Badge label={`${checks.running} checks running`} count={checks.running}>
          <HugeiconsIcon icon={Clock01Icon} size={12} className="text-pen-amber" aria-hidden />
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
            <Badge
              label={`${checks.waitingOnPeople} reviewer policies not satisfied yet`}
              count={checks.waitingOnPeople}
            >
              <HugeiconsIcon icon={UserCheck01Icon} size={12} className="text-pen-amber" aria-hidden />
            </Badge>
          ) : null}
          {checks.waiting > checks.waitingOnPeople ? (
            <Badge
              label={`${checks.waiting - checks.waitingOnPeople} policies not satisfied yet`}
              count={checks.waiting - checks.waitingOnPeople}
            >
              <HugeiconsIcon icon={HourglassIcon} size={12} className="text-pen-amber" aria-hidden />
            </Badge>
          ) : null}
        </>
      ) : checks && checks.passed > 0 && !ready ? (
        // Not while the ready mark is up: it already implies this, and says more.
        <Badge label="All checks passed">
          <HugeiconsIcon icon={Tick02Icon} size={12} className="text-pen-green" aria-hidden />
        </Badge>
      ) : null}

      {/* One badge with two faces, for the unmet-policy badge's reason a level
          further down the scale: "5 unresolved comments" does not say whether a
          colleague is waiting on an answer or Azure Pipelines left its usual
          note, and only the first of those is a job for the person reading the
          row.

          So a person outranks the machine. Whenever anybody wrote anything the
          count is *their* count, in the speech bubble and in the navy pen, and
          the bot glyph in the palest ink the column has is what a row falls back
          to when the machine is all there is. The gap between those two pens is
          the whole point: the actionable half has to be legible across a page of
          rows, and the other half only has to be there.

          Not two badges side by side, the way the policy split is drawn: the
          widest row this column can already draw fills it, so a second comment
          badge would clip the conflict mark off the left. The bot tally goes in
          the label instead, and the row's gutter already carries it as the
          action that clears it. */}
      {fromPeople > 0 || fromBots > 0 ? (
        <Badge label={commentLabel} count={fromPeople > 0 ? fromPeople : fromBots}>
          <HugeiconsIcon
            icon={fromPeople > 0 ? Message01Icon : BotIcon}
            size={12}
            className={fromPeople > 0 ? 'text-ink' : 'text-ink-300'}
            aria-hidden
          />
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
    <span className="flex w-36 shrink-0 items-center justify-end overflow-hidden">
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

/** How long the pointer rests on a row before its card opens. */
const CARD_DELAY = 500

const exact = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

function stamp(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : `${exact.format(at)} (${age(iso)})`
}

/**
 * Opens a row's card after the pointer rests on it, and closes it on leave.
 *
 * The card is `fixed` to where the row was when it opened, so a scroll closes it
 * rather than leaving it behind over some other row.
 */
function useRowCard() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const close = () => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }

  useEffect(() => {
    if (anchor === null) return
    const onScroll = () => setAnchor(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [anchor])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return {
    anchor,
    handlers: {
      onMouseEnter: (event: MouseEvent<HTMLElement>) => {
        const target = event.currentTarget
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(
          () => setAnchor(target.getBoundingClientRect()),
          CARD_DELAY,
        )
      },
      onMouseLeave: close,
      onMouseDown: close,
    },
  }
}

/**
 * The whole pull request in one place, for the mouse: the row truncates the
 * title and hides its columns at narrow widths, and this does neither.
 *
 * `aria-hidden` because the row link already carries the title and the place as
 * its name and description. `pointer-events-none` so the card can never catch the
 * pointer and close itself.
 */
function RowCard({ row, anchor }: { row: PullRequestRow; anchor: DOMRect }) {
  const width = Math.min(384, window.innerWidth - 32)
  const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16))
  // Above a row that sits low on the screen, where a card below would be cut off.
  const below = anchor.bottom < window.innerHeight * 0.6
  const people = row.reviewers.filter((reviewer) => !reviewer.isContainer)
  const teams = row.reviewers.length - people.length

  return createPortal(
    <div
      aria-hidden
      data-testid="row-card"
      className="sketch-box bg-popover text-popover-foreground shadow-popover pointer-events-none fixed z-50 flex flex-col gap-2 p-3 text-sm"
      style={{
        width,
        left,
        ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground font-mono text-xs">!{row.id}</span>
        {row.isDraft ? (
          <span className="prof-badge prof-badge--amber tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase">
            draft
          </span>
        ) : null}
        {row.closed ? (
          <span
            className={cn(
              'prof-badge tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase',
              row.closed.outcome === 'completed' ? 'prof-badge--teal' : 'prof-badge--red',
            )}
          >
            {row.closed.outcome}
          </span>
        ) : null}
      </span>
      <span className="font-medium break-words">{row.title}</span>
      {/* The list endpoint cuts this at 400 characters, so it is a preview at best. */}
      {row.description === '' ? null : (
        <span className="text-muted-foreground line-clamp-4 text-xs break-words whitespace-pre-line">
          {row.description}
        </span>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="truncate font-mono">
          {row.project}/{row.repository}
        </dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd className="truncate">{row.author}</dd>
        {row.viaTeam ? (
          <>
            <dt className="text-muted-foreground">Via</dt>
            <dd className="truncate">{row.viaTeam}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Target</dt>
        <dd className="truncate font-mono">{row.targetBranch}</dd>
        <dt className="text-muted-foreground">Opened</dt>
        <dd>{stamp(row.createdAt)}</dd>
        {row.closed?.at ? (
          <>
            <dt className="text-muted-foreground">Closed</dt>
            <dd>{stamp(row.closed.at)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Reviewers</dt>
        <dd className="flex min-w-0 flex-col gap-0.5">
          {people.map((reviewer) => (
            <span key={reviewer.id} className="flex min-w-0 items-center gap-1.5">
              <Avatar
                href={reviewer.avatarHref}
                name={reviewer.displayName}
                className={cn('size-4 shrink-0 text-2xs', VOTE_RINGS.get(reviewer.vote))}
              />
              <span className="truncate">{reviewer.displayName}</span>
              <span className="text-muted-foreground shrink-0">{voteWord(reviewer.vote)}</span>
            </span>
          ))}
          {teams > 0 ? (
            <span className="text-muted-foreground">
              {people.length > 0 ? '+ ' : ''}
              {teams} {teams === 1 ? 'team' : 'teams'}
            </span>
          ) : people.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : null}
        </dd>
      </dl>
    </div>,
    document.body,
  )
}

/**
 * What every glyph in the row's right-hand gutter aligns to: the first line of
 * the row, wherever the rest of the row ends.
 *
 * `self-start` because these are flex children of the row and would otherwise
 * stretch to its full height, and `h-8` because that is the height of one line of
 * the row's own type — a 20px `text-sm` line box in a link that pads 6px above
 * and below it.
 */
const GUTTER = 'self-start h-8'

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
  mine = false,
  roomy = false,
  onResolveCallout,
  onRequeue,
  onMerge,
}: {
  row: PullRequestRow
  result: HydrationResult | undefined
  isSelected?: boolean
  mine?: boolean
  roomy?: boolean
  onResolveCallout?: ResolveCallout
  onRequeue?: RequeueRow
  onMerge?: (row: AddressableRow) => void
}) {
  // Every other column is truncated or hidden at narrow widths, so the
  // accessible name has to carry what the eye might not get — including the
  // outcome, which is otherwise a coloured pill and a relative date.
  const label = `${row.project}/${row.repository}${mine ? '' : ` · ${row.author}`}${row.viaTeam ? ` · via ${row.viaTeam}` : ''}${row.closed ? ` · ${row.closed.outcome}${row.closed.at ? ` ${row.closed.at.slice(0, 10)}` : ''}` : ''}`
  const labelId = useId()
  const card = useRowCard()
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
  // A page that can write reserves the whole gutter on every row, drawn or not.
  // These buttons are flex siblings of a `flex-1` link, so without the box each
  // one takes 30px off the link and drags the badge and age columns left with it
  // — a row with no act would sit a glyph right of the row under it, and the
  // columns would move again as the hydration lands.
  //
  // Three slots at 30px, because all three acts can be true at once: an optional
  // build can be broken, and requeueable, while the pull request is still ready
  // to merge on the policies that block.
  const writes = onResolveCallout !== undefined || onRequeue !== undefined || onMerge !== undefined

  // Both arrangements draw the same facts and differ only in where they put
  // three of them, so everything that does not move is built once. What moves is
  // the repository, the author and the target branch: columns beside the title
  // when the row is one line, a caption under it when the row is two.
  const identifier = (
    <span className="text-muted-foreground w-14 shrink-0 text-right font-mono text-xs tabular-nums">
      {row.id}
    </span>
  )
  const heading = (
    <>
      {/* Amber is the waiting pen, and a draft is a pull request waiting on its
          own author. Sized to stay inside the row's line box so a draft row is
          not taller than its neighbours. */}
      {row.isDraft ? (
        <span className="prof-badge prof-badge--amber tracking-label mr-1.5 px-1.5 py-0.5 text-2xs leading-none uppercase">
          draft
        </span>
      ) : null}
      {row.title}
    </>
  )
  // Next to the badges in both arrangements, because the pair is the whole
  // question a triage pass asks of a row: who is on the hook to read it, and
  // what is holding it up.
  const faces = <Faces reviewers={row.reviewers} />
  const status = row.closed ? (
    <Outcome closed={row.closed} />
  ) : (
    <Rich row={row} result={result} />
  )
  // The same column, measuring the thing you triage on. On an open PR that is
  // how long it has been waiting; on a closed one it is how long ago it stopped,
  // and its creation date is trivia. The exact date goes in the `title`, because
  // a history page is the one place someone asks for it.
  const when = (
    <span
      className="text-muted-foreground w-16 shrink-0 text-right font-mono text-xs tabular-nums"
      title={row.closed?.at || undefined}
    >
      {age(row.closed ? row.closed.at : row.createdAt)}
    </span>
  )
  const body = roomy ? (
    <>
      {identifier}
      {/* Two lines, split by question. Line one is what you triage on — which
          pull request, who is reviewing it, what is holding it up. Line two is
          how you place it: whose repository, whose work, where it lands. Set
          quiet and small it reads as a caption under the title, rather than as
          three more columns beside it — which is what they were when the title
          had to truncate to make room for them.

          The indent is free: this box starts where the title starts, so line two
          hangs under the title and clear of the id. */}
      <span className="min-w-0 flex-1">
        {/* The faces stay up here with the title, and they cannot make this line
            taller: a 16px blob centred in the 20px line box `text-sm` already
            reserves. `Faces` is `self-center` for that centring — on a baseline
            it would hang below the line. */}
        <span className="flex min-w-0 items-baseline gap-x-3">
          <span className="min-w-0 flex-1 truncate">{heading}</span>
          {faces}
        </span>
        {/* Repository and branch are identifiers, so the line is set in mono; the
            author is a person and takes the prose face back.

            Neither name is hidden at narrow widths any more. They were, because
            each one took width off the title — and on a line of their own they
            do not. A narrow window shortens them to an ellipsis instead. */}
        <span className="text-muted-foreground flex min-w-0 items-baseline gap-x-3 font-mono text-xs">
          <span className="truncate">{row.repository}</span>
          {/* Dropped, not blanked, on a section that is all your own work: your
              name on every row answers a question nobody asked there. */}
          {mine ? null : <span className="truncate font-sans">{row.author}</span>}
          <span className="truncate">→{row.targetBranch}</span>
        </span>
      </span>
      {status}
      {when}
    </>
  ) : (
    <>
      {identifier}
      <span className="min-w-0 flex-1 truncate">{heading}</span>
      {/* One line has to spend its width on the title first, so each of these
          three waits for a breakpoint wide enough to afford it. That ranking is
          the reason the roomy arrangement exists. */}
      <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-xs sm:block sm:max-w-40">
        {row.repository}
      </span>
      {mine ? null : (
        <span className="text-muted-foreground hidden shrink-0 truncate text-xs md:block md:max-w-32">
          {row.author}
        </span>
      )}
      {faces}
      <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-xs lg:block lg:max-w-28">
        →{row.targetBranch}
      </span>
      {status}
      {when}
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
            // A description and not a `title`: the row card is the hover, and a
            // native tooltip on top of it would say half of the same thing.
            aria-describedby={labelId}
            {...card.handlers}
          >
            {body}
          </Link>
          {writes ? (
            // Right-packed, like `Rich`: the act nearest the Azure DevOps link
            // lands on the same column on every row, and a second or third one
            // grows leftward into space that was already spent.
            //
            // `h-8` is the gutter's whole vertical claim: the link's own 20px line
            // box plus its 6px of padding, top and bottom. A one-line row is
            // exactly that tall, so this is what the row always did; on a two-line
            // row it holds the glyphs beside the title rather than letting them
            // drift down to the middle of a taller row, away from the badge column
            // they read with.
            <span className={cn('flex w-[90px] shrink-0 items-center justify-end', GUTTER)}>
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
            </span>
          ) : null}
          {/* Demoted, not removed: this app replaces the ADO tab for reading a
              PR, and there will always be something only ADO can do. */}
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            title={`Open !${row.id} in Azure DevOps`}
            className={cn(
              'text-muted-foreground hover:text-teal-600 flex shrink-0 items-center rounded-sm px-2',
              GUTTER,
            )}
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={14} aria-hidden />
            <span className="sr-only">Open in Azure DevOps</span>
          </a>
        </>
      ) : (
        // ADO answered without the GUIDs, so there is no internal address for
        // this row. Its own click goes where it always went rather than to a
        // route that cannot be built.
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className={columns}
          aria-describedby={labelId}
          {...card.handlers}
        >
          {body}
        </a>
      )}
      <span id={labelId} hidden>
        {label}
      </span>
      {card.anchor === null ? null : <RowCard row={row} anchor={card.anchor} />}
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
  mine = false,
  roomy = false,
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
  /**
   * Whether you wrote every pull request in this section. Given, the rows drop
   * the author column and leave the name out of their accessible names too — the
   * section heading already says whose these are.
   */
  mine?: boolean
  /**
   * Whether to give each row two lines instead of one. The row draws the same
   * facts either way — see `Row` for which three of them move.
   */
  roomy?: boolean
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
          mine={mine}
          roomy={roomy}
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
