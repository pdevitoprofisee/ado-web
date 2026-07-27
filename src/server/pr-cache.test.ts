// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from './db'
import { readPrCache, writePrCache } from './pr-cache'

const OLD = 'a'.repeat(40)
const PUSHED = 'b'.repeat(40)

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-cache-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('pr cache', () => {
  it('returns the payload when the commit matches', () => {
    writePrCache(42, OLD, { unresolved: 3 }, db)
    expect(readPrCache(42, OLD, db)).toEqual({ unresolved: 3 })
  })

  it('misses when the PR has been pushed to', () => {
    writePrCache(42, OLD, { unresolved: 3 }, db)

    // The whole point of the validity token: a new head commit means the
    // hydrated data is stale, and the store refuses to serve it. T-007's
    // "zero calls on an unchanged inbox" is only safe if this half is exact.
    expect(readPrCache(42, PUSHED, db)).toBeUndefined()
  })

  it('misses on a PR it has never seen', () => {
    expect(readPrCache(999, OLD, db)).toBeUndefined()
  })

  it('replaces the row on re-hydration instead of accumulating rows', () => {
    writePrCache(42, OLD, { unresolved: 3 }, db)
    writePrCache(42, PUSHED, { unresolved: 0 }, db)

    expect(db.prepare('SELECT count(*) c FROM pr_cache').get()?.c).toBe(1)
    expect(readPrCache(42, PUSHED, db)).toEqual({ unresolved: 0 })
    expect(readPrCache(42, OLD, db)).toBeUndefined()
  })
})
