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
