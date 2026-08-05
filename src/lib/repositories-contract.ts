// One row of the organisation's repository list. Types only — this file imports
// nothing and must not import from `src/server/*`, so the loader and the page can
// agree on a shape without either of them owning it.
//
// Evidence: `docs/research/repositories-inventory.md`. One org-wide GET to
// `_apis/git/repositories` answered with 114 repositories across 6 projects, and
// the union of the six per-project lists matched it exactly — 0 rows missing in
// either direction. Every field below was counted across all 114.
//
// This is the Azure DevOps list. The repositories on this disk are
// `LocalRepository` in `local-git-contract.ts`, and they are a different thing: a
// local repository has a HEAD, a target and uncommitted files. This one has a
// clone URL and a project.

/**
 * What a row draws, and nothing else.
 *
 * **There is no `lastUpdated`.** T-046 read every field of all 114 rows and found
 * no timestamp on the repository itself. The only date in the response is
 * `project.lastUpdateTime`, which belongs to the project — the same value on all
 * 90 repositories in `Products`. Sorting by recency costs 114 more calls, so it
 * is a later ticket rather than a nullable field somebody will try to fill in.
 */
export interface RepositoryRow {
  /** `PC.IAC.Networking`. Unique inside its project, not across the organisation. */
  readonly name: string
  /** The project's name, never its id. `SaaS`, `Products`, `Professional Services`. */
  readonly project: string
  /**
   * A branch name, never a ref: `main`, not `refs/heads/main`. That is what a
   * person calls it.
   *
   * Optional even though all 114 rows carried one. Azure DevOps omits the field
   * for a repository with no commits, and this organisation merely happens to
   * have none. A row that finds it missing says "no commits yet" — the absence
   * has a word, not a gap.
   */
  readonly defaultBranch?: string
  /**
   * `remoteUrl` verbatim, `Profisee@` prefix and all. The prefix is what makes
   * the string work when somebody pastes it into `git clone`, so nothing here
   * tidies it up.
   */
  readonly cloneUrl: string
  /**
   * `webUrl` — the page a browser can open. Not `url`, which is the API address
   * and renders JSON, and not `remoteUrl`, which belongs to git.
   */
  readonly webUrl: string
  /** True on 11 of 114. Those rows stay in the list, marked. */
  readonly isDisabled: boolean
  /**
   * Absent rather than `false` on 110 of the 114 wire rows. The loader reads that
   * absence as "no" once, where it builds the row, so every reader downstream
   * gets a boolean instead of repeating the question.
   */
  readonly isFork: boolean
}
