// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdoError, createAdoClient } from './ado-client'

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
