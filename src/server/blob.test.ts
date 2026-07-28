// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdoError } from './ado-client'
import { MAX_BLOB_BYTES, loadFileBlobs, readBlob } from './blob'
import { openDatabase } from './db'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoBytes, AdoBytesOptions, AdoClient, QueryValue } from './ado-client'
import type { BlobRepo } from './blob'
import type { BlobSide } from '../lib/diff-contract'

const REPO: BlobRepo = {
  projectId: 'ad098ab8-fc30-4fe4-982d-460e6c9eb694',
  repositoryId: 'c4b60ecd-7beb-408e-9813-25a5d067d182',
}

const BEFORE = '123EE35863E25FC275A928E68713FA80DC7B051E'
const AFTER = 'F1A56CB989CF1E71DD279C8C542CA0487148BED4'
/** !24766's pure rename carried this sha on both sides. */
const RENAMED = '21C62CD891FD9DBCE5FA224BC6B4416A21796912'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * The first 16 bytes of the live `/Common/Common/Resources/group24.png`: PNG
 * magic, then the IHDR chunk length. First NUL at index 8, which is the only
 * property the detection is allowed to use.
 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

/**
 * A blob as the wire delivers it. `declared` is `Content-Length`, and `null`
 * models the chunked response ADO sends above ~256 KiB — the case where the
 * body arrives whether we wanted it or not.
 */
type Fixture = Uint8Array | Error | { declared: number | null; body: Uint8Array }

const normalise = (fixture: Exclude<Fixture, Error>): { declared: number | null; body: Uint8Array } =>
  fixture instanceof Uint8Array ? { declared: fixture.length, body: fixture } : fixture

/**
 * Reproduces `getBytes`'s contract rather than approximating it, because two of
 * the cases under test *are* that contract: a declared size over `maxBytes`
 * comes back as a null body, and `bodiesServed` records that the body was never
 * handed over. `calls` is the client's own counter, which is what the ticket
 * asks the caching claim to be proved against.
 */
function fakeClient(blobs: Record<string, Fixture>) {
  let calls = 0
  let bodiesServed = 0
  const shas: string[] = []

  const client: AdoClient = {
    org: 'Profisee',
    get: () => Promise.reject(new Error('this fixture serves blobs only')),
    getBytes(
      path: string,
      params: Record<string, QueryValue> = {},
      { maxBytes }: AdoBytesOptions = {},
    ): Promise<AdoBytes> {
      calls++
      const sha = path.slice(path.lastIndexOf('/') + 1)
      shas.push(sha)

      const fixture = blobs[sha]
      if (fixture === undefined) return Promise.reject(new Error(`unexpected blob: ${sha}`))
      if (fixture instanceof Error) return Promise.reject(fixture)

      expect(params.$format).toBe('text')

      const { declared, body } = normalise(fixture)
      // Live, 44 of 44 text blobs answered with this and nothing else.
      const contentType = 'application/octet-stream; api-version=7.1'

      if (maxBytes !== undefined && declared !== null && declared > maxBytes) {
        return Promise.resolve({ bytes: null, size: declared, contentType })
      }
      bodiesServed++

      return Promise.resolve({ bytes: body, size: declared, contentType })
    },
    fanOut: (items, task) => Promise.all(items.map((item) => task(item))),
    rateLimit: () => ({
      remaining: null,
      limit: null,
      delay: null,
      resetAt: null,
      throttledUntil: null,
      throttled: false,
      calls,
      cost: 0,
    }),
  }

  return { client, shas, served: () => bodiesServed }
}

function textSide(side: BlobSide): Extract<BlobSide, { kind: 'text' }> {
  if (side.kind !== 'text') throw new Error(`expected text, got ${side.kind}`)

  return side
}

/** The inverse of the split. Nothing may be lost between here and `readBlob`. */
const rejoin = (side: Extract<BlobSide, { kind: 'text' }>): string =>
  side.lines.length === 0 ? '' : side.lines.join('\n') + (side.noFinalNewline ? '' : '\n')

