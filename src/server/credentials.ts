import { Entry } from '@napi-rs/keyring'

// Server-only, and more strictly so than the rest of src/server: this is the
// one module in the app that can read a token back out of the OS. Importing it
// from a component would break the browser bundle long before it leaked
// anything — `@napi-rs/keyring` is a native addon — but "it wouldn't build" is
// not the reason to keep it out.
//
// `@napi-rs/keyring`, never `keytar` (map: security constraints). On Windows
// this is the Credential Manager; the entries appear under the target name
// `<service>/<kind>`.

/**
 * Overridable so a test can exercise the *real* credential store without
 * touching the entries the running app uses — the same escape hatch db.ts
 * gives with `ADO_WEB_DATA_DIR`. Read per call, not at import, so a test can
 * set it after the module is loaded.
 */
function service(): string {
  return process.env.ADO_WEB_KEYRING_SERVICE ?? 'ado-web'
}

export const CREDENTIAL_KINDS = ['azure-devops', 'sonarcloud'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export interface AdoCredential {
  /** The organization as it appears in the ADO URL, e.g. `Profisee`. Not a secret. */
  readonly org: string
  readonly pat: string
}

export interface SonarCredential {
  readonly token: string
}

/**
 * One entry per kind, keyed by a *fixed* username, with the whole record as
 * JSON in the password field.
 *
 * The obvious alternative — username = the ADO org, password = the PAT — can be
 * written but never read: `Entry` needs both halves to address an entry, so we
 * would have to already know the org in order to look up the credential that
 * tells us the org.
 */
function entryFor(kind: CredentialKind): Entry {
  return new Entry(service(), kind)
}

function readRecord(kind: CredentialKind): Record<string, unknown> | null {
  // A missing entry reads back as `null` rather than throwing — verified
  // against the real Windows credential store, which is why there is no
  // try/catch around the read itself.
  const raw = entryFor(kind).getPassword()
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Corrupt, half-written and hand-edited entries all read as "not configured".
 *
 * The alternative is throwing, which would make a mangled credential entry into
 * an app that cannot boot and gives you no screen from which to fix it. The
 * onboarding route can always overwrite; it can't rescue a crash loop.
 */
export function readAdoCredential(): AdoCredential | null {
  const record = readRecord('azure-devops')
  if (!record || !nonEmptyString(record.org) || !nonEmptyString(record.pat)) return null

  return { org: record.org, pat: record.pat }
}

export function readSonarCredential(): SonarCredential | null {
  const record = readRecord('sonarcloud')
  if (!record || !nonEmptyString(record.token)) return null

  return { token: record.token }
}

export function writeAdoCredential(credential: AdoCredential): void {
  entryFor('azure-devops').setPassword(JSON.stringify(credential))
}

export function writeSonarCredential(credential: SonarCredential): void {
  entryFor('sonarcloud').setPassword(JSON.stringify(credential))
}

/** Idempotent: `false` means there was nothing to delete, not that it failed. */
export function forgetCredential(kind: CredentialKind): boolean {
  return entryFor(kind).deleteCredential()
}
