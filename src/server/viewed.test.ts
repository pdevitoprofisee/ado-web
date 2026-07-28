// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from './db'
import { contentId, listViewed, setViewed, viewedKey } from './viewed'
import { markViewedRequest, viewedListRequest } from './viewed-fn'

const REPO = 'c4b60ecd-7beb-408e-9813-25a5d067d182'
const OTHER_REPO = 'ad098ab8-fc30-4fe4-982d-460e6c9eb694'
const PR = 24766

/** Uppercase, because that is how ADO sends a sha (T-015). */
const BEFORE = '123EE35863E25FC275A928E68713FA80DC7B051E'
const AFTER = 'F1A56CB989CF1E71DD279C8C542CA0487148BED4'
/** !24766's pure rename carried this sha on both sides. */
const RENAMED = '21C62CD891FD9DBCE5FA224BC6B4416A21796912'

const PATH = '/Api/Auth.Service.Api.csproj'

let dir: string
let path: string
let db: DatabaseSync

const mark = (
  file: { path: string; objectId: string },
  viewed = true,
  pullRequestId = PR,
  repositoryId = REPO,
): void => setViewed({ repositoryId, pullRequestId, path: file.path, objectId: file.objectId }, viewed, db)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-viewed-'))
  path = join(dir, 'app.db')
  db = openDatabase(path)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the mark', () => {
  it('reads back the file it was made on', () => {
    mark({ path: PATH, objectId: AFTER })

    expect(listViewed(REPO, PR, db)).toEqual(new Set([viewedKey(AFTER, PATH)]))
  })

  it('survives a restart, which is the half a session cache could not do', () => {
    mark({ path: PATH, objectId: AFTER })
    db.close()

    db = openDatabase(path)

    expect(listViewed(REPO, PR, db).has(viewedKey(AFTER, PATH))).toBe(true)
  })

  it('comes back off again when it is unset', () => {
    mark({ path: PATH, objectId: AFTER })
    mark({ path: PATH, objectId: AFTER }, false)

    expect(listViewed(REPO, PR, db).size).toBe(0)
    // Unviewed is an absent row and not a `false` column, so there is exactly
    // one representation of it and nothing for `listViewed` to filter.
    expect(db.prepare('SELECT count(*) c FROM viewed_file').get()?.c).toBe(0)
  })

  it('is idempotent — marking twice leaves one row, not two', () => {
    mark({ path: PATH, objectId: AFTER })
    mark({ path: PATH, objectId: AFTER })

    expect(db.prepare('SELECT count(*) c FROM viewed_file').get()?.c).toBe(1)
  })

  it('unsetting a file that was never marked is not an error', () => {
    mark({ path: PATH, objectId: AFTER }, false)

    expect(listViewed(REPO, PR, db).size).toBe(0)
  })
})

describe('keyed to the content, not the path', () => {
  it('does not carry the mark to the same path at a different sha', () => {
    // T-021's entire point. The reviewer read `AFTER`; the author pushed, and
    // the file now arrives in the diff as `BEFORE`. Nothing was invalidated —
    // the old row is still there and simply addresses bytes that are no longer
    // in the pull request.
    mark({ path: PATH, objectId: AFTER })

    const keys = listViewed(REPO, PR, db)

    expect(keys.has(viewedKey(AFTER, PATH))).toBe(true)
    expect(keys.has(viewedKey(BEFORE, PATH))).toBe(false)
  })

  it('leaves an untouched file marked when the push changed something else', () => {
    // The other half of the requirement, and the one a path-plus-iteration key
    // would have got wrong: a push that rewrites `other.cs` must not un-view
    // this file.
    mark({ path: PATH, objectId: AFTER })
    mark({ path: '/Api/Other.cs', objectId: BEFORE })

    expect(listViewed(REPO, PR, db).has(viewedKey(AFTER, PATH))).toBe(true)
  })

  it('re-marking after a push leaves both rows, so going back un-hides nothing', () => {
    mark({ path: PATH, objectId: AFTER })
    mark({ path: PATH, objectId: BEFORE })

    // Two rows for one path is correct: each records a distinct set of bytes
    // that was read. Whichever sha the current iteration serves is the one that
    // matches, and the other costs a set entry.
    expect(listViewed(REPO, PR, db)).toEqual(
      new Set([viewedKey(AFTER, PATH), viewedKey(BEFORE, PATH)]),
    )
  })

  it('keeps two files with byte-identical content apart', () => {
    // Why the path is in the key at all. Key on the sha alone and these two
    // share a row, so ticking one ticks the other — a wrong answer visible on
    // screen.
    mark({ path: '/A/Empty.cs', objectId: AFTER })

    const keys = listViewed(REPO, PR, db)

    expect(keys.has(viewedKey(AFTER, '/A/Empty.cs'))).toBe(true)
    expect(keys.has(viewedKey(AFTER, '/B/Empty.cs'))).toBe(false)
  })

  it('matches a sha whatever case it arrives in', () => {
    // ADO sends shas uppercase, but a key rebuilt from a route param has been
    // through a URL. A mark lost to casing is a file the reviewer reads twice.
    mark({ path: PATH, objectId: AFTER })

    expect(listViewed(REPO, PR, db).has(viewedKey(AFTER.toLowerCase(), PATH))).toBe(true)
  })

  it('matches a repository id whatever case it arrives in', () => {
    mark({ path: PATH, objectId: AFTER }, true, PR, REPO.toUpperCase())

    expect(listViewed(REPO, PR, db).size).toBe(1)
  })
})

