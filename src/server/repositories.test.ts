// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { loadRepositories } from './repositories'

import type { AdoClient, AdoHost, QueryValue } from './ado-client'

/**
 * A fake client rather than a stubbed `fetch`, because the thing most of this
 * file is about is **what was not sent**, and the params are an argument here
 * rather than something to recover from a query string. `params` is recorded
 * exactly as passed — `undefined` stays `undefined`, with no `= {}` default — so
 * "no parameters" and "an empty object" are different observations.
 */
function fakeClient(reply: unknown) {
  const calls: {
    path: string
    params: Record<string, QueryValue> | undefined
    host: AdoHost | undefined
  }[] = []

  const client: AdoClient = {
    org: 'Contoso',
    async get<T>(
      path: string,
      params?: Record<string, QueryValue>,
      host?: AdoHost,
    ): Promise<T> {
      calls.push({ path, params, host })

      return reply as T
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    write: () => Promise.reject(new Error('this fixture is read-only')),
    fanOut: async (items, task) => Promise.all(items.map(task)),
    rateLimit: () => ({
      remaining: null,
      limit: null,
      delay: null,
      resetAt: null,
      throttledUntil: null,
      throttled: false,
      calls: calls.length,
      cost: 0,
    }),
  }

  return { client, calls }
}

/**
 * A wire row as T-046 recorded it, trimmed to the fields the loader reads.
 * `isFork` is deliberately absent unless a test asks for it — that is how 110 of
 * the 114 real rows arrive.
 */
const wire = (name: string, project: string, over: Record<string, unknown> = {}) => ({
  id: '2cb3fe4f-cf55-4afb-a1ed-00d8d189c67f',
  name,
  project: { id: '3a6b2d90-dec8-4131-8f1a-86673ad6f1bb', name: project },
  defaultBranch: 'refs/heads/main',
  size: 12345,
  remoteUrl: `https://Profisee@dev.azure.com/Profisee/${project}/_git/${name}`,
  sshUrl: `git@ssh.dev.azure.com:v3/Profisee/${project}/${name}`,
  url: `https://dev.azure.com/Profisee/_apis/git/repositories/2cb3fe4f`,
  webUrl: `https://dev.azure.com/Profisee/${project}/_git/${name}`,
  isDisabled: false,
  isInMaintenance: false,
  ...over,
})

describe('loadRepositories', () => {
  it('makes exactly one call, to the org-wide path', async () => {
    const { client, calls } = fakeClient({ value: [wire('one', 'SaaS')] })

    await loadRepositories(client)

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('_apis/git/repositories')
  })

  // The test the ticket cares most about. T-046 measured what each of these
  // costs: `$top`/`$skip` are ignored outright so they would look like paging
  // that works, `includeLinks` is 235 KB and `includeAllUrls` is 1.58 MB. Nothing
  // stops a later "while I'm here" from adding one except this assertion.
  it('sends no parameters at all', async () => {
    const { client, calls } = fakeClient({ value: [] })

    await loadRepositories(client)

    expect(calls[0].params).toBeUndefined()
  })

  it('does not send a project segment', async () => {
    const { client, calls } = fakeClient({ value: [] })

    await loadRepositories(client)

    expect(calls[0].path.startsWith('_apis/')).toBe(true)
  })

  it('turns the default branch ref into a branch name', async () => {
    const { client } = fakeClient({
      value: [wire('one', 'SaaS', { defaultBranch: 'refs/heads/release/2024.R1' })],
    })

    const { rows } = await loadRepositories(client)

    expect(rows[0].defaultBranch).toBe('release/2024.R1')
  })

  // Not `''`, and not `null`. A repository with no commits has no default branch,
  // and the row's word for that is the absent key.
  it('leaves defaultBranch absent when ADO omitted it', async () => {
    const empty = wire('fresh', 'SaaS')
    delete (empty as { defaultBranch?: unknown }).defaultBranch
    const { client } = fakeClient({ value: [empty] })

    const { rows } = await loadRepositories(client)

    expect('defaultBranch' in rows[0]).toBe(false)
  })

  it('reads an absent isFork as false', async () => {
    const { client } = fakeClient({ value: [wire('one', 'SaaS')] })

    const { rows } = await loadRepositories(client)

    expect('isFork' in wire('one', 'SaaS')).toBe(false)
    expect(rows[0].isFork).toBe(false)
  })

  it('keeps isFork when ADO sent it', async () => {
    const { client } = fakeClient({ value: [wire('one', 'SaaS', { isFork: true })] })

    const { rows } = await loadRepositories(client)

    expect(rows[0].isFork).toBe(true)
  })

  // Shown, marked. Dropping them makes the count disagree with the web UI.
  it('keeps a disabled repository in the list', async () => {
    const { client } = fakeClient({
      value: [wire('off', 'SaaS', { isDisabled: true }), wire('on', 'SaaS')],
    })

    const { rows } = await loadRepositories(client)

    expect(rows.map((row) => row.name)).toEqual(['off', 'on'])
    expect(rows.map((row) => row.isDisabled)).toEqual([true, false])
  })

  it('keeps remoteUrl verbatim, prefix and all', async () => {
    const { client } = fakeClient({ value: [wire('PC.IAC.Networking', 'SaaS')] })

    const { rows } = await loadRepositories(client)

    expect(rows[0].cloneUrl).toBe(
      'https://Profisee@dev.azure.com/Profisee/SaaS/_git/PC.IAC.Networking',
    )
  })

  // `url` is the API address and renders JSON. Confusing the two gives a link
  // that opens correctly and shows the wrong thing.
  it('takes the web link from webUrl and not from url', async () => {
    const { client } = fakeClient({ value: [wire('one', 'SaaS')] })

    const { rows } = await loadRepositories(client)

    expect(rows[0].webUrl).toBe('https://dev.azure.com/Profisee/SaaS/_git/one')
  })

  it('sorts by project, then by name', async () => {
    const { client } = fakeClient({
      value: [
        wire('zeta', 'SaaS'),
        wire('alpha', 'Products'),
        wire('alpha', 'SaaS'),
        wire('beta', 'Products'),
      ],
    })

    const { rows } = await loadRepositories(client)

    expect(rows.map((row) => `${row.project}/${row.name}`)).toEqual([
      'Products/alpha',
      'Products/beta',
      'SaaS/alpha',
      'SaaS/zeta',
    ])
  })

  it('drops a row with no name, project or clone URL rather than drawing a blank', async () => {
    const { client } = fakeClient({
      value: [
        wire('good', 'SaaS'),
        { ...wire('bad', 'SaaS'), name: undefined },
        { ...wire('bad', 'SaaS'), project: undefined },
        { ...wire('bad', 'SaaS'), remoteUrl: undefined },
      ],
    })

    const { rows, returned } = await loadRepositories(client)

    expect(rows.map((row) => row.name)).toEqual(['good'])
    // `returned` is the organisation's number, not the surviving rows'. If the
    // two disagree the page can say so.
    expect(returned).toBe(4)
  })

  it('answers an empty list rather than throwing when there is no value', async () => {
    const { client } = fakeClient({})

    const { rows, returned } = await loadRepositories(client)

    expect(rows).toEqual([])
    expect(returned).toBe(0)
  })
})
