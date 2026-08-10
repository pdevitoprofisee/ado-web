import { describe, expect, it } from 'vitest'

import { openDatabase } from './db'
import { approvalWasReset, countUnresolved, hydrate, readBlocked, readChecks } from './hydrate'
import { listNotifications, watch } from './notifications'

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
  isDraft: false,
  conflicted: false,
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
    write: () => Promise.reject(new Error('this fixture is read-only')),
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
  it('sorts the policy evaluations into the four states that matter', () => {
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
    ).toEqual({ passed: 2, failed: 2, running: 1, waiting: 1, waitingOnPeople: 0 })
  })

  it('does not count a queued evaluation as one that is running', () => {
    // The live shape from !24971: three approved, one expired build, one build
    // nobody queued, and two reviewer policies with no votes yet. The row this
    // feeds said "7 checks running" while nothing at all was running.
    expect(
      readChecks({
        value: [
          { status: 'approved' },
          { status: 'approved' },
          { status: 'approved' },
          { status: 'queued' },
          { status: 'queued' },
          { status: 'queued', configuration: { settings: { minimumApproverCount: 2 } } },
          { status: 'queued', configuration: { settings: { requiredReviewerIds: ['a'] } } },
        ],
      }),
    ).toEqual({ passed: 3, failed: 0, running: 0, waiting: 4, waitingOnPeople: 2 })
  })

  it('counts only the queued half of a reviewer policy as waiting on people', () => {
    // The subset has to hold: an approved reviewer policy is nobody's job, and a
    // row that counted it would send a reviewer to chase a vote already cast.
    expect(
      readChecks({
        value: [
          { status: 'approved', configuration: { settings: { minimumApproverCount: 2 } } },
          { status: 'queued', configuration: { settings: { minimumApproverCount: 2 } } },
        ],
      }),
    ).toEqual({ passed: 1, failed: 0, running: 0, waiting: 1, waitingOnPeople: 1 })
  })

  it('treats a PR with no policies as having no checks, not as passing', () => {
    expect(readChecks({})).toEqual({
      passed: 0,
      failed: 0,
      running: 0,
      waiting: 0,
      waitingOnPeople: 0,
    })
  })
})

