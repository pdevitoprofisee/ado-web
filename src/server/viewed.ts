import { getDatabase } from './db'
import { viewedKey } from '@/lib/viewed-key'

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

// `contentId` and `viewedKey` moved to `@/lib/viewed-key` once the file list
// needed them too. Re-exported here because this is still where a server-side
// caller looks for them, and because the format has to have exactly one
// definition — the client cannot import this module at all.
export { contentId, viewedKey, type ViewedContent } from '@/lib/viewed-key'

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

// ---------------------------------------------------------------------------
// The same thing, for a repository on this disk.
// ---------------------------------------------------------------------------
//
// Everything above holds here — the mark hangs on a blob sha, unviewing deletes
// the row, and the table is not a cache — and only the address changes: a
// directory basename and a branch name in place of a repository GUID and a pull
// request id. `viewedKey` is shared verbatim, because it names no vendor and the
// two pages have to agree on what a key looks like or the file list's lookups
// silently miss.

/** One mark on a local branch diff, fully addressed. */
export interface LocalViewedRef {
  readonly slug: string
  /**
   * In the key for the reason `pullRequestId` is above: reading a file on this
   * branch is not reading it on the branch beside it, even at the same sha.
   *
   * The branch and not the target. A diff whose base moved is a different diff,
   * but it is the *same reading pass* — re-marking every file because someone
   * fetched would make the marks worthless on exactly the branch that is being
   * worked on hardest.
   */
  readonly branch: string
  readonly path: string
  /** Already resolved through `contentId` — never the raw `objectId` of a delete. */
  readonly objectId: string
}

/** Every mark for one branch of one repository. See `listViewed`. */
export function listLocalViewed(
  slug: string,
  branch: string,
  db: DatabaseSync = getDatabase(),
): ReadonlySet<string> {
  const rows = db
    .prepare(
      `SELECT object_id, path FROM local_viewed_file
       WHERE slug = ? AND branch = ?`,
    )
    .all(slug, branch)

  return new Set(rows.map((row) => viewedKey(row.object_id as string, row.path as string)))
}

/**
 * See `setViewed`. Neither the slug nor the branch is lower-cased on the way in:
 * a repository GUID is a GUID however it is spelled, and `Feature/X` and
 * `feature/x` are two different branches on the case-sensitive half of the
 * machines this runs on.
 */
export function setLocalViewed(
  ref: LocalViewedRef,
  viewed: boolean,
  db: DatabaseSync = getDatabase(),
): void {
  const key = [ref.slug, ref.branch, ref.path, ref.objectId.toLowerCase()] as const

  if (!viewed) {
    db.prepare(
      `DELETE FROM local_viewed_file
       WHERE slug = ? AND branch = ? AND path = ? AND object_id = ?`,
    ).run(...key)

    return
  }

  db.prepare(
    `INSERT INTO local_viewed_file (slug, branch, path, object_id, viewed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug, branch, path, object_id) DO UPDATE SET
       viewed_at = excluded.viewed_at`,
  ).run(...key, Date.now())
}
