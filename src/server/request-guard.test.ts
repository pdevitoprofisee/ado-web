// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { LAUNCH_TOKEN_HEADER, LAUNCH_TOKEN_PATH } from '../lib/launch-token'
import { currentLaunchToken } from './request-guard'
import type { GuardContext } from './request-guard'
import { startInstance } from '../start'

// Everything here goes through the real chain from src/start.ts, not a
// hand-built one. T-005 established that a server function cannot be driven by
// curling `/_serverFn/<id>` — the id in the server bundle is not the client's
// RPC id — so a curl-based "it 403'd" proves nothing. The guard is the level at
// which these rules are actually decided, so that is where they are exercised.

const ORIGIN = 'http://127.0.0.1:7331'
const PASSED = Symbol('handler reached')

type Middleware = { options: { server: (ctx: unknown) => unknown } }

/**
 * Drives `startInstance`'s request middleware the way `createStartHandler` does:
 * each entry gets `next`, and the first one to return a Response instead of
 * calling it ends the chain.
 */
async function runChain(
  request: Request,
  { pathname = '/_serverFn/x', handlerType = 'serverFn' }: Partial<GuardContext> = {},
): Promise<Response | typeof PASSED> {
  const { requestMiddleware } = await startInstance.getOptions()
  const chain = requestMiddleware as unknown as ReadonlyArray<Middleware>

  let index = -1
  const next = async (): Promise<unknown> => {
    index++
    const middleware = chain[index]
    if (!middleware) return PASSED
    return middleware.options.server({ request, pathname, handlerType, context: {}, next })
  }

  return (await next()) as Response | typeof PASSED
}

