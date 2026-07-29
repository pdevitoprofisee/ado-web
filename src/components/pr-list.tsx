import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Alert02Icon,
  Cancel01Icon,
  Clock01Icon,
  GitMergeConflictIcon,
  GitMergeIcon,
  LinkSquare02Icon,
  Message01Icon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { useCommand } from '@/commands/command-provider'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'

import type { HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

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

  // One pen per meaning, and the counts in mono because they are figures: at
  // 6rem wide this column is read as a row of coloured marks, so the colour has
  // to be the message. Red is something wrong, amber is something unfinished,
  // teal is something done, navy is something to look at.
  return (
    <span className="text-muted-foreground flex w-24 shrink-0 items-center justify-end gap-1 overflow-hidden font-mono text-xs tabular-nums">
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
          suppressed below while this is showing. Two teal marks in a 6rem column
          would read as one emphatic thing rather than two different facts.

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
        <Badge label={`${checks.failed} checks failed`}>
          <HugeiconsIcon icon={Cancel01Icon} size={12} className="text-destructive" aria-hidden />
          {checks.failed}
        </Badge>
      ) : checks && checks.pending > 0 ? (
        <Badge label={`${checks.pending} checks running`}>
          <HugeiconsIcon icon={Clock01Icon} size={12} className="text-pen-amber" aria-hidden />
          {checks.pending}
        </Badge>
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
 * act on, and there is none here. Reserving 6rem for badges that will never
 * arrive would leave a hole in every row of the page, so the one thing history
 * *does* have to say goes in it.
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
    <span className="flex w-24 shrink-0 items-center justify-end overflow-hidden">
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

/** Whether the detail route can address this PR: it is keyed by the two GUIDs. */
function addressable(
  row: PullRequestRow,
): row is PullRequestRow & { projectId: string; repositoryId: string } {
  return row.projectId !== null && row.repositoryId !== null
}

function Row({
  row,
  result,
  isSelected = false,
}: {
  row: PullRequestRow
  result: HydrationResult | undefined
  isSelected?: boolean
}) {
  // Every other column is truncated or hidden at narrow widths, so the
  // accessible name has to carry what the eye might not get — including the
  // outcome, which is otherwise a coloured pill and a relative date.
  const label = `${row.project}/${row.repository} · ${row.author}${row.viaTeam ? ` · via ${row.viaTeam}` : ''}${row.closed ? ` · ${row.closed.outcome}${row.closed.at ? ` ${row.closed.at.slice(0, 10)}` : ''}` : ''}`
  // `rounded-sm` on the link, not just on the row: this is the element the
  // keyboard focuses all day, and Prof's focus ring is a box-shadow that follows
  // whatever radius it finds. On a square link it would be a square ring.
  const columns = 'flex min-w-0 flex-1 items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-sm'
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
  hydration,
  listRef,
  selectedId,
}: {
  title: string
  rows: readonly PullRequestRow[]
  empty: string
  /** All optional so a section still renders standalone, plain, in a test. */
  hydration?: (row: PullRequestRow) => HydrationResult | undefined
  listRef?: (element: HTMLUListElement | null) => (() => void) | undefined
  /** The inbox-wide selection; at most one section holds it at a time. */
  selectedId?: number | null
}) {
  return (
    <section className="w-full" aria-label={title}>
      {/* Labelled because the flex gap is whitespace only to the eye — the
          accessible name would otherwise run together as "Mine3". `.annotation`
          then carries the whole visual style, so the section names read as the
          labels on a drawing rather than as headings competing with the title. */}
      <h2
        aria-label={`${title}, ${rows.length} pull requests`}
        className="annotation flex items-baseline gap-2"
      >
        {title}
        <span className="tabular-nums">{rows.length}</span>
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
      ) : (
        // The list is a sheet raised off the desk. `p-1` is the gutter that keeps
        // a washed row's organic corners — and its focus ring — off the box's own
        // edge, which `overflow-hidden` would have clipped instead.
        <ul ref={listRef} className="sketch-box sketch-box--quiet p-1">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              result={hydration?.(row)}
              isSelected={row.id === selectedId}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