describe('readBlocked', () => {
  const required = (status: string, over: Record<string, unknown> = {}) => ({
    status,
    configuration: { isBlocking: true, ...over },
  })

  it('blocks on a required policy that is not satisfied', () => {
    expect(readBlocked({ value: [required('rejected')] })).toBe(true)
    expect(readBlocked({ value: [required('broken')] })).toBe(true)
    // The one `readChecks` calls merely pending: the reviewer policy sits at
    // `queued` while it waits for approvals, and it is blocking the whole time.
    expect(readBlocked({ value: [required('queued')] })).toBe(true)
    expect(readBlocked({ value: [required('running')] })).toBe(true)
  })

  it('is not satisfied by a status it has never heard of', () => {
    expect(readBlocked({ value: [required('somethingNew')] })).toBe(true)
    expect(readBlocked({ value: [required('')] })).toBe(true)
  })

  it('clears once every required policy is approved or does not apply', () => {
    expect(readBlocked({ value: [required('approved'), required('notApplicable')] })).toBe(false)
  })

  it('ignores a policy that is switched off, whose evaluation ADO still returns', () => {
    expect(readBlocked({ value: [required('rejected', { isEnabled: false })] })).toBe(false)
  })

  it('ignores an optional policy, however badly it is doing', () => {
    expect(
      readBlocked({
        value: [
          { status: 'rejected' },
          { status: 'broken', configuration: { isBlocking: false } },
        ],
      }),
    ).toBe(false)
  })

  it('treats a PR with no policies as unblocked rather than unknown', () => {
    expect(readBlocked({})).toBe(false)
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
        checks: { passed: 1, failed: 1, running: 0, waiting: 0, waitingOnPeople: 0 },
        unresolved: 1,
        approvalReset: true,
        // The failing evaluation here carries no configuration, so nothing says
        // it is required — and an optional policy failing does not stop a merge.
        blocked: false,
        readyToMerge: true,
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

  /** Backdates the cached row, which is the only way to age it inside a test. */
  const age = (db: DatabaseSync, minutes: number) => {
    db.prepare('UPDATE pr_cache SET fetched_at = ?').run(Date.now() - minutes * 60_000)
  }

  it('re-asks about a PR whose verdicts are still moving, though nothing was pushed', async () => {
    // !25033, exactly: created, three policies queued, and then nothing pushed
    // to it ever again. Its builds finished and its reviewers voted, and the
    // row went on reporting the state it was born in until somebody pressed
    // Refresh — because a commit key cannot see a policy change.
    const db = memory()
    const moving = {
      ...replies,
      '/policy/evaluations': { value: [{ status: 'queued', configuration: { isBlocking: true } }] },
    }
    await hydrate(fakeClient(moving), TARGET, me, db)
    age(db, 5)

    const settled = fakeClient(replies)
    const again = await hydrate(settled, TARGET, me, db)

    expect(settled.calls).toHaveLength(3)
    expect(again.ok && again.data.readyToMerge).toBe(true)
  })

  it('still serves a settled PR from the cache across the same interval', async () => {
    // The other half of the bargain: only the pull requests that are actually
    // moving pay 3 calls a poll. A settled inbox is still free to re-poll.
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)
    age(db, 5)

    const second = fakeClient(replies)
    await hydrate(second, TARGET, me, db)

    expect(second.calls).toHaveLength(0)
  })

  it('gives up on even a settled row eventually', async () => {
    // A rejection or a new comment moves no commit either, and "cached forever"
    // would mean an inbox that is only ever right if you press Refresh.
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)
    age(db, 20)

    const later = fakeClient(replies)
    await hydrate(later, TARGET, me, db)

    expect(later.calls).toHaveLength(3)
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

  it('withholds the ready mark when a required policy is unsatisfied', async () => {
    const client = fakeClient({
      ...replies,
      '/policy/evaluations': {
        value: [{ status: 'queued', configuration: { isBlocking: true } }],
      },
    })

    const result = await hydrate(client, TARGET, me, memory())

    expect(result.ok && result.data).toMatchObject({ blocked: true, readyToMerge: false })
  })

  it('recomputes the ready mark from the row rather than trusting the cache', async () => {
    // The failure this exists to prevent: publishing a draft and resolving a
    // conflict both leave `commitId` alone, so a trusted cached `readyToMerge`
    // would keep answering with the state the row was in when it was cached.
    const db = memory()
    const first = await hydrate(fakeClient(replies), { ...TARGET, isDraft: true }, me, db)
    expect(first.ok && first.data.readyToMerge).toBe(false)

    const published = fakeClient(replies)
    const again = await hydrate(published, TARGET, me, db)

    expect(published.calls).toHaveLength(0)
    expect(again.ok && again.data.readyToMerge).toBe(true)
  })

  it('withholds the ready mark on a conflicted row that was cached clean', async () => {
    const db = memory()
    await hydrate(fakeClient(replies), TARGET, me, db)

    const conflicted = await hydrate(
      fakeClient(replies),
      { ...TARGET, conflicted: true },
      me,
      db,
    )

    expect(conflicted.ok && conflicted.data.readyToMerge).toBe(false)
    // Only the readiness is recomputed — the counts that cost calls still come
    // from the cache untouched.
    expect(conflicted.ok && conflicted.data.unresolved).toBe(1)
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

describe('what hydration notices for the notification panel', () => {
  // T-039's detection is a diff taken where the poll already happens, so the
  // wiring is here: these three signals are only visible in the responses this
  // function already fetches, and nothing else in the app fetches them.
  const human = (by: string, at: string, id: number) => ({
    id,
    status: 'active',
    publishedDate: at,
    comments: [
      { id: 1, commentType: 'text', content: 'needs a rollback plan', publishedDate: at, author: { id: by, displayName: 'Ravi' } },
    ],
  })

  const replies = (threads: readonly unknown[], evaluations: readonly unknown[]) => ({
    '/threads': { value: threads },
    '/statuses': { value: [{ createdBy: { id: SONAR } }] },
    '/policy/evaluations': { value: evaluations },
  })

  const watched = {
    prId: TARGET.id,
    title: 'disable sql auditing',
    projectId: TARGET.projectId,
    repositoryId: TARGET.repositoryId,
    role: 'author' as const,
    commitId: TARGET.commitId,
  }

  it('announces nothing on the first hydration, and the new things on the second', async () => {
    const db = memory()
    watch([watched], 1000, db)

    const first = await hydrate(
      fakeClient(replies([human(COLLEAGUE, '2026-07-20T10:00:00Z', 10)], [{ status: 'approved' }])),
      TARGET,
      me,
      db,
    )

    expect(first.ok).toBe(true)
    expect(listNotifications(50, db)).toEqual([])

    // A push, so the commit-keyed cache misses and the responses are fetched
    // again — carrying a colleague's new comment, a bot's, one of my own, and a
    // rejected policy.
    const second = await hydrate(
      fakeClient(
        replies(
          [
            human(COLLEAGUE, '2026-07-20T10:00:00Z', 10),
            human(COLLEAGUE, '2026-07-21T10:00:00Z', 11),
            human(SONAR, '2026-07-21T11:00:00Z', 12),
            human(ME, '2026-07-21T12:00:00Z', 13),
          ],
          [{ status: 'approved' }, { status: 'rejected' }],
        ),
      ),
      { ...TARGET, commitId: 'b'.repeat(40) },
      me,
      db,
    )

    expect(second.ok).toBe(true)
    // Not the bot's, and not mine — `viewerId` comes from `me()`, which is the
    // credential, so nothing a request could say changes this.
    expect(listNotifications(50, db).map((item) => [item.kind, item.detail])).toEqual([
      ['comment', 'Ravi: needs a rollback plan'],
      ['build', 'A check is failing'],
    ])
  })

  it('still returns the row when the notification cannot be written', async () => {
    const db = memory()
    watch([watched], 1000, db)
    db.exec('DROP TABLE notification')

    const result = await hydrate(
      fakeClient(replies([human(COLLEAGUE, '2026-07-20T10:00:00Z', 10)], [{ status: 'rejected' }])),
      TARGET,
      me,
      db,
    )

    // The badges are the point of this call. A panel that could not be written to
    // must not cost the row the counts it already paid for.
    expect(result.ok && result.data.checks.failed).toBe(1)
  })
})
