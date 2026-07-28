import { describe, expect, it } from 'vitest'

import { changeFlags, commitSubject, loadChanges, loadPullRequest, toPolicies } from './pull-request'

import type { AdoClient, QueryValue } from './ado-client'
import type { PullRequestRef } from './pull-request'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'
const CONTRIBUTORS = 'cc86398c-49fe-4239-9765-4a4da7535e01'

const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

const PR = `${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullRequests/24698`
const EVALUATIONS = `${PROJECT}/_apis/policy/evaluations`

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
}

/** An `Error` is thrown, a function is handed the params, anything else is the body. */
type Reply = Error | ((params: Record<string, QueryValue>) => unknown) | Record<string, unknown>

/**
 * Replies are matched by path suffix, which is how the six endpoints of one PR
 * tell themselves apart without every fixture repeating the base path.
 */
function fakeClient(replies: Record<string, Reply>) {
  const calls: Call[] = []

  const client: AdoClient = {
    org: 'Profisee',
    get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, params })
      const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
      if (match === undefined) return Promise.reject(new Error(`unexpected call: ${path}`))

      const reply = replies[match]
      if (reply instanceof Error) return Promise.reject(reply)

      return Promise.resolve((typeof reply === 'function' ? reply(params) : reply) as T)
    },
    // Nothing under test here fetches a blob; a call would be a mistake, not a
    // case to cover.
    getBytes: () => Promise.reject(new Error('this fixture serves JSON only')),
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

/** The detail payload, in the shape T-011 measured it. */
const detail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pullRequestId: 24698,
  title: 'Add structured logging to the utilities host',
  description: 'x'.repeat(1710),
  createdBy: { id: ME, displayName: 'Paul DeVito' },
  creationDate: '2026-07-20T09:00:00Z',
  isDraft: false,
  status: 'active',
  sourceRefName: 'refs/heads/feature/logging',
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  reviewers: [],
  repository: { name: 'utilities', project: { name: 'Products' } },
  ...over,
})

const commit = (
  id: string,
  comment: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  commitId: id,
  comment,
  commentTruncated: false,
  author: { name: 'Paul DeVito', date: '2026-07-20T09:00:00Z' },
  ...over,
})

const change = (
  path: string,
  changeType: string,
  item: Record<string, unknown> = {},
): Record<string, unknown> => ({
  changeType,
  item: { path, objectId: 'a'.repeat(40), ...item },
})

const REPLIES: Record<string, Reply> = {
  '_apis/connectionData': { authenticatedUser: { id: ME, providerDisplayName: 'Paul DeVito' } },
  '/pullRequests/24698': detail(),
  '/policy/evaluations': { value: [] },
  '/commits': { value: [commit('b'.repeat(40), 'feat: log things')] },
  '/iterations': { value: [{ id: 1 }, { id: 2 }] },
  '/changes': { nextTop: 1, nextSkip: 5, changeEntries: [change('/src/log.ts', 'edit')] },
  '/conflicts': { count: 0, value: [] },
}

function load(over: Record<string, Reply> = {}) {
  const { client, calls } = fakeClient({ ...REPLIES, ...over })

  return { calls, loading: loadPullRequest(client, REF) }
}

describe('the call budget', () => {
  it('meets the whole page in five calls once it knows who is looking', async () => {
    const { client, calls } = fakeClient(REPLIES)

    // Six on the first PR opened per credential and five on every one after:
    // an account's own id cannot change under the memo, so it is asked once.
    await loadPullRequest(client, REF)
    expect(calls).toHaveLength(6)
    expect(calls.some((call) => call.path.endsWith('_apis/connectionData'))).toBe(true)

    calls.length = 0
    await loadPullRequest(client, REF)

    expect(calls.map((call) => call.path)).toEqual([
      PR,
      EVALUATIONS,
      `${PR}/commits`,
      `${PR}/iterations`,
      `${PR}/iterations/2/changes`,
    ])
  })

  it('does not ask about conflicts on a PR that says it has none', async () => {
    const { calls, loading } = load()
    await loading

    expect(calls.some((call) => call.path.endsWith('/conflicts'))).toBe(false)
  })

  it('asks for the preview api-version the policy endpoint demands', async () => {
    const { calls, loading } = load()
    await loading

    const policy = calls.find((call) => call.path === EVALUATIONS)
    expect(policy?.params['api-version']).toBe('7.1-preview.1')
    expect(policy?.params.artifactId).toBe(`vstfs:///CodeReview/CodeReviewId/${PROJECT}/${REF.id}`)
  })
})

