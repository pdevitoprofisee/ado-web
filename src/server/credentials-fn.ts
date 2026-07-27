import { createServerFn } from '@tanstack/react-start'

import {
  CREDENTIAL_KINDS,
  forgetCredential,
  readAdoCredential,
  readSonarCredential,
  writeAdoCredential,
  writeSonarCredential,
} from './credentials'
import { testAdoConnection, testSonarConnection } from './connection-test'

import type { CredentialKind } from './credentials'
import type { ConnectionResult } from './connection-test'

// The only way the client can reach the credential store, and the reason the
// store has a narrow shape: everything below either returns a boolean, an org
// name, or a message we wrote ourselves. No path returns a token, and the
// handler bodies are stripped from the client bundle, so the keyring import
// above never reaches the browser (asserted by the build check in the T-003
// resolution, not assumed).
//
// These sit behind T-010's guard by construction — a server function reaches
// its handler only with a current launch token — so there is no per-endpoint
// hardening here.

export interface CredentialStatus {
  /** `org` is not a secret; returning it is what lets the form prefill. */
  readonly ado: { readonly configured: boolean; readonly org: string | null }
  readonly sonar: { readonly configured: boolean }
}

function requireString(value: unknown, field: string): string {
  // Trimmed, not just checked: a PAT is copied out of a web page and arrives
  // with a trailing newline more often than not.
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) throw new Error(`${field} is required.`)

  return trimmed
}

export const credentialStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CredentialStatus> => {
    const ado = readAdoCredential()

    return {
      ado: { configured: ado !== null, org: ado?.org ?? null },
      sonar: { configured: readSonarCredential() !== null },
    }
  },
)

export const saveAdoCredential = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const input = (data ?? {}) as Record<string, unknown>

    return {
      org: requireString(input.org, 'Organization'),
      pat: requireString(input.pat, 'Personal access token'),
    }
  })
  .handler(async ({ data }): Promise<ConnectionResult> => {
    const result = await testAdoConnection(data)
    // Test *before* accepting, so a credential that has never worked cannot
    // displace one that does — retyping a PAT with a typo should leave the
    // app exactly as authenticated as it was.
    if (result.ok) writeAdoCredential(data)

    return result
  })

export const saveSonarCredential = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const input = (data ?? {}) as Record<string, unknown>

    return { token: requireString(input.token, 'Token') }
  })
  .handler(async ({ data }): Promise<ConnectionResult> => {
    const result = await testSonarConnection(data)
    if (result.ok) writeSonarCredential(data)

    return result
  })

/**
 * Present because overwriting is not the same as removing: a revoked PAT should
 * be able to leave the machine without a valid replacement to type in first.
 */
export const forgetCredentialFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const kind = (data as { kind?: unknown } | null)?.kind
    if (!CREDENTIAL_KINDS.includes(kind as CredentialKind)) {
      throw new Error('Unknown credential kind.')
    }

    return { kind: kind as CredentialKind }
  })
  .handler(async ({ data }): Promise<{ removed: boolean }> => ({
    removed: forgetCredential(data.kind),
  }))
