import type { AdoCredential, SonarCredential } from './credentials'

// Server-only. The "test connection" check T-003 gates saving on, and nothing
// more — the map rules out PAT scope introspection beyond this.
//
// These are deliberately hand-rolled fetches rather than the T-004 ADO client:
// T-004 is blocked on T-001's measured concurrency cap and on the throttling
// behaviour it has to implement, and none of that applies to a single
// credential check. What T-004 *should* reuse is `adoAuthHeaders` below, which
// is the part that is easy to get wrong.

const ADO = 'https://dev.azure.com'
const SONAR = 'https://sonarcloud.io'
const TIMEOUT_MS = 10_000

/**
 * `-preview.1`, not `7.1`. connectionData is a preview-only resource, and
 * asking for the plain version earns a 400 VssInvalidPreviewVersionException.
 *
 * Worth knowing for T-004: ADO validates the api-version *after* it validates
 * the credential, so a wrong-token test answers 401 and never reaches the
 * version check. A version mistake is therefore invisible until the first
 * request that actually authenticates.
 */
const CONNECTION_DATA = 'api-version=7.1-preview.1'

/** ADO's well-known anonymous identity — see `isSystemIdentity`. */
const ANONYMOUS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

export type ConnectionFailure = 'auth' | 'not-found' | 'unreachable' | 'unexpected'

export type ConnectionResult =
  | { readonly ok: true; readonly account: string | null; readonly note?: string }
  | { readonly ok: false; readonly reason: ConnectionFailure; readonly message: string }

/**
 * Shared with T-004: every ADO request needs both of these.
 *
 * `X-TFS-FedAuthRedirect: Suppress` is note 4 — without it an auth failure is a
 * 302 to a sign-in page instead of a 401, and every caller downstream has to
 * guess what happened.
 */
export function adoAuthHeaders(pat: string): Record<string, string> {
  return {
    // ADO wants Basic with an empty username and the PAT as the password.
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'X-TFS-FedAuthRedirect': 'Suppress',
    Accept: 'application/json',
  }
}

/**
 * Fixed text, never `cause.message`.
 *
 * Nothing in an undici error message is secret today, but "no string derived
 * from a credential reaches the client" is only enforceable if it is mechanical
 * rather than re-argued at each call site.
 */
function unreachable(cause: unknown): ConnectionResult {
  const timedOut = cause instanceof Error && cause.name === 'TimeoutError'

  return {
    ok: false,
    reason: 'unreachable',
    message: timedOut
      ? `No response within ${TIMEOUT_MS / 1000} seconds. Check the network, a VPN, or a proxy.`
      : 'Could not reach the service. Check the network, a VPN, or a proxy.',
  }
}

const authFailed = (message: string): ConnectionResult =>
  ({ ok: false, reason: 'auth', message })

/**
 * Both services describe a rejected request in the body, and that description
 * is about the *request* — never the caller. Surfacing it is the difference
 * between "answered 400, which we don't know how to read", which is a dead end,
 * and a message that names the mistake. The 7.1-vs-7.1-preview.1 bug above cost
 * a round trip through the user precisely because this text was thrown away.
 *
 * Dropped whole if it contains the credential, so "no token in a response body"
 * stays mechanical rather than a bet on what a server might echo back. Exported
 * for T-004's client for that reason — the redaction has to be one function, not
 * an argument re-made at each call site.
 */
export async function serviceDetail(response: Response, secret: string): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as
    | { message?: unknown; errors?: ReadonlyArray<{ msg?: unknown }> }
    | null
  const raw =
    typeof body?.message === 'string' ? body.message
    : typeof body?.errors?.[0]?.msg === 'string' ? body.errors[0].msg
    : null

  if (raw === null || raw.includes(secret)) return null

  return raw.slice(0, 200)
}

const unexpected = (what: string, status: number, detail: string | null): ConnectionResult => ({
  ok: false,
  reason: 'unexpected',
  message: detail
    ? `${what} answered ${status}: ${detail}`
    : `${what} answered ${status}, which we don't know how to read.`,
})

