// What a work item looks like once it has left Azure DevOps, and the four numbers
// that shape every call this feature makes.
//
// Types only — this file imports nothing, and must not import from `src/server/*`.
// The picker, the section and the loader all read the same shape from here.
//
// The numbers below are measured, not chosen. Their evidence is
// `docs/research/pr-detail-inventory.md` §3, which called both work item endpoints
// against all 164 active pull requests in this org.

/**
 * One work item, flattened out of `fields`.
 *
 * `id` is a number here even though `pullRequests/{id}/workitems` reports it as a
 * *string* — the batch call returns the same id as a number, and a shape where the
 * same field is a string on one path and a number on the other is a shape that
 * gets compared with `===` and quietly never matches.
 *
 * `type` and `state` are ADO's own words (`Task`, `Bug`, `Active`, `Closed`) and
 * are not translated: the org has custom process states, and a mapping this app
 * invented would be wrong the first time somebody edits the process template.
 */
export interface WorkItem {
  readonly id: number
  readonly title: string
  /** `System.State`, verbatim. */
  readonly state: string
  /** `System.WorkItemType`, verbatim. */
  readonly type: string
  /** Where a browser opens it, which is not the `url` on the wire — that is the API. */
  readonly url: string
}

/**
 * The work items on one pull request, and what could not be read.
 *
 * `total` is how many the pull request claims, `items` is how many came back with
 * a title. They differ when a work item was deleted or sits in a project the
 * credential cannot see, which is normal enough that `errorPolicy=omit` exists —
 * so the gap is shown rather than smoothed over, `DirectoryResult`'s reasoning.
 */
export interface WorkItemsResult {
  readonly items: readonly WorkItem[]
  readonly total: number
  /** `null` when both calls answered. A sentence when one did not. */
  readonly error: string | null
}

/** What a search came back with, or why it did not. */
export interface WorkItemSearchResult {
  readonly items: readonly WorkItem[]
  readonly error: string | null
}

/**
 * The fields worth asking for, and the whole reason to ask for any.
 *
 * All 128 work item ids in this org, fetched without `fields`: **283,839 bytes**,
 * 18 fields each. The same ids with the first four below: **14,253 bytes**. A 20×
 * reduction for the same rendered row.
 *
 * `System.TeamProject` is the fifth and was not part of that measurement. It is
 * here because a work item linked to a pull request can live in another project,
 * and the URL a browser opens needs the project in its path — so the alternative
 * is guessing that an org-scoped work item URL resolves, which is a guess that
 * fails in the browser rather than in a test.
 */
export const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.TeamProject',
] as const

/**
 * How many ids one batch call may carry.
 *
 * Measured: 210 ids answered HTTP 500 `VS403474: You requested 210 work items
 * which exceeds the limit of 200`. Not a guess and not a safety margin — it is
 * the number in the error.
 */
export const WORK_ITEM_BATCH = 200

/**
 * How many matches the picker offers.
 *
 * Also what the search asks WIQL for, because WIQL does the ordering: the newest
 * eight it returns are the eight worth showing, so the batch call that follows
 * fetches eight titles rather than fifty.
 */
export const WORK_ITEM_SUGGESTIONS = 8

/**
 * How long to wait after a keystroke before searching. 150ms.
 *
 * The reviewer picker has no debounce because it matches one cached snapshot of
 * the org locally. This one cannot: a work item search is WIQL plus a batch call,
 * on the server, per query. So it borrows `SUBJECT_QUERY_DEBOUNCE_MS` and its
 * reasoning — a debounce shorter than the round trip has a fast typist racing
 * answers against each other, and nothing about the two calls guarantees they come
 * back in the order they were sent.
 */
export const WORK_ITEM_DEBOUNCE_MS = 150

/**
 * What a search asks for.
 *
 * The project and not the pull request: WIQL is project-scoped, and carrying the
 * repository and the pull request number would mean validating two values this
 * read does not use — `CheckDetailTarget`'s reasoning.
 */
export interface WorkItemSearchRequest {
  readonly projectId: string
  /** Empty means "offer the recent ones", which is what an opened picker shows. */
  readonly query: string
}
