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

function Row({ row }: { row: PullRequestRow }) {
  return (
    <li className="hover:bg-muted/50 border-border/60 border-b last:border-b-0">
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
}: {
  title: string
  rows: readonly PullRequestRow[]
  empty: string
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
        <ul className="border-border/60 rounded-md border">
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}
