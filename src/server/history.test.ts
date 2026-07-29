// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAdoClient } from './ado-client'
import { loadHistory } from './history'

import type { AdoClient, AdoHost, QueryValue } from './ado-client'

const ME = 'ba11ca22-79d4-65e2-8401-70ab29e1a5e2'
const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPO = '22222222-2222-2222-2222-222222222222'

const CONNECTED = { authenticatedUser: { id: ME, providerDisplayName: 'Paul DeVito' } }

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
  readonly host: AdoHost
}

const pr = (id: number, closedDate: string, over: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  createdBy: { id: ME, displayName: 'Paul DeVito' },
  repository: { id: REPO, name: 'PC.IAC.Modules', project: { id: PROJECT, name: 'SaaS' } },
  targetRefName: 'refs/heads/main',
  creationDate: '2026-01-01T00:00:00Z',
  closedDate,
  ...over,
})

/**
 * Replies to `pullrequests` are keyed by the `searchCriteria.status` asked for,
 * because that is the whole shape of this module: two calls that differ in one
 * parameter, and a fake that ignored it would make them indistinguishable.
 */
function fakeClient(byStatus: Record<string, unknown[]>, connectionData: unknown = CONNECTED) {
  const calls: Call[] = []

  const client: AdoClient = {
    org: 'Contoso',
    async get<T>(
      path: string,
      params: Record<string, QueryValue> = {},
      host: AdoHost = 'core',
    ): Promise<T> {
      calls.push({ path, params, host })
      if (path === '_apis/connectionData') return connectionData as T
      if (path === '_apis/git/pullrequests') {
        const value = byStatus[String(params['searchCriteria.status'])] ?? []

        return { count: value.length, value } as T
      }

      throw new Error(`unexpected call to ${path}`)
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    write: () => Promise.reject(new Error('this fixture is read-only')),
    fanOut: async (items, task) => Promise.all(items.map((item) => task(item))),
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

const listings = (calls: readonly Call[]) => calls.filter((c) => c.path === '_apis/git/pullrequests')

describe('loadHistory', () => {
  it('asks ADO twice, once per closed state, filtered to me and bounded', async () => {
    const { client, calls } = fakeClient({
      completed: [pr(1, '2026-05-01T00:00:00Z')],
      abandoned: [pr(2, '2026-06-01T00:00:00Z')],
    })

    const history = await loadHistory(client)

    // Three cold: `connectionData` and the two listings. Nothing else — no
    // per-PR hydration, and no `active` scan of the org.
    expect(calls.map((c) => c.path)).toEqual([
      '_apis/connectionData',
      '_apis/git/pullrequests',
      '_apis/git/pullrequests',
    ])
    expect(listings(calls).map((c) => c.params['searchCriteria.status'])).toEqual([
      'completed',
      'abandoned',
    ])
    for (const call of listings(calls)) {
      expect(call.params['searchCriteria.creatorId']).toBe(ME)
      expect(call.params.$top).toBe(history.perOutcome)
      // No paging loop: the correct stop condition for this endpoint is an empty
      // page, and a closed history never gives one.
      expect(call.params.$skip).toBeUndefined()
    }
  })

  it('interleaves the two outcomes newest-closed first', async () => {
    const { client } = fakeClient({
      completed: [pr(1, '2026-01-05T00:00:00Z'), pr(3, '2026-03-05T00:00:00Z')],
      abandoned: [pr(2, '2026-02-05T00:00:00Z'), pr(4, '2026-04-05T00:00:00Z')],
    })

    const history = await loadHistory(client)

    expect(history.rows.map((row) => row.id)).toEqual([4, 3, 2, 1])
  })

  it('tags each row with which of the two it was, and when', async () => {
    const { client } = fakeClient({
      completed: [pr(1, '2026-05-01T09:00:00Z')],
      abandoned: [pr(2, '2026-06-01T09:00:00Z')],
    })

    const history = await loadHistory(client)

    expect(history.rows.map((row) => row.closed)).toEqual([
      { at: '2026-06-01T09:00:00Z', outcome: 'abandoned' },
      { at: '2026-05-01T09:00:00Z', outcome: 'completed' },
    ])
  })

  it('keeps the two GUIDs, so a closed row still links into the app', async () => {
    const { client } = fakeClient({ completed: [pr(1, '2026-05-01T00:00:00Z')], abandoned: [] })

    const history = await loadHistory(client)

    expect(history.rows[0]).toMatchObject({
      projectId: PROJECT,
      repositoryId: REPO,
      url: 'https://dev.azure.com/Contoso/SaaS/_git/PC.IAC.Modules/pullrequest/1',
    })
  })

  it('costs two calls on a warm process, because the identity does not change', async () => {
    const { client, calls } = fakeClient({
      completed: [pr(1, '2026-05-01T00:00:00Z')],
      abandoned: [],
    })

    await loadHistory(client)
    expect(calls).toHaveLength(3)

    await loadHistory(client)

    // Only the two listings. `connectionData` is the one call here with no news
    // in it, and going through the inbox's `whoAmI` would have added `teams` and
    // two `identities` lookups this page never reads.
    expect(calls.slice(3).map((c) => c.path)).toEqual([
      '_apis/git/pullrequests',
      '_apis/git/pullrequests',
    ])
  })

  it('re-derives the identity when Refresh asks for it', async () => {
    const { client, calls } = fakeClient({ completed: [], abandoned: [] })

    await loadHistory(client)
    await loadHistory(client, true)

    expect(calls).toHaveLength(6)
  })

  it('says it was capped when ADO filled a request to the brim', async () => {
    const day = (i: number) => String((i % 28) + 1).padStart(2, '0')
    const full = (count: number) =>
      Array.from({ length: count }, (_, i) => pr(i + 1, `2026-05-${day(i)}T00:00:00Z`))
    const { client } = fakeClient({ completed: full(100), abandoned: [] })

    const history = await loadHistory(client)

    expect(history.perOutcome).toBe(100)
    expect(history.capped).toBe(true)
    // Capped, not truncated: everything fetched is shown, and the flag is what
    // lets the page admit there is more behind it.
    expect(history.rows).toHaveLength(100)
  })

  it('does not raise the flag when neither request came back full', async () => {
    const { client } = fakeClient({
      completed: [pr(1, '2026-05-01T00:00:00Z')],
      abandoned: [pr(2, '2026-05-02T00:00:00Z')],
    })

    expect((await loadHistory(client)).capped).toBe(false)
  })

  it('sorts a PR with no closed date to the bottom rather than the top', async () => {
    // An empty date sorts *first* under a naive ascending compare, which would
    // put the one row we know least about at the head of the page.
    const { client } = fakeClient({
      completed: [pr(1, ''), pr(2, '2026-05-01T00:00:00Z')],
      abandoned: [],
    })

    const history = await loadHistory(client)

    expect(history.rows.map((row) => row.id)).toEqual([2, 1])
    expect(history.rows[1].closed).toEqual({ at: '', outcome: 'completed' })
  })

  it('keeps history that the inbox would have hidden as too old', async () => {
    // The inbox drops anything over three years old, because an ancient review
    // request is not a queue. This page is the opposite: old is the point.
    const { client } = fakeClient({ completed: [pr(1, '2019-04-01T00:00:00Z')], abandoned: [] })

    expect((await loadHistory(client)).rows.map((row) => row.id)).toEqual([1])
  })

  it('skips an entry ADO answered without an id, since there is nothing to link to', async () => {
    const { client } = fakeClient({
      completed: [pr(1, '2026-05-01T00:00:00Z'), { title: 'no id' }],
      abandoned: [],
    })

    expect((await loadHistory(client)).rows.map((row) => row.id)).toEqual([1])
  })

  it('refuses to build a page with no identity to filter on', async () => {
    const { client, calls } = fakeClient({ completed: [], abandoned: [] }, {})

    await expect(loadHistory(client)).rejects.toThrow(/no authenticated user/)
    // And it asked ADO for nothing else: an unfiltered listing is exactly the
    // failure this page must never have.
    expect(listings(calls)).toEqual([])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('note 1, wired up', () => {
  it('never lists pull requests at all when the identity is not a GUID', async () => {
    // The guard lives in `ado-client.ts`, but it only fires on a parameter *named*
    // `creatorId`. This test is the wiring: if the filter were ever sent under
    // another name, ADO would silently ignore it and this page would render the
    // whole organisation's closed pull requests as mine, with no error to see.
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)

      return Promise.resolve(
        new Response(JSON.stringify({ authenticatedUser: { id: 'paul@example.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    const client = createAdoClient({ org: 'Contoso', pat: 'p'.repeat(52) })

    await expect(loadHistory(client)).rejects.toThrow(/must be a GUID/)

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('_apis/connectionData')
  })
})