describe('the header', () => {
  it('carries the description the inbox row could not', async () => {
    const pr = await load().loading

    expect(pr.description).toHaveLength(1710)
    expect(pr.sourceBranch).toBe('feature/logging')
    expect(pr.targetBranch).toBe('main')
    expect(pr.url).toBe('https://dev.azure.com/Profisee/Products/_git/utilities/pullrequest/24698')
    expect(pr.viewerId).toBe(ME)
  })

  it('refuses a response with no pull request in it', async () => {
    await expect(load({ '/pullRequests/24698': {} }).loading).rejects.toThrow(
      'Azure DevOps answered without a pull request for !24698.',
    )
  })

  it('lets the detail call take the page down, because nothing stands in for it', async () => {
    const { loading } = load({ '/pullRequests/24698': new Error('Azure DevOps answered 404.') })

    await expect(loading).rejects.toThrow('Azure DevOps answered 404.')
  })
})

describe('merge state', () => {
  it('lists what conflicts, not merely that something does', async () => {
    const { calls, loading } = load({
      '/pullRequests/24698': detail({ mergeStatus: 'conflicts' }),
      '/conflicts': {
        count: 2,
        value: [
          { conflictPath: '/src/log.ts', conflictType: 'editEdit', resolutionStatus: 'unresolved' },
          { conflictPath: '/src/gone.ts', conflictType: 'deleteEdit', resolutionStatus: 'resolved' },
        ],
      },
    })
    const pr = await loading

    expect(pr.merge.conflicted).toBe(true)
    expect(pr.merge.conflicts).toEqual([
      { path: '/src/log.ts', type: 'editEdit', resolved: false },
      { path: '/src/gone.ts', type: 'deleteEdit', resolved: true },
    ])
    expect(calls.filter((call) => call.path.endsWith('/conflicts'))).toHaveLength(1)
  })

  it('treats a mergeStatus ADO did not send as neutral, never as a conflict', async () => {
    // Absent on all 1480 abandoned PRs measured. Reading that as a conflict
    // would put a red banner on every closed PR in the org.
    const pr = await load({
      '/pullRequests/24698': detail({ mergeStatus: undefined, status: 'abandoned' }),
    }).loading

    expect(pr.merge).toEqual({ status: '', conflicted: false, conflicts: [] })
  })

  it('keeps the conflict flag when only the path list failed', async () => {
    const pr = await load({
      '/pullRequests/24698': detail({ mergeStatus: 'conflicts' }),
      '/conflicts': new Error('Azure DevOps answered 500.'),
    }).loading

    expect(pr.merge.conflicted).toBe(true)
    expect(pr.merge.conflicts).toEqual([])
    expect(pr.errors.conflicts).toBe('Azure DevOps answered 500.')
  })
})