/** A well-formed same-origin browser call, which every negative case below mutates one field of. */
function browserCall(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/_serverFn/x`, {
    headers: {
      host: '127.0.0.1:7331',
      'sec-fetch-site': 'same-origin',
      [LAUNCH_TOKEN_HEADER]: currentLaunchToken(),
      ...headers,
    },
  })
}

describe('the chain is wired', () => {
  it('passes a well-formed same-origin call with a current token', async () => {
    expect(await runChain(browserCall())).toBe(PASSED)
  })

  it('still rejects a foreign origin — T-002 must not have been undone', async () => {
    // Declaring a start instance replaces Start's default CSRF middleware, so
    // this asserts the replacement is present, not that Start works.
    const foreign = browserCall({ 'sec-fetch-site': 'cross-site' })
    expect((await runChain(foreign) as Response).status).toBe(403)

    const noOriginAtAll = new Request(`${ORIGIN}/_serverFn/x`, {
      headers: { host: '127.0.0.1:7331', [LAUNCH_TOKEN_HEADER]: currentLaunchToken() },
    })
    expect((await runChain(noOriginAtAll) as Response).status).toBe(403)
  })
})

describe('Host validation', () => {
  it('rejects a rebound host whose Origin is genuinely its own', async () => {
    // What DNS rebinding looks like on the wire: the page really is served from
    // attacker.example, so Sec-Fetch-Site is same-origin and the request URL's
    // origin matches. Only Host gives it away.
    const rebound = new Request('http://attacker.example/_serverFn/x', {
      headers: {
        host: 'attacker.example',
        'sec-fetch-site': 'same-origin',
        [LAUNCH_TOKEN_HEADER]: currentLaunchToken(),
      },
    })

    expect((await runChain(rebound) as Response).status).toBe(403)
  })

  it('rejects a request with no Host header', async () => {
    // srvx fills request.url from the socket's local address when Host is
    // absent, so request.url here is a perfectly innocent
    // http://127.0.0.1:7331/… — the raw header is the only thing that tells
    // the truth.
    const request = new Request(`${ORIGIN}/_serverFn/x`, {
      headers: {
        'sec-fetch-site': 'same-origin',
        [LAUNCH_TOKEN_HEADER]: currentLaunchToken(),
      },
    })
    expect(request.headers.get('host')).toBeNull()

    expect((await runChain(request) as Response).status).toBe(403)
  })

  it('rejects forwarded headers even from a loopback Host', async () => {
    for (const header of ['x-forwarded-host', 'x-forwarded-proto', 'forwarded']) {
      const response = await runChain(browserCall({ [header]: 'attacker.example' }))
      expect((response as Response).status, header).toBe(403)
    }
  })

  it('accepts every loopback spelling, on any port', async () => {
    // localhost:<random port> is what the prerenderer sends: `pnpm build`
    // drives the app through a Vite preview server on port 0.
    for (const host of ['127.0.0.1:7331', 'localhost:52341', 'LocalHost', '[::1]:7331', 'adoweb.localhost:7330']) {
      const request = new Request(`${ORIGIN}/`, { headers: { host, 'sec-fetch-site': 'same-origin' } })
      expect(await runChain(request, { pathname: '/', handlerType: 'router' }), host).toBe(PASSED)
    }
  })

  it('accepts only the one named localhost, not every subdomain', async () => {
    const request = new Request(`${ORIGIN}/`, { headers: { host: 'other.localhost:7330', 'sec-fetch-site': 'same-origin' } })
    expect((await runChain(request, { pathname: '/', handlerType: 'router' }) as Response).status).toBe(403)
  })
})

describe('launch token', () => {
  it('rejects a server function call with no token', async () => {
    const request = new Request(`${ORIGIN}/_serverFn/x`, {
      headers: { host: '127.0.0.1:7331', 'sec-fetch-site': 'same-origin' },
    })

    expect((await runChain(request) as Response).status).toBe(403)
  })

  it('rejects a stale token from a previous launch', async () => {
    // A token of the right shape and the right length, from a different boot.
    const stale = currentLaunchToken().replace(/./, (c) => (c === 'a' ? 'b' : 'a'))
    expect(stale).toHaveLength(currentLaunchToken().length)

    expect((await runChain(browserCall({ [LAUNCH_TOKEN_HEADER]: stale })) as Response).status)
      .toBe(403)
  })

  it('does not require a token for the document request', async () => {
    // The shell has to load before anything can fetch a token.
    const request = new Request(`${ORIGIN}/`, { headers: { host: '127.0.0.1:7331' } })
    expect(await runChain(request, { pathname: '/', handlerType: 'router' })).toBe(PASSED)
  })

  it('is a different value on every launch', async () => {
    const first = currentLaunchToken()
    vi.resetModules()
    const { currentLaunchToken: second } = await import('./request-guard')

    expect(second()).not.toBe(first)
    expect(second()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the bootstrap', () => {
  it('hands the token to a same-origin browser fetch and forbids caching', async () => {
    const request = new Request(`${ORIGIN}${LAUNCH_TOKEN_PATH}`, {
      headers: { host: '127.0.0.1:7331', 'sec-fetch-site': 'same-origin' },
    })

    const response = await runChain(request, {
      pathname: LAUNCH_TOKEN_PATH,
      handlerType: 'router',
    })

    expect(response).toBeInstanceOf(Response)
    expect(await (response as Response).text()).toBe(currentLaunchToken())
    expect((response as Response).headers.get('cache-control')).toBe('no-store')
  })

  it('is covered by the origin check, unlike other page requests', async () => {
    // A bare local process — or a <script src> from another origin — sends no
    // Sec-Fetch-Site, Origin or Referer at all. Start's default CSRF filter
    // would skip this path because it is not a serverFn; the widened one does not.
    const request = new Request(`${ORIGIN}${LAUNCH_TOKEN_PATH}`, {
      headers: { host: '127.0.0.1:7331' },
    })

    const response = await runChain(request, {
      pathname: LAUNCH_TOKEN_PATH,
      handlerType: 'router',
    })

    expect((response as Response).status).toBe(403)
    expect(await (response as Response).text()).not.toContain(currentLaunchToken())
  })

  it('checks Host before it answers', async () => {
    const request = new Request(`http://attacker.example${LAUNCH_TOKEN_PATH}`, {
      headers: { host: 'attacker.example', 'sec-fetch-site': 'same-origin' },
    })

    const response = await runChain(request, {
      pathname: LAUNCH_TOKEN_PATH,
      handlerType: 'router',
    })

    expect((response as Response).status).toBe(403)
  })
})
