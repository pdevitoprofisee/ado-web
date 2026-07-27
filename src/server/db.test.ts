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
  it('creates the round-1 schema and records the version', () => {
    const db = openDatabase(join(dir, 'app.db'))

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => row.name)

    // Round-1 tables only. Empty tables for later phases are not schema, they
    // are guesses; the phase that needs one adds it.
    expect(tables).toEqual(['pr_cache', 'schema_migrations'])
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'pr-cache' },
    ])

    db.close()
  })

  it('is idempotent — re-running applies nothing and preserves data', () => {
    const path = join(dir, 'app.db')
    const first = openDatabase(path)
    writePrCache(7, 'a'.repeat(40), { checks: 'green' }, first)
    first.close()

    const second = openDatabase(path)
    migrate(second) // and again, in-process, for good measure

    expect(second.prepare('SELECT count(*) c FROM schema_migrations').get()?.c).toBe(1)
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
