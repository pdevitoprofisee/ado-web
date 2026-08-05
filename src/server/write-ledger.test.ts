// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AdoError, createAdoClient } from './ado-client'

// The ledger is tested through the client on purpose. What T-049 has to prove is
// that the transport boundary records what it sent and what came back — a test
// against `createLedger` alone would prove the file format and leave the wiring
// exactly as unproven as the fifteen writes are.

const PAT = 'p'.repeat(52)
const CREDENTIAL = { org: 'Contoso', pat: PAT }
const THREADS = 'P/_apis/git/repositories/R/pullRequests/24794/threads'
const THREAD = `${THREADS}/312114`

/** `ado-client.test.ts`'s stub, copied because that suite must stay unmodified. */
function stubFetch(make: (call: number) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })

    return Promise.resolve(make(calls.length - 1))
  })

  return calls
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-ledger-'))
  // One directory deeper than the temp root, so "nothing is opened" also covers
  // the `mkdirSync` the ledger does on its first append.
  file = join(dir, 'transcript', 'writes.jsonl')
})

afterEach(() => {
  delete process.env.ADO_WEB_WRITE_LEDGER
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const enable = () => {
  process.env.ADO_WEB_WRITE_LEDGER = file
}

const raw = () => readFileSync(file, 'utf8')

const records = (): Array<Record<string, any>> =>
  raw()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))

