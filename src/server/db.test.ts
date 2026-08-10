// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { databasePath, dataDir, migrate, openDatabase } from './db'
import { readPrCache, writePrCache } from './pr-cache'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-db-'))
})

afterEach(() => {
  delete process.env.ADO_WEB_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('database location', () => {
  it('lives under per-user application data, not the repo', () => {
    const path = databasePath()

    expect(path.endsWith('ado-web.db')).toBe(true)
    expect(dataDir()).toContain('ado-web')
    expect(path).not.toContain(process.cwd())
  })

  it('honours ADO_WEB_DATA_DIR so tests never touch the real path', () => {
    process.env.ADO_WEB_DATA_DIR = dir
    expect(databasePath()).toBe(join(dir, 'ado-web.db'))
  })
})

describe('migrations', () => {
  it('creates every shipped table and records each version', () => {
    const db = openDatabase(join(dir, 'app.db'))

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => row.name)

    // Shipped tables only. Empty tables for later phases are not schema, they
    // are guesses; the phase that needs one adds it.
    expect(tables).toEqual([
      'blob_cache',
      'local_viewed_file',
      'notification',
      'pr_cache',
      'pr_signal',
      'schema_migrations',
      'viewed_file',
    ])
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'pr-cache' },
      { version: 2, name: 'blob-cache' },
      { version: 3, name: 'viewed-files' },
      { version: 4, name: 'pr-cache-ready' },
      { version: 5, name: 'notification-log' },
      { version: 6, name: 'pr-signal' },
      { version: 7, name: 'local-viewed-files' },
      { version: 8, name: 'pr-cache-check-states' },
      { version: 9, name: 'pr-cache-waiting-on-people' },
    ])

    db.close()
  })

  it('lets blob_cache hold a NULL body, which is how a refusal is stored', () => {
    // STRICT tables reject a type mismatch outright, so this is worth pinning:
    // `bytes` is the one nullable column, and a row with no bytes is the cached
    // "too large to render" answer rather than missing data.
    const db = openDatabase(join(dir, 'app.db'))

    db.prepare('INSERT INTO blob_cache (object_id, size, bytes, fetched_at) VALUES (?, ?, ?, ?)').run(
      'a'.repeat(40),
      4_238_334,
      null,
      Date.now(),
    )
    const row = db.prepare('SELECT size, bytes FROM blob_cache').get()

    expect(row).toEqual({ size: 4_238_334, bytes: null })

    db.close()
  })

  it('empties pr_cache when a migration changes the cached payload shape', () => {
    // Rehearses the upgrade an existing machine actually performs: rows written
    // under the old `Hydration` shape are still keyed on a current commit, so
    // nothing would refetch them and the inbox would draw them as not ready
    // forever. Version 4 is rolled back by hand because `openDatabase` has
    // already applied it.
    const path = join(dir, 'app.db')
    const db = openDatabase(path)
    db.prepare('DELETE FROM schema_migrations WHERE version = 4').run()
    writePrCache(7, 'a'.repeat(40), { checks: 'green' }, db)

    migrate(db)

    expect(readPrCache(7, 'a'.repeat(40), db)).toBeUndefined()

    db.close()
  })

  it('is idempotent — re-running applies nothing and preserves data', () => {
    const path = join(dir, 'app.db')
    const first = openDatabase(path)
    writePrCache(7, 'a'.repeat(40), { checks: 'green' }, first)
    first.close()

    const second = openDatabase(path)
    migrate(second) // and again, in-process, for good measure

    expect(second.prepare('SELECT count(*) c FROM schema_migrations').get()?.c).toBe(9)
    expect(readPrCache(7, 'a'.repeat(40), second)).toEqual({ checks: 'green' })

    second.close()
  })
})

describe('recovery', () => {
  it('treats a deleted database file as a clean slate, not a crash', () => {
    const path = join(dir, 'app.db')
    const before = openDatabase(path)
    writePrCache(7, 'a'.repeat(40), { checks: 'green' }, before)
    before.close()

    unlinkSync(path)

    const after = openDatabase(path)
    expect(after.prepare('SELECT count(*) c FROM pr_cache').get()?.c).toBe(0)
    expect(readPrCache(7, 'a'.repeat(40), after)).toBeUndefined()

    after.close()
  })

  it('creates the data directory rather than requiring it to exist', () => {
    const path = join(dir, 'nested', 'deeper', 'app.db')
    expect(existsSync(path)).toBe(false)

    const db = openDatabase(path)
    expect(existsSync(path)).toBe(true)

    db.close()
  })
})
