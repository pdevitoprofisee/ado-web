import { getDatabase } from './db'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoClient } from './ado-client'
import type { BlobSide, FileBlobs } from '../lib/diff-contract'

// Server-only. A changed file's two shas turned into the two sides the diff
// compares — and, for the four cases that have no text, into the result the
// view renders instead of text.
//
// What the live probe settled, so nothing below re-derives it. All figures are
// from 705 distinct blobs across 60 completed pull requests in `Profisee`:
//
//   - **A delete has no `objectId` and an add has no `originalObjectId`** —
//     16/16 and 84/84 on !24766. So the sha pair alone says which of add, edit,
//     delete and rename this is, and `changeType` is not needed here. One
//     source of truth for "is there a before", and it is the one the fetch
//     actually depends on.
//   - **A pure rename carries the same sha twice.** !24766's `rename` entry had
//     `21C62CD8…` on both sides; its `edit, rename` entry had two different
//     shas. Sha equality is therefore the test, not the word.
//   - `Content-Type` is `application/octet-stream; api-version=7.1` on 44/44
//     text blobs. It carries no text-versus-binary signal and is not read.
//   - `$format=text`, `$format=octetstream` and no `$format` at all returned
//     byte-identical bodies (T-015). `text` is passed anyway, as documentation:
//     it costs nothing and does not leave us relying on an unstated default.
//   - Blob bodies are not compressed — `Content-Length` equalled the byte count
//     on 690/690 blobs that declared one — so the ceiling below compares like
//     with like. (`$format=json` *is* compressed: 362 declared for a 607 b
//     body. Another reason not to reach for it.)

/**
 * The size ceiling, and a policy choice rather than a fitted one — but now a
 * measured policy choice.
 *
 * Live, the largest blob is 4,238,334 b (`Strings.Designer.cs`, machine-
 * generated) and the largest hand-written one is 635,664 b. At 1 MiB, 8 of 705
 * sampled blobs are refused and every one of them is a generated `.resx` or
 * `.Designer.cs` — nothing a person reviews line by line. T-015 could find
 * nothing above 7,164 b and said so; this is the number that replaces it, and
 * it should still move the first time a minified bundle goes through it.
 */
export const MAX_BLOB_BYTES = 1024 * 1024

/**
 * How much of the front of a blob is searched for a NUL.
 *
 * The live `.png` puts its first NUL at index 8, right behind the magic, and
 * every real binary format announces itself in the first few bytes. 8 KiB is
 * generous enough that the window is not the thing that decides, and small
 * enough that it is not a second pass over a megabyte.
 */
const SNIFF_BYTES = 8 * 1024

/** Where a blob lives. A blob is repository-scoped; the pull request is not in the URL. */
export interface BlobRepo {
  readonly projectId: string
  readonly repositoryId: string
}

/**
 * The three fields of a `ChangedFile` that a fetch needs. Structurally
 * satisfied by `ChangedFile` itself, so the caller passes the row it already
 * has rather than a translation of it.
 */
export interface BlobRequest {
  readonly path: string
  readonly objectId: string | null
  readonly originalObjectId: string | null
}

const ABSENT: BlobSide = { kind: 'absent' }

/**
 * `ignoreBOM` is the whole point: the default strips a leading U+FEFF, and a
 * BOM is content here. 19 of 30 sampled `.csproj`/`.props`/`.ps1`/`.config`
 * blobs in this org start with `ef bb bf`, and a change that adds or removes
 * one is a real change that `git diff` shows. Keeping it means a BOM survives
 * the round trip untouched and both sides of an unchanged file still compare
 * equal, because both keep it.
 */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * Split on `\n` with `\r` left exactly where it was.
 *
 * CRLF is live here — `/Api/web.config` is 27 CRLF out of 27 line endings, and
 * `/Api/Auth.Service.Api.csproj` is 112 of 112 — and stripping the `\r` would
 * hide a whole class of real change. The trailing empty element that `split`
 * produces for a file ending in a newline is dropped rather than kept as a
 * blank last line; that a file did *not* end in one is carried as
 * `noFinalNewline` instead, which is what `git diff` prints. 4 of 44 blobs
 * sampled on !24766 have no final newline, so this is the common case's twin,
 * not an edge.
 *
 * The round trip is `lines.join('\n')` plus a `\n` unless `noFinalNewline`,
 * with the empty file — no lines at all — as its own case. Nothing is
 * normalised away.
 */
function toLines(text: string): { lines: string[]; noFinalNewline: boolean } {
  if (text === '') return { lines: [], noFinalNewline: false }

  const lines = text.split('\n')
  const noFinalNewline = lines[lines.length - 1] !== ''
  if (!noFinalNewline) lines.pop()

  return { lines, noFinalNewline }
}

/**
 * Bytes to a side, deciding text-versus-binary from the bytes and nothing else.
 *
 * The live `/Common/Common/Resources/group24.png` is the case: 750 b, magic
 * `89 50 4e 47 0d 0a 1a 0a`, first NUL at index 8, and 263 U+FFFD if it is
 * decoded as UTF-8. Its extension would have worked here; `Content-Type` would
 * not, and the extension stops working the moment someone commits a `.dat` or a
 * `.png` full of SVG. A NUL is the property that actually distinguishes them.
 */
export function readBlob(bytes: Uint8Array): BlobSide {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
    return { kind: 'binary', bytes: bytes.length }
  }

  const { lines, noFinalNewline } = toLines(decoder.decode(bytes))

  return { kind: 'text', lines, bytes: bytes.length, noFinalNewline }
}

interface CachedBlob {
  readonly size: number
  readonly bytes: Uint8Array | null
}

