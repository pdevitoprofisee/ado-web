import { Check, Clock, GitMerge, MessageSquare, RotateCcw, TriangleAlert, X } from 'lucide-react'

import type { ReactNode } from 'react'

import type { HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

// The inbox's two sections. Split out of the route so it can be rendered without
// a router: the route's only other job is fetching, and a list this dense is
// worth being able to test on its own.

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

function Row({ row, result }: { row: PullRequestRow; result: HydrationResult | undefined }) {
  return (
    <li
      // How `useHydration` finds this row in the DOM to measure whether it is
      // above the fold.
      data-pr-id={row.id}
      className="hover:bg-muted/50 border-border/60 border-b last:border-b-0"
    >
      <a
        href={row.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-baseline gap-x-3 px-2 py-1.5 text-sm"
        // Every other column is truncated or hidden at narrow widths, so the
        // accessible name has to carry what the eye might not get.
        title={`${row.project}/${row.repository} · ${row.author}${row.viaTeam ? ` · via ${row.viaTeam}` : ''}`}
      >
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
      </a>
    </li>
  )
}

export function PullRequestSection({
  title,
  rows,
  empty,
  hydration,
  listRef,
}: {
  title: string
  rows: readonly PullRequestRow[]
  empty: string
  /** Both optional so a section still renders standalone, plain, in a test. */
  hydration?: (row: PullRequestRow) => HydrationResult | undefined
  listRef?: (element: HTMLUListElement | null) => (() => void) | undefined
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
            <Row key={row.id} row={row} result={hydration?.(row)} />
          ))}
        </ul>
      )}
    </section>
  )
}
