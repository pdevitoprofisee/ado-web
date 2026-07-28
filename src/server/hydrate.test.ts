import { describe, expect, it } from 'vitest'

import { openDatabase } from './db'
import { approvalWasReset, countUnresolved, hydrate, readChecks } from './hydrate'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoClient, QueryValue } from './ado-client'
import type { HydrationTarget } from './hydrate'

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const SONAR = 'bbbbbbbb-1111-2222-3333-444444444444'
const PIPELINES = 'cccccccc-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'

const TARGET: HydrationTarget = {
  id: 24698,
  commitId: 'a'.repeat(40),
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  myVote: 0,
}

/** A human comment thread, in the shape the live API actually returns. */
const thread = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  comments: [{ commentType: 'text', author: { id: COLLEAGUE } }],
  ...over,
})

const system = (type: string, at: string, over: Record<string, unknown> = {}) => ({
  publishedDate: at,
  comments: [{ commentType: 'system', author: { id: ME } }],
  properties: { CodeReviewThreadType: { $value: type } },
  ...over,
})

const vote = (by: string, result: string, at: string) => ({
  publishedDate: at,
  comments: [{ commentType: 'system', author: { id: by } }],
  properties: {
    CodeReviewThreadType: { $value: 'VoteUpdate' },
    CodeReviewVoteResult: { $value: result },
  },
})

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
}

