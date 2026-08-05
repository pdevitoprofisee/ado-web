import { useCallback, useState } from 'react'

import type { PullRequestRow } from '@/server/inbox'

// How the inbox is arranged, and whether that choice survives a reload.
//
// Grouping happens *inside* each section rather than instead of them. "Mine" and
// "Assigned to me" is the triage axis — whether this is your work or somebody
// asking for your time — and a flat list of repository headings would answer a
// question nobody opened the page with while losing the one they did.

/** `SaaS/PC.IAC.Modules` — unique across the org, unlike the repository name. */
export const repositoryKey = (row: PullRequestRow): string => `${row.project}/${row.repository}`

export interface PullRequestGroup {
  /** Identity: `project/repository`, because a repository name is not unique. */
  readonly key: string
  /** What the heading says: the repository name alone. */
  readonly label: string
  readonly rows: readonly PullRequestRow[]
}

/**
 * One group per repository, in alphabetical order by the name the heading shows.
 *
 * **Keyed on `project/repository` but labelled with the repository alone.** The
 * project is what makes two `platform`s two repositories, so it cannot leave the
 * key; it is also a word every heading in a project would repeat, so it does not
 * belong on screen. In the rare inbox that holds both `platform`s, the page
 * draws two headings reading `platform` and the rows beneath each say which is
 * which — cheaper than prefixing every other heading against a collision that
 * usually is not there.
 *
 * Sorted on the label rather than the key, so the headings read alphabetically
 * as drawn. `key` breaks the tie, which is what keeps that pair of `platform`s
 * in a stable order across polls.
 *
 * **Alphabetical rather than newest-first**, which is the order the rows
 * themselves are in. A poll lands every two minutes and any of it can bring a
 * new pull request; if groups were ordered by their newest row, one push would
 * lift a repository over the others and move every heading under it while
 * somebody was reading. Alphabetical is the only order here that a poll cannot
 * disturb — a repository only moves when it appears or empties.
 *
 * Rows keep the order they arrived in, so within a repository the inbox is still
 * newest-first.
 */
export function groupByRepository(rows: readonly PullRequestRow[]): readonly PullRequestGroup[] {
  const groups = new Map<string, PullRequestGroup & { rows: PullRequestRow[] }>()

  for (const row of rows) {
    const key = repositoryKey(row)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { key, label: row.repository, rows: [row] })
    else existing.rows.push(row)
  }

  return [...groups.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  )
}

/**
 * The same rows, flat, in the order the page will actually draw them.
 *
 * This exists so that the keyboard selection and the section that renders the
 * rows cannot disagree about what "next" means. Both go through
 * `groupByRepository`; neither reimplements it. `pr-list.tsx` renders the groups
 * and `routes/index.tsx` hands this to `useInboxSelection`, and grouping is the
 * one edit that would otherwise have made `j` jump around the page.
 */
export function inReadingOrder(
  rows: readonly PullRequestRow[],
  grouped: boolean,
): readonly PullRequestRow[] {
  if (!grouped) return rows

  return groupByRepository(rows).flatMap((group) => group.rows)
}

/** Where the choice is kept. Nothing else reads this key. */
const STORAGE_KEY = 'ado-web.inbox.grouped'

/**
 * The grouping toggle, remembered.
 *
 * A view preference outlives the tab it was set in — the same reasoning as the
 * theme, and the same defensive reads: `localStorage` *throws* on access in a
 * hardened browser profile, and an arrangement is not worth a blank page.
 *
 * Component state rather than `theme.ts`'s module store, because this has
 * exactly one consumer. The theme is shared by a header control and a tokeniser
 * inside a virtualised row, which is what a store is for; a single page's list
 * arrangement is not.
 */
export function useGroupByRepository(): readonly [boolean, (next: boolean) => void] {
  const [grouped, setGrouped] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const choose = useCallback((next: boolean) => {
    setGrouped(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // A session that cannot persist still gets to rearrange its own inbox.
    }
  }, [])

  return [grouped, choose]
}
