import type { AdoCredential } from './credentials'
import { adoAuthHeaders, serviceDetail } from './connection-test'

// Server-only. The single chokepoint for every Azure DevOps call.
//
// It exists for one reason the browser cannot cover and one the caller should
// not have to: `X-RateLimit-*` and `Retry-After` are not in ADO's
// `Access-Control-Expose-Headers` (note 3), so only a server can see them at
// all; and once seen, backing off is a property of the transport rather than of
// whichever feature happened to make the call.

const ADO = 'https://dev.azure.com'

/**
 * The default, overridable per call via an explicit `api-version` param.
 *
 * That override is not decoration. `connectionData` is preview-only and needs
 * `7.1-preview.1`; asking for the plain version earns a 400 — and because ADO
 * validates the credential *before* the api-version, a version mistake is
 * invisible to every test that uses a bad token. Check each new endpoint's
 * version against a real credential, not against a 401.
 */
const API_VERSION = '7.1'

const TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 3
/** A single gate wait is bounded, so one slow call cannot hang a request forever. */
const MAX_WAIT_MS = 60_000

/**
 * A guess, deliberately low, and it must keep being labelled one.
 *
 * T-001 was supposed to measure this and could not: ~30 live calls produced no
 * `X-RateLimit-*` header at all, which is a "didn't measure", not a "costs
 * nothing". The only anchor is the documented 200 TSTU per sliding five-minute
 * window, and we know neither the per-call TSTU cost nor how close the org
 * already is. Low is the safe direction to be wrong in, the throttle gate below
 * absorbs the cost of being too low, and the banner will show when there is
 * headroom to raise it.
 */
export const DEFAULT_CONCURRENCY = 4

/** note 1. Case-insensitive; ADO accepts either casing of the hex. */
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/** Matches `creatorId`, `reviewerId`, and any `searchCriteria.`-prefixed form. */
const IDENTITY_PARAM = /(?:^|\.)(?:creatorId|reviewerId)$/i

export type QueryValue = string | number | boolean | undefined

/** What the throttling banner binds to. `null` means ADO has not told us. */
export interface RateLimit {
  /** TSTUs left in the current window. */
  readonly remaining: number | null
  readonly limit: number | null
  /** Seconds ADO deliberately delayed the last response by. */
  readonly delay: number | null
  /** Epoch ms at which the window resets. */
  readonly resetAt: number | null
  /** Epoch ms before which the client will not send. */
  readonly throttledUntil: number | null
  readonly throttled: boolean
}

/** A response ADO refused. `detail` is ADO's own explanation, credential-redacted. */
export class AdoError extends Error {
  readonly status: number
  readonly detail: string | null

  constructor(status: number, message: string, detail: string | null = null) {
    super(detail ? `${message} (${detail})` : message)
    this.name = 'AdoError'
    this.status = status
    this.detail = detail
  }
}

export interface AdoClient {
  /** Not a secret, and callers that build `dev.azure.com` links need it. */
  readonly org: string
  /** `path` is org-relative: `_apis/git/pullrequests`, `Products/_apis/…`. */
  get<T>(path: string, params?: Record<string, QueryValue>): Promise<T>
  /** Runs `task` over `items` at most `concurrency` at a time, results in order. */
  fanOut<I, O>(items: readonly I[], task: (item: I) => Promise<O>): Promise<O[]>
  rateLimit(): RateLimit
}

export interface AdoClientOptions {
  readonly concurrency?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const header = (response: Response, name: string): number | null => {
  const raw = response.headers.get(name)
  if (raw === null) return null
  const value = Number(raw)

  return Number.isFinite(value) ? value : null
}

/** `Retry-After` is seconds in practice; the RFC also allows an HTTP-date. */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('Retry-After')
  if (raw === null) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const at = Date.parse(raw)

  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/**
 * Throws rather than dropping the filter, because note 1 is a *silent* failure:
 * ADO ignores a malformed identity filter and answers 200 with everyone's PRs.
 * "My PRs" rendering as the whole org is worse than an error, and there is no
 * response to inspect that would tell you it happened.
 */
function assertIdentity(key: string, value: QueryValue): void {
  if (typeof value !== 'string' || GUID.test(value)) return

  throw new TypeError(
    `${key} must be a GUID; got "${value.slice(0, 60)}". Azure DevOps silently ignores a malformed identity filter and returns unfiltered results (note 1).`,
  )
}

function buildUrl(org: string, path: string, params: Record<string, QueryValue>): string {
  const url = new URL(`${ADO}/${encodeURIComponent(org)}/${path.replace(/^\//, '')}`)

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (IDENTITY_PARAM.test(key)) assertIdentity(key, value)
    url.searchParams.set(key, String(value))
  }
  if (!url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', API_VERSION)
  }

