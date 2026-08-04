// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdoError, ThrottledError, createAdoClient } from './ado-client'

const PAT = 'p'.repeat(52)
const CREDENTIAL = { org: 'Contoso', pat: PAT }
const GUID = 'ba11ca22-0000-4000-8000-0123456789ab'

/** `make` is called per request, so every reply gets an unread body. */
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

const ok = () => json({ count: 0 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('every request', () => {
  it('carries Basic auth and the redirect suppression, and never follows a redirect', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)
    await client.get('_apis/git/pullrequests')
    await client.get('Products/_apis/git/repositories')

    expect(calls).toHaveLength(2)
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe(`Basic ${Buffer.from(`:${PAT}`).toString('base64')}`)
      expect(headers['X-TFS-FedAuthRedirect']).toBe('Suppress')
      expect(init.redirect).toBe('manual')
    }
  })

  it('pins an api-version, and lets a caller override it with a preview suffix', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)
    await client.get('_apis/git/pullrequests', { 'searchCriteria.status': 'active', $top: 100 })
    await client.get('_apis/connectionData', { 'api-version': '7.1-preview.1' })

    // `$` survives as `%24`, which ADO decodes — verified live against the org.
    expect(calls[0].url).toBe(
      'https://dev.azure.com/Contoso/_apis/git/pullrequests?searchCriteria.status=active&%24top=100&api-version=7.1',
    )
    // The override is load-bearing: connectionData is preview-only and plain 7.1
    // earns a 400 that no bad-token test can reach.
    expect(calls[1].url).toBe(
      'https://dev.azure.com/Contoso/_apis/connectionData?api-version=7.1-preview.1',
    )
  })
})

describe('the identity guard — note 1', () => {
  it('refuses a non-GUID creatorId rather than returning everyone’s PRs', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)

    await expect(
      client.get('_apis/git/pullrequests', { 'searchCriteria.creatorId': 'paul@example.com' }),
    ).rejects.toThrow(TypeError)
    // Failing loud is the point: ADO would have answered 200 with the filter
    // silently dropped, so the request must not leave at all.
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-GUID reviewerId too', async () => {
    stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)

    await expect(
      client.get('_apis/git/pullrequests', { 'searchCriteria.reviewerId': 'me' }),
    ).rejects.toThrow(/must be a GUID/)
  })

  it('lets a real GUID through', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)
    await client.get('_apis/git/pullrequests', { 'searchCriteria.creatorId': GUID })

    expect(calls[0].url).toContain(`searchCriteria.creatorId=${GUID}`)
  })
})

