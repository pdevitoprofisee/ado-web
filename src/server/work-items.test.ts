import { describe, expect, it } from 'vitest'

import { WORK_ITEM_FIELDS, WORK_ITEM_SUGGESTIONS } from '../lib/work-item-contract'
import {
  fetchWorkItems,
  linkWorkItem,
  loadWorkItems,
  pullRequestArtifact,
  searchWorkItems,
} from './work-items'

import type { AdoHost, AdoClient, AdoWriteMethod, QueryValue } from './ado-client'
import type { PullRequestRef } from './pull-request'

// Work items: the two-call read, the search that has three shapes, and the one
// write nobody has sent to Azure DevOps yet.
//
// The fixture is `checks.test.ts`' `fakeClient` with one thing added — writes are
// answered by path, because this module sends two different ones through `write`
// and only one of them is a write. The WIQL query is a `POST` that changes
// nothing, and it goes down that path because `write` is the only path with a body.

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
  readonly host: AdoHost
}

interface WriteCall {
  readonly method: AdoWriteMethod
  readonly path: string
  readonly body: unknown
  readonly contentType: string | undefined
}

type Reply = Error | Record<string, unknown>

function fakeClient(replies: Record<string, Reply | readonly Reply[]>) {
  const calls: Call[] = []
  const writes: WriteCall[] = []

  const answer = (path: string, before: number): Reply | undefined => {
    const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
    if (match === undefined) return undefined
    const reply = replies[match]

    // An array is "one reply per call to this path", which is how a chunked batch
    // gets a different page each time.
    return Array.isArray(reply) ? reply[Math.min(before, reply.length - 1)] : (reply as Reply)
  }

  const client: AdoClient = {
    org: 'Profisee',
    get<T>(
      path: string,
      params: Record<string, QueryValue> = {},
      host: AdoHost = 'core',
    ): Promise<T> {
      const before = calls.filter((call) => call.path === path).length
      calls.push({ path, params, host })
      const reply = answer(path, before)
      if (reply === undefined) return Promise.reject(new Error(`unexpected call: ${path}`))
      if (reply instanceof Error) return Promise.reject(reply)

      return Promise.resolve(reply as T)
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    write<T>(
      method: AdoWriteMethod,
      path: string,
      body?: unknown,
      _params: Record<string, QueryValue> = {},
      options: { readonly contentType?: string } = {},
    ): Promise<T | null> {
      const before = writes.filter((write) => write.path === path).length
      writes.push({ method, path, body, contentType: options.contentType })
      const reply = answer(path, before)
      if (reply === undefined) return Promise.resolve(null)
      if (reply instanceof Error) return Promise.reject(reply)

      return Promise.resolve(reply as T)
    },
    fanOut: (items, task) => Promise.all(items.map(task)),
    rateLimit: () => ({
      remaining: null,
      limit: null,
      delay: null,
      resetAt: null,
      throttledUntil: null,
      throttled: false,
      calls: calls.length + writes.length,
      cost: 0,
    }),
  }

  return { client, calls, writes }
}

const PROJECT = '11111111-1111-4111-8111-111111111111'
const REPO = '22222222-2222-4222-8222-222222222222'
const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPO, id: 7 }

const PR_WORK_ITEMS = `/pullRequests/7/workitems`
const BATCH = '_apis/wit/workitems'
const WIQL = '_apis/wit/wiql'

const refs = (ids: readonly string[]) => ({ value: ids.map((id) => ({ id })) })

const wire = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  fields: {
    'System.Id': id,
    'System.Title': `Work item ${id}`,
    'System.State': 'Active',
    'System.WorkItemType': 'Bug',
    'System.TeamProject': 'Platform',
    ...over,
  },
})

const batch = (value: readonly unknown[]) => ({ value })
const found = (ids: readonly number[]) => ({ workItems: ids.map((id) => ({ id })) })

