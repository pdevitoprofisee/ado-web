import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Alert02Icon, GitBranchIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { useCommand } from '@/commands/command-provider'
import { TARGET_RUNG_LABEL } from '@/lib/local-git-contract'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'

import type {
  LocalRepository,
  RepoHead,
  RepositoryEntry,
  RepositoryScan,
  ScannedRoot,
  TargetResolution,
} from '@/lib/local-git-contract'

// The repositories under your roots, as a list. Split out of the route for the
// reason `pr-list.tsx` is: the route's other job is fetching, and a list is only
// testable on its own once it has nothing to fetch.
//
// Every cell here is a **ref read** — name, HEAD, target. No dirty count, no
// commit count, no file list: `status --porcelain=v2` is 107–216 ms per
// repository and fanning it out across nineteen buys ~20%, so a list that
// carried one would take two and a half seconds to draw. Those belong to the
// diff page, which asks for one repository.

/** "There are none" and "we could not read it" are different facts. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

function Failed({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 px-2 py-1.5 text-sm">
      <HugeiconsIcon icon={Alert02Icon} size={14} className="shrink-0" aria-hidden />
      {children}
    </p>
  )
}

/** A path is an identifier, so it is set in mono wherever it appears in prose. */
function Path({ children }: { children: string }) {
  return <code className="font-mono text-xs">{children}</code>
}

const short = (commit: string): string => commit.slice(0, 7)

/** What the row says out loud, for a reader who cannot see the two badges. */
function headLabel(head: RepoHead): string {
  if (head.kind === 'branch') return `on ${head.name}`
  if (head.kind === 'detached') return `detached at ${short(head.commit)}`

  return `unborn — ${head.name} has no commits yet`
}

/**
 * Where the repository is sitting.
 *
 * The two unusual arms get the amber pill rather than a word in the branch
 * column, because they are not branch names: a reader scanning nineteen rows for
 * "which of these am I in the middle of" is reading the shape of the cell.
 */
function Head({ head }: { head: RepoHead }) {
  if (head.kind === 'branch') {
    return (
      <span className="text-muted-foreground flex min-w-0 shrink-0 items-center gap-1 font-mono text-xs sm:w-40">
        <HugeiconsIcon icon={GitBranchIcon} size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{head.name}</span>
      </span>
    )
  }

  return (
    <span className="text-muted-foreground flex min-w-0 shrink-0 items-center gap-1.5 font-mono text-xs sm:w-40">
      <span className="prof-badge prof-badge--amber tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase">
        {head.kind}
      </span>
      <span className="truncate">{head.kind === 'detached' ? short(head.commit) : head.name}</span>
    </span>
  )
}

/**
 * What a diff on this repository would be taken against, and how that was found.
 *
 * The rung's wording is `TARGET_RUNG_LABEL`'s and not this file's: the diff page
 * states the same fact, and two wordings for one fact is how they drift. It is
 * truncated at narrow widths like every other secondary column, with the whole
 * of it in the row's `title`.
 */
function Target({ target }: { target: TargetResolution }) {
  if (target.kind === 'unresolved') {
    // Amber, not red: nothing failed. This repository has no `origin` and no
    // local `main`, so there is no branch to hold still while another moves.
    return (
      <span className="text-pen-amber hidden shrink-0 truncate text-xs md:block md:max-w-64">
        no target — tried {target.tried.join(', ')}
      </span>
    )
  }

  return (
    <>
      <span className="text-muted-foreground shrink-0 truncate font-mono text-xs sm:max-w-40">
        →{target.ref.name}
      </span>
      <span className="text-muted-foreground hidden shrink-0 truncate text-xs md:block md:max-w-56">
        {TARGET_RUNG_LABEL[target.rung]}
      </span>
    </>
  )
}

/** Whether `/repos/$repo` can address this row — see `unaddressable`. */
export function openable(entry: RepositoryEntry): entry is LocalRepository {
  return entry.kind === 'repository' && entry.unaddressable === null
}

function Row({ entry, isSelected = false }: { entry: RepositoryEntry; isSelected?: boolean }) {
  // `rounded-sm` on the link and not only on the row, for `pr-list.tsx`'s
  // reason: Prof's focus ring is a box-shadow that follows whatever radius it
  // finds, and this is the element the keyboard focuses all day.
  const columns = 'flex min-w-0 flex-1 items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-sm'
  const name = <span className="min-w-0 flex-1 truncate font-mono">{entry.slug}</span>

  return (
    <li
      // How the selection finds this row in the DOM to focus it, and how a test
      // reads which row is selected.
      data-repo-slug={entry.slug}
      aria-current={isSelected ? true : undefined}
      className={cn(
        'border-border flex border-b last:border-b-0',
        isSelected ? 'bg-accent rounded-sm' : 'hover:bg-accent/50 hover:rounded-sm',
      )}
    >
      {entry.kind === 'unreadable' ? (
        // Kept in the list rather than dropped, and not a link: a silently
        // shortened list reads as "you have eighteen repositories", and a row
        // that goes nowhere must not look like one that does.
        <div className={columns}>
          {name}
          <span className="text-destructive flex min-w-0 items-center gap-1.5 text-xs">
            <HugeiconsIcon icon={Alert02Icon} size={14} className="shrink-0" aria-hidden />
            <span className="truncate">{entry.message}</span>
          </span>
        </div>
      ) : entry.unaddressable !== null ? (
        // The one live cause is a slug collision. Both rows carry their full
        // path, because the path is the only thing telling them apart.
        <div className={columns}>
          {name}
          <span className="text-muted-foreground hidden min-w-0 shrink truncate font-mono text-xs lg:block">
            {entry.path}
          </span>
          <span className="text-pen-amber shrink-0 truncate text-xs">{entry.unaddressable}</span>
        </div>
      ) : (
        <Link
          to="/repos/$repo"
          params={{ repo: entry.slug }}
          className={columns}
          title={`${entry.path} · ${headLabel(entry.head)}`}
        >
          {name}
          <Head head={entry.head} />
          <Target target={entry.target} />
        </Link>
      )}
    </li>
  )
}