describe('reviewers', () => {
  it('keeps the whole vote vocabulary rather than a boolean', async () => {
    const pr = await load({
      '/pullRequests/24698': detail({
        reviewers: [
          { id: '1', displayName: 'Approved', vote: 10 },
          { id: '2', displayName: 'With suggestions', vote: 5 },
          { id: '3', displayName: 'No vote', vote: 0 },
          { id: '4', displayName: 'Waiting for author', vote: -5 },
          { id: '5', displayName: 'Rejected', vote: -10 },
          { id: '6', displayName: 'Never voted' },
        ],
      }),
    }).loading

    expect(pr.reviewers.map((reviewer) => reviewer.vote)).toEqual([10, 5, 0, -5, -10, 0])
  })

  it('tells a team from a person and required from optional', async () => {
    const pr = await load({
      '/pullRequests/24698': detail({
        reviewers: [
          {
            id: CONTRIBUTORS,
            displayName: '[Products]\\Contributors',
            vote: 0,
            isContainer: true,
            isRequired: true,
          },
          { id: COLLEAGUE, displayName: 'Naveen Angali', vote: 10 },
        ],
      }),
    }).loading

    expect(pr.reviewers[0]).toMatchObject({ isContainer: true, isRequired: true, vote: 0 })
    expect(pr.reviewers[1]).toMatchObject({ isContainer: false, isRequired: false, vote: 10 })
  })

  it('attributes a team vote to whoever cast it without reading the nested vote', async () => {
    // The `vote` inside a `votedFor` entry is always 0 — all 117 measured — so
    // carrying it would report every team as undecided. The container's real
    // vote is its own top-level row.
    const pr = await load({
      '/pullRequests/24698': detail({
        reviewers: [
          { id: CONTRIBUTORS, displayName: '[Products]\\Contributors', vote: 10, isContainer: true },
          {
            id: COLLEAGUE,
            displayName: 'Naveen Angali',
            vote: 10,
            votedFor: [{ id: CONTRIBUTORS, displayName: '[Products]\\Contributors', vote: 0 }],
          },
        ],
      }),
    }).loading

    expect(pr.reviewers[0].vote).toBe(10)
    expect(pr.reviewers[1].votedFor).toEqual([
      { id: CONTRIBUTORS, displayName: '[Products]\\Contributors' },
    ])
  })
})

// The wire shape is deliberately not exported — the contract is what comes out,
// not what goes in — so the fixtures borrow it back off the function signature.
type Evaluation = Parameters<typeof toPolicies>[0][number]
type Settings = NonNullable<NonNullable<Evaluation['configuration']>['settings']>

const evaluation = (
  id: number,
  displayName: string,
  status: string,
  settings: Settings,
  over: Partial<Evaluation> = {},
): Evaluation => ({
  status,
  configuration: { id, isBlocking: true, isEnabled: true, type: { displayName }, settings },
  ...over,
})

