import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { AdoCredential } from './credentials'

// Server-only, and off unless it is asked for. The harness T-040 needs, and
// nothing else.
//
// T-040 has two questions about fifteen writes that have never been sent: what
// came back, and did the follow-up re-read see the change. A script that
// re-implements the fifteen requests cannot answer either one — it would prove
// the API and leave the app's parsers exactly as unproven as they are now. The
// screen cannot answer them either: ten of the fifteen paths discard the
// response, and the five that keep it hand it to a mapper defensive enough to
// turn `{}` into a comment with id `0` and no author.
//
// So this records the bytes, before the parse, and the person just uses the app.
//
// **It sends nothing.** There is no request in this file. Every byte it records
// was sent by code that existed before it.
//
// Note 12 says the client owes callers a way to see response headers and that it
// is worth doing once rather than per feature. This is not that change: headers
// are *recorded* here, which is additive, and `get`'s return type does not move.

/**
 * The one switch, and its value is the file to append to.
 *
 * A path rather than a flag, for `ADO_WEB_DATA_DIR`'s reason: the transcript is
 * neither the repository's business nor the temp directory's, and the person
 * running the afternoon is the one who knows where they want it.
 */
const VARIABLE = 'ADO_WEB_WRITE_LEDGER'

/**
 * Long enough for the read that answers "did it land" — the thread list is the
 * biggest of them — and short enough that one 1.5 MB response cannot make the
 * transcript unreadable. `chars` is recorded unclipped, so a truncated record
 * still says how much there was.
 */
const MAX_BODY_CHARS = 256_000

/**
 * Writes still waiting for a re-read. A write whose re-read never arrives falls
 * off the end rather than claiming a `GET` that happens minutes later.
 */
const MAX_PENDING = 8

/**
 * Dropped, not masked. `serviceDetail` already drops ADO's own error text whole
 * when the credential is in it, and how much of a token to print is not a
 * decision worth making twice: a record with a credential in it is a worse
 * outcome than no record.
 */
const DROPPED = '[dropped: contained the credential]'

/** What one response looked like on the wire, before anything parsed it. */
export interface ObservedResponse {
  readonly status: number
  /** Response headers, `Authorization` dropped outright. */
  readonly headers: Record<string, string>
  /**
   * `false` when there was no body at all. Through `fetch` that means a
   * null-body status — a 204 — and it is the only way to tell a delete's silence
   * apart from an empty 200's.
   */
  readonly present: boolean
  /** `''` for an empty body *and* for an absent one; `present` separates them. */
  readonly text: string
  /** The length before any truncation, so a clipped record still says how much. */
  readonly chars: number
  readonly truncated: boolean
}

/**
 * What the caller of `write` observed. Recorded rather than re-derived: working
 * it out from the status and the body would re-implement the branch under
 * observation, and a harness that re-implements the code path proves the
 * harness.
 */
export type CallerOutcome = 'value' | 'null' | 'threw'

export interface WriteObservation {
  readonly method: string
  readonly url: string
  /** Org-relative, as the call site wrote it. What the re-read is matched on. */
  readonly path: string
  /** The exact string sent, or `null` when no body was sent at all. */
  readonly requestBody: string | null
  readonly response: ObservedResponse
  readonly caller: CallerOutcome
  /** What `JSON.parse` made of the body — the app's own value, not a re-parse. */
  readonly parsed: unknown
  readonly failure: unknown
}

/** How a read's path relates to the written one. */
export type PathMatch = 'same' | 'ancestor' | 'descendant'

export interface ReadClaim {
  readonly writeId: number
  readonly match: PathMatch
}

export interface WriteLedger {
  /** Reads the body off a clone, so the code being watched still reads its own. */
  observe(response: Response): Promise<ObservedResponse>
  write(observation: WriteObservation): void
  /**
   * Claims this `GET` for the write that is waiting for it, if there is one.
   * Claimed *before* the request goes out, so the first read that could have
   * seen the change is the one recorded rather than the second.
   */
  claimRead(path: string): ReadClaim | null
  read(claim: ReadClaim, url: string, path: string, response: ObservedResponse): void
}

const segmentsOf = (path: string): string[] =>
  path.split('/').filter((segment) => segment !== '')

/**
 * The written resource, its parent, or something under it.
 *
 * A comment is posted to `…/threads/{t}/comments` and the page re-reads
 * `…/threads`, two levels up, so the rule is ancestry rather than "the parent".
 */
function relate(read: readonly string[], written: readonly string[]): PathMatch | null {
  const shared = Math.min(read.length, written.length)
  for (let index = 0; index < shared; index += 1) {
    if (read[index] !== written[index]) return null
  }
  if (read.length === written.length) return 'same'

  return read.length < written.length ? 'ancestor' : 'descendant'
}

/**
 * The org out of the URL, and out of the *first* path segment only.
 *
 * A project can carry the organisation's own name, so replacing every
 * occurrence would rewrite the project segment too and the record would name a
 * path that was never requested.
 */
