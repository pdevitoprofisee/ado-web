import { describe, expect, it } from 'vitest'

import {
  deleteComment,
  editComment,
  fileThreads,
  guardOwnComment,
  isSettableStatus,
  loadBotThreads,
  loadThreads,
  createThread,
  postReply,
  resolutionOf,
  setThreadStatus,
  toThreadList,
} from './threads'

import type { AdoClient, AdoHost, AdoWriteMethod, QueryValue } from './ado-client'
import type { AdoThread } from './threads'
import type { PullRequestRef } from './pull-request'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'
/** The identity that posted every SonarCloud status across the eight PRs T-022 sampled. */
const SONAR = '27ec814b-a933-430b-85ff-75142b4aaf4f'

const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24794 }

const PR = `${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullRequests/24794`
const THREADS = `${PR}/threads`

const FILE = '/Services.ConnEx.Core/Services/Portal/IntegrationStrategy/ModelBuilder.cs'

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
  /** Recorded because identity lookups 404 on the core host, and the default is core. */
  readonly host: AdoHost
}

/** `write` takes no host — every write in this file is on the core one. */
interface WriteCall extends Omit<Call, 'host'> {
  readonly method: AdoWriteMethod
  readonly body: unknown
}

type Reply = Error | Record<string, unknown>

/**
 * Replies are matched by path suffix, the way `pull-request.test.ts` does it, so a
 * fixture names the endpoint it is about rather than repeating the base path. The
 * writes are recorded rather than answered by suffix: what a write test wants to
 * assert is the method, the URL and the body, not what came back.
 */