describe('loadWorkItems', () => {
  it('reads refs, then titles, and keeps the refs order', async () => {
    const { client, calls } = fakeClient({
      [PR_WORK_ITEMS]: refs(['91', '90']),
      [BATCH]: batch([wire(90), wire(91)]),
    })

    const result = await loadWorkItems(client, REF)

    expect(result.items.map((item) => item.id)).toEqual([91, 90])
    expect(result.total).toBe(2)
    expect(result.error).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[1].params).toEqual({
      ids: '91,90',
      fields: WORK_ITEM_FIELDS.join(','),
      // Always sent. A work item the credential cannot see otherwise costs every
      // good id in the same request a 404.
      errorPolicy: 'omit',
    })
  })

  it('reads the whole title, the state and the type, and builds a browser url', async () => {
    const { client } = fakeClient({
      [PR_WORK_ITEMS]: refs(['91']),
      [BATCH]: batch([wire(91)]),
    })

    const result = await loadWorkItems(client, REF)

    expect(result.items[0]).toEqual({
      id: 91,
      title: 'Work item 91',
      state: 'Active',
      type: 'Bug',
      url: 'https://dev.azure.com/Profisee/Platform/_workitems/edit/91',
    })
  })

  it('drops the project from the url when the work item did not name one', async () => {
    const { client } = fakeClient({
      [PR_WORK_ITEMS]: refs(['91']),
      [BATCH]: batch([wire(91, { 'System.TeamProject': undefined })]),
    })

    const result = await loadWorkItems(client, REF)

    expect(result.items[0].url).toBe('https://dev.azure.com/Profisee/_workitems/edit/91')
  })

  it('leaves an untitled work item untitled', async () => {
    const { client } = fakeClient({
      [PR_WORK_ITEMS]: refs(['91']),
      [BATCH]: batch([wire(91, { 'System.Title': undefined })]),
    })

    const result = await loadWorkItems(client, REF)

    expect(result.items[0].title).toBe('')
  })

  it('asks for nothing when the pull request has no work items', async () => {
    const { client, calls } = fakeClient({ [PR_WORK_ITEMS]: refs([]) })

    const result = await loadWorkItems(client, REF)

    expect(result).toEqual({ items: [], total: 0, error: null })
    expect(calls).toHaveLength(1)
  })

  it('drops a ref whose id is not a work item number, and does not count it', async () => {
    const { client, calls } = fakeClient({
      [PR_WORK_ITEMS]: { value: [{ id: '91' }, { id: '' }, { id: 'abc' }, { id: '0' }, {}] },
      [BATCH]: batch([wire(91)]),
    })

    const result = await loadWorkItems(client, REF)

    expect(calls[1].params.ids).toBe('91')
    expect(result.total).toBe(1)
  })

  it('counts what is attached, not what arrived, when the batch omits one', async () => {
    const { client } = fakeClient({
      [PR_WORK_ITEMS]: refs(['91', '92']),
      [BATCH]: batch([wire(91)]),
    })

    const result = await loadWorkItems(client, REF)

    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(2)
  })
})