describe('throttling — note 2', () => {
  it('does not retry a 200 that carries Retry-After, but makes the next call wait', async () => {
    vi.useFakeTimers()
    const calls = stubFetch((call) =>
      call === 0 ? json({ count: 1 }, { headers: { 'Retry-After': '5' } }) : json({ count: 2 }),
    )
    const client = createAdoClient(CREDENTIAL)

    // The throttled response is complete and correct — ADO delayed it rather
    // than rejecting it. Re-requesting would discard good data and add load.
    expect(await client.get('_apis/git/pullrequests')).toEqual({ count: 1 })
    expect(calls).toHaveLength(1)
    expect(client.rateLimit().throttled).toBe(true)

    const next = client.get('_apis/git/pullrequests')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await next).toEqual({ count: 2 })
    expect(calls).toHaveLength(2)
    expect(client.rateLimit().throttled).toBe(false)
  })

  it('waits out a 429 and retries it', async () => {
    vi.useFakeTimers()
    const calls = stubFetch((call) =>
      call === 0
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : json({ count: 7 }),
    )
    const client = createAdoClient(CREDENTIAL)

    const result = client.get('_apis/git/pullrequests')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await result).toEqual({ count: 7 })
    expect(calls).toHaveLength(2)
  })

  it('gives up after three attempts rather than hammering', async () => {
    vi.useFakeTimers()
    const calls = stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
    const client = createAdoClient(CREDENTIAL)

    const result = client.get('_apis/git/pullrequests')
    const settled = expect(result).rejects.toBeInstanceOf(AdoError)
    await vi.advanceTimersByTimeAsync(10_000)
    await settled

    expect(calls).toHaveLength(3)
  })

  it('gives up rather than holding a request past the wait budget', async () => {
    vi.useFakeTimers()
    const calls = stubFetch(() => json({ count: 1 }, { headers: { 'Retry-After': '60' } }))
    const client = createAdoClient(CREDENTIAL)

    await client.get('_apis/git/pullrequests')

    // A minute parked here is a minute of one of the browser's six connections
    // to this host, shared by every open tab. Failing frees it, and the page
    // keeps the answer it already has.
    await expect(client.get('_apis/git/pullrequests')).rejects.toBeInstanceOf(ThrottledError)
    expect(calls).toHaveLength(1)
  })

  it('says when Azure DevOps will listen again', async () => {
    vi.useFakeTimers()
    stubFetch(() => json({ count: 1 }, { headers: { 'Retry-After': '45' } }))
    const client = createAdoClient(CREDENTIAL)
    await client.get('_apis/git/pullrequests')

    // The one useful thing to put on a page: not "it failed", but for how long.
    await expect(client.get('_apis/git/pullrequests')).rejects.toThrow(/about 45 seconds/)
  })

  it('spends one wait across all three attempts, not one each', async () => {
    vi.useFakeTimers()
    const calls = stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '8' } }))
    const client = createAdoClient(CREDENTIAL)

    const result = client.get('_apis/git/pullrequests')
    const settled = expect(result).rejects.toBeInstanceOf(ThrottledError)
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    // Two attempts and one 8s wait, then the budget is gone. The gate used to be
    // checked per attempt, so this same pair of headers bought three waits of up
    // to a minute apiece — which is the stall this test exists to keep out.
    expect(calls).toHaveLength(2)
  })

  it('exposes the rate-limit headers the banner needs', async () => {
    stubFetch(() =>
      json(
        { count: 0 },
        {
          headers: {
            'X-RateLimit-Remaining': '150',
            'X-RateLimit-Limit': '200',
            'X-RateLimit-Delay': '3',
            'X-RateLimit-Reset': '1700000000',
          },
        },
      ),
    )
    const client = createAdoClient(CREDENTIAL)
    await client.get('_apis/git/pullrequests')

    expect(client.rateLimit()).toMatchObject({
      remaining: 150,
      limit: 200,
      delay: 3,
      // Epoch seconds on the wire, epoch ms everywhere in this codebase.
      resetAt: 1_700_000_000_000,
      throttled: false,
    })
  })
})

describe('reads in flight', () => {
  it('joins an identical read instead of asking Azure DevOps twice', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)

    // Started together, the way two open tabs on one pull request start them:
    // one client per credential, one 30-second cadence, the same five questions.
    const [first, second] = await Promise.all([
      client.get('_apis/git/pullrequests'),
      client.get('_apis/git/pullrequests'),
    ])

    expect(first).toEqual({ count: 0 })
    expect(second).toEqual({ count: 0 })
    expect(calls).toHaveLength(1)
    expect(client.rateLimit().calls).toBe(1)
  })

  it('keeps different questions apart', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)

    await Promise.all([
      client.get('_apis/git/pullrequests'),
      client.get('_apis/git/pullrequests', { $top: 10 }),
      // Same path, other host. `vssps` is a different service answering.
      client.get('_apis/identities', {}, 'vssps'),
    ])

    expect(calls).toHaveLength(3)
  })

  it('asks again once the first read has landed', async () => {
    const calls = stubFetch(ok)
    const client = createAdoClient(CREDENTIAL)

    await client.get('_apis/git/pullrequests')
    await client.get('_apis/git/pullrequests')

    // In flight only, no TTL. How long an answer stays good is the query cache's
    // business, and this map must never be a second one with its own opinion.
    expect(calls).toHaveLength(2)
  })

  it('does not remember a failure', async () => {
    const calls = stubFetch((call) =>
      call === 0 ? json({ message: 'nope' }, { status: 500 }) : json({ count: 9 }),
    )
    const client = createAdoClient(CREDENTIAL)

    await expect(client.get('_apis/git/pullrequests')).rejects.toBeInstanceOf(AdoError)
    // A cached rejection would turn one bad answer into a page that stays broken.
    expect(await client.get('_apis/git/pullrequests')).toEqual({ count: 9 })
    expect(calls).toHaveLength(2)
  })
})

