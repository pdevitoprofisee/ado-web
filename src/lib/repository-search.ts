import type { RepositoryRow } from './repositories-contract'

// Narrowing 114 rows by what has been typed. A pure function, in `src/lib/`, with
// its own test — `filterPeople`'s arrangement, for `filterPeople`'s reason: the
// whole list is already in hand, so the filter is local, immediate, has no debounce
// and nothing to cancel. There is no request here to get wrong.

/**
 * The one string a row is searched in: `SaaS/PC.IAC.Networking`.
 *
 * Project and name in one haystack, because "the repository called `data`" and
 * "the repositories in `SaaS`" are the same question asked two ways, and the `/`
 * between them means typing `saas/pc` narrows the way the row reads on screen.
 * The separator also stops a term from matching across the join by accident.
 */
const haystack = (row: RepositoryRow): string =>
  `${row.project}/${row.name}`.toLowerCase()

/**
 * The repositories worth showing for what has been typed.
 *
 * **Every term must match, and they need not be adjacent.** `net saas` and
 * `saas net` both find `SaaS/PC.IAC.Networking`, which is what makes the box
 * usable without knowing whether the project or the repository comes first.
 *
 * **The order is not touched.** `filterPeople` ranks its answers because it shows
 * eight of 344 and the ordering *is* the answer. Here every match is on screen and
 * the list is grouped by project, so re-sorting under the cursor would move rows a
 * reader is already looking at. Narrowing a stable list is easier to read than
 * re-ranking one.
 *
 * An empty query is the whole list, not an empty one — the same array back, so a
 * component can compare identities and skip the work.
 */
export function filterRepositories(
  rows: readonly RepositoryRow[],
  query: string,
): readonly RepositoryRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return rows

  return rows.filter((row) => {
    const text = haystack(row)

    return terms.every((term) => text.includes(term))
  })
}
