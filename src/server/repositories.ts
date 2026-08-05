import type { AdoClient } from './ado-client'
import type { RepositoryRow } from '../lib/repositories-contract'

// Server-only. Every git repository in the organisation, in one call.
//
// One call, and that is the whole reason this file is short. T-046 asked whether
// `_apis/git/repositories` with no project segment really answers across projects
// or quietly scopes itself to one, and it answers across all of them: 114
// repositories in 87 ms, matching the union of six per-project enumerations
// exactly — 0 rows missing in either direction. So there is no fan-out here, no
// project list to walk first, and no page loop.
//
// What this file mostly does is *not* send things. Four parameters are available
// and each of them costs something for nothing:
//
// - `$top` and `$skip` are **ignored outright** by this route (measured: `$top=5`
//   returns all 114). Sending them would look like paging that works, which is
//   worse than no paging — the pull request list clamps and short-pages, so the
//   habit of trusting `$top` is already in this codebase and would be wrong here.
// - `includeLinks` takes the response from 100 KB to 235 KB for `_links`.
// - `includeAllUrls` takes it to 1.58 MB — sixteen times the size — for
//   `validRemoteUrls`, which no row reads.
// - `includeHidden` is a decision, not an omission: three repositories in this
//   org are hidden, and Azure DevOps' own UI does not list them either. This list
//   agreeing with the web UI is worth more than three extra rows.
//
// No SQLite cache, for `history.ts`' reason: one cheap call, and Refresh is the
// whole freshness mechanism. A migration for a 100 KB response that changes when
// somebody creates a repository would be storage for its own sake.

/** One repository as the wire hands it over. Only the fields a row reads. */
interface AdoRepository {
  readonly name?: string
  readonly project?: { readonly name?: string }
  readonly defaultBranch?: string
  readonly remoteUrl?: string
  readonly webUrl?: string
  readonly isDisabled?: boolean
  readonly isFork?: boolean
}

interface RepositoryPage {
  readonly value?: ReadonlyArray<AdoRepository>
}

/** ADO says `refs/heads/foo`; nobody else does. */
const branch = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/**
 * A-Z by name, and by project first.
 *
 * Alphabetical because there is nothing better to sort by: T-046 read every field
 * of all 114 rows and found the repository carries **no timestamp of any kind**.
 * `project.lastUpdateTime` is the project's — all 90 repositories in `Products`
 * share one value — so a "recently updated" order would be a lie in the shape of
 * a sort. Project first, so the list reads as the six groups it is.
 *
 * `localeCompare` with `numeric`, so `PC.IAC.Networking2` sorts after
 * `PC.IAC.Networking10`'s neighbours the way a person expects rather than the way
 * a byte comparison would.
 */
const byProjectThenName = (a: RepositoryRow, b: RepositoryRow) =>
  a.project.localeCompare(b.project, undefined, { numeric: true }) ||
  a.name.localeCompare(b.name, undefined, { numeric: true })

/**
 * The row, or `null` for a wire row that cannot be one.
 *
 * A repository with no name, no project or no `remoteUrl` has no row to draw and
 * no clone URL to copy, so it is dropped rather than rendered as a blank line —
 * `loadHistory` drops a pull request with no id for the same reason. All 114
 * carried all three, so this is the guard for a shape that has not been seen, not
 * a case being handled.
 *
 * **`isFork`'s absence is read here and nowhere else.** It arrives on 4 of 114
 * rows and is simply missing on the other 110 — not `false`. Answering "absent
 * means no" once, at the boundary, is what stops every reader downstream from
 * having to know that.
 */
function toRow(repository: AdoRepository): RepositoryRow | null {
  const { name, remoteUrl, webUrl } = repository
  const project = repository.project?.name
  if (!name || !project || !remoteUrl) return null

  return {
    name,
    project,
    // Optional, not empty-string. ADO omits `defaultBranch` for a repository with
    // no commits, and the row's word for that is "no commits yet" rather than a
    // gap where a branch name goes.
    ...(repository.defaultBranch ? { defaultBranch: branch(repository.defaultBranch) } : {}),
    // `remoteUrl` verbatim, `Profisee@` prefix and all, because that prefix is
    // what makes the string work when somebody pastes it into `git clone`.
    cloneUrl: remoteUrl,
    // `webUrl`, which is not `url`. `url` is the API address and opens JSON.
    webUrl: webUrl ?? '',
    isDisabled: repository.isDisabled === true,
    isFork: repository.isFork === true,
  }
}

export interface Repositories {
  /** Sorted by project, then name. Disabled repositories included, marked. */
  readonly rows: readonly RepositoryRow[]
  /**
   * What ADO said `count` was, before anything was dropped.
   *
   * Kept so the page can say "114" and mean the organisation's number rather than
   * the number of rows that survived mapping. If the two ever disagree, that is
   * news.
   */
  readonly returned: number
}

export async function loadRepositories(client: AdoClient): Promise<Repositories> {
  // No params. Deliberately, and there is a test that says so.
  const page = await client.get<RepositoryPage>('_apis/git/repositories')
  const value = page.value ?? []

  return {
    rows: value
      .map(toRow)
      .filter((row): row is RepositoryRow => row !== null)
      .sort(byProjectThenName),
    returned: value.length,
  }
}