/** A row's link, found the way the row is tagged. */
const linkOf = (slug: string): HTMLElement | null =>
  // Escaped because a slug is a directory name off the disk rather than a
  // number, and a selector is the one place in this file it is not just text.
  document.querySelector(`[data-repo-slug="${CSS.escape(slug)}"] a`)

/**
 * Keyboard selection over the list, keyed by slug.
 *
 * It moves over the **openable** rows only. Every other list in this app can
 * say that every row goes somewhere — an inbox row with no GUIDs still opens in
 * Azure DevOps — and here an unreadable repository and a collided one go
 * nowhere at all. A cursor exists so that Enter has something to open, and
 * stopping it on a row where Enter does nothing would be a cursor that
 * sometimes lies. Both kinds of row are still on the page saying why.
 */
export function useRepoSelection(entries: readonly RepositoryEntry[]): string | null {
  const rows = useMemo(() => entries.filter(openable), [entries])
  const [selected, setSelected] = useState<string | null>(null)
  const navigate = useNavigate()

  const move = (step: number) => {
    if (rows.length === 0) return
    const at = rows.findIndex((repo) => repo.slug === selected)
    if (at === -1) {
      setSelected((step > 0 ? rows[0] : rows[rows.length - 1]).slug)
      return
    }
    setSelected(rows[Math.min(Math.max(at + step, 0), rows.length - 1)].slug)
  }

  useCommand('nav.next', () => move(1))
  useCommand('nav.previous', () => move(-1))
  useCommand('nav.open', () => {
    const repo = rows.find((one) => one.slug === selected)
    if (repo === undefined) return

    void navigate({ to: '/repos/$repo', params: { repo: repo.slug } })
  })
  // Escape means "never mind" in a list: there is no row-level state to back out
  // of, so it drops the selection rather than navigating anywhere.
  useCommand('nav.back', () => {
    if (selected === null) return
    const focused = linkOf(selected)
    setSelected(null)
    if (document.activeElement === focused) focused?.blur()
  })

  // Moving focus rather than only painting a highlight: it is what puts the row
  // in front of a screen reader, and it scrolls the row into view for free.
  useEffect(() => {
    if (selected === null) return
    const row = linkOf(selected)
    row?.focus()
    // Absent in jsdom, and the selection is still correct without it.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return selected
}

/**
 * The three ways the list can be empty that are about a root rather than about a
 * repository — the fourth is `UnreadableRepository`, which is a row.
 *
 * A configured root that is gone is stated **whether or not the list is empty**:
 * with two roots, one missing and one full, the page would otherwise draw a
 * plausible list and never mention that half of what was asked for is not there.
 */
function Roots({ roots, empty }: { roots: readonly ScannedRoot[]; empty: boolean }) {
  const missing = roots.filter((root) => root.configured && !root.exists)
  // `rootPaths()` produces exactly one unconfigured root, the `~/repos` default,
  // so this is "nobody has told the app where to look" rather than one root of
  // several having gone missing.
  const unset = roots.find((root) => !root.configured && !root.exists)

  return (
    <>
      {missing.map((root) => (
        <Failed key={root.path}>
          <span>
            <Path>{root.path}</Path> is not there. <Path>ADO_WEB_REPOS_ROOT</Path> names it and
            nothing is at that path.
          </span>
        </Failed>
      ))}

      {empty && unset ? (
        <Empty>
          Point the app at your repositories: set <Path>ADO_WEB_REPOS_ROOT</Path>. There is no{' '}
          <Path>{unset.path}</Path> to fall back on.
        </Empty>
      ) : null}

      {empty
        ? roots
            .filter((root) => root.exists)
            .map((root) => (
              <Empty key={root.path}>
                <Path>{root.path}</Path> holds no git repositories. The scan is one level deep, so
                a repository nested below a direct child of it is not found.
              </Empty>
            ))
        : null}
    </>
  )
}

export function RepositoryList({
  scan,
  selectedSlug,
}: {
  scan: RepositoryScan
  /** At most one row holds it; `null` when the keyboard has not been used. */
  selectedSlug?: string | null
}) {
  const empty = scan.repositories.length === 0

  return (
    <section className="w-full" aria-label="Repositories">
      {/* Labelled, because the flex gap between the word and the count is
          whitespace only to the eye. `.annotation` then carries the style, so the
          heading reads as the label on a drawing rather than as a second title. */}
      <h2
        aria-label={`Repositories, ${scan.repositories.length}`}
        className="annotation flex items-baseline gap-2"
      >
        Repositories
        <span className="tabular-nums">{scan.repositories.length}</span>
      </h2>
      <div className="sketch-rule mt-1 mb-1.5" aria-hidden />

      <Roots roots={scan.roots} empty={empty} />

      {empty ? null : (
        // The list is a sheet raised off the desk. `p-1` is the gutter that keeps
        // a washed row's organic corners — and its focus ring — off the box's own
        // edge, which `overflow-hidden` would have clipped instead.
        <ul className="sketch-box sketch-box--quiet p-1">
          {scan.repositories.map((entry) => (
            <Row key={entry.path} entry={entry} isSelected={entry.slug === selectedSlug} />
          ))}
        </ul>
      )}
    </section>
  )
}