const roundTrip = (source: string): string => rejoin(textSide(readBlob(encode(source))))

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-blob-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the four changes with a missing side', () => {
  it('gives an add an absent before and fetches only the after', async () => {
    const { client, shas } = fakeClient({ [AFTER]: encode('new\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/src/new.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(blobs.before).toEqual({ kind: 'absent' })
    expect(textSide(blobs.after).lines).toEqual(['new'])
    expect(blobs.renamedOnly).toBe(false)
    expect(shas).toEqual([AFTER])
  })

  it('gives a delete an absent after and fetches only the before', async () => {
    // Live !24766: `item.objectId` is absent on 16 of 16 deletes, and the path
    // is on the entry rather than the item. The sha pair alone says "delete".
    const { client, shas } = fakeClient({ [BEFORE]: encode('gone\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/src/gone.cs', objectId: null, originalObjectId: BEFORE },
      db,
    )

    expect(textSide(blobs.before).lines).toEqual(['gone'])
    expect(blobs.after).toEqual({ kind: 'absent' })
    expect(shas).toEqual([BEFORE])
  })

  it('fetches nothing at all for a pure rename', async () => {
    const { client } = fakeClient({})

    const blobs = await loadFileBlobs(
      client,
      REPO,
      {
        path: '/CrewChief/CrewChief.Web/SampleContent/reference-data/configuration-values.refkv.json',
        objectId: RENAMED,
        originalObjectId: RENAMED,
      },
      db,
    )

    expect(client.rateLimit().calls).toBe(0)
    expect(blobs).toEqual({
      path: blobs.path,
      before: { kind: 'absent' },
      after: { kind: 'absent' },
      renamedOnly: true,
    })
  })

  it('treats an edit-and-rename as an ordinary two-sided change', async () => {
    // !24766 carried both: `rename` with one sha twice, `edit, rename` with two.
    const { client } = fakeClient({ [BEFORE]: encode('a\n'), [AFTER]: encode('b\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/moved.json', objectId: AFTER, originalObjectId: BEFORE },
      db,
    )

    expect(blobs.renamedOnly).toBe(false)
    expect(client.rateLimit().calls).toBe(2)
  })
})

describe('binary, decided from the bytes', () => {
  it('calls the live png binary on its NUL at index 8', async () => {
    const { client } = fakeClient({ [AFTER]: PNG })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/Common/Common/Resources/group24.png', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(blobs.after).toEqual({ kind: 'binary', bytes: 16 })
    // The alternative this exists to avoid: decoding it produced 263 U+FFFD on
    // the real 750-byte file, and 3 on these 16 bytes.
    expect(new TextDecoder().decode(PNG)).toContain('�')
  })

  it('does not consult the extension — a .png full of text is text', async () => {
    const { client } = fakeClient({ [AFTER]: encode('<svg />\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/assets/logo.png', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(textSide(blobs.after).lines).toEqual(['<svg />'])
  })

  it('does not consult Content-Type, which is octet-stream on every text blob', async () => {
    const { client } = fakeClient({ [AFTER]: encode('using System;\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/Program.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    // The fixture answers `application/octet-stream; api-version=7.1`, as ADO
    // did on 44 of 44 sampled text blobs. It is still text.
    expect(blobs.after.kind).toBe('text')
  })

  it('only sniffs the front, and says so: a NUL past 8 KiB reads as text', () => {
    const late = new Uint8Array(9000)
    late.fill(0x61)
    late[8500] = 0

    expect(readBlob(late).kind).toBe('text')
  })
})

describe('the size ceiling', () => {
  it('refuses a declared oversize blob without its body being read', async () => {
    const { client, served } = fakeClient({
      [AFTER]: { declared: MAX_BLOB_BYTES + 1, body: encode('never handed over') },
    })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/big.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(blobs.after).toEqual({ kind: 'too-large', bytes: MAX_BLOB_BYTES + 1 })
    expect(served()).toBe(0)
  })

  it('still refuses a chunked oversize blob, which declares no size at all', async () => {
    // The 15 live blobs above ~256 KiB arrive `Transfer-Encoding: chunked` with
    // no `Content-Length`, so `maxBytes` cannot fire and the body is in hand
    // before anything can be decided. Refusing it is still the right answer;
    // refusing it *unread* needs a change in `ado-client.ts`.
    const huge = new Uint8Array(MAX_BLOB_BYTES + 64).fill(0x61)
    const { client, served } = fakeClient({ [AFTER]: { declared: null, body: huge } })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/Common/Common/Properties/Strings.Designer.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(blobs.after).toEqual({ kind: 'too-large', bytes: MAX_BLOB_BYTES + 64 })
    expect(served()).toBe(1)
  })

  it('is a result the view renders, not a throw, and leaves the other side alone', async () => {
    const { client } = fakeClient({
      [BEFORE]: encode('small\n'),
      [AFTER]: { declared: MAX_BLOB_BYTES + 1, body: new Uint8Array(0) },
    })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/grew.cs', objectId: AFTER, originalObjectId: BEFORE },
      db,
    )

    expect(textSide(blobs.before).lines).toEqual(['small'])
    expect(blobs.after.kind).toBe('too-large')
  })
})

describe('the cache, keyed on a sha that cannot mean two things', () => {
  const file = { path: '/Program.cs', objectId: AFTER, originalObjectId: BEFORE }

  it('makes a second open of the same file cost no calls', async () => {
    const { client } = fakeClient({ [BEFORE]: encode('a\nb\n'), [AFTER]: encode('a\nc\n') })

    const first = await loadFileBlobs(client, REPO, file, db)
    const afterFirst = client.rateLimit().calls
    const second = await loadFileBlobs(client, REPO, file, db)

    expect(afterFirst).toBe(2)
    expect(client.rateLimit().calls).toBe(2)
    expect(second).toEqual(first)
  })

  it('survives a restart — a new process, a new client, the same file', async () => {
    const path = join(dir, 'restart.db')
    const warm = openDatabase(path)
    const first = fakeClient({ [BEFORE]: encode('a\nb\n'), [AFTER]: encode('a\nc\n') })
    const before = await loadFileBlobs(first.client, REPO, file, warm)
    warm.close()

    // Nothing in memory carries over: a different database handle, a different
    // client, and a fixture that would throw if either blob were asked for.
    const cold = openDatabase(path)
    const second = fakeClient({})
    const after = await loadFileBlobs(second.client, REPO, file, cold)
    cold.close()

    expect(second.client.rateLimit().calls).toBe(0)
    expect(after).toEqual(before)
  })

  it('caches the refusal too, so re-opening an oversize file also costs nothing', async () => {
    const { client } = fakeClient({
      [AFTER]: { declared: MAX_BLOB_BYTES + 1, body: new Uint8Array(0) },
    })
    const oversize = { path: '/big.cs', objectId: AFTER, originalObjectId: null }

    await loadFileBlobs(client, REPO, oversize, db)
    const again = await loadFileBlobs(client, REPO, oversize, db)

    expect(client.rateLimit().calls).toBe(1)
    expect(again.after).toEqual({ kind: 'too-large', bytes: MAX_BLOB_BYTES + 1 })
  })

  it('refetches a cached refusal whose size the ceiling has since grown past', async () => {
    // A row with no body is a refusal, not content, and it is the one row the
    // ceiling can invalidate. Written here as an older, stricter ceiling would
    // have left it.
    db.prepare('INSERT INTO blob_cache (object_id, size, bytes, fetched_at) VALUES (?, ?, ?, ?)').run(
      AFTER,
      1024,
      null,
      Date.now(),
    )
    const { client } = fakeClient({ [AFTER]: encode('readable now\n') })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/small.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(client.rateLimit().calls).toBe(1)
    expect(textSide(blobs.after).lines).toEqual(['readable now'])
  })

  it('never invalidates a blob it has bytes for, even as the file list moves on', async () => {
    const { client } = fakeClient({ [BEFORE]: encode('a\n'), [AFTER]: encode('b\n') })

    await loadFileBlobs(client, REPO, file, db)
    // A new push renames the file and re-uses the same after-sha. A sha is the
    // hash of the content, so the cached bytes are still exactly right — there
    // is nothing here for a validity token to protect against.
    const moved = await loadFileBlobs(
      client,
      REPO,
      { path: '/renamed/Program.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(client.rateLimit().calls).toBe(2)
    expect(textSide(moved.after).lines).toEqual(['b'])
  })
})

describe('one blob failing', () => {
  it('fails that side and leaves the other one readable', async () => {
    // T-015: a valid-looking sha that does not exist answers 400 `TF401035`,
    // not 404.
    const { client } = fakeClient({
      [BEFORE]: new AdoError(400, 'Azure DevOps answered 400.', "TF401035: The object '000…' does not exist."),
      [AFTER]: encode('still here\n'),
    })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/Program.cs', objectId: AFTER, originalObjectId: BEFORE },
      db,
    )

    expect(blobs.before.kind).toBe('failed')
    expect(blobs.before).toMatchObject({ message: expect.stringContaining('TF401035') })
    expect(textSide(blobs.after).lines).toEqual(['still here'])
  })

  it('does not cache the failure — a blip must not become permanent', async () => {
    const flaky: Record<string, Fixture> = { [AFTER]: new AdoError(503, 'Azure DevOps answered 503.') }
    const { client } = fakeClient(flaky)
    const file = { path: '/Program.cs', objectId: AFTER, originalObjectId: null }

    expect((await loadFileBlobs(client, REPO, file, db)).after.kind).toBe('failed')

    flaky[AFTER] = encode('recovered\n')
    expect(textSide((await loadFileBlobs(client, REPO, file, db)).after).lines).toEqual(['recovered'])
  })

  it('reports a timeout as a failed side too, not as a lost file', async () => {
    const { client } = fakeClient({
      [AFTER]: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    })

    const blobs = await loadFileBlobs(
      client,
      REPO,
      { path: '/Program.cs', objectId: AFTER, originalObjectId: null },
      db,
    )

    expect(blobs.after).toMatchObject({ kind: 'failed', message: expect.stringContaining('timeout') })
  })
})

describe('line splitting, which loses nothing', () => {
  it('round-trips LF, the ordinary case', () => {
    expect(roundTrip('using System;\nnamespace X;\n')).toBe('using System;\nnamespace X;\n')
  })

  it('keeps the CR of a CRLF file on the line, where the diff can see it', () => {
    // `/Api/Auth.Service.Api.csproj` is 112 CRLF of 112 endings; `/Api/web.config`
    // is 27 of 27. Stripping the CR would hide a whole class of real change.
    const side = textSide(readBlob(encode('<Project>\r\n</Project>\r\n')))

    expect(side.lines).toEqual(['<Project>\r', '</Project>\r'])
    expect(rejoin(side)).toBe('<Project>\r\n</Project>\r\n')
  })

  it('records a missing final newline rather than inventing one', () => {
    // 4 of 44 blobs sampled on !24766 end without one.
    const side = textSide(readBlob(encode('{\n  "a": 1\n}')))

    expect(side.lines).toEqual(['{', '  "a": 1', '}'])
    expect(side.noFinalNewline).toBe(true)
    expect(rejoin(side)).toBe('{\n  "a": 1\n}')
  })

  it('keeps a BOM instead of normalising it away', () => {
    // 19 of 30 sampled .csproj/.props/.ps1/.config blobs start `ef bb bf`.
    // `TextDecoder` strips it by default; `ignoreBOM: true` is what keeps the
    // round trip exact and keeps "a BOM was added" a visible change.
    const source = '﻿<Project>\n'
    const side = textSide(readBlob(encode(source)))

    expect(side.lines[0]).toBe('﻿<Project>')
    expect(rejoin(side)).toBe(source)
  })

  it('round-trips the live triple: BOM, CRLF and no final newline at once', () => {
    // `/Api/web.config` is all three, in one 1008-byte file.
    const source = '﻿<?xml version="1.0"?>\r\n<configuration>\r\n</configuration>'
    const side = textSide(readBlob(encode(source)))

    expect(side.noFinalNewline).toBe(true)
    expect(rejoin(side)).toBe(source)
  })

  it('treats an empty file as no lines, and round-trips that too', () => {
    const side = textSide(readBlob(new Uint8Array(0)))

    expect(side).toEqual({ kind: 'text', lines: [], bytes: 0, noFinalNewline: false })
    expect(rejoin(side)).toBe('')
  })

  it('counts bytes, not characters', () => {
    // A `.cs` file full of accented strings is not shorter than it is.
    const side = textSide(readBlob(encode('héllo\n')))

    expect(side.bytes).toBe(7)
    expect(side.lines).toEqual(['héllo'])
  })

  it('keeps a lone CR as content rather than as a line break', () => {
    // Never seen live (0 of 44), and split on `\n` only, so an old-Mac ending
    // stays inside the line it was in. Written down because it is a decision.
    const side = textSide(readBlob(encode('a\rb\n')))

    expect(side.lines).toEqual(['a\rb'])
    expect(rejoin(side)).toBe('a\rb\n')
  })
})
