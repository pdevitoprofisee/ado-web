// @vitest-environment node
import { Entry } from '@napi-rs/keyring'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  forgetCredential,
  readAdoCredential,
  readSonarCredential,
  writeAdoCredential,
  writeSonarCredential,
} from './credentials'

// These run against the **real** Windows credential store, not a fake. A mock
// would prove the JSON encoding and nothing about the thing the ticket is
// actually about — that a credential survives the process that wrote it.
// `ADO_WEB_KEYRING_SERVICE` keeps the test's entries away from the running
// app's, and the pid keeps two concurrent runs away from each other.
const SERVICE = `ado-web-test-${process.pid}`

beforeAll(() => {
  process.env.ADO_WEB_KEYRING_SERVICE = SERVICE
})

afterEach(() => {
  // Leaving entries behind would pollute the developer's credential manager,
  // and would also make every one of these tests pass on the second run for
  // the wrong reason.
  forgetCredential('azure-devops')
  forgetCredential('sonarcloud')
})

const PAT = 'p'.repeat(52)

describe('reading nothing', () => {
  it('is not configured before anything is written', () => {
    expect(readAdoCredential()).toBeNull()
    expect(readSonarCredential()).toBeNull()
  })
})

describe('round trip', () => {
  it('stores and returns the ADO org and PAT', () => {
    writeAdoCredential({ org: 'Contoso', pat: PAT })

    expect(readAdoCredential()).toEqual({ org: 'Contoso', pat: PAT })
  })

  it('survives a fresh module instance — the credential is in the OS, not in memory', async () => {
    writeAdoCredential({ org: 'Contoso', pat: PAT })
    writeSonarCredential({ token: 'squ_abc' })

    // The closest thing a test has to "restart the app": drop every module
    // instance and read it back through a newly evaluated one.
    vi.resetModules()
    const fresh = await import('./credentials')

    expect(fresh.readAdoCredential()).toEqual({ org: 'Contoso', pat: PAT })
    expect(fresh.readSonarCredential()).toEqual({ token: 'squ_abc' })
  })

  it('keeps the two services independent', () => {
    writeAdoCredential({ org: 'Contoso', pat: PAT })

    expect(readSonarCredential()).toBeNull()
  })
})

describe('an entry that is present but unusable reads as not configured', () => {
  // The alternative is throwing, which turns a mangled credential entry into an
  // app that cannot boot and offers no screen from which to fix it.
  it('tolerates a hand-edited entry that is not JSON', () => {
    new Entry(SERVICE, 'azure-devops').setPassword('not json at all')

    expect(readAdoCredential()).toBeNull()
  })

  it('tolerates JSON of the wrong shape', () => {
    new Entry(SERVICE, 'azure-devops').setPassword('"just a string"')

    expect(readAdoCredential()).toBeNull()
  })

  it('rejects a half-written record rather than returning an org with no PAT', () => {
    new Entry(SERVICE, 'azure-devops').setPassword(JSON.stringify({ org: 'Contoso' }))

    expect(readAdoCredential()).toBeNull()
  })

  it('rejects a blank PAT, which is what an empty form field would leave', () => {
    new Entry(SERVICE, 'azure-devops').setPassword(JSON.stringify({ org: 'Contoso', pat: '   ' }))

    expect(readAdoCredential()).toBeNull()
  })
})

describe('forgetting', () => {
  it('removes the credential', () => {
    writeAdoCredential({ org: 'Contoso', pat: PAT })

    expect(forgetCredential('azure-devops')).toBe(true)
    expect(readAdoCredential()).toBeNull()
  })

  it('is idempotent — false means there was nothing there, not that it failed', () => {
    expect(forgetCredential('azure-devops')).toBe(false)
  })
})