  return url.toString()
}

export function createAdoClient(
  credential: AdoCredential,
  { concurrency = DEFAULT_CONCURRENCY }: AdoClientOptions = {},
): AdoClient {
  let state: RateLimit = {
    remaining: null,
    limit: null,
    delay: null,
    resetAt: null,
    throttledUntil: null,
    throttled: false,
  }

  /**
   * Note 2 is the whole reason this client exists, and it is easy to implement
   * backwards. ADO throttles by *delaying* a request and answering **200** with
   * `Retry-After` — Microsoft's own guidance is that retry logic isn't required,
   * because the response is complete and correct. Retrying it would throw away
   * good data and add load to a service already telling us to slow down.
   *
   * So the wait applies to the *next* request rather than to this one: any
   * `Retry-After`, on any status, closes this gate, and 429/503 then retry
   * through it. One mechanism covers both, and a caller that only ever gets 200s
   * still slows down instead of "eating stalls and looking broken".
   */
  function absorb(response: Response): void {
    const wait = retryAfterMs(response)
    const reset = header(response, 'X-RateLimit-Reset')
    const throttledUntil =
      wait === null ? state.throttledUntil : Math.max(state.throttledUntil ?? 0, Date.now() + wait)

    state = {
      remaining: header(response, 'X-RateLimit-Remaining') ?? state.remaining,
      limit: header(response, 'X-RateLimit-Limit') ?? state.limit,
      delay: header(response, 'X-RateLimit-Delay') ?? state.delay,
      // Epoch *seconds* on the wire.
      resetAt: reset === null ? state.resetAt : reset * 1000,
      throttledUntil,
      throttled: throttledUntil !== null && throttledUntil > Date.now(),
    }
  }

  async function gate(): Promise<void> {
    const wait = (state.throttledUntil ?? 0) - Date.now()
    if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_MS))
  }

  async function send(url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      await gate()

      let response: Response
      try {
        response = await fetch(url, {
          headers: adoAuthHeaders(credential.pat),
          // A redirect is note 4's auth failure, and following one would forward
          // the Authorization header to a sign-in host we did not choose.
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (cause) {
        if (attempt >= MAX_ATTEMPTS) throw cause
        await sleep(attempt * 500)
        continue
      }

      absorb(response)

      if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
        // Usually `absorb` has already closed the gate. A 429 without a
        // `Retry-After` would otherwise spin.
        if (!state.throttled) await sleep(attempt * 500)
        continue
      }

      return response
    }
  }

  async function get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const response = await send(buildUrl(credential.org, path, params))

    if (response.status >= 300 && response.status < 400) {
      throw new AdoError(
        response.status,
        'Azure DevOps redirected to a sign-in page, which is how it reports a bad or expired token.',
      )
    }
    if (!response.ok) {
      throw new AdoError(
        response.status,
        `Azure DevOps answered ${response.status}.`,
        await serviceDetail(response, credential.pat),
      )
    }

    return (await response.json()) as T
  }

  async function fanOut<I, O>(
    items: readonly I[],
    task: (item: I) => Promise<O>,
  ): Promise<O[]> {
    const results = new Array<O>(items.length)
    let next = 0

    // Workers pull from a shared cursor rather than being handed a slice, so a
    // slow item cannot idle a lane while others wait behind it.
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await task(items[index])
      }
    })
    await Promise.all(workers)

    return results
  }

  return {
    org: credential.org,
    get,
    fanOut,
    rateLimit: () => ({ ...state, throttled: (state.throttledUntil ?? 0) > Date.now() }),
  }
}
