import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Server-only. Nothing under src/server may be imported from a component: a
// `node:sqlite` import in the client graph breaks the browser bundle.
//
// Driver: `node:sqlite` (Node 24, SQLite 3.53). Deliberately not better-sqlite3
// — a native addon has to be externalised from the Nitro bundle and carries
// prebuilds per platform, and we get nothing for it at this scale.

const APP_DIR = 'ado-web'
const DB_FILE = 'ado-web.db'

/**
 * Per-user application data, not the repo and not the temp dir: the cache has
 * to survive a rebuild and must never be committed. `ADO_WEB_DATA_DIR`
 * overrides it, which is how tests avoid touching the real user path.
 */
export function dataDir(): string {
  const override = process.env.ADO_WEB_DATA_DIR
  if (override) return override

  if (process.platform === 'win32') {
    // LOCALAPPDATA rather than APPDATA: this is machine-local cache data and
    // has no business roaming between machines.
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(local, APP_DIR)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR)
  }
  const share = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(share, APP_DIR)
}

export function databasePath(): string {
  return join(dataDir(), DB_FILE)
}

type Migration = { version: number; name: string; up: string }

/**
 * Append-only, and never edited once shipped — an edited migration is a schema
 * that differs between a fresh machine and an existing one.
 *
 * Cache tables are an exception to "migrate, don't drop": when a cached payload
 * shape changes, the migration that changes it should `DELETE FROM` the table
 * rather than transform rows. The data is re-fetchable by definition.
 */
