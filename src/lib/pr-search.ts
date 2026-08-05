import type { PullRequestRow } from '@/server/inbox'

// Narrowing the inbox by what has been typed. `filterRepositories`' arrangement
// and its bargain: the rows are already in hand, so the filter is local,
// immediate, has no debounce, no minimum length and nothing to cancel. There is
// no request here to get wrong.

/**
 * The one string a row is searched in.
 *
 * Three fields, joined by newlines. The newlines are not decoration — they stop
 * a term from matching across the seam, so typing `modules disable` cannot be
 * satisfied by a title that ends in `modules` sitting next to a project that
 * starts with `disable`.
 *
 * `project/repository` rather than the repository alone, because "the PRs in
 * `PC.IAC.Modules`" and "the PRs in `SaaS`" are the same question asked two
 * ways — the same reason `filterRepositories` uses that pair, and it means
 * typing `saas/pc` narrows the way the row reads on screen.
 *
 * The description is the first 400 characters of it and no more; see
 * `PullRequestRow.description` for why, and `SEARCHES` for where that is said
 * out loud on the page. A term that only appears in the tail of a long
 * description will not be found, and the honest fix for that is not a haystack
 * change — it is one detail call per row, which an inbox poll cannot afford.
 */
const haystack = (row: PullRequestRow): string =>
  `${row.title}\n${row.project}/${row.repository}\n${row.description}`.toLowerCase()

/**
 * What the page says it is searching, so the box and the no-matches line cannot
 * describe different behaviour than `haystack` implements.
 */
export const SEARCHES = 'title, repository and the first 400 characters of the description'

/**
 * The pull requests worth showing for what has been typed.
 *
 * **Every term must match, and they need not be adjacent.** `modules sql` and
 * `sql modules` both find `disable sql auditing` in `SaaS/PC.IAC.Modules`, which
 * is what makes the box usable without knowing which field a word lives in.
 *
 * **The order is not touched**, for `filterRepositories`' reason: every match is
 * on screen, so re-ranking under the cursor would move rows a reader is already
 * looking at. An empty query is the whole list, and the same array back, so a
 * caller can compare identities and skip the work.
 */
export function filterPullRequests(
  rows: readonly PullRequestRow[],
  query: string,
): readonly PullRequestRow[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) return rows

  return rows.filter((row) => {
    const text = haystack(row)

    return terms.every((term) => text.includes(term))
  })
}