function fakeClient(replies: Record<string, Reply>, written: Reply = {}) {
  const calls: Call[] = []
  const writes: WriteCall[] = []

  const client: AdoClient = {
    org: 'Profisee',
    get<T>(
      path: string,
      params: Record<string, QueryValue> = {},
      host: AdoHost = 'core',
    ): Promise<T> {
      calls.push({ path, params, host })
      const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
      if (match === undefined) return Promise.reject(new Error(`unexpected call: ${path}`))

      const reply = replies[match]
      if (reply instanceof Error) return Promise.reject(reply)

      return Promise.resolve(reply as T)
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    write<T>(
      method: AdoWriteMethod,
      path: string,
      body?: unknown,
      params: Record<string, QueryValue> = {},
    ): Promise<T | null> {
      writes.push({ method, path, body, params })
      if (written instanceof Error) return Promise.reject(written)

      return Promise.resolve(written as T)
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

/** `{"$type","$value"}` on every property of all 56 threads T-022 read. */
const property = (value: string | number, type = 'System.String') => ({
  $type: type,
  $value: value,
})

const comment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  parentCommentId: 0,
  author: { id: ME, displayName: 'Paul DeVito', uniqueName: 'paul@example.com' },
  content: 'This wants a null check.',
  publishedDate: '2026-07-21T10:00:00Z',
  lastUpdatedDate: '2026-07-21T10:00:00Z',
  lastContentUpdatedDate: '2026-07-21T10:00:00Z',
  commentType: 'text',
  usersLiked: [],
  ...over,
})

const thread = (over: Partial<AdoThread> = {}): AdoThread =>
  ({
    id: 312114,
    status: 'active',
    publishedDate: '2026-07-21T10:00:00Z',
    lastUpdatedDate: '2026-07-21T10:00:00Z',
    isDeleted: false,
    comments: [comment()],
    properties: {
      'Microsoft.TeamFoundation.Discussion.UniqueID': property('8681d0adeab64c06bafe8fe0a6d4c325'),
      'Microsoft.TeamFoundation.Discussion.SupportsMarkdown': property(1, 'System.Int32'),
    },
    ...over,
  }) as AdoThread

/** The 32-of-56 shape: ADO's activity trail, carrying no `status` key at all. */
const systemThread = (over: Partial<AdoThread> = {}): AdoThread =>
  ({
    id: 312000,
    publishedDate: '2026-07-20T09:00:00Z',
    comments: [
      comment({
        id: 1,
        content: 'Melissa Stan voted 10',
        commentType: 'system',
        author: { id: COLLEAGUE, displayName: 'Melissa Stan' },
      }),
    ],
    properties: {
      CodeReviewThreadType: property('VoteUpdate'),
    },
    ...over,
  }) as AdoThread

const anchored = (over: Partial<AdoThread> = {}): AdoThread =>
  thread({
    threadContext: {
      filePath: FILE,
      rightFileStart: { line: 350, offset: 56 },
      rightFileEnd: { line: 350, offset: 57 },
    },
    pullRequestThreadContext: {
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
      changeTrackingId: 12,
    },
    ...over,
  })

const sonarStatus = (id = SONAR) => ({
  context: { genre: 'SonarCloud', name: 'quality-gate' },
  createdBy: { id, displayName: 'QA Automation' },
})

function load(threads: readonly AdoThread[], over: Record<string, Reply> = {}) {
  const { client, calls } = fakeClient({
    '/threads': { value: threads },
    '/statuses': { value: [sonarStatus()] },
    ...over,
  })

  return { calls, loading: loadThreads(client, REF) }
}

describe('the call budget', () => {
  it('reads the whole conversation in one call, with no parameters and no paging', async () => {
    const { calls, loading } = load([anchored(), systemThread()])
    await loading

    const threads = calls.filter((call) => call.path === THREADS)
    expect(threads).toHaveLength(1)
    // T-022 sent `$top`, `$skip`, `$expand=none` and an iteration pair at this
    // endpoint and got the same nine threads every time. A parameter here would
    // be a knob wired to nothing.
    expect(threads[0]?.params).toEqual({})
  })

  it('asks the statuses endpoint who the robot is, and nothing else', async () => {
    const { calls, loading } = load([anchored()])
    await loading

    expect(calls.map((call) => call.path)).toEqual([THREADS, `${PR}/statuses`])
  })
})

describe('the mapper', () => {
  it('unwraps every property out of its $type/$value envelope', async () => {
    const list = await load([thread()]).loading

    expect(list.threads[0]?.properties).toEqual({
      'Microsoft.TeamFoundation.Discussion.UniqueID': '8681d0adeab64c06bafe8fe0a6d4c325',
      // A `System.Int32` on the wire, a string here: the bag has one shape so
      // that reading `CodeReviewThreadType` is not a type test.
      'Microsoft.TeamFoundation.Discussion.SupportsMarkdown': '1',
    })
  })

  it('carries a thread with no status as no status, not as active', async () => {
    const list = toThreadList([systemThread()])

    // Counted, not dropped silently — and `null` rather than `unknown`, because
    // 32 of 56 threads were never a question and "unknown status" would report
    // them as conversations nobody could classify.
    expect(list.systemCount).toBe(1)
    expect(list.threads).toEqual([])

    const raw = toThreadList([systemThread({ properties: null, comments: [comment()] })])
    expect(raw.threads[0]?.status).toBeNull()
    expect(raw.threads[0]?.resolution).toBe('done')
  })

  it('reads a deleted comment, which arrives with no content key at all', async () => {
    const list = await load([
      thread({
        comments: [
          // 7 of 59 comments were deleted, and `content` was absent on all 7 —
          // not null, not empty. One of them had a live reply under it.
          comment({ id: 1, isDeleted: true, content: undefined }),
          comment({ id: 2, parentCommentId: 1, content: 'done', author: { id: COLLEAGUE } }),
        ],
      }),
    ]).loading

    const [tombstone, reply] = list.threads[0]?.comments ?? []
    expect(tombstone?.isDeleted).toBe(true)
    expect(tombstone?.content).toBeNull()
    // The reply survives its parent, or a live comment would vanish with it.
    expect(reply?.content).toBe('done')
    expect(reply?.parentCommentId).toBe(1)
    // ADO's "no parent" is the number 0, which is not a comment id.
    expect(tombstone?.parentCommentId).toBeNull()
  })

  it('flattens changeTrackingId in beside the iteration pair it arrives next to', async () => {
    const list = await load([anchored()]).loading

    expect(list.threads[0]?.iterationContext).toEqual({
      firstComparingIteration: 1,
      secondComparingIteration: 1,
      changeTrackingId: 12,
    })
  })

  it('keeps an author with no display name readable', async () => {
    const list = toThreadList([thread({ comments: [comment({ author: { id: ME } })] })])

    expect(list.threads[0]?.comments[0]?.author).toEqual({
      id: ME,
      displayName: 'unknown',
      uniqueName: null,
      imageUrl: null,
    })
  })

  it('reads likes without offering a way to write one', async () => {
    const liked = comment({ usersLiked: [{ id: COLLEAGUE, displayName: 'Melissa Stan' }] })
    const list = toThreadList([thread({ comments: [liked] })])

    expect(list.threads[0]?.comments[0]?.likedBy.map((who) => who.displayName)).toEqual([
      'Melissa Stan',
    ])
  })
})

describe('resolution', () => {
  it('opens on active and pending, and closes on everything else including nothing', () => {
    expect(resolutionOf('active')).toBe('open')
    expect(resolutionOf('pending')).toBe('open')

    for (const status of ['fixed', 'wontFix', 'closed', 'byDesign', 'unknown'] as const) {
      expect(resolutionOf(status)).toBe('done')
    }
    // A missing status is the 32-thread case, and it is done: nothing is waiting.
    expect(resolutionOf(null)).toBe('done')
  })

  it('keeps a status ADO invents as unknown rather than throwing', () => {
    const list = toThreadList([thread({ status: 'escalated' })])

    expect(list.threads[0]?.status).toBe('unknown')
    expect(list.threads[0]?.resolution).toBe('done')
  })
})

describe('classification', () => {
  it('files Sonar under bot by the identity that posted its status', async () => {
    const robot = comment({ author: { id: SONAR, displayName: 'QA Automation' } })
    const list = await load([thread({ id: 1, comments: [robot] }), thread({ id: 2 })]).loading

    expect(list.botCount).toBe(1)
    expect(list.threads.map((entry) => entry.id)).toEqual([2])
    expect(list.threads.every((entry) => entry.kind === 'human')).toBe(true)
  })

  it('has no bots when the pull request has no Sonar status', async () => {
    // 6 of the 14 pull requests T-022 looked at had none, so this is the normal
    // answer and not a degraded one.
    const list = await load([thread({ comments: [comment({ author: { id: SONAR } })] })], {
      '/statuses': { value: [{ context: { genre: 'Custom' }, createdBy: { id: SONAR } }] },
    }).loading

    expect(list.botCount).toBe(0)
    expect(list.threads).toHaveLength(1)
  })

  it('keeps the conversation when the statuses call fails, and loses only the label', async () => {
    const list = await load([thread({ comments: [comment({ author: { id: SONAR } })] })], {
      '/statuses': new Error('Azure DevOps answered 500.'),
    }).loading

    // The price of a failed statuses call is that Sonar reads as a person. The
    // price of throwing would be a blank conversation because a side call
    // hiccupped.
    expect(list.threads).toHaveLength(1)
    expect(list.threads[0]?.kind).toBe('human')
  })

  it('lets the threads call itself fail, because nothing stands in for it', async () => {
    const { loading } = load([], { '/threads': new Error('Azure DevOps answered 404.') })

    await expect(loading).rejects.toThrow('Azure DevOps answered 404.')
  })

  it('treats a thread with no comments as system, because nobody is talking', () => {
    const list = toThreadList([thread({ comments: [], properties: null })])

    expect(list.systemCount).toBe(1)
    expect(list.threads).toEqual([])
  })

  it('counts what it excluded, so an empty conversation can say why', async () => {
    const list = await load([
      thread({ id: 1, status: 'active' }),
      thread({ id: 2, status: 'fixed' }),
      thread({ id: 3, comments: [comment({ author: { id: SONAR } })] }),
      systemThread({ id: 4 }),
      systemThread({ id: 5 }),
    ]).loading

    expect(list).toMatchObject({ openCount: 1, doneCount: 1, botCount: 1, systemCount: 2 })
    expect(list.threads).toHaveLength(2)
  })
})

describe('the robot half', () => {
  const robot = (over: Record<string, unknown> = {}) =>
    comment({ author: { id: SONAR, displayName: 'QA Automation' }, ...over })

  const bots = (threads: readonly AdoThread[], over: Record<string, Reply> = {}) => {
    const { client, calls } = fakeClient({
      '/threads': { value: threads },
      '/statuses': { value: [sonarStatus()] },
      ...over,
    })

    return { calls, loading: loadBotThreads(client, REF) }
  }

  it('answers with the threads the conversation drops, and only those', async () => {
    const threads = await bots([
      thread({ id: 1, comments: [robot({ content: 'Code Smell: 8 parameters.' })] }),
      thread({ id: 2 }),
      systemThread({ id: 3 }),
    ]).loading

    expect(threads.map((entry) => entry.id)).toEqual([1])
    expect(threads[0]?.kind).toBe('bot')
    expect(threads[0]?.comments[0]?.content).toBe('Code Smell: 8 parameters.')
  })

  it('answers with an empty list when the robot opened no thread', async () => {
    const threads = await bots([thread({ id: 1 }), systemThread({ id: 2 })]).loading

    expect(threads).toEqual([])
  })

  it('fails when it cannot tell whose threads are whose', async () => {
    const { loading } = bots([thread({ comments: [robot()] })], {
      '/statuses': new Error('Azure DevOps answered 500.'),
    })

    // `loadThreads` swallows this one and pays a label for it. Here the answer
    // would be an empty list, which reads as "Sonar opened no thread" — and the
    // caller would then report a finding as triaged with its comment left open.
    await expect(loading).rejects.toThrow('Azure DevOps answered 500.')
  })

  it('resolves no mention, because nothing here is read by a person', async () => {
    const tag = '@<FBFD3DD4-4D56-641D-9005-AE776A2D856C>'
    const { calls, loading } = bots([thread({ comments: [robot({ content: `cc ${tag}` })] })])
    const threads = await loading

    // Two calls, not three: this list exists to be matched against an issue key
    // and then PATCHed, so a name to draw is a call spent on nothing.
    expect(calls.map((call) => call.path)).toEqual([THREADS, `${PR}/statuses`])
    expect(threads[0]?.comments[0]?.mentions).toEqual({})
  })
})

describe('the vote trail', () => {
  const voted = (vote: number, at: string, voter = COLLEAGUE): AdoThread =>
    systemThread({
      publishedDate: at,
      comments: [comment({ commentType: 'system', author: { id: voter } })],
      properties: {
        CodeReviewThreadType: property('VoteUpdate'),
        CodeReviewVoteResult: property(String(vote)),
      },
    } as Partial<AdoThread>)

  it('carries a vote out with the date the standing vote does not have', () => {
    const list = toThreadList([voted(10, '2026-07-20T09:00:00Z')])

    // `reviewers[].vote` says Melissa approved and stops there. This is the only
    // place in the payload that says when, and "changes since my last review" is
    // a question about when.
    expect(list.votes).toEqual([{ voterId: COLLEAGUE, at: '2026-07-20T09:00:00Z', vote: 10 }])
    expect(list.threads).toEqual([])
    expect(list.systemCount).toBe(1)
  })

  it('keeps every vote, so the last one can be found rather than the first', () => {
    const list = toThreadList([
      voted(-5, '2026-07-20T09:00:00Z'),
      voted(10, '2026-07-22T09:00:00Z'),
    ])

    expect(list.votes.map((vote) => vote.vote)).toEqual([-5, 10])
  })

  it('drops a vote of zero, because that is a vote being taken away', () => {
    // ADO writes one of these when a push resets an approval. Treating it as a
    // review would date a review that no longer exists — and date it to the push
    // that cancelled it, which is the worst possible answer.
    expect(toThreadList([voted(0, '2026-07-20T09:00:00Z')]).votes).toEqual([])
  })

  it('ignores a system thread that is not a vote', () => {
    const list = toThreadList([
      systemThread({
        properties: { CodeReviewThreadType: property('RefUpdate') },
      } as Partial<AdoThread>),
    ])

    expect(list.votes).toEqual([])
    expect(list.systemCount).toBe(1)
  })

  it('ignores a vote thread ADO sent no vote on', () => {
    expect(toThreadList([systemThread()]).votes).toEqual([])
  })
})

describe('mentions', () => {
  /** The identity T-022 found tagged in a real comment, and the casing ADO wrote it in. */
  const TAGGED = 'fbfd3dd4-4d56-641d-9005-ae776a2d856c'

  /** A tag as ADO stores one: the GUID in the body, upper case, and no name anywhere. */
  const tagging = (id = TAGGED) =>
    thread({ comments: [comment({ content: `cc @<${id.toUpperCase()}>` })] })

  const tagged = (over: Record<string, Reply> = {}) =>
    fakeClient({
      '/threads': { value: [tagging()] },
      '/statuses': { value: [sonarStatus()] },
      '/identities': { value: [{ id: TAGGED.toUpperCase(), displayName: 'Patrick Mize' }] },
      ...over,
    })

  const mentionsOf = (list: Awaited<ReturnType<typeof loadThreads>>) =>
    list.threads[0]?.comments[0]?.mentions

  it('looks the tagged identity up on the host that answers, and hangs the name on the comment', async () => {
    const { client, calls } = tagged()
    const list = await loadThreads(client, REF)

    expect(mentionsOf(list)).toEqual({ [TAGGED]: 'Patrick Mize' })

    // `vssps` and not the core host: `_apis/identities` 404s on the core one,
    // which reads as a wrong path rather than a wrong host. And the id goes up
    // lower case while the reply comes back upper — every comparison in here is
    // case-insensitive for exactly that reason.
    const lookup = calls.find((call) => call.path === '_apis/identities')
    expect(lookup).toMatchObject({ host: 'vssps', params: { identityIds: TAGGED } })

    // The body is left as ADO stored it. The edit composer opens on `content`, so
    // rewriting the name in would post a comment that had lost its tag.
    expect(list.threads[0]?.comments[0]?.content).toBe(`cc @<${TAGGED.toUpperCase()}>`)
  })

  it('asks nothing when nobody is tagged, which is nearly every conversation', async () => {
    const { calls, loading } = load([anchored()])
    await loading

    expect(calls.some((call) => call.path.endsWith('/identities'))).toBe(false)
  })

  it('asks once per identity per client, however often the conversation is polled', async () => {
    // The diff refetches every ~30s. Without the cache, a thread with a tag in it
    // would buy a third call on every one of them for an answer that cannot change.
    const { client, calls } = tagged()
    await loadThreads(client, REF)
    const list = await loadThreads(client, REF)

    expect(calls.filter((call) => call.path === '_apis/identities')).toHaveLength(1)
    expect(mentionsOf(list)).toEqual({ [TAGGED]: 'Patrick Mize' })
  })

  it('remembers an identity it got no answer for, rather than asking again forever', async () => {
    // A deleted account resolves to nothing, and nothing is a real answer. Caching
    // it costs one call; not caching it costs one every poll, for ever.
    const { client, calls } = tagged({ '/identities': { value: [] } })
    await loadThreads(client, REF)
    const list = await loadThreads(client, REF)

    expect(calls.filter((call) => call.path === '_apis/identities')).toHaveLength(1)
    // Left out entirely rather than mapped to an empty name — the renderer's cue
    // to print the GUID the way the comment says it instead of a blank chip.
    expect(mentionsOf(list)).toEqual({})
  })

  it('keeps the conversation when the lookup fails, and tries again next time', async () => {
    const { client, calls } = tagged({ '/identities': new Error('Azure DevOps answered 500.') })
    const list = await loadThreads(client, REF)
    await loadThreads(client, REF)

    // Same trade as the statuses call: the price of a failure is a GUID on the
    // page, not a blank conversation. A failure caches nothing, though — it is not
    // an answer — so the second load asks again.
    expect(list.threads).toHaveLength(1)
    expect(mentionsOf(list)).toEqual({})
    expect(calls.filter((call) => call.path === '_apis/identities')).toHaveLength(2)
  })
})

describe('grouping by file', () => {
  const group = (threads: readonly AdoThread[]) => fileThreads(toThreadList(threads).threads)

  it('keys a right-side anchor on the line it starts at, offset and all', () => {
    const files = group([anchored()])
    const file = files.get(FILE)

    // Multi-line on 5 of 12 anchors and `offset` is not always 1 — the thread
    // still belongs under the line the reviewer selected first.
    expect(file?.byRightLine.get(350)?.map((entry) => entry.id)).toEqual([312114])
    expect(file?.unanchored).toEqual([])
    expect(files.size).toBe(1)
  })

  it('keeps a multi-line anchor with a mid-line offset on its first line only', () => {
    const files = group([
      anchored({
        threadContext: {
          filePath: FILE,
          rightFileStart: { line: 412, offset: 17 },
          rightFileEnd: { line: 418, offset: 3 },
        },
      }),
    ])

    expect([...(files.get(FILE)?.byRightLine.keys() ?? [])]).toEqual([412])
  })

  it('stacks two threads on the same line rather than losing one', () => {
    const files = group([anchored({ id: 1 }), anchored({ id: 2 })])

    expect(files.get(FILE)?.byRightLine.get(350)?.map((entry) => entry.id)).toEqual([1, 2])
  })

  it('puts an anchor that lands nowhere in unanchored rather than dropping it', () => {
    const files = group([
      // A left-side comment: real in ADO (a remark on a deleted line), and 0 of
      // 12 live. No right-side key can hold it, and it is still a comment.
      anchored({
        id: 700,
        threadContext: { filePath: FILE, leftFileStart: { line: 12, offset: 1 } },
      }),
      // An anchor ADO sent with no line at all.
      anchored({ id: 701, threadContext: { filePath: FILE, rightFileStart: { offset: 4 } } }),
    ])
    const file = files.get(FILE)

    expect(file?.unanchored.map((entry) => entry.id)).toEqual([700, 701])
    expect(file?.byRightLine.size).toBe(0)
  })

  it('leaves a thread on the pull request itself out of the file map entirely', () => {
    // 44 of 56 threads have no `threadContext`. They belong to the overview, and
    // a file that is not mentioned must not gain a key.
    expect(group([thread()]).size).toBe(0)
  })
})

describe('the writes', () => {
  const target = { threadId: 312114, commentId: 2 }

  it('replies on the thread’s comment collection, carrying the parent it answers', async () => {
    const { client, writes } = fakeClient({}, comment({ id: 3, parentCommentId: 1 }))

    const created = await postReply(client, REF, {
      threadId: 312114,
      parentCommentId: 1,
      content: 'Fixed in the next push.',
    })

    expect(writes).toEqual([
      {
        method: 'POST',
        path: `${THREADS}/312114/comments`,
        body: { content: 'Fixed in the next push.', parentCommentId: 1, commentType: 'text' },
        params: {},
      },
    ])
    // The server's copy, so the optimistic row gets a real comment id rather
    // than staying a placeholder.
    expect(created?.id).toBe(3)
    expect(created?.parentCommentId).toBe(1)
  })

  it('changes a status on its own request, with the status and nothing else in it', async () => {
    const fixed = thread({ status: 'fixed' }) as Record<string, unknown>
    const { client, writes } = fakeClient({}, fixed)

    const updated = await setThreadStatus(client, REF, { threadId: 312114, status: 'fixed' })

    expect(writes).toEqual([
      { method: 'PATCH', path: `${THREADS}/312114`, body: { status: 'fixed' }, params: {} },
    ])
    // No `content` key anywhere in the body: this is the shape that makes a
    // reply unable to close a thread by accident.
    expect(updated?.status).toBe('fixed')
    expect(updated?.resolution).toBe('done')
  })

  it('offers only the three settable states, plus reopening', () => {
    for (const status of ['fixed', 'wontFix', 'pending', 'active']) {
      expect(isSettableStatus(status)).toBe(true)
    }
    // `closed` is what completing the PR writes, `byDesign` comes from the web
    // UI's menu, and `unknown` is not a state anybody chose.
    for (const status of ['closed', 'byDesign', 'unknown', '', undefined, 7]) {
      expect(isSettableStatus(status)).toBe(false)
    }
  })

  it('edits by patching content alone', async () => {
    const { client, writes } = fakeClient({}, comment({ id: 2, content: 'Reworded.' }))

    const edited = await editComment(client, REF, { ...target, content: 'Reworded.' })

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `${THREADS}/312114/comments/2`,
        // Nothing else, so a stale `parentCommentId` cannot move the comment.
        body: { content: 'Reworded.' },
        params: {},
      },
    ])
    expect(edited?.content).toBe('Reworded.')
  })

  it('deletes with no body, and survives the 204 that answers it', async () => {
    // `write` returns `null` on a 204; `deleteComment` must not try to read a
    // comment out of it.
    const { client, writes } = fakeClient({})

    await expect(deleteComment(client, REF, target)).resolves.toBeUndefined()
    expect(writes).toEqual([
      { method: 'DELETE', path: `${THREADS}/312114/comments/2`, body: undefined, params: {} },
    ])
  })

  it('reports a write Azure DevOps refused rather than swallowing it', async () => {
    const { client } = fakeClient({}, new Error('Azure DevOps answered 400.'))

    await expect(
      postReply(client, REF, { threadId: 1, parentCommentId: 1, content: 'x' }),
    ).rejects.toThrow('Azure DevOps answered 400.')
  })
})