export function withoutOrg(url: string, org: string): string {
  const scheme = url.indexOf('://')
  const start = scheme === -1 ? 0 : url.indexOf('/', scheme + 3)
  if (start === -1) return url

  for (const name of new Set([encodeURIComponent(org), org])) {
    const marker = `/${name}/`
    if (url.startsWith(marker, start)) {
      return `${url.slice(0, start)}/{org}${url.slice(start + marker.length - 1)}`
    }
  }

  return url
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

function createLedger(file: string, org: string, pat: string): WriteLedger {
  const pending: { id: number; segments: string[] }[] = []
  let sequence = 0
  let ready = false
  let broken = false

  /** `serviceDetail`'s rule: if the credential is in the string, there is no string. */
  const clean = (value: string): string => (value.includes(pat) ? DROPPED : value)

  function append(record: Record<string, unknown>): void {
    if (broken) return

    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true })
        ready = true
      }
      // One line, appended, synchronously. A crashed session leaves every record
      // it had finished, and a long one holds none of them in memory.
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (cause) {
      // A harness that can break a write is worse than no harness. It says so
      // once and stops, rather than throwing into the call it was watching.
      broken = true
      console.error(`[${VARIABLE}] capture stopped: ${messageOf(cause)}`)
    }
  }

  function headersOf(response: Response): Record<string, string> {
    const headers: Record<string, string> = {}

    for (const [name, value] of response.headers) {
      // Dropped outright, and dropped on a response too, where it has no
      // business being in the first place.
      if (name.toLowerCase() === 'authorization') continue
      headers[name] = clean(value)
    }

    return headers
  }

  async function observe(response: Response): Promise<ObservedResponse> {
    const present = response.body !== null
    let text: string
    let chars: number

    try {
      // A clone: `demand` consumes the body on a failure and `write` consumes it
      // on success, and a body can only be read once.
      const raw = present ? clean(await response.clone().text()) : ''
      chars = raw.length
      text = raw.slice(0, MAX_BODY_CHARS)
    } catch (cause) {
      // Said out loud rather than recorded as an empty body: a research file that
      // silently reports `''` for a stream that failed is the kind of wrong
      // answer this whole harness exists to prevent.
      text = `[unreadable: ${messageOf(cause)}]`
      chars = 0
    }

    return {
      status: response.status,
      headers: headersOf(response),
      present,
      text,
      chars,
      truncated: chars > MAX_BODY_CHARS,
    }
  }

  const bodyOf = (response: ObservedResponse) => ({
    present: response.present,
    text: response.text,
    chars: response.chars,
    truncated: response.truncated,
  })

  function write(observation: WriteObservation): void {
    const id = (sequence += 1)

    append({
      kind: 'write',
      id,
      at: new Date().toISOString(),
      method: observation.method,
      url: withoutOrg(observation.url, org),
      path: observation.path,
      requestBody:
        observation.requestBody === null ? null : clean(observation.requestBody),
      status: observation.response.status,
      headers: observation.response.headers,
      body: bodyOf(observation.response),
      // Separate from the bytes on purpose. `{}`, `null`, `''` and a 204 are four
      // different responses and three of them reach a caller as the same `null`.
      parsed: observation.parsed === undefined ? null : observation.parsed,
      caller: observation.caller,
      error:
        observation.failure === null || observation.failure === undefined
          ? null
          : clean(messageOf(observation.failure)),
    })

    pending.push({ id, segments: segmentsOf(observation.path) })
    if (pending.length > MAX_PENDING) pending.shift()
  }

  function claimRead(path: string): ReadClaim | null {
    if (pending.length === 0) return null
    const segments = segmentsOf(path)

    // Newest first: a write's re-read is the one that follows it, and an older
    // write still waiting must not swallow it.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const match = relate(segments, pending[index].segments)
      if (match === null) continue
      const [claimed] = pending.splice(index, 1)

      return { writeId: claimed.id, match }
    }

    return null
  }

  function read(
    claim: ReadClaim,
    url: string,
    path: string,
    response: ObservedResponse,
  ): void {
    append({
      kind: 'read',
      id: (sequence += 1),
      at: new Date().toISOString(),
      method: 'GET',
      url: withoutOrg(url, org),
      path,
      // T-040's second question, as a line in a file rather than something the
      // person has to remember having seen.
      afterWrite: claim.writeId,
      match: claim.match,
      status: response.status,
      headers: response.headers,
      body: bodyOf(response),
    })
  }

  return { observe, write, claimRead, read }
}

/**
 * The ledger, or `null` — which is every normal run.
 *
 * Read once, when the client is built, and there is one client per credential
 * for the length of the process (`ado.ts`). `null` is the whole of the disabled
 * path: no file is opened, no directory is made, and the only cost in the hot
 * path is one comparison against it.
 */
export function openWriteLedger(credential: AdoCredential): WriteLedger | null {
  const configured = process.env[VARIABLE]?.trim()
  if (configured === undefined || configured === '') return null

  return createLedger(resolve(configured), credential.org, credential.pat)
}