describe('failures', () => {
  it('repeats Azure DevOps’ own explanation of a rejected request', async () => {
    stubFetch(() => json({ message: 'The requested version is invalid.' }, { status: 400 }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.get('_apis/connectionData')).rejects.toThrow(
      'Azure DevOps answered 400. (The requested version is invalid.)',
    )
  })

  it('never lets the credential reach an error message', async () => {
    stubFetch(() => json({ message: `Rejected token ${PAT}` }, { status: 400 }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.get('_apis/git/pullrequests')).rejects.toThrow(
      /^Azure DevOps answered 400\.$/,
    )
  })

  it('reads a redirect as the auth failure it is — note 4', async () => {
    stubFetch(() => new Response('', { status: 302, headers: { location: 'https://login/' } }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.get('_apis/git/pullrequests')).rejects.toThrow(/sign-in page/)
  })
})

describe('fanOut', () => {
  it('never runs more tasks at once than the cap, and keeps results in order', async () => {
    const client = createAdoClient(CREDENTIAL, { concurrency: 2 })
    let running = 0
    let peak = 0

    const results = await client.fanOut([1, 2, 3, 4, 5], async (n) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1

      return n * 2
    })

    expect(peak).toBe(2)
    expect(results).toEqual([2, 4, 6, 8, 10])
  })

  it('does not stall on an empty list', async () => {
    const client = createAdoClient(CREDENTIAL)

    expect(await client.fanOut([], async () => 1)).toEqual([])
  })
})

describe('getBytes', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

  const blob = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain', ...headers },
    })

  it('hands back the bytes as committed, without a decode in the way', async () => {
    // Live, `$format=text` on a `.png` returns intact PNG bytes; decoding them
    // as UTF-8 produced 204 replacement characters. A string return type would
    // make binary detection impossible after the fact.
    stubFetch(() => blob(PNG, { 'content-length': String(PNG.length) }))
    const client = createAdoClient(CREDENTIAL)
    const result = await client.getBytes('P/_apis/git/repositories/R/blobs/abc', {
      $format: 'text',
    })

    expect(result.bytes).toEqual(PNG)
    expect(result.size).toBe(10)
    expect(result.contentType).toBe('text/plain')
  })

  it('refuses a body bigger than the caller asked for, without reading it', async () => {
    // `Content-Length` is exact on blobs and arrives before the body, so this
    // costs no extra call — the point is that the stream is cancelled, not that
    // a downloaded buffer is discarded.
    let cancelled = false
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200, headers: { 'content-length': '9000000' } },
        ),
    )
    const client = createAdoClient(CREDENTIAL)
    const result = await client.getBytes('P/_apis/git/repositories/R/blobs/abc', {}, {
      maxBytes: 1_000_000,
    })

    expect(result.bytes).toBeNull()
    expect(result.size).toBe(9_000_000)
    expect(cancelled).toBe(true)
  })

  it('reads a body whose size it cannot know', async () => {
    stubFetch(() => blob('hello'))
    const client = createAdoClient(CREDENTIAL)
    const result = await client.getBytes('P/_apis/git/repositories/R/blobs/abc', {}, {
      maxBytes: 1,
    })

    // No `Content-Length` means no basis to refuse. Guessing "probably huge"
    // would drop small files for a header the service simply did not send.
    expect(result.size).toBeNull()
    expect(new TextDecoder().decode(result.bytes!)).toBe('hello')
  })

  it('reports a missing blob as the 400 that ADO actually answers', async () => {
    // Live: an absent-but-well-formed sha is `TF401035 … does not exist`, a 400,
    // not a 404. Anything keying recovery off 404 would never fire.
    stubFetch(
      () =>
        new Response(JSON.stringify({ message: "TF401035: The object '000…' does not exist." }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const client = createAdoClient(CREDENTIAL)

    await expect(
      client.getBytes('P/_apis/git/repositories/R/blobs/' + '0'.repeat(40)),
    ).rejects.toMatchObject({ name: 'AdoError', status: 400 })
  })

  it('goes through the same throttle gate as get', async () => {
    stubFetch((call) =>
      call === 0
        ? new Response('x', { status: 200, headers: { 'Retry-After': '30' } })
        : new Response('y', { status: 200 }),
    )
    const client = createAdoClient(CREDENTIAL)
    await client.getBytes('P/_apis/git/repositories/R/blobs/abc')

    expect(client.rateLimit().throttled).toBe(true)
    expect(client.rateLimit().calls).toBe(1)
  })
})

describe('write', () => {
  const THREAD = 'P/_apis/git/repositories/R/pullRequests/24794/threads/312114'

  it('sends the verb and a JSON body through the same chokepoint as a read', async () => {
    const calls = stubFetch(() => json({ id: 3 }))
    const client = createAdoClient(CREDENTIAL)

    expect(await client.write('POST', `${THREAD}/comments`, { content: 'ok' })).toEqual({ id: 3 })

    const { url, init } = calls[0]
    const headers = init.headers as Record<string, string>
    expect(url).toBe(`https://dev.azure.com/Contoso/${THREAD}/comments?api-version=7.1`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"content":"ok"}')
    expect(headers['Content-Type']).toBe('application/json')
    // Everything a read gets, because a write that skipped these would fail the
    // way note 4 describes: a 302 to a sign-in page, read as success.
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`:${PAT}`).toString('base64')}`)
    expect(headers['X-TFS-FedAuthRedirect']).toBe('Suppress')
    expect(init.redirect).toBe('manual')
  })

  it('sends a DELETE with no body and no Content-Type', async () => {
    // `null`, not `''`: a 204 is a null-body status and the Response constructor
    // refuses any body at all for one.
    const calls = stubFetch(() => new Response(null, { status: 204 }))
    const client = createAdoClient(CREDENTIAL)

    // 204, so there is nothing to parse — and `JSON.parse('')` would turn a
    // successful delete into an error.
    expect(await client.write('DELETE', `${THREAD}/comments/2`)).toBeNull()

    const headers = calls[0].init.headers as Record<string, string>
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.body).toBeUndefined()
    // A DELETE with a body is a different request to a DELETE without one.
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('reads an empty 200 as no body rather than as broken JSON', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    const client = createAdoClient(CREDENTIAL)

    expect(await client.write('PATCH', THREAD, { status: 'fixed' })).toBeNull()
  })

  it('never retries a write — note 2', async () => {
    vi.useFakeTimers()
    const calls = stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
    const client = createAdoClient(CREDENTIAL)

    const result = client.write('POST', `${THREAD}/comments`, { content: 'ok' })
    const settled = expect(result).rejects.toBeInstanceOf(AdoError)
    await vi.advanceTimersByTimeAsync(10_000)
    await settled

    // A read retries three times; a retried POST is a second comment on a
    // colleague's pull request. One attempt, and the failure is reported.
    expect(calls).toHaveLength(1)
  })

  it('does not retry a write that failed in transport, because that case is ambiguous', async () => {
    vi.useFakeTimers()
    let attempts = 0
    vi.stubGlobal('fetch', () => {
      attempts += 1

      return Promise.reject(new Error('socket hang up'))
    })
    const client = createAdoClient(CREDENTIAL)

    const result = client.write('POST', `${THREAD}/comments`, { content: 'ok' })
    const settled = expect(result).rejects.toThrow('socket hang up')
    await vi.advanceTimersByTimeAsync(10_000)
    await settled

    // A timed-out POST may already have been applied. "Probably not" is not a
    // basis for sending it again.
    expect(attempts).toBe(1)
  })

  it('still slows the next call when a write comes back throttled', async () => {
    vi.useFakeTimers()
    const calls = stubFetch((call) =>
      call === 0 ? json({ id: 3 }, { headers: { 'Retry-After': '5' } }) : json({ id: 4 }),
    )
    const client = createAdoClient(CREDENTIAL)

    // The write succeeded — a throttled response is a slow 200, not a rejection.
    // What it costs is the *next* request, which is the whole shape of note 2.
    expect(await client.write('POST', `${THREAD}/comments`, { content: 'ok' })).toEqual({ id: 3 })
    expect(client.rateLimit().throttled).toBe(true)

    const next = client.write('POST', `${THREAD}/comments`, { content: 'again' })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await next).toEqual({ id: 4 })
  })

  it('reads a redirect on a write as the auth failure it is — note 4', async () => {
    stubFetch(() => new Response('', { status: 302, headers: { location: 'https://login/' } }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('PATCH', THREAD, { status: 'fixed' })).rejects.toThrow(/sign-in page/)
  })

  it('never lets the credential reach a failed write’s message', async () => {
    stubFetch(() => json({ message: `Rejected token ${PAT}` }, { status: 400 }))
    const client = createAdoClient(CREDENTIAL)

    await expect(client.write('POST', `${THREAD}/comments`, { content: 'ok' })).rejects.toThrow(
      /^Azure DevOps answered 400\.$/,
    )
  })
})