describe('the policy checklist', () => {
  const policies = (evaluations: Evaluation[]) => toPolicies(evaluations, 'Profisee', PROJECT)

  it('keeps two policies that share a displayName apart', () => {
    // The live case: two "Minimum number of reviewers" on one PR, differing
    // only in scope. Two identical rows with different verdicts is a checklist
    // nobody can act on.
    const rows = policies([
      evaluation(101, 'Minimum number of reviewers', 'queued', {
        minimumApproverCount: 1,
        scope: [{ refName: 'refs/heads/main' }],
      }),
      evaluation(102, 'Minimum number of reviewers', 'approved', {
        minimumApproverCount: 2,
        scope: [{ refName: 'refs/heads/release/*' }],
      }),
    ])

    expect(rows.map((row) => row.id)).toEqual(['101', '102'])
    expect(new Set(rows.map((row) => row.name)).size).toBe(2)
    expect(rows[0].name).toContain('main')
    expect(rows[1].name).toContain('release/*')
  })

  it('calls a required policy that already passes required, not blocking', () => {
    const rows = policies([
      evaluation(101, 'Minimum number of reviewers', 'approved', { minimumApproverCount: 1 }),
      evaluation(102, 'Comment requirements', 'rejected', {}),
      evaluation(103, 'Work item linking', 'notApplicable', {}),
      evaluation(104, 'Build', 'queued', { buildDefinitionId: 320 }),
      evaluation(
        105,
        'Status',
        'queued',
        {},
        {
          configuration: {
            id: 105,
            isBlocking: false,
            isEnabled: true,
            type: { displayName: 'Status' },
            settings: {},
          },
        },
      ),
      evaluation(
        106,
        'Disabled',
        'queued',
        {},
        {
          configuration: {
            id: 106,
            isBlocking: true,
            isEnabled: false,
            type: { displayName: 'Disabled' },
            settings: {},
          },
        },
      ),
    ])

    expect(rows.filter((row) => row.blocking).map((row) => row.id)).toEqual(['102', '104'])
  })

  it('says what each row is actually about', () => {
    const rows = policies([
      evaluation(
        101,
        'Build',
        'queued',
        { buildDefinitionId: 320, displayName: 'utilities.logging' },
        {
          context: {
            buildId: 998877,
            buildDefinitionName: 'utilities.logging',
            buildIsNotCurrent: true,
          },
        },
      ),
      evaluation(102, 'Minimum number of reviewers', 'queued', {
        minimumApproverCount: 1,
        creatorVoteCounts: true,
      }),
      // Live, a "Required reviewers" policy carries **both** keys — 10 of 10 —
      // and the earlier fixture carried only one, which is why the rows read
      // "1 approval, author counts" on the real org and passed here anyway.
      evaluation(103, 'Required reviewers', 'queued', {
        requiredReviewerIds: [ME, COLLEAGUE],
        minimumApproverCount: 1,
        creatorVoteCounts: true,
      }),
      evaluation(104, 'Comment requirements', 'rejected', {}),
    ])

    expect(rows[0].detail).toBe('utilities.logging · build 998877 · ran on an earlier commit')
    expect(rows[0].url).toBe(
      `https://dev.azure.com/Profisee/${PROJECT}/_build/results?buildId=998877`,
    )
    expect(rows[0].name).toBe('Build — utilities.logging')
    expect(rows[1].detail).toBe('1 approval, author counts')
    expect(rows[2].detail).toBe('2 required reviewers')
    expect(rows[3].detail).toBeNull()
    expect(rows[3].url).toBeNull()
  })

  it('does not invent a status vocabulary of its own', () => {
    const rows = policies([evaluation(101, 'Something new', 'somethingElse', {})])

    expect(rows[0].status).toBe('unknown')
    // Unrecognised errs toward standing in the way, not toward silently passing.
    expect(rows[0].blocking).toBe(true)
  })
})

describe('commits', () => {
  it('takes the first line and reports a dropped body beside it', async () => {
    const pr = await load({
      '/commits': {
        value: [
          commit('a'.repeat(40), 'feat: add logging\n\nA long body ADO clipped', {
            commentTruncated: true,
          }),
          // What `commentTruncated` actually looks like on the wire: measured
          // against the standalone commit resource, the `comment` handed over
          // is the complete first line every time and the body is what went
          // missing. So the flag rides beside a *whole* subject, and the field
          // is named `bodyOmitted` rather than ADO's `commentTruncated`.
          commit('b'.repeat(40), 'fix: rename the sink', { commentTruncated: true }),
          commit('c'.repeat(40), 'chore: whole message'),
        ],
      },
    }).loading

    expect(pr.commits.map((entry) => entry.subject)).toEqual([
      'feat: add logging',
      'fix: rename the sink',
      'chore: whole message',
    ])
    expect(pr.commits.map((entry) => entry.bodyOmitted)).toEqual([true, true, false])
  })

  it('links a commit somewhere a person can read it', async () => {
    const pr = await load().loading

    expect(pr.commits[0].url).toBe(
      `https://dev.azure.com/Profisee/${PROJECT}/_git/${REPOSITORY}/commit/${'b'.repeat(40)}`,
    )
  })

  it('drops an entry with no commit id rather than linking to nothing', async () => {
    const pr = await load({ '/commits': { value: [{ comment: 'orphan' }] } }).loading

    expect(pr.commits).toEqual([])
  })
})

