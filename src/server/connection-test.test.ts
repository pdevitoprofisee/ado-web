// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adoAuthHeaders, testAdoConnection, testSonarConnection } from './connection-test'

const PAT = 'p'.repeat(52)
const ADO_CREDENTIAL = { org: 'Contoso', pat: PAT }

/** Stubs `fetch` and hands back the call record, so header assertions are possible. */
function stubFetch(reply: Response | (() => never)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (typeof reply === 'function') reply()

    return Promise.resolve(reply)
  })

  return calls
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('adoAuthHeaders', () => {
  it('sends Basic with an empty username and the PAT as the password', () => {
    const { Authorization } = adoAuthHeaders('secret')

    expect(Authorization).toBe(`Basic ${Buffer.from(':secret').toString('base64')}`)
  })

  it('suppresses the federated auth redirect — note 4', () => {
    expect(adoAuthHeaders('secret')['X-TFS-FedAuthRedirect']).toBe('Suppress')
  })
})

describe('testAdoConnection', () => {
  it('accepts a real connectionData response and names the account', async () => {
    stubFetch(json({ authenticatedUser: { id: 'a-guid', providerDisplayName: 'Ada Lovelace' } }))

    expect(await testAdoConnection(ADO_CREDENTIAL)).toEqual({ ok: true, account: 'Ada Lovelace' })
  })

  it('asks the right organization, and never follows a redirect', async () => {
    const calls = stubFetch(json({ authenticatedUser: { id: 'a-guid' } }))
    await testAdoConnection({ org: 'Space Org', pat: PAT })

    // `-preview.1` is load-bearing: connectionData is a preview-only resource
    // and plain `7.1` earns a 400. ADO checks the credential before the
    // api-version, so only a *valid* token ever reaches that error.
    expect(calls[0].url).toBe(
      'https://dev.azure.com/Space%20Org/_apis/connectionData?api-version=7.1-preview.1',
    )
    // Following would forward the Authorization header to whatever sign-in host
    // ADO nominates.
    expect(calls[0].init.redirect).toBe('manual')
  })

  it('reports a 401 as an auth failure', async () => {
    stubFetch(new Response('', { status: 401 }))
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('reports a 302 as an auth failure, not as a redirect — note 4', async () => {
    // What ADO does when the Suppress header is missing or ignored. Calling
    // this "a redirect" would be true and useless.
    stubFetch(new Response('', { status: 302, headers: { location: 'https://login.microsoftonline.com/' } }))
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'auth' })
    expect(result.ok === false && result.message).toMatch(/sign-in/i)
  })

  it('rejects a 200 that is a sign-in page rather than connectionData', async () => {
    // The trap the status code alone walks straight into.
    stubFetch(new Response('<html>Sign in to your account</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))

    expect(await testAdoConnection(ADO_CREDENTIAL)).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('rejects a 200 whose authenticatedUser has no id', async () => {
    stubFetch(json({ authenticatedUser: {} }))

    expect(await testAdoConnection(ADO_CREDENTIAL)).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('rejects the anonymous identity a public organization answers with', async () => {
    // Captured verbatim from dev.azure.com. A public org answers connectionData
    // without any credential at all: 200, a real GUID, well-formed. Accepting
    // it would report "Connected as Anonymous" and store a token ADO never
    // looked at.
    stubFetch(json({
      authenticatedUser: {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        descriptor: 'System:PublicAccess;aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        providerDisplayName: 'Anonymous',
      },
    }))
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'auth' })
    expect(result.ok === false && result.message).toMatch(/anonymous/i)
  })

  it('rejects any System: identity, not just the anonymous GUID', async () => {
    stubFetch(json({
      authenticatedUser: { id: 'some-other-guid', descriptor: 'System:ServiceIdentity;x' },
    }))

    expect(await testAdoConnection(ADO_CREDENTIAL)).toMatchObject({ ok: false, reason: 'auth' })
  })

  it("repeats ADO's own explanation of a status we cannot read", async () => {
    // The 7.1-preview.1 bug was a dead end for exactly as long as this text was
    // being discarded.
    stubFetch(json(
      { message: 'The requested version "7.1" of the resource is under preview.' },
      { status: 400 },
    ))
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'unexpected' })
    expect(result.ok === false && result.message).toContain('under preview')
  })

  it('distinguishes a bad organization from a bad token', async () => {
    stubFetch(new Response('', { status: 404 }))
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
    expect(result.ok === false && result.message).toContain('Contoso')
  })

  it('does not claim an auth failure when ADO is simply broken', async () => {
    stubFetch(new Response('', { status: 503 }))

    expect(await testAdoConnection(ADO_CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'unexpected',
    })
  })

  it('reports an unreachable host without leaking the underlying error', async () => {
    stubFetch(() => {
      throw new TypeError(`fetch failed for ${PAT}`)
    })
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(result.ok === false && result.message).not.toContain(PAT)
  })

  it('says so when the request times out', async () => {
    stubFetch(() => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    const result = await testAdoConnection(ADO_CREDENTIAL)

    expect(result.ok === false && result.message).toMatch(/10 seconds/)
  })
})

describe('testSonarConnection', () => {
  it('accepts a token the API says is valid', async () => {
    const calls = stubFetch(json({ valid: true }))
    const result = await testSonarConnection({ token: 'squ_abc' })

    expect(result).toMatchObject({ ok: true })
    expect(calls[0].url).toBe('https://sonarcloud.io/api/authentication/validate')
    // Bearer, not Basic — research: sonarcloud-api §1.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer squ_abc')
  })

  it('rejects a 200 that says valid: false', async () => {
    // validate answers 200 either way, so trusting the status accepts anonymous.
    stubFetch(json({ valid: false }))

    expect(await testSonarConnection({ token: 'squ_abc' })).toMatchObject({
      ok: false,
      reason: 'auth',
    })
  })

  it('reports a 401 as an auth failure and says a personal token is required', async () => {
    stubFetch(new Response('', { status: 401 }))
    const result = await testSonarConnection({ token: 'squ_abc' })

    expect(result).toMatchObject({ ok: false, reason: 'auth' })
    expect(result.ok === false && result.message).toMatch(/personal token/i)
  })

  it('surfaces the expiry header so a dying token does not read as an outage', async () => {
    stubFetch(json({ valid: true }, {
      headers: {
        'content-type': 'application/json',
        'SonarQube-Authentication-Token-Expiration': '2026-09-01T00:00:00+0000',
      },
    }))
    const result = await testSonarConnection({ token: 'squ_abc' })

    expect(result.ok === true && result.note).toContain('2026-09-01')
  })
})

describe('no message ever carries the credential', () => {
  // The criterion is "no token value in a network response body". These
  // messages are the only free text that crosses that boundary.
  const responses = [
    new Response('', { status: 401 }),
    new Response('', { status: 302 }),
    new Response('', { status: 404 }),
    new Response('', { status: 503 }),
    new Response('<html>Sign in</html>', { status: 200 }),
    json({ valid: false }),
    // We now repeat what the service said about a status we cannot read. These
    // two are the reason that has to be conditional: a server that echoes the
    // credential back at us must not get it relayed to the browser.
    json({ message: `Rejected token ${PAT}` }, { status: 400 }),
    json({ errors: [{ msg: `Rejected token ${PAT}` }] }, { status: 400 }),
  ]

  it.each(responses.map((r, i) => [i, r] as const))('case %i', async (_i, response) => {
    stubFetch(response.clone())
    const ado = await testAdoConnection(ADO_CREDENTIAL)
    expect(JSON.stringify(ado)).not.toContain(PAT)

    stubFetch(response.clone())
    const sonar = await testSonarConnection({ token: PAT })
    expect(JSON.stringify(sonar)).not.toContain(PAT)
  })
})
