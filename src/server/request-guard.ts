import { randomBytes, timingSafeEqual } from 'node:crypto'

import { LAUNCH_TOKEN_HEADER, LAUNCH_TOKEN_PATH } from '../lib/launch-token'

// Server-only, and the single gate every request passes through before a
// handler runs. Wired in src/start.ts, which is its only caller — "some
// endpoints are hardened" is the same as none once phase 2 shells out to `git`.
//
// Start already rejects a server-function call whose `Origin` is foreign
// (T-002). Two holes stay open behind that check:
//
//   DNS rebinding. The attacker's page re-resolves its own hostname to
//   127.0.0.1, so the `Origin` it sends is genuinely its own and the origin
//   check passes. What the browser will not forge is `Host` — it still carries
//   the hostname the page was loaded from, which is the attacker's.
//
//   Local processes that are not browsers. Anything running as this user can
//   open a socket to the loopback port and send whatever headers it likes; no
//   browser-enforced check touches it. Only a secret it does not have does.

/**
 * Hostname only, deliberately not the ticket's literal `127.0.0.1:<port>`. The
 * port in a `Host` header is client-supplied and grants nothing by itself —
 * every rebinding case is decided by the hostname — while pinning it would
 * break `pnpm build`, whose prerender step drives the app through a Vite
 * preview server on `localhost:<random port>`.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Forwarded headers are refused outright rather than parsed. A loopback-bound
 * single-user app is never legitimately behind a proxy, srvx only honours these
 * when `trustProxy` is on and it defaults off — but if that ever flipped,
 * `X-Forwarded-Host` would rewrite `request.url`, and the origin check compares
 * `Origin` against exactly that URL. Refusing them means the switch cannot
 * quietly become a bypass.
 */
const FORWARDED_HEADERS = ['x-forwarded-host', 'x-forwarded-proto', 'forwarded']

/**
 * One 256-bit token per process. Generated at boot and never persisted: a token
 * that outlives its launch is a token that anything which read it once can
 * still use.
 */
const LAUNCH_TOKEN = randomBytes(32).toString('hex')

/** Exported for the middleware's client half to have something to compare against in tests. */
export function currentLaunchToken(): string {
  return LAUNCH_TOKEN
}

/**
 * Read from the raw header, never from `new URL(request.url).host`: srvx's node
 * adapter falls back to the socket's local address when `Host` is absent, so a
 * request with no `Host` at all arrives with a request URL of
 * `http://127.0.0.1:3000/…` and sails through a URL-based check.
 */
function isLoopbackHost(host: string | null): boolean {
  if (host === null) return false

  // `[::1]:3000` brackets the address; `127.0.0.1:3000` does not.
  const end = host.startsWith('[') ? host.indexOf(']') + 1 : host.indexOf(':')
  const hostname = end <= 0 ? host : host.slice(0, end)

  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

function tokenMatches(presented: string | null): boolean {
  if (presented === null || presented.length !== LAUNCH_TOKEN.length) return false

  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(presented), encoder.encode(LAUNCH_TOKEN))
}

/** Deliberately says nothing. The guard does not log either — the only interesting thing it holds is the token. */
function forbidden(): Response {
  return new Response('Forbidden', { status: 403 })
}

function launchTokenResponse(): Response {
  return new Response(LAUNCH_TOKEN, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // A cached token outlives the process that issued it and would be
      // replayed against the next launch, which rejects it.
      'cache-control': 'no-store',
    },
  })
}

/** The subset of Start's request-middleware context the guard reads. */
export interface GuardContext {
  request: Request
  pathname: string
  handlerType: 'serverFn' | 'router'
}

/**
 * Returns the response to send *instead of* running the handler, or `undefined`
 * to let the request through.
 */
export function guardRequest({
  request,
  pathname,
  handlerType,
}: GuardContext): Response | undefined {
  if (FORWARDED_HEADERS.some((header) => request.headers.has(header))) return forbidden()
  if (!isLoopbackHost(request.headers.get('host'))) return forbidden()

  // The bootstrap. It cannot carry a token — it is what hands one out — so what
  // stands in front of it is the `Host` check above and the origin check ahead
  // of it in the chain, which together make it a browser-only, same-origin
  // surface. That is the honest limit: any local process running as this user
  // can forge `Sec-Fetch-Site: same-origin` and collect a token. The token stops
  // processes that do not know the protocol, not one written against this app.
  if (pathname === LAUNCH_TOKEN_PATH) return launchTokenResponse()

  // Document and asset requests carry no token by construction — the first one
  // is what goes on to fetch it. They are `Host`-checked and serve only the
  // static shell; the server functions are the surface worth a secret.
  if (handlerType !== 'serverFn') return undefined

  return tokenMatches(request.headers.get(LAUNCH_TOKEN_HEADER)) ? undefined : forbidden()
}