describe('the file list', () => {
  it('parses changeType as the [Flags] set it is', () => {
    expect(changeFlags('edit, rename')).toEqual(['edit', 'rename'])
    expect(changeFlags('edit')).toEqual(['edit'])
    expect(changeFlags(undefined)).toEqual([])
  })

  it('keeps a rename whole, including the sha that did not move and the name that did', async () => {
    const pr = await load({
      '/changes': {
        changeEntries: [
          {
            ...change('/src/new.ts', 'edit, rename', { originalObjectId: 'a'.repeat(40) }),
            originalPath: '/src/old.ts',
          },
          change('/src/added.ts', 'add'),
          { changeType: 'add', item: { path: '/src/', isFolder: true } },
        ],
      },
    }).loading

    expect(pr.files.files).toEqual([
      {
        path: '/src/new.ts',
        changeType: ['edit', 'rename'],
        originalPath: '/src/old.ts',
        objectId: 'a'.repeat(40),
        originalObjectId: 'a'.repeat(40),
      },
      {
        path: '/src/added.ts',
        changeType: ['add'],
        originalPath: null,
        objectId: 'a'.repeat(40),
        originalObjectId: null,
      },
    ])
    expect(pr.files.iterationId).toBe(2)
    expect(pr.files.truncated).toBe(false)
  })

  /**
   * This exact payload shape shipped a crash: `item.path` is `null` — not
   * absent — so an `=== undefined` guard let it through and the file list
   * called `lastIndexOf` on it. 16 of 294 files in live !24766 were deletes.
   */
  it('finds a deleted file its path on the entry, where ADO left it', async () => {
    const pr = await load({
      '/changes': {
        changeEntries: [
          {
            changeType: 'delete',
            originalPath: '/src/gone.ts',
            item: { path: null, originalObjectId: 'b'.repeat(40) },
          },
          // No path anywhere is still a skip, not a null-named row.
          { changeType: 'delete', item: { path: null } },
        ],
      },
    }).loading

    expect(pr.files.files).toEqual([
      {
        path: '/src/gone.ts',
        changeType: ['delete'],
        // Spent on `path` — a delete has no second name to show.
        originalPath: null,
        objectId: null,
        originalObjectId: 'b'.repeat(40),
      },
    ])
  })

  it('asks the latest iteration explicitly and ignores nextTop', async () => {
    // `nextTop` is `min($top, remaining)`, not a page size — the fixture answers
    // 1. Feeding it forward would crawl the tail one file at a time, and
    // omitting `$top` altogether silently truncates the list at 100.
    const { calls, loading } = load()
    await loading

    const changes = calls.find((call) => call.path.endsWith('/changes'))
    expect(changes?.path).toBe(`${PR}/iterations/2/changes`)
    expect(changes?.params.$top).toBe(5000)
    expect(changes?.params.$skip).toBeUndefined()
  })

  it('compares the page against the merge base, which is the combined diff', async () => {
    // The whole pull request and not the latest push. `$compareTo=0` is the merge
    // base and is what the parameter defaults to, so this asserts the zero is
    // sent rather than assumed: the same call with `$compareTo=1` would answer
    // with one update's files under a heading that says all of them.
    const { calls, loading } = load()
    await loading

    expect(calls.find((call) => call.path.endsWith('/changes'))?.params.$compareTo).toBe(0)
  })

  it('carries every update, so the view can offer one without a second round trip', async () => {
    const pr = await load({
      '/iterations': {
        value: [
          {
            id: 1,
            // ADO calls this a description and sends the tip commit's whole
            // message. Cut to its first line, the same way a commit's is.
            description: 'point the sink at its own account\n\nand explain why',
            author: { displayName: 'Paul DeVito' },
            createdDate: '2026-07-20T09:00:00Z',
            reason: 'push',
          },
          { id: 2, reason: 'forcePush' },
        ],
      },
    }).loading

    expect(pr.files.iterations).toEqual([
      {
        id: 1,
        subject: 'point the sink at its own account',
        author: 'Paul DeVito',
        createdAt: '2026-07-20T09:00:00Z',
        reason: 'push',
      },
      // Everything absent, because a payload is allowed to be thin: iteration 1
      // of a real PR arrived with no `push` key at all, so nothing here is
      // load-bearing except the id.
      { id: 2, subject: '', author: 'unknown', createdAt: '', reason: 'forcePush' },
    ])
  })

  it('asks one update for its own changes and nothing else', async () => {
    // Measured: `$compareTo=k-1` isolates update k. On !24766 the 39 updates
    // answered 64, 34, 12, 3, … files against a combined diff of 294.
    const { client, calls } = fakeClient(REPLIES)
    const changes = await loadChanges(client, REF, 7, 6)

    expect(calls.map((call) => call.path)).toEqual([`${PR}/iterations/7/changes`])
    expect(calls[0]?.params).toMatchObject({ $top: 5000, $compareTo: 6 })
    expect(changes).toEqual({
      files: [
        {
          path: '/src/log.ts',
          changeType: ['edit'],
          originalPath: null,
          objectId: 'a'.repeat(40),
          originalObjectId: null,
        },
      ],
      truncated: false,
    })
  })

  it('says so when it hit its own ceiling instead of pretending the list is whole', async () => {
    const many = Array.from({ length: 5000 }, (_, index) => change(`/src/f${index}.ts`, 'edit'))
    const pr = await load({ '/changes': { changeEntries: many } }).loading

    expect(pr.files.files).toHaveLength(5000)
    expect(pr.files.truncated).toBe(true)
  })

  it('treats a PR with no iterations as having no files, not as broken', async () => {
    const { calls, loading } = load({ '/iterations': { value: [] } })
    const pr = await loading

    expect(pr.files).toEqual({ files: [], iterationId: null, iterations: [], truncated: false })
    expect(pr.errors.files).toBeNull()
    expect(calls.some((call) => call.path.endsWith('/changes'))).toBe(false)
  })
})