const isSystemIdentity = (id: string, descriptor: unknown): boolean =>
  id === ANONYMOUS_ID || (typeof descriptor === 'string' && descriptor.startsWith('System:'))

export async function testAdoConnection(credential: AdoCredential): Promise<ConnectionResult> {
  const url = `${ADO}/${encodeURIComponent(credential.org)}/_apis/connectionData?${CONNECTION_DATA}`

  let response: Response
  try {
    response = await fetch(url, {
      headers: adoAuthHeaders(credential.pat),
      // Never follow. A redirect *is* the failure we are testing for, and
      // following one would forward the Authorization header to wherever ADO
      // points — a sign-in host we did not choose.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    return unreachable(cause)
  }

  if (response.status === 401 || response.status === 403) {
    return authFailed('Azure DevOps rejected the token. Check that it has not expired and that it carries Code (read), Build (read) and Identity (read).')
  }
  if (response.status >= 300 && response.status < 400) {
    // Belt and braces on note 4: this is what an auth failure looks like when
    // the Suppress header is missing or ignored. Reporting it as a redirect
    // would be technically true and useless.
    return authFailed('Azure DevOps redirected to a sign-in page, which is how it reports a bad or expired token.')
  }
  if (response.status === 404) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No organization named “${credential.org}”. Use the name exactly as it appears in the URL, e.g. dev.azure.com/Contoso → Contoso.`,
    }
  }
  if (!response.ok) {
    return unexpected('Azure DevOps', response.status, await serviceDetail(response, credential.pat))
  }

  // A 200 is not proof of anything. ADO will answer a browser-shaped request
  // with the sign-in page itself, status 200 and all, so the body has to look
  // like connectionData before we believe it.
  const body = (await response.json().catch(() => null)) as
    | {
        authenticatedUser?: {
          id?: unknown
          descriptor?: unknown
          providerDisplayName?: unknown
        }
      }
    | null
  const user = body?.authenticatedUser

  if (typeof user?.id !== 'string') {
    return authFailed('Azure DevOps answered without an authenticated user, which means the token was not accepted.')
  }
  // …and a well-formed `authenticatedUser` is not proof either. A public
  // organization answers connectionData anonymously: 200, a real GUID, and
  // `providerDisplayName: "Anonymous"`. Accepting that would report "Connected"
  // and store a credential ADO never looked at — the precise thing testing
  // before accepting exists to prevent. Anonymous and every other service
  // identity live in the `System:` descriptor namespace.
  if (isSystemIdentity(user.id, user.descriptor)) {
    return authFailed('Azure DevOps answered as an anonymous user. The organization allows public access, so the request succeeded without the token being accepted — check that the token has not expired.')
  }

  return {
    ok: true,
    account: typeof user.providerDisplayName === 'string' ? user.providerDisplayName : null,
  }
}

export async function testSonarConnection(credential: SonarCredential): Promise<ConnectionResult> {
  let response: Response
  try {
    response = await fetch(`${SONAR}/api/authentication/validate`, {
      // Bearer, not Basic: documented for Cloud, and what SonarSource's own ADO
      // extension sends (research: sonarcloud-api §1).
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    return unreachable(cause)
  }

  if (response.status === 401 || response.status === 403) {
    return authFailed('SonarCloud rejected the token. It must be a personal token — an analysis or scoped organization token cannot read issues.')
  }
  if (!response.ok) {
    return unexpected('SonarCloud', response.status, await serviceDetail(response, credential.token))
  }

  // `authentication/validate` answers 200 either way and puts the verdict in
  // the body, so the status alone would accept an anonymous request.
  const body = (await response.json().catch(() => null)) as { valid?: unknown } | null
  if (body?.valid !== true) {
    return authFailed('SonarCloud did not recognise the token. It must be a personal token — an analysis or scoped organization token cannot read issues.')
  }

  // Surfaced so an expiring token reads as an expiring token rather than as an
  // outage three weeks from now (research: sonarcloud-api §1).
  const expiry = response.headers.get('SonarQube-Authentication-Token-Expiration')

  return { ok: true, account: null, ...(expiry ? { note: `This token expires ${expiry}.` } : {}) }
}