function readBlobCache(objectId: string, db: DatabaseSync): CachedBlob | undefined {
  const row = db.prepare('SELECT size, bytes FROM blob_cache WHERE object_id = ?').get(objectId)
  if (row === undefined) return undefined

  return { size: row.size as number, bytes: row.bytes as Uint8Array | null }
}

/**
 * `INSERT OR REPLACE` rather than `INSERT`, and it is never an update in any
 * meaningful sense: the only way to write a second row for the same sha is to
 * fetch the same content twice, which two concurrent opens of the same file can
 * genuinely do.
 */
function writeBlobCache(
  objectId: string,
  size: number,
  bytes: Uint8Array | null,
  db: DatabaseSync,
): void {
  db.prepare(
    `INSERT INTO blob_cache (object_id, size, bytes, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(object_id) DO UPDATE SET
       size       = excluded.size,
       bytes      = excluded.bytes,
       fetched_at = excluded.fetched_at`,
  ).run(objectId, size, bytes, Date.now())
}

/** `null` when the row cannot answer today's question and the blob must be refetched. */
function fromCache(row: CachedBlob): BlobSide | null {
  if (row.bytes !== null) return readBlob(row.bytes)

  return row.size > MAX_BLOB_BYTES ? { kind: 'too-large', bytes: row.size } : null
}

/**
 * One sha, from the cache if it is there and from Azure DevOps if it is not.
 *
 * **The cache is never invalidated, and that is not an optimisation to be
 * tidied up later — it is the reason it is safe.** `object_id` is the sha of
 * the bytes, so a sha cannot come to mean something else; a row is either the
 * content or it is not there. There is no commit token here as there is in
 * `pr-cache.ts`, no TTL, and no `ETag` to compare — T-015 measured that blobs
 * carry none, and a content-addressed object has nothing to do with one.
 *
 * **The size guard does not fire where it is needed, and cannot from here.**
 * `getBytes` refuses on `Content-Length` before reading the body, which is
 * exactly right — but ADO sends `Content-Length` only *below* about 256 KiB and
 * switches to `Transfer-Encoding: chunked` above it. Measured: present on 690
 * of 705 blobs, absent on 15, largest declared 251,913 b, smallest chunked
 * 263,283 b, no overlap. So every blob big enough to refuse is precisely the
 * one that declares no size, `maxBytes` never fires live, and the second check
 * below — on bytes already in hand — is the one that does. Passing `maxBytes`
 * is still correct and still free; it just has an empty live domain. Refusing a
 * chunked response unread needs `getBytes` to look at `Transfer-Encoding` or to
 * abort the stream, and that is `ado-client.ts`'s to decide, not this file's.
 *
 * What that costs, measured: the 4,238,334 b `Strings.Designer.cs` takes 609 ms
 * to download and throw away. The refusal is cached with it, so that happens
 * once per sha and never again — which is what makes the gap survivable rather
 * than urgent.
 */
async function fetchSide(
  client: AdoClient,
  repo: BlobRepo,
  sha: string,
  db: DatabaseSync,
): Promise<BlobSide> {
  const cached = readBlobCache(sha, db)
  if (cached !== undefined) {
    const hit = fromCache(cached)
    if (hit !== null) return hit
  }

  const { bytes, size } = await client.getBytes(
    `${repo.projectId}/_apis/git/repositories/${repo.repositoryId}/blobs/${sha}`,
    { $format: 'text' },
    { maxBytes: MAX_BLOB_BYTES },
  )
  // A null body means `getBytes` compared a real `Content-Length` and refused,
  // so `size` is present whenever that happens.
  const length = bytes === null ? (size ?? 0) : bytes.length

  if (bytes === null || length > MAX_BLOB_BYTES) {
    writeBlobCache(sha, length, null, db)

    // The contract calls this `bytes` "declared, not counted". On the chunked
    // path above it is counted, because ADO declared nothing to count against.
    return { kind: 'too-large', bytes: length }
  }

  writeBlobCache(sha, length, bytes, db)

  return readBlob(bytes)
}

/**
 * One failing blob costs one side of one file and nothing else.
 *
 * Not narrowed to `AdoError`, though that is the expected one — T-015 measured
 * a 400 (`TF401035`) for a sha that does not exist, not a 404. A 30-second
 * timeout arrives as a `DOMException` and is no better a reason to lose the
 * other side of the file, or the file list behind it.
 */
async function side(
  client: AdoClient,
  repo: BlobRepo,
  sha: string,
  db: DatabaseSync,
): Promise<BlobSide> {
  try {
    return await fetchSide(client, repo, sha, db)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Both sides of one changed file.
 *
 * The two fetches go through `client.fanOut` rather than `Promise.all` for the
 * reason `pull-request.ts` gives: the concurrency cap and the throttle gate
 * live in the client, and going around them is how a diff spends a budget
 * nobody is metering. Blob text carries no `X-RateLimit-Cost` at all, so
 * `rateLimit().calls` is the only honest meter this makes a mark on.
 */
export async function loadFileBlobs(
  client: AdoClient,
  repo: BlobRepo,
  file: BlobRequest,
  db: DatabaseSync = getDatabase(),
): Promise<FileBlobs> {
  const { objectId, originalObjectId } = file

  // The bytes did not move, only the name did. Fetching either sha would return
  // the same content and the view would render an empty diff that reads as a
  // bug — so nothing is fetched and the caller is told why.
  if (objectId !== null && objectId === originalObjectId) {
    return { path: file.path, before: ABSENT, after: ABSENT, renamedOnly: true }
  }

  const [before, after] = await client.fanOut([originalObjectId, objectId], (sha) =>
    sha === null ? Promise.resolve(ABSENT) : side(client, repo, sha, db),
  )

  return { path: file.path, before, after, renamedOnly: false }
}
