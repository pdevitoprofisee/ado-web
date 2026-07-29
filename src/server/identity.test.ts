import { describe, expect, it } from 'vitest'

import { loadDirectory } from './identity'

import type { AdoClient, AdoHost, QueryValue } from './ado-client'

// T-035. The directory as one page of `graph/users` crossed onto identity GUIDs,
// and the three ways that crossing can go wrong.
//
// The fixture is `threads.test.ts`' `fakeClient`, narrowed: this module reads and
// never writes, and every call it makes has to be on `vssps` — the graph and
// identity paths 404 on the core host, which is the client's default.

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
  readonly host: AdoHost
}

type Reply = Error | Record<string, unknown>

function fakeClient(replies: Record<string, Reply | readonly Reply[]>) {
  const calls: Call[] = []

  const client: AdoClient = {
    org: 'Profisee',
    get<T>(
      path: string,
      params: Record<string, QueryValue> = {},
      host: AdoHost = 'core',
    ): Promise<T> {
      const before = calls.filter((call) => call.path === path).length
      calls.push({ path, params, host })

      const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
      if (match === undefined) return Promise.reject(new Error(`unexpected call: ${path}`))

      // An array is "one reply per call to this path", which is how the batched
      // `identities` calls get one failure among several successes.
      const reply = replies[match]
      const answer = Array.isArray(reply) ? reply[Math.min(before, reply.length - 1)] : reply
      if (answer instanceof Error) return Promise.reject(answer)

      return Promise.resolve(answer as T)
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    write: () => Promise.reject(new Error('this module never writes')),
    fanOut: (items, task) => Promise.all(items.map(task)),
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

const descriptor = (index: number) => `aad.person-${index}`
const guid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

const subject = (index: number, over: Record<string, unknown> = {}) => ({
  descriptor: descriptor(index),
  subjectKind: 'user',
  displayName: `Person ${String(index).padStart(3, '0')}`,
  mailAddress: `person${index}@profisee.com`,
  origin: 'aad',
  _links: { avatar: { href: `https://vssps/_apis/graph/Subjects/${descriptor(index)}/avatars` } },
  ...over,
})

const identity = (index: number, over: Record<string, unknown> = {}) => ({
  id: guid(index),
  subjectDescriptor: descriptor(index),
  isActive: true,
  ...over,
})

const users = (value: readonly unknown[]) => ({ value })
const crossed = (value: readonly unknown[]) => ({ value })

describe('loadDirectory', () => {
  it('reads one page of users and crosses it onto identity ids, on vssps', async () => {
    const { client, calls } = fakeClient({
      '_apis/graph/users': users([subject(1), subject(2)]),
      '_apis/identities': crossed([identity(1), identity(2)]),
    })

    const directory = await loadDirectory(client)

    expect(directory.people).toEqual([
      {
        identityId: guid(1),
        descriptor: descriptor(1),
        kind: 'user',
        displayName: 'Person 001',
        uniqueName: 'person1@profisee.com',
        avatarHref: `https://vssps/_apis/graph/Subjects/${descriptor(1)}/avatars`,
      },
      {
        identityId: guid(2),
        descriptor: descriptor(2),
        kind: 'user',
        displayName: 'Person 002',
        uniqueName: 'person2@profisee.com',
        avatarHref: `https://vssps/_apis/graph/Subjects/${descriptor(2)}/avatars`,
      },
    ])
    expect(directory.total).toBe(2)
    expect(directory.complete).toBe(true)

    // Both on `vssps`, and the graph call on the preview api-version: plain `7.1`
    // answers 400 on every `graph/*` path, and an omitted version on `identities`
    // answers a different, legacy, PascalCase body in which every field reads
    // `undefined`.
    expect(calls.map((call) => call.host)).toEqual(['vssps', 'vssps'])
    expect(calls[0].params['api-version']).toBe('7.1-preview.1')
    expect(calls[1].params['api-version']).toBe('7.1')
    // `descriptors=` is the legacy parameter and answers an array of nulls.
    expect(calls[1].params.subjectDescriptors).toBe(`${descriptor(1)},${descriptor(2)}`)
  })

  it('asks for identities fifty at a time, because seventy answers 404', async () => {
    const many = Array.from({ length: 120 }, (_, index) => subject(index))
    const { client, calls } = fakeClient({
      '_apis/graph/users': users(many),
      '_apis/identities': [
        crossed(many.slice(0, 50).map((_, index) => identity(index))),
        crossed(many.slice(50, 100).map((_, index) => identity(index + 50))),
        crossed(many.slice(100).map((_, index) => identity(index + 100))),
      ],
    })

    const directory = await loadDirectory(client)

    const batches = calls.filter((call) => call.path.endsWith('_apis/identities'))
    expect(batches).toHaveLength(3)
    expect(
      batches.map((call) => String(call.params.subjectDescriptors).split(',').length),
    ).toEqual([50, 50, 20])
    expect(directory.people).toHaveLength(120)
  })

  it('pairs people by the descriptor ADO echoes, never by position', async () => {
    // The worst failure available in this feature: zipping the answers onto the
    // batch by index means that one missing identity pairs everybody after it with
    // somebody else's GUID, and the composer inserts a mention of the wrong
    // colleague under the right name. Here the middle person is absent and the
    // answers come back shuffled.
    const { client } = fakeClient({
      '_apis/graph/users': users([subject(1), subject(2), subject(3)]),
      '_apis/identities': crossed([identity(3), null, identity(1)]),
    })

    const directory = await loadDirectory(client)

    expect(directory.people.map((found) => [found.displayName, found.identityId])).toEqual([
      ['Person 001', guid(1)],
      ['Person 003', guid(3)],
    ])
    // Still counted: the person who could not be crossed is the difference between
    // `total` and the list, which is what the picker says out loud.
    expect(directory.total).toBe(3)
  })

  it('loses one batch rather than the whole directory', async () => {
    const many = Array.from({ length: 60 }, (_, index) => subject(index))
    const { client } = fakeClient({
      '_apis/graph/users': users(many),
      '_apis/identities': [
        new Error('Azure DevOps answered 404 for _apis/identities.'),
        crossed(many.slice(50).map((_, index) => identity(index + 50))),
      ],
    })

    const directory = await loadDirectory(client)

    // 50 people missing from the picker is recoverable and visible. One 404 taking
    // the whole directory down is neither.
    expect(directory.people).toHaveLength(10)
    expect(directory.total).toBe(60)
  })

  it('drops a subject it could not offer, and a deactivated identity', async () => {
    const { client } = fakeClient({
      '_apis/graph/users': users([
        subject(1),
        // No descriptor to resolve, and no name to show: neither can be mentioned,
        // and a blank row in the picker is worse than a shorter list.
        subject(2, { descriptor: '' }),
        subject(3, { displayName: '' }),
        subject(4),
        null,
      ]),
      '_apis/identities': crossed([
        identity(1),
        identity(4, { isActive: false }),
        // A successful response can also carry an id-less identity.
        identity(5, { id: '' }),
      ]),
    })

    const directory = await loadDirectory(client)

    expect(directory.people.map((found) => found.displayName)).toEqual(['Person 001'])
    // The two unusable subjects are not counted as people who could not be looked
    // up, because they were never offerable in the first place.
    expect(directory.total).toBe(2)
  })

  it('sorts by display name, so a bare @ is alphabetical for both consumers', async () => {
    const { client } = fakeClient({
      '_apis/graph/users': users([
        subject(1, { displayName: 'Zoë Ali' }),
        subject(2, { displayName: 'aaron beck' }),
        subject(3, { displayName: 'Marjorie Chen' }),
      ]),
      '_apis/identities': crossed([identity(1), identity(2), identity(3)]),
    })

    const directory = await loadDirectory(client)

    // `localeCompare`, so a lower-cased name is not filed after every capital one.
    expect(directory.people.map((found) => found.displayName)).toEqual([
      'aaron beck',
      'Marjorie Chen',
      'Zoë Ali',
    ])
  })

  it('reads a group as a group and a missing mail address as absent', async () => {
    const { client } = fakeClient({
      '_apis/graph/users': users([
        subject(1, { subjectKind: 'group', mailAddress: undefined }),
        subject(2, { subjectKind: undefined, _links: null }),
      ]),
      '_apis/identities': crossed([identity(1), identity(2)]),
    })

    const directory = await loadDirectory(client)

    expect(directory.people[0].kind).toBe('group')
    // `''` and not `undefined`: the contract says to read the empty string as
    // absent, which is what the 151 service accounts in the org come back as.
    expect(directory.people[0].uniqueName).toBe('')
    expect(directory.people[1].kind).toBe('user')
    expect(directory.people[1].avatarHref).toBe('')
  })

  it('admits it cannot tell a full page from a whole directory', async () => {
    // The one thing this route cannot see: `graph/users` pages with a continuation
    // *header*, and `AdoClient.get` hands back parsed JSON. So the only signal left
    // is the count, and at the documented page size the answer is "may be short" —
    // which the picker prints, because a silently truncated directory looks exactly
    // like a search that does not work.
    const many = Array.from({ length: 500 }, (_, index) => subject(index))
    const { client } = fakeClient({
      '_apis/graph/users': users(many),
      '_apis/identities': crossed([]),
    })

    const directory = await loadDirectory(client)

    expect(directory.complete).toBe(false)
  })

  it('has nothing to say for an empty organisation, and does not ask', async () => {
    const { client, calls } = fakeClient({ '_apis/graph/users': {} })

    const directory = await loadDirectory(client)

    expect(directory).toEqual({ people: [], total: 0, complete: true })
    expect(calls).toHaveLength(1)
  })
})