describe('scope', () => {
  it('does not leak between repositories', () => {
    mark({ path: PATH, objectId: AFTER })

    expect(listViewed(OTHER_REPO, PR, db).size).toBe(0)
  })

  it('does not leak between pull requests', () => {
    // The same file at the same sha, reached through a second pull request, has
    // not been read in that pull request.
    mark({ path: PATH, objectId: AFTER })

    expect(listViewed(REPO, 24798, db).size).toBe(0)
  })

  it('returns every marked file of the pull request it was asked about', () => {
    mark({ path: '/A.cs', objectId: AFTER })
    mark({ path: '/B.cs', objectId: BEFORE })
    mark({ path: '/C.cs', objectId: AFTER }, true, 24798)
    mark({ path: '/D.cs', objectId: AFTER }, true, PR, OTHER_REPO)

    expect(listViewed(REPO, PR, db)).toEqual(
      new Set([viewedKey(AFTER, '/A.cs'), viewedKey(BEFORE, '/B.cs')]),
    )
  })
})

describe('a delete', () => {
  // T-015: `objectId` was absent on 16 of 16 deletes on !24766, so the
  // after-side sha a mark would normally use does not exist.
  const DELETED = { path: '/Api/Gone.cs', objectId: null, originalObjectId: BEFORE }

  it('hangs its mark on the content that is going away', () => {
    expect(contentId(DELETED)).toBe(BEFORE)
  })

  it('can be marked and read back like any other file', () => {
    mark({ path: DELETED.path, objectId: contentId(DELETED) as string })

    expect(listViewed(REPO, PR, db).has(viewedKey(BEFORE, DELETED.path))).toBe(true)
  })

  it('un-views when a rebase changes the bytes being deleted', () => {
    mark({ path: DELETED.path, objectId: BEFORE })

    const rebased = { path: DELETED.path, objectId: null, originalObjectId: AFTER }

    expect(listViewed(REPO, PR, db).has(viewedKey(contentId(rebased) as string, rebased.path))).toBe(
      false,
    )
  })

  it('is never stored under a NULL sha, which a STRICT primary key forbids outright', () => {
    // Measured on SQLite 3.53.1: a STRICT table makes every PRIMARY KEY column
    // implicitly NOT NULL. Without STRICT the same insert succeeds twice and the
    // table silently holds two marks for one file.
    expect(() =>
      db
        .prepare(
          `INSERT INTO viewed_file (repository_id, pull_request_id, path, object_id, viewed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(REPO, PR, DELETED.path, null, Date.now()),
    ).toThrow(/NOT NULL/)
  })
})

describe('a rename', () => {
  it('un-views a pure rename, even though the bytes did not move', () => {
    // The decision this store makes on purpose. `objectId === originalObjectId`
    // — T-015 measured both sides of !24766's `rename` entry as this same sha —
    // so the content is genuinely unchanged, but the file now claims to live
    // somewhere else and the path is part of the key.
    mark({ path: '/Api/Old.cs', objectId: RENAMED })

    const keys = listViewed(REPO, PR, db)

    expect(keys.has(viewedKey(RENAMED, '/Api/New.cs'))).toBe(false)
    expect(keys.has(viewedKey(RENAMED, '/Api/Old.cs'))).toBe(true)
  })

  it('resolves a pure rename to the one sha it carries twice', () => {
    expect(contentId({ objectId: RENAMED, originalObjectId: RENAMED })).toBe(RENAMED)
  })

  it('un-views an `edit, rename` for both reasons at once', () => {
    mark({ path: '/Api/Old.cs', objectId: BEFORE })

    const moved = { path: '/Api/New.cs', objectId: AFTER, originalObjectId: BEFORE }

    expect(
      listViewed(REPO, PR, db).has(viewedKey(contentId(moved) as string, moved.path)),
    ).toBe(false)
  })
})

describe('contentId', () => {
  it('prefers the after-side sha on an edit', () => {
    expect(contentId({ objectId: AFTER, originalObjectId: BEFORE })).toBe(AFTER)
  })

  it('answers with the after-side sha on an add, which has no before', () => {
    expect(contentId({ objectId: AFTER, originalObjectId: null })).toBe(AFTER)
  })

  it('is null for a change entry with a blob on neither side', () => {
    expect(contentId({ objectId: null, originalObjectId: null })).toBeNull()
  })
})

describe('validation at the edge', () => {
  // Bound parameters already stop injection. What these reject is a value that
  // would write a row nothing can ever look up again — a mark that fails
  // silently, which the reviewer only discovers by re-reading a file.
  it('accepts a well-formed list request', () => {
    expect(viewedListRequest({ repositoryId: REPO, id: PR })).toEqual({
      repositoryId: REPO,
      id: PR,
    })
  })

  it.each([
    ['a repository id that is not a GUID', { repositoryId: '../../etc', id: PR }],
    ['a percent-encoded traversal', { repositoryId: '%2e%2e%2f', id: PR }],
    ['a missing repository id', { id: PR }],
    ['a pull request id of zero', { repositoryId: REPO, id: 0 }],
    ['a negative pull request id', { repositoryId: REPO, id: -1 }],
    ['a pull request id that is a string', { repositoryId: REPO, id: '24766' }],
    ['a fractional pull request id', { repositoryId: REPO, id: 1.5 }],
    ['nothing at all', undefined],
  ])('rejects %s', (_case, input) => {
    expect(() => viewedListRequest(input)).toThrow()
  })

  it('accepts a well-formed mark', () => {
    expect(
      markViewedRequest({
        repositoryId: REPO,
        id: PR,
        path: PATH,
        objectId: AFTER,
        originalObjectId: BEFORE,
        viewed: true,
      }),
    ).toEqual({
      repositoryId: REPO,
      id: PR,
      path: PATH,
      objectId: AFTER,
      originalObjectId: BEFORE,
      viewed: true,
    })
  })

  it('accepts a delete, whose missing after-sha is a real answer and not a bad one', () => {
    expect(
      markViewedRequest({
        repositoryId: REPO,
        id: PR,
        path: PATH,
        objectId: null,
        originalObjectId: BEFORE,
        viewed: true,
      }).objectId,
    ).toBeNull()
  })

  it.each([
    ['a sha that is not 40 hex', { objectId: 'not-a-sha' }],
    ['a sha with one hex digit too many', { objectId: `${AFTER}A` }],
    ['a numeric sha', { objectId: 12345 }],
    ['an empty path', { path: '' }],
    ['a missing path', { path: undefined }],
    ['a non-boolean viewed', { viewed: 'true' }],
    ['a missing viewed', { viewed: undefined }],
  ])('rejects %s', (_case, override) => {
    expect(() =>
      markViewedRequest({
        repositoryId: REPO,
        id: PR,
        path: PATH,
        objectId: AFTER,
        originalObjectId: BEFORE,
        viewed: true,
        ...override,
      }),
    ).toThrow()
  })
})