describe('fetchWorkItems', () => {
  it('chunks at 200, because 210 ids answered HTTP 500', async () => {
    const ids = Array.from({ length: 201 }, (_, at) => at + 1)
    const { client, calls } = fakeClient({
      [BATCH]: [batch(ids.slice(0, 200).map((id) => wire(id))), batch([wire(201)])],
    })

    const items = await fetchWorkItems(client, ids)

    expect(calls).toHaveLength(2)
    expect(String(calls[0].params.ids).split(',')).toHaveLength(200)
    expect(String(calls[1].params.ids)).toBe('201')
    expect(items).toHaveLength(201)
  })

  it('matches by the id Azure DevOps echoes, never by position', async () => {
    const { client } = fakeClient({ [BATCH]: batch([wire(93), wire(91)]) })

    const items = await fetchWorkItems(client, [91, 92, 93])

    expect(items.map((item) => item.id)).toEqual([91, 93])
  })

  it('ignores a row with no fields, which is what an omitted id looks like', async () => {
    const { client } = fakeClient({ [BATCH]: batch([{ id: 91 }, wire(92)]) })

    const items = await fetchWorkItems(client, [91, 92])

    expect(items.map((item) => item.id)).toEqual([92])
  })

  it('asks nothing for an empty list', async () => {
    const { client, calls } = fakeClient({})

    expect(await fetchWorkItems(client, [])).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('searchWorkItems', () => {
  it('offers what is assigned to me, newest change first, when nothing is typed', async () => {
    const { client, writes } = fakeClient({
      [WIQL]: found([91]),
      [BATCH]: batch([wire(91)]),
    })

    const result = await searchWorkItems(client, PROJECT, '   ')

    expect(result.items.map((item) => item.id)).toEqual([91])
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('POST')
    expect(writes[0].path).toBe(`${PROJECT}/_apis/wit/wiql`)

    const { query } = writes[0].body as { query: string }
    expect(query).toContain('[System.TeamProject] = @project')
    expect(query).toContain('[System.AssignedTo] = @Me')
    expect(query).toContain('ORDER BY [System.ChangedDate] DESC')
  })

  it('caps the suggestions at the number the picker shows', async () => {
    const { client } = fakeClient({ [WIQL]: found([]), [BATCH]: batch([]) })

    await searchWorkItems(client, PROJECT, '')

    // `$top` rather than a slice here, because WIQL is what does the ordering.
    expect(WORK_ITEM_SUGGESTIONS).toBe(8)
  })

  it('reads a number as an id first, and asks nothing else when it is one', async () => {
    const { client, calls, writes } = fakeClient({ [BATCH]: batch([wire(162828)]) })

    const result = await searchWorkItems(client, PROJECT, ' 162828 ')

    expect(result.items.map((item) => item.id)).toEqual([162828])
    expect(calls[0].params.ids).toBe('162828')
    expect(writes).toEqual([])
  })

  it('falls through to the title search when the number is not an id', async () => {
    const { client, writes } = fakeClient({
      [BATCH]: [batch([]), batch([wire(91)])],
      [WIQL]: found([91]),
    })

    const result = await searchWorkItems(client, PROJECT, '1628')

    expect(result.items.map((item) => item.id)).toEqual([91])
    expect((writes[0].body as { query: string }).query).toContain(
      "[System.Title] CONTAINS '1628'",
    )
  })

  it('searches titles for anything else', async () => {
    const { client, writes } = fakeClient({
      [WIQL]: found([91]),
      [BATCH]: batch([wire(91)]),
    })

    await searchWorkItems(client, PROJECT, 'login')

    expect((writes[0].body as { query: string }).query).toContain(
      "[System.Title] CONTAINS 'login'",
    )
  })

  it("doubles a quote, which is the only escape WIQL has", async () => {
    const { client, writes } = fakeClient({ [WIQL]: found([]), [BATCH]: batch([]) })

    await searchWorkItems(client, PROJECT, "o'brien")

    expect((writes[0].body as { query: string }).query).toContain(
      "[System.Title] CONTAINS 'o''brien'",
    )
  })

  it('drops an id WIQL did not answer with a number', async () => {
    const { client, calls } = fakeClient({
      [WIQL]: { workItems: [{ id: 91 }, { id: 0 }, {}] },
      [BATCH]: batch([wire(91)]),
    })

    await searchWorkItems(client, PROJECT, 'login')

    expect(calls[0].params.ids).toBe('91')
  })
})

describe('linkWorkItem', () => {
  it('patches the work item, not the pull request, with a JSON Patch document', async () => {
    const { client, writes } = fakeClient({})

    await linkWorkItem(client, REF, 91)

    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('PATCH')
    expect(writes[0].path).toBe(`${PROJECT}/_apis/wit/workitems/91`)
    // The reason `AdoClient.write` learned a per-call content type: `wit` refuses
    // `application/json` for a patch document.
    expect(writes[0].contentType).toBe('application/json-patch+json')
    expect(writes[0].body).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F7`,
          attributes: { name: 'Pull Request' },
        },
      },
    ])
  })

  it('appends rather than writing an index, so no revision test is needed', async () => {
    const { client, writes } = fakeClient({})

    await linkWorkItem(client, REF, 91)

    expect((writes[0].body as { path: string }[])[0].path).toBe('/relations/-')
  })

  it('refuses an id that is not a work item number, and writes nothing', async () => {
    const { client, writes } = fakeClient({})

    await expect(linkWorkItem(client, REF, 0)).rejects.toThrow('0 is not a work item id')
    await expect(linkWorkItem(client, REF, 1.5)).rejects.toThrow('not a work item id')
    expect(writes).toEqual([])
  })

  it('passes a refusal through rather than folding it into one of ours', async () => {
    const { client } = fakeClient({
      '_apis/wit/workitems/91': new Error('Azure DevOps answered 403.'),
    })

    await expect(linkWorkItem(client, REF, 91)).rejects.toThrow('Azure DevOps answered 403.')
  })
})

describe('pullRequestArtifact', () => {
  it('percent-encodes the slashes inside the value, because they are part of it', () => {
    expect(pullRequestArtifact(REF)).toBe(
      `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F7`,
    )
  })
})
