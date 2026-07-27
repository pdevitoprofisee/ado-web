import type { DatabaseSync } from 'node:sqlite'

import { getDatabase } from './db'

// The hydration cache behind the inbox. Rich row data costs 1+N calls per poll
// (map note: irreducible), so an unchanged PR must cost nothing on re-poll.
//
// `commitId` is `lastMergeSourceCommit.commitId` from the PR list call — the one
// field the cheap call gives us that changes whenever anything about the PR's
// content changes. The comparison lives *inside* the read so a caller cannot
// forget it and serve a stale row.
//
// That same check is why rows carry no organization column: a PR id is
// org-scoped in ADO, and for a cached row to be served across an org switch it
// would have to collide on both the id and a 40-hex commit sha — i.e. be the
// same commit.

/**
 * The payload is whatever the caller wrote, round-tripped through JSON. The
 * type parameter documents that contract; it is not validated on read, so a
 * change to the payload's shape must clear the table in a migration (see
 * MIGRATIONS in ./db.ts).
 */
export function readPrCache<T>(
  prId: number,
  commitId: string,
  db: DatabaseSync = getDatabase(),
): T | undefined {
  const row = db
    .prepare('SELECT payload FROM pr_cache WHERE pr_id = ? AND commit_id = ?')
    .get(prId, commitId)

  return row === undefined ? undefined : (JSON.parse(row.payload as string) as T)
}

export function writePrCache(
  prId: number,
  commitId: string,
  payload: unknown,
  db: DatabaseSync = getDatabase(),
): void {
  db.prepare(
    `INSERT INTO pr_cache (pr_id, commit_id, payload, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pr_id) DO UPDATE SET
       commit_id  = excluded.commit_id,
       payload    = excluded.payload,
       fetched_at = excluded.fetched_at`,
  ).run(prId, commitId, JSON.stringify(payload), Date.now())
}