describe('with ADO_WEB_WRITE_LEDGER unset', () => {
  it('opens nothing, writes nothing, and returns exactly what it returned before', async () => {
    stubFetch((call) => {
      if (call === 0) return json({ id: 3 })
      if (call === 1) return new Response(null, { status: 204 })
      if (call === 2) return new Response('', { status: 200 })

      return json({ count: 0 })
    })
    const client = createAdoClient(CREDENTIAL)

    // The four outcomes a caller can get. Every one is the value the suite in
    // `ado-client.test.ts` already pins.
    expect(await client.write('POST', `${THREAD}/comments`, { content: 'ok' })).toEqual({ id: 3 })
    expect(await client.write('DELETE', `${THREAD}/comments/2`)).toBeNull()
    expect(await client.write('PATCH', THREAD, { status: 'fixed' })).toBeNull()
    expect(await client.get(THREADS)).toEqual({ count: 0 })

    expect(existsSync(dirname(file))).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('reports a rejected write the same way, with nothing recorded', async () => {
    stubFetch(() => json({ message: 'The requested version is invalid.' }, { status: 400 }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('POST', `${THREAD}/comments`, { content: 'ok' })).rejects.toThrow(
      'Azure DevOps answered 400. (The requested version is invalid.)',
    )
    expect(existsSync(dirname(file))).toBe(false)
  })
})

describe('with ADO_WEB_WRITE_LEDGER set', () => {
  it('records the bytes as they arrived, and the parse as a separate field', async () => {
    // Spaced and reordered on purpose: `JSON.stringify(parsed)` cannot reproduce
    // this string, so the two fields being different is the proof.
    const body = '{ "id": 3,  "content": "ok" }'
    stubFetch(() => new Response(body, { status: 201 }))
    enable()
    const client = createAdoClient(CREDENTIAL)

    expect(await client.write('POST', `${THREAD}/comments`, { content: 'ok' })).toEqual({
      id: 3,
      content: 'ok',
    })

    const [record] = records()
    expect(record).toMatchObject({
      kind: 'write',
      method: 'POST',
      path: `${THREAD}/comments`,
      requestBody: '{"content":"ok"}',
      status: 201,
      caller: 'value',
      parsed: { id: 3, content: 'ok' },
      error: null,
    })
    expect(record.body).toEqual({ present: true, text: body, chars: body.length, truncated: false })
    // The org is out of the URL and out of the first segment only.
    expect(record.url).toBe(`https://dev.azure.com/{org}/${THREAD}/comments?api-version=7.1`)
  })

  it('never lets the credential or an Authorization header reach the file', async () => {
    stubFetch(
      () =>
        new Response(`{"token":"${PAT}"}`, {
          status: 200,
          // Nothing sends this back on a response. It is dropped anyway, because
          // "we have never seen one" is not a reason to print a credential.
          headers: { authorization: `Basic ${PAT}`, 'x-echo': `token ${PAT}` },
        }),
    )
    enable()
    const client = createAdoClient(CREDENTIAL)
    await client.write('POST', `${THREAD}/comments`, { content: PAT })

    expect(raw()).not.toContain(PAT)
    expect(raw()).not.toContain(Buffer.from(`:${PAT}`).toString('base64'))
    expect(raw().toLowerCase()).not.toContain('authorization')

    const [record] = records()
    expect(record.headers.authorization).toBeUndefined()
    expect(record.headers['x-echo']).toBe('[dropped: contained the credential]')
    expect(record.body.text).toBe('[dropped: contained the credential]')
    expect(record.requestBody).toBe('[dropped: contained the credential]')
    // The parse goes with the bytes. It is an object rather than a string, so the
    // ledger cannot clean it and the client drops it whole instead.
    expect(record.parsed).toBeNull()
    expect(record.caller).toBe('value')
  })

  it('tells a 204 apart from an empty 200, which the caller cannot', async () => {
    stubFetch((call) =>
      call === 0 ? new Response(null, { status: 204 }) : new Response('', { status: 200 }),
    )
    enable()
    const client = createAdoClient(CREDENTIAL)

    // Both of these reach the caller as the same `null`, which is the reason the
    // record holds the bytes and not the return value.
    expect(await client.write('DELETE', `${THREAD}/comments/2`)).toBeNull()
    expect(await client.write('PATCH', THREAD, { status: 'fixed' })).toBeNull()

    const [deleted, patched] = records()
    expect(deleted).toMatchObject({ status: 204, caller: 'null', parsed: null, requestBody: null })
    expect(deleted.body).toMatchObject({ present: false, text: '', chars: 0 })
    expect(patched).toMatchObject({ status: 200, caller: 'null', parsed: null })
    // There was a body, and it was empty. A different fact from the 204 above.
    expect(patched.body).toMatchObject({ present: true, text: '', chars: 0 })
  })

  it('correlates the next read of the written resource, and claims it once', async () => {
    const thread = { id: 312114, comments: [{ id: 2 }] }
    stubFetch((call) => (call === 0 ? json({ id: 3 }) : json(thread)))
    enable()
    const client = createAdoClient(CREDENTIAL)

    await client.write('POST', `${THREAD}/comments`, { content: 'ok' })
    // Two levels up from the write, which is the path the page actually re-reads.
    await client.get(THREADS)
    // The second read answers nothing new. One write, one re-read.
    await client.get(THREADS)

    const [written, reread] = records()
    expect(records()).toHaveLength(2)
    expect(reread).toMatchObject({
      kind: 'read',
      method: 'GET',
      path: THREADS,
      afterWrite: written.id,
      match: 'ancestor',
      status: 200,
    })
    expect(reread.body.text).toBe(JSON.stringify(thread))
  })

  it('leaves an unrelated read alone', async () => {
    stubFetch((call) => (call === 0 ? json({ id: 3 }) : json({ count: 0 })))
    enable()
    const client = createAdoClient(CREDENTIAL)

    await client.write('POST', `${THREAD}/comments`, { content: 'ok' })
    await client.get('P/_apis/build/builds')

    expect(records()).toHaveLength(1)
  })

  it('records what a rejected write came back with', async () => {
    // `demand` reads this body through `serviceDetail`, so a record that arrived
    // empty here would mean the observation is happening too late.
    stubFetch(() => json({ message: 'TF401019: no such thread.' }, { status: 404 }))
    enable()
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('PATCH', THREAD, { status: 'fixed' })).rejects.toBeInstanceOf(AdoError)

    const [record] = records()
    expect(record).toMatchObject({ status: 404, caller: 'threw', parsed: null })
    expect(record.body.text).toBe('{"message":"TF401019: no such thread."}')
    expect(record.error).toContain('TF401019')
  })

  it('records a 200 whose body is not JSON at all', async () => {
    stubFetch(() => new Response('<html>sign in</html>', { status: 200 }))
    enable()
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('POST', `${THREAD}/comments`, { content: 'ok' })).rejects.toThrow()

    const [record] = records()
    expect(record).toMatchObject({ status: 200, caller: 'threw', parsed: null })
    expect(record.body.text).toBe('<html>sign in</html>')
  })

  it('records a write that never got an answer', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('socket hang up')))
    enable()
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('POST', `${THREAD}/comments`, { content: 'ok' })).rejects.toThrow(
      'socket hang up',
    )

    // Note 2's ambiguous case. Status 0 says no response arrived, and the record
    // exists so the transcript does not look like the button was never pressed.
    const [record] = records()
    expect(record).toMatchObject({ status: 0, caller: 'threw', error: 'Error: socket hang up' })
    expect(record.body).toMatchObject({ present: false, text: '' })
  })

  it('appends one line per record', async () => {
    stubFetch(() => json({ id: 3 }))
    enable()
    const client = createAdoClient(CREDENTIAL)
    await client.write('POST', `${THREAD}/comments`, { content: 'one' })
    await client.write('POST', `${THREAD}/comments`, { content: 'two' })

    // JSONL, so a crashed session leaves every record it had finished.
    expect(raw().endsWith('\n')).toBe(true)
    expect(records().map((record) => record.id)).toEqual([1, 2])
  })
})