function fakeClient(replies: Record<string, unknown>): AdoClient & { calls: Call[] } {
  const calls: Call[] = []

  return {
    org: 'Profisee',
    calls,
    async get(path: string, params: Record<string, QueryValue> = {}) {
      calls.push({ path, params })
      const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
      if (match === undefined) throw new Error(`unexpected call: ${path}`)
      const reply = replies[match]
      if (reply instanceof Error) throw reply

      return reply as never
    },
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
    async fanOut(items, task) {
      return Promise.all(items.map(task))
    },
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
}

const memory = (): DatabaseSync => openDatabase(':memory:')
const me = async () => ME

describe('countUnresolved', () => {
  const bots = new Set([SONAR, PIPELINES])

  it('counts only threads a person is still waiting on', () => {
    expect(
      countUnresolved(
        [
          thread({ status: 'active' }),
          thread({ status: 'pending' }),
          thread({ status: 'fixed' }),
          thread({ status: 'wontFix' }),
          thread({ status: 'closed' }),
        ],
        bots,
      ),
    ).toBe(2)
  })

  it('does not let Sonar inflate the count, even though it posts as a human would', () => {
    // The trap: Sonar's comments are `commentType: "text"`, so filtering on the
    // comment type alone leaves all five of these in.
    const sonarThreads = Array.from({ length: 5 }, () =>
      thread({ comments: [{ commentType: 'text', author: { id: SONAR } }] }),
    )

    expect(countUnresolved([...sonarThreads, thread()], bots)).toBe(1)
  })

  it('excludes the build bot too, which the ticket did not know about', () => {
    expect(
      countUnresolved(
        [thread({ comments: [{ commentType: 'text', author: { id: PIPELINES } }] })],
        bots,
      ),
    ).toBe(0)
  })

  it('ignores system threads and deleted threads', () => {
    expect(
      countUnresolved(
        [
          system('ReviewersUpdate', '2026-07-01T00:00:00Z', { status: 'active' }),
          thread({ isDeleted: true }),
        ],
        bots,
      ),
    ).toBe(0)
  })

  it('counts a bot that posted no status on this PR, rather than risk hiding a person', () => {
    expect(countUnresolved([thread({ comments: [{ commentType: 'text', author: { id: SONAR } }] })], new Set())).toBe(1)
  })
})

describe('readChecks', () => {
  it('sorts the policy evaluations into the three states that matter', () => {
    expect(
      readChecks({
        value: [
          { status: 'approved' },
          { status: 'approved' },
          { status: 'rejected' },
          { status: 'broken' },
          { status: 'queued' },
          { status: 'running' },
          { status: 'notApplicable' },
        ],
      }),
    ).toEqual({ passed: 2, failed: 2, pending: 2 })
  })

  it('treats a PR with no policies as having no checks, not as passing', () => {
    expect(readChecks({})).toEqual({ passed: 0, failed: 0, pending: 0 })
  })
})

describe('approvalWasReset', () => {
  const approved = vote(ME, '10', '2026-07-20T10:00:00Z')
  const pushed = system('RefUpdate', '2026-07-21T10:00:00Z')

  it('fires when I approved and someone then pushed', () => {
    expect(approvalWasReset([approved, pushed], ME, 0)).toBe(true)
  })

  it('stays quiet while my approval is still standing', () => {
    // The push happened, but the branch policy did not reset votes — which is
    // the difference between "act again" and a false alarm on every push.
    expect(approvalWasReset([approved, pushed], ME, 10)).toBe(false)
  })

  it('ignores a push that came before I approved', () => {
    expect(
      approvalWasReset([vote(ME, '10', '2026-07-22T10:00:00Z'), pushed], ME, 0),
    ).toBe(false)
  })

  it('does not fire on somebody else being reset', () => {
    expect(approvalWasReset([vote(COLLEAGUE, '10', '2026-07-20T10:00:00Z'), pushed], ME, 0)).toBe(
      false,
    )
  })

  it('does not treat "waiting for author" as an approval to lose', () => {
    expect(approvalWasReset([vote(ME, '-5', '2026-07-20T10:00:00Z'), pushed], ME, 0)).toBe(false)
  })

  it('needs both halves', () => {
    expect(approvalWasReset([approved], ME, 0)).toBe(false)
    expect(approvalWasReset([pushed], ME, 0)).toBe(false)
  })
})

describe('hydrate', () => {
  const replies = {
    '/threads': {
      value: [
        thread(),
        thread({ comments: [{ commentType: 'text', author: { id: SONAR } }] }),
        vote(ME, '10', '2026-07-20T10:00:00Z'),
        system('RefUpdate', '2026-07-21T10:00:00Z'),
      ],
    },
    '/statuses': { value: [{ createdBy: { id: SONAR } }] },
    '/policy/evaluations': { value: [{ status: 'approved' }, { status: 'rejected' }] },
  }

  it('derives the row from three calls and caches the result', async () => {
    const db = memory()
    const client = fakeClient(replies)

    const first = await hydrate(client, TARGET, me, db)

    expect(first).toEqual({
      id: 24698,
      ok: true,
      data: {
        checks: { passed: 1, failed: 1, pending: 0 },
        unresolved: 1,
        approvalReset: true,
      },
    })
    expect(client.calls).toHaveLength(3)
  })

  it('costs zero calls on an unchanged second visit', async () => {
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)

    const second = fakeClient(replies)
    const again = await hydrate(second, TARGET, me, db)

    expect(second.calls).toHaveLength(0)
    expect(again.ok && again.data.unresolved).toBe(1)
  })

  it('refetches on Refresh even though nothing was pushed', async () => {
    // The commit key's blind spot: a thread opened or resolved without a push
    // does not move `commitId`, so a poll can never correct the count (T-008).
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)

    const forced = fakeClient({
      ...replies,
      '/threads': { value: [thread(), thread()] },
    })
    const again = await hydrate(forced, TARGET, me, db, true)

    expect(forced.calls).toHaveLength(3)
    expect(again.ok && again.data.unresolved).toBe(2)
    // And the refreshed answer replaces the stale one for the next poll.
    const next = fakeClient(replies)
    const polled = await hydrate(next, TARGET, me, db)
    expect(next.calls).toHaveLength(0)
    expect(polled.ok && polled.data.unresolved).toBe(2)
  })

  it('refetches once the PR is pushed to', async () => {
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)

    const after = fakeClient(replies)
    await hydrate(after, { ...TARGET, commitId: 'b'.repeat(40) }, me, db)

    expect(after.calls).toHaveLength(3)
  })

  it('asks for the preview api-version the policy endpoint demands', async () => {
    const client = fakeClient(replies)
    await hydrate(client, TARGET, me, memory())

    const policy = client.calls.find((call) => call.path.includes('policy/evaluations'))
    expect(policy?.params['api-version']).toBe('7.1-preview.1')
    expect(policy?.params.artifactId).toBe(
      `vstfs:///CodeReview/CodeReviewId/${TARGET.projectId}/${TARGET.id}`,
    )
  })

  it('never asks for the single-PR detail call, because the list already had it', async () => {
    const client = fakeClient(replies)
    await hydrate(client, TARGET, me, memory())

    expect(client.calls.every((call) => /\/(threads|statuses|evaluations)$/.test(call.path))).toBe(
      true,
    )
  })

  it('reports a failed PR instead of throwing, and does not cache the failure', async () => {
    const db = memory()
    const broken = { ...replies, '/threads': new Error('Azure DevOps answered 500.') }

    const failed = await hydrate(fakeClient(broken), TARGET, me, db)
    expect(failed).toEqual({ id: 24698, ok: false, error: 'Azure DevOps answered 500.' })

    // A failure that stuck in the cache would leave the row broken until the
    // next push, which could be never.
    const retry = fakeClient(replies)
    expect((await hydrate(retry, TARGET, me, db)).ok).toBe(true)
    expect(retry.calls).toHaveLength(3)
  })

  it('does not spend an identity call when everything is cached', async () => {
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)

    let resolved = 0
    await hydrate(
      fakeClient(replies),
      TARGET,
      async () => {
        resolved++
        return ME
      },
      db,
    )

    expect(resolved).toBe(0)
  })
})