const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: 'pr-cache',
    // `commit_id` is the validity token, not part of the key: one row per PR,
    // replaced in place when the PR is pushed to. See src/server/pr-cache.ts.
    up: `CREATE TABLE pr_cache (
           pr_id      INTEGER PRIMARY KEY,
           commit_id  TEXT    NOT NULL,
           payload    TEXT    NOT NULL,
           fetched_at INTEGER NOT NULL
         ) STRICT`,
  },
  {
    version: 2,
    name: 'blob-cache',
    // The one table here with no validity token, and deliberately: `object_id`
    // is the sha *of the content*, so a row can never be stale. Nothing
    // invalidates it, nothing needs to. See src/server/blob.ts.
    //
    // `bytes` is NULL for a blob refused over the size ceiling — the refusal is
    // cached too, so re-opening a 4 MB file costs no calls either. `size` is
    // kept beside it so that refusal stays re-checkable: raise the ceiling and
    // the row stops being an answer, rather than refusing a file we would now
    // render.
    up: `CREATE TABLE blob_cache (
           object_id  TEXT PRIMARY KEY,
           size       INTEGER NOT NULL,
           bytes      BLOB,
           fetched_at INTEGER NOT NULL
         ) STRICT`,
  },
  {
    version: 3,
    name: 'viewed-files',
    // The first table here that is **not** a cache, so the `DELETE FROM`
    // licence above does not extend to it: a viewed mark is a fact about the
    // person reading, nothing re-fetches it, and dropping the table loses work
    // rather than a copy of something Azure DevOps still has.
    //
    // `object_id` is in the key and that is the whole feature — the mark is on
    // the content, so a push that rewrites the file writes a new sha and the
    // old row stops matching. On a delete, which has no after-sha, the caller
    // stores the before-sha; it may not simply store NULL, because a STRICT
    // table makes every PRIMARY KEY column implicitly NOT NULL (measured on
    // SQLite 3.53.1 — the same table without STRICT happily holds two rows that
    // differ only by a NULL key part). See src/server/viewed.ts.
    up: `CREATE TABLE viewed_file (
           repository_id   TEXT    NOT NULL,
           pull_request_id INTEGER NOT NULL,
           path            TEXT    NOT NULL,
           object_id       TEXT    NOT NULL,
           viewed_at       INTEGER NOT NULL,
           PRIMARY KEY (repository_id, pull_request_id, path, object_id)
         ) STRICT`,
  },
  {
    version: 4,
    name: 'pr-cache-ready',
    // The `DELETE FROM` licence above, taken up for the first time: `Hydration`
    // grew `blocked` and `readyToMerge`, and the payload is parsed without being
    // validated (see src/server/pr-cache.ts). A row written before this would
    // hand back `undefined` for both, and the inbox would draw every cached pull
    // request as not ready — indefinitely, because the commit token those rows
    // are keyed on is still current, so nothing would ever refetch them.
    up: 'DELETE FROM pr_cache',
  },
  {
    version: 5,
    name: 'notification-log',
    // Not a cache either, so the `DELETE FROM` licence does not extend here: a
    // notification is the record that something happened while the app was
    // open, and nothing can refetch it — the poll it was a diff against is
    // gone.
    //
    // `key` is the primary key and it describes **what happened**, never when it
    // was noticed: `vote:<pr>:<thread>` rather than a timestamp. That is the
    // whole of the deduplication story. Two detection paths racing on the same
    // vote, or the same vote seen again after a restart, collide on this column
    // and the second insert does nothing. See src/server/notifications.ts.
    //
    // `announced_at` is separate from `read_at` because they answer different
    // questions: announced means the sound has played, read means the person
    // looked. A row can be announced and unread, which is the normal state of a
    // notification sitting in the panel.
    // The two GUIDs are stored rather than a path, because the panel links with
    // typed route params like every other link in the app, and because a row has
    // to keep making sense after the pull request has left the inbox — a
    // notification outlives the `pr_signal` row it was detected from.
    up: `CREATE TABLE notification (
           key           TEXT    PRIMARY KEY,
           kind          TEXT    NOT NULL,
           pr_id         INTEGER NOT NULL,
           title         TEXT    NOT NULL,
           detail        TEXT    NOT NULL,
           project_id    TEXT    NOT NULL,
           repository_id TEXT    NOT NULL,
           created_at    INTEGER NOT NULL,
           announced_at  INTEGER,
           read_at       INTEGER
         ) STRICT`,
  },
  {
    version: 6,
    name: 'pr-signal',
    // The other half of a diff: what the previous poll saw. One row per pull
    // request the app has looked at, and its *existence* is what makes the first
    // poll silent — a pull request with no row here has no previous poll to be
    // compared against, so it produces no events, only this row.
    //
    // The three watermarks start at -1, meaning "not observed yet", which is a
    // different thing from 0: no failing checks is news the next time a check
    // fails, whereas not knowing yet must announce nothing. A STRICT table would
    // take NULL here, but then every read would have to decide what NULL means,
    // and the two possible answers are exactly the bug.
    up: `CREATE TABLE pr_signal (
           pr_id         INTEGER PRIMARY KEY,
           title         TEXT    NOT NULL,
           project_id    TEXT    NOT NULL,
           repository_id TEXT    NOT NULL,
           role          TEXT    NOT NULL,
           commit_id     TEXT    NOT NULL,
           comment_at    INTEGER NOT NULL,
           vote_at       INTEGER NOT NULL,
           failed        INTEGER NOT NULL,
           updated_at    INTEGER NOT NULL
         ) STRICT`,
  },
  {
    version: 7,
    name: 'local-viewed-files',
    // `viewed_file`'s twin for a repository on this disk, and not a cache either
    // — so the `DELETE FROM` licence does not extend here for the same reason it
    // does not extend to migration 3: a mark is a fact about the person reading,
    // and dropping the table loses work rather than a copy of something a server
    // still has.
    //
    // A second table rather than nullable columns on the first. The two are
    // addressed by things that have nothing to do with each other — a repository
    // GUID and a pull request id there, a directory basename and a branch name
    // here — and a shared table would mean a key where half the columns are NULL
    // in every row, which a STRICT table's implicitly NOT NULL primary key will
    // not hold anyway (see migration 3).
    //
    // `branch` is in the key because a mark is about reading *this* diff: the
    // same file at the same sha, read on a feature branch, is not something you
    // have read on the branch beside it. `object_id` carries the same meaning it
    // does above — the mark is on the content, so a rebase writes a new sha and
    // the old row stops matching. See src/server/viewed.ts.
    up: `CREATE TABLE local_viewed_file (
           slug      TEXT    NOT NULL,
           branch    TEXT    NOT NULL,
           path      TEXT    NOT NULL,
           object_id TEXT    NOT NULL,
           viewed_at INTEGER NOT NULL,
           PRIMARY KEY (slug, branch, path, object_id)
         ) STRICT`,
  },
]

/**
 * Idempotent: applies whatever hasn't been applied, in order. Safe to call on
 * every open, which is exactly what `openDatabase` does.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT    NOT NULL,
             applied_at INTEGER NOT NULL
           ) STRICT`)

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version as number),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue

    // DDL is transactional in SQLite, so a migration either lands whole or not
    // at all — and its bookkeeping row lands in the same transaction, which is
    // what stops the table and the version record from diverging.
    db.exec('BEGIN')
    try {
      db.exec(migration.up)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now())
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed`,
        { cause },
      )
    }
  }
}

/**
 * Opens (creating if absent) and migrates. Recreating the directory here is
 * what makes "delete the database file" a supported recovery rather than a
 * crash on next boot.
 */
export function openDatabase(path: string = databasePath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

let singleton: DatabaseSync | undefined

/**
 * The process-wide handle. Lazy rather than opened at boot because server
 * functions are the only consumers and Nitro gives us no boot hook worth
 * hanging this off; first use pays for the migration, once.
 */
export function getDatabase(): DatabaseSync {
  singleton ??= openDatabase()
  return singleton
}
