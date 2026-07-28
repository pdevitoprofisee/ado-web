import { getDatabase } from './db'

import type { DatabaseSync } from 'node:sqlite'

// Server-only. Which files of a pull request the reviewer has already read.
//
// **The mark hangs on a blob sha, not on a path**, which is what makes T-021's
// requirement fall out rather than have to be enforced. A push that rewrites a
// file gives it a new `objectId`, the row written under the old sha addresses
// bytes that are no longer in the diff, and the file comes back unviewed. A
// push that touches ten other files leaves this one's sha alone, and its mark
// with it. Nothing below compares timestamps, iteration numbers or commit ids,
// and nothing invalidates: as `blob.ts` puts it for the same reason, a sha
// cannot come to mean something else.
//
// This is the first table in the database that is not a cache, and the
// difference matters for anyone editing it later. `pr_cache` and `blob_cache`
// can be thrown away and refilled from Azure DevOps; these rows cannot, because
// they are a fact about the person reading rather than about the pull request.
// A migration may not clear this table the way `db.ts` licenses a cache
// migration to.

/**
 * The two shas of a `ChangedFile`, narrowed to what a mark needs. Structurally
 * satisfied by `ChangedFile` and by `blob.ts`'s `BlobRequest`, so a caller
 * passes the row it already has rather than a translation of it.
 */
export interface ViewedContent {
  readonly objectId: string | null
  readonly originalObjectId: string | null
}

/** One mark, fully addressed. */
export interface ViewedRef {
  readonly repositoryId: string
  /**
   * In the key because a mark is a fact about a *review*, not about a
   * repository: the same file at the same sha reached through a second pull
   * request has not been read in that pull request. It is also the only way
   * `listViewed` can answer for one page without loading every mark ever made.
   */
  readonly pullRequestId: number
  readonly path: string
  /** Already resolved through `contentId` — never the raw `objectId` of a delete. */
  readonly objectId: string
}

/**
 * Which sha a mark hangs on, or `null` for a change entry with content on
 * neither side.
 *
 * `objectId` — the after-side blob — answers for an add, an edit and a rename.
 * **A delete has none**: T-015 measured `objectId` absent on 16 of 16 deletes on
 * !24766, and a mark that could not be made on a deleted file would leave a hole
 * in the progress count exactly where a reviewer is most likely to skim. What
 * they read there is the content going away, so the before-sha stands in for it,
 * and the ticket's property survives intact — rebase onto a base where that file
 * held different bytes and `originalObjectId` moves, un-viewing it.
 *
 * `null` is reachable only for an entry with no blob at all, which `loadFiles`
 * already filters (folders) and which live payloads have never produced. It is
 * returned rather than thrown so the caller decides, and `viewed-fn.ts` rejects
 * it at the edge.
 */
export function contentId(file: ViewedContent): string | null {
  return file.objectId ?? file.originalObjectId
}

/**
 * The key a marked file is recognised by, and the string `listViewed` returns.
 *
 * `${objectId}:${path}` needs no escaping: an object id is validated as forty
 * hex digits, so the first colon is the separator however many the path
 * contains. Lower-cased because ADO returns shas uppercase but the route params
 * a key is rebuilt from have been through a URL — one mark written under
 * `21C62CD8…` and looked up under `21c62cd8…` is a mark silently lost, which is
 * worse than the wasted blob fetch the same mismatch costs `blob_cache`.
 *
 * **The path is in the key, which bounds "content, not path" deliberately.** Key
 * on content alone and two files holding identical bytes — an empty file, a
 * generated stub, a copied header — collapse into one mark, so ticking either
 * ticks both, and that is a wrong answer the reviewer can see on screen. The
 * price is that a **pure rename un-views the file**: `objectId ===
 * originalObjectId`, the bytes did not move, but the path did and the old key no
 * longer matches. That is the outcome to want. T-015 records a pure rename as
 * the one case where "unchanged" is right about the content while being wrong
 * about the file, and T-016 makes the view say so out loud; a file that has just
 * started claiming to live somewhere else is worth the second glance.
 */
export function viewedKey(objectId: string, path: string): string {
  return `${objectId.toLowerCase()}:${path}`
}

/**
 * Every mark for one pull request, as keys the file list can test each row
 * against — which is what "progress is visible from the file list" needs: one
 * query for the page, not one per file.
 *
 * Rows written under a sha the current iteration no longer contains are still
 * returned. They match nothing, cost a set entry, and are the record that the
 * file *was* read before it changed; pruning them would need to know which
 * iteration is current, which is the one thing this store deliberately does not
 * track.
 */
export function listViewed(
  repositoryId: string,
  pullRequestId: number,
  db: DatabaseSync = getDatabase(),
): ReadonlySet<string> {
  const rows = db
    .prepare(
      `SELECT object_id, path FROM viewed_file
       WHERE repository_id = ? AND pull_request_id = ?`,
    )
    .all(repositoryId.toLowerCase(), pullRequestId)

  return new Set(rows.map((row) => viewedKey(row.object_id as string, row.path as string)))
}

/**
 * Unviewing deletes the row rather than flipping a column, so "not viewed" has
 * exactly one representation and `listViewed` never has to filter. The upsert on
 * the other branch is not an update in any meaningful sense — re-marking an
 * already-marked file just moves `viewed_at`, which exists to make the table
 * readable by a human debugging it and is read by nothing.
 */
export function setViewed(
  ref: ViewedRef,
  viewed: boolean,
  db: DatabaseSync = getDatabase(),
): void {
  const key = [
    ref.repositoryId.toLowerCase(),
    ref.pullRequestId,
    ref.path,
    ref.objectId.toLowerCase(),
  ] as const

  if (!viewed) {
    db.prepare(
      `DELETE FROM viewed_file
       WHERE repository_id = ? AND pull_request_id = ? AND path = ? AND object_id = ?`,
    ).run(...key)

    return
  }

  db.prepare(
    `INSERT INTO viewed_file (repository_id, pull_request_id, path, object_id, viewed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, pull_request_id, path, object_id) DO UPDATE SET
       viewed_at = excluded.viewed_at`,
  ).run(...key, Date.now())
}