describe('starting a thread', () => {
  const ANCHOR = { line: 40, offset: 1 }

  it('creates the thread with its first comment inside it, active, on the line asked for', async () => {
    const { client, writes } = fakeClient({}, thread({ id: 999 }) as Record<string, unknown>)

    const created = await createThread(client, REF, {
      content: 'This reads better as a guard clause.',
      context: {
        filePath: '/src/log.ts',
        rightStart: ANCHOR,
        rightEnd: null,
        leftStart: null,
        leftEnd: null,
      },
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2, changeTrackingId: 7 },
    })

    expect(writes).toEqual([
      {
        method: 'POST',
        path: THREADS,
        body: {
          comments: [
            {
              parentCommentId: 0,
              content: 'This reads better as a guard clause.',
              commentType: 'text',
            },
          ],
          status: 'active',
          threadContext: {
            filePath: '/src/log.ts',
            rightFileStart: ANCHOR,
            // Filled in from the start: ADO anchors nothing when handed a start
            // with no end, and a one-line selection is the common case.
            rightFileEnd: ANCHOR,
            leftFileStart: undefined,
            leftFileEnd: undefined,
          },
          // The nesting the contract gets wrong, written the way the wire wants
          // it: `changeTrackingId` beside `iterationContext`, not inside it.
          pullRequestThreadContext: {
            changeTrackingId: 7,
            iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 },
          },
        },
        params: {},
      },
    ])
    expect(created?.id).toBe(999)
  })

  it('sends no context at all for a thread on the pull request itself', async () => {
    const { client, writes } = fakeClient({}, thread({ id: 999 }) as Record<string, unknown>)

    await createThread(client, REF, {
      content: 'Rebasing this onto main first would shrink the diff.',
      context: null,
      iterationContext: null,
    })

    const body = writes[0].body as Record<string, unknown>
    // Not `{}` and not a filePath of '': 44 of 56 sampled threads hang on the
    // pull request, and they hang there by having no `threadContext` key.
    expect(body.threadContext).toBeUndefined()
    expect(body.pullRequestThreadContext).toBeUndefined()
    expect(body.status).toBe('active')
  })

  it('sends a file-level thread as a path with no positions', async () => {
    const { client, writes } = fakeClient({}, thread({ id: 999 }) as Record<string, unknown>)

    await createThread(client, REF, {
      content: 'This file could go entirely.',
      context: {
        filePath: '/src/log.ts',
        rightStart: null,
        rightEnd: null,
        leftStart: null,
        leftEnd: null,
      },
      iterationContext: null,
    })

    expect((writes[0].body as { threadContext: unknown }).threadContext).toEqual({
      filePath: '/src/log.ts',
      rightFileStart: undefined,
      rightFileEnd: undefined,
      leftFileStart: undefined,
      leftFileEnd: undefined,
    })
  })

  it('reports a refusal rather than retrying it', async () => {
    const { client } = fakeClient({}, new Error('Azure DevOps answered 400.'))

    await expect(
      createThread(client, REF, { content: 'x', context: null, iterationContext: null }),
    ).rejects.toThrow('Azure DevOps answered 400.')
  })
})

