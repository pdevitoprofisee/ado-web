import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Check,
  Clock,
  ExternalLink,
  GitMerge,
  MessageSquare,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react'

import { useCommand } from '@/commands/command-provider'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'

import type { HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

// The inbox's two sections, and the keyboard selection that runs across both of
// them. Split out of the route so the list can be tested on its own: the route's
// only other job is fetching.

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

  return (
    <span className="text-muted-foreground flex w-24 shrink-0 items-center justify-end gap-1 overflow-hidden text-xs tabular-nums">
      {/* Free from the list call, so it is the one badge that never waits. */}
      {row.conflicted ? (
        <Badge label="Merge conflicts">
          <GitMerge className="text-destructive size-3" aria-hidden />
        </Badge>
      ) : null}

      {result?.ok === false ? (
        <Badge label={`Could not load: ${result.error}`}>
          <TriangleAlert className="size-3" aria-hidden />
        </Badge>
      ) : null}

      {checks && checks.failed > 0 ? (
        <Badge label={`${checks.failed} checks failed`}>
          <X className="text-destructive size-3" aria-hidden />
          {checks.failed}
        </Badge>
      ) : checks && checks.pending > 0 ? (
        <Badge label={`${checks.pending} checks running`}>
          <Clock className="size-3" aria-hidden />
          {checks.pending}
        </Badge>
      ) : checks && checks.passed > 0 ? (
        <Badge label="All checks passed">
          <Check className="size-3" aria-hidden />
        </Badge>
      ) : null}

      {result?.ok === true && result.data.unresolved > 0 ? (
        <Badge label={`${result.data.unresolved} unresolved comments`}>
          <MessageSquare className="size-3" aria-hidden />
          {result.data.unresolved}
        </Badge>
      ) : null}

      {result?.ok === true && result.data.approvalReset ? (
        <Badge label="A push reset your approval">
          <RotateCcw className="text-destructive size-3" aria-hidden />
        </Badge>
      ) : null}
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
  // accessible name has to carry what the eye might not get.
  const label = `${row.project}/${row.repository} · ${row.author}${row.viaTeam ? ` · via ${row.viaTeam}` : ''}`
  const columns = 'flex min-w-0 flex-1 items-baseline gap-x-3 px-2 py-1.5 text-sm'
  const body = (
    <>
      <span className="text-muted-foreground w-14 shrink-0 text-right font-mono text-xs tabular-nums">
        {row.id}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {row.isDraft ? (
          <span className="text-muted-foreground border-border mr-1.5 rounded border px-1 text-[10px] uppercase">
            draft
          </span>
        ) : null}
        {row.title}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate text-xs sm:block sm:max-w-40">
        {row.repository}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate text-xs md:block md:max-w-32">
        {row.author}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-xs lg:block lg:max-w-28">
        →{row.targetBranch}
      </span>
      <Rich row={row} result={result} />
      <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
        {age(row.createdAt)}
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
        'hover:bg-muted/50 border-border/60 flex border-b last:border-b-0',
        isSelected && 'bg-muted',
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
            className="text-muted-foreground hover:text-foreground flex shrink-0 items-center px-2"
          >
            <ExternalLink className="size-3.5" aria-hidden />
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
 * Keyboard selection over the inbox as one list.
 *
 * Takes both sections concatenated in visual order, because `j` off the end of
 * "Assigned to me" lands on the top of "Mine" — which neither section can know
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
  // Nothing to go back to from the inbox, so Escape means "never mind" here.
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
          accessible name would otherwise run together as "Mine3". */}
      <h2
        aria-label={`${title}, ${rows.length} pull requests`}
        className="text-muted-foreground mb-1 flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase"
      >
        {title}
        <span className="tabular-nums">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1.5 text-sm">{empty}</p>
      ) : (
        <ul ref={listRef} className="border-border/60 rounded-md border">
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