describe('degrading one section', () => {
  it('costs that section its data, not the page its header', async () => {
    const pr = await load({ '/commits': new Error('Azure DevOps answered 500.') }).loading

    expect(pr.title).toBe('Add structured logging to the utilities host')
    expect(pr.commits).toEqual([])
    expect(pr.errors.commits).toBe('Azure DevOps answered 500.')
    // The other sections are untouched, which is the whole point of the split.
    expect(pr.errors.policies).toBeNull()
    expect(pr.errors.files).toBeNull()
    expect(pr.files.files).toHaveLength(1)
  })

  it('reports a failed section rather than an empty one, for each of the three', async () => {
    const broken = new Error('Azure DevOps answered 503.')
    const pr = await load({
      '/policy/evaluations': broken,
      '/commits': broken,
      '/iterations': broken,
    }).loading

    expect(pr.errors).toEqual({
      policies: 'Azure DevOps answered 503.',
      commits: 'Azure DevOps answered 503.',
      files: 'Azure DevOps answered 503.',
      conflicts: null,
    })
    expect(pr.policies).toEqual([])
    expect(pr.files).toEqual({ files: [], iterationId: null, iterations: [], truncated: false })
  })

  it('keeps the page when nobody can say who is looking', async () => {
    const pr = await load({ '_apis/connectionData': new Error('ECONNRESET') }).loading

    expect(pr.viewerId).toBeNull()
    expect(pr.title).toBe('Add structured logging to the utilities host')
  })

  it('does not remember a failed identity lookup', async () => {
    let attempts = 0
    const { client } = fakeClient({
      ...REPLIES,
      '_apis/connectionData': () => {
        attempts += 1
        if (attempts === 1) throw new Error('ECONNRESET')

        return { authenticatedUser: { id: ME } }
      },
    })

    expect((await loadPullRequest(client, REF)).viewerId).toBeNull()
    expect((await loadPullRequest(client, REF)).viewerId).toBe(ME)
  })
})

describe('commitSubject', () => {
  it('is the first line, trimmed, and nothing more', () => {
    expect(commitSubject('feat: thing\n\nbody')).toBe('feat: thing')
    expect(commitSubject('  spaced  ')).toBe('spaced')
    expect(commitSubject(undefined)).toBe('')
  })
})