describe('the own-author guard', () => {
  const target = { threadId: 312114, commentId: 2 }

  /** `threads/{id}` answers with one thread, **not** wrapped in `value` — measured. */
  const single = (authorId: string) => ({
    '/threads/312114': thread({
      comments: [comment({ id: 1 }), comment({ id: 2, author: { id: authorId } })],
    }) as Record<string, unknown>,
  })

  it('lets the author through, on one unwrapped single-thread read', async () => {
    const { client, calls, writes } = fakeClient(single(ME))

    await expect(guardOwnComment(client, REF, target, ME)).resolves.toBeNull()
    expect(calls.map((call) => call.path)).toEqual([`${THREADS}/312114`])
    // The guard reads. It must never be the thing that writes.
    expect(writes).toEqual([])
  })

  it('refuses a colleague’s comment on the server, not merely in the UI', async () => {
    const { client } = fakeClient(single(COLLEAGUE))

    await expect(guardOwnComment(client, REF, target, ME)).resolves.toBe(
      'Only a comment’s author can edit or delete it.',
    )
  })

  it('ignores GUID casing, which ADO is not consistent about between endpoints', async () => {
    const { client } = fakeClient(single(ME.toUpperCase()))

    await expect(guardOwnComment(client, REF, target, ME)).resolves.toBeNull()
  })

  it('refuses when the viewer has no id, rather than matching an authorless comment', async () => {
    const { client } = fakeClient(single(''))

    await expect(guardOwnComment(client, REF, target, '')).resolves.toBe(
      'Only a comment’s author can edit or delete it.',
    )
  })

  it('says the comment is gone rather than that it is not yours', async () => {
    const { client } = fakeClient({
      '/threads/312114': thread({ comments: [comment({ id: 1 })] }) as Record<string, unknown>,
    })

    await expect(guardOwnComment(client, REF, target, ME)).resolves.toBe(
      'That comment is no longer on the thread.',
    )
  })
})
