import { describe, expect, it } from 'vitest'

import {
  POLICY_VERSION,
  abandon,
  addReviewer,
  castVote,
  changeFlags,
  commitSubject,
  completePullRequest,
  isVote,
  loadChanges,
  loadPullRequest,
  reactivate,
  removeReviewer,
  requeueEvaluation,
  setTitle,
  toPolicies,
} from './pull-request'

import type { AdoClient, QueryValue } from './ado-client'
import type { PullRequestRef } from './pull-request'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'
const CONTRIBUTORS = 'cc86398c-49fe-4239-9765-4a4da7535e01'
/** Where `_links.avatar.href` points, which is not where `imageUrl` does. */
const AVATARS = 'https://dev.azure.com/profisee/_apis/GraphProfile/MemberAvatars'

const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

/**
 * Evaluation ids — one policy's verdict on one pull request, which is a different
 * id from the policy's own and the only thing a requeue can be addressed to.
 */
const EVALUATIONS_ID = [
  'e0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000002',
  'e0000000-0000-0000-0000-000000000003',
  'e0000000-0000-0000-0000-000000000004',
  'e0000000-0000-0000-0000-000000000005',
  'e0000000-0000-0000-0000-000000000006',
] as const

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
    write: () => Promise.reject(new Error('this fixture is read-only')),
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
      { id: CONTRIBUTORS, displayName: '[Products]\\Contributors', avatarHref: null },
    ])
  })

  it('takes the avatar from the link and not from imageUrl', async () => {
    // T-030 counted `descriptor` on 0 of 30 reviewers and `_links.avatar.href`
    // ending in one on 30 of 30, so the link is the only place a browser-loadable
    // avatar can be recovered from. `imageUrl` is beside it on every one of the 30
    // and is the `identityImage` form, which 302s to a sign-in page — carrying it
    // would be carrying a broken image.
    const pr = await load({
      '/pullRequests/24698': detail({
        reviewers: [
          {
            id: COLLEAGUE,
            displayName: 'Naveen Angali',
            vote: 10,
            imageUrl: `https://dev.azure.com/profisee/_api/_common/identityImage?id=${COLLEAGUE}`,
            _links: { avatar: { href: `${AVATARS}/aad.OWY0NTIwYTMtMzc` } },
          },
          { id: CONTRIBUTORS, displayName: '[Products]\\Contributors', isContainer: true },
        ],
      }),
    }).loading

    expect(pr.reviewers[0].avatarHref).toBe(`${AVATARS}/aad.OWY0NTIwYTMtMzc`)
    // Nothing invented for the one that came without a link.
    expect(pr.reviewers[1].avatarHref).toBeNull()
  })

  it('takes the authors avatar from the same link', async () => {
    const pr = await load({
      '/pullRequests/24698': detail({
        createdBy: {
          id: ME,
          displayName: 'Paul DeVito',
          imageUrl: `https://dev.azure.com/profisee/_api/_common/identityImage?id=${ME}`,
          _links: { avatar: { href: `${AVATARS}/aad.NTQ0MzZiMGEtNzQ` } },
        },
      }),
    }).loading

    expect(pr.author.avatarHref).toBe(`${AVATARS}/aad.NTQ0MzZiMGEtNzQ`)
  })

  it('leaves the author without an avatar when ADO sends no link', async () => {
    // The one thing T-030 did not measure is `createdBy._links` — it read
    // `createdBy.imageUrl` on all 99 and nothing else — so absence is the case
    // this has to survive, and initials are what it survives into.
    const pr = await load({ '/pullRequests/24698': detail() }).loading

    expect(pr.author.avatarHref).toBeNull()
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

  it('offers a requeue on the builds worth running again, and on nothing else', () => {
    const build = { buildDefinitionId: 320 }
    const rows = policies([
      // Unmet. The plain case: a build that has not passed.
      evaluation(101, 'Build', 'queued', build, { evaluationId: EVALUATIONS_ID[0] }),
      evaluation(102, 'Build', 'rejected', build, { evaluationId: EVALUATIONS_ID[1] }),
      // Green, and green about an earlier commit — the one reason to press this
      // on a row that has already passed.
      evaluation(103, 'Build', 'approved', build, {
        evaluationId: EVALUATIONS_ID[2],
        context: { buildId: 193288, buildIsNotCurrent: true },
      }),
      // A build that is already going is not one to queue.
      evaluation(104, 'Build', 'running', build, { evaluationId: EVALUATIONS_ID[3] }),
      // Green about this commit: nothing to ask for.
      evaluation(105, 'Build', 'approved', build, {
        evaluationId: EVALUATIONS_ID[4],
        context: { buildId: 193290 },
      }),
      // Not a policy that runs anything. A requeue here would re-ask a question
      // whose answer is a vote count.
      evaluation(106, 'Minimum number of reviewers', 'queued', { minimumApproverCount: 1 }, {
        evaluationId: EVALUATIONS_ID[5],
      }),
      // A build ADO gave us no evaluation id for. There is nothing to address.
      evaluation(107, 'Build', 'queued', build),
    ])

    expect(rows.map((row) => row.requeueId)).toEqual([
      EVALUATIONS_ID[0],
      EVALUATIONS_ID[1],
      EVALUATIONS_ID[2],
      null,
      null,
      null,
      null,
    ])
  })
})

describe('requeueing a build policy', () => {
  it('patches the evaluation, with no body and at the preview api-version', async () => {
    const writes: Array<{
      method: string
      path: string
      body: unknown
      params: Record<string, QueryValue>
    }> = []

    const client: AdoClient = {
      ...fakeClient({}).client,
      write: (method, path, body, params = {}) => {
        writes.push({ method, path, body, params })

        return Promise.resolve(null)
      },
    }

    await requeueEvaluation(client, { projectId: PROJECT, evaluationId: EVALUATIONS_ID[0] })

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `${PROJECT}/_apis/policy/evaluations/${EVALUATIONS_ID[0]}`,
        // Not `{}`: ADO's requeue takes no body, and a body would make the
        // client send a `Content-Type` for something it is not sending.
        body: undefined,
        params: { 'api-version': POLICY_VERSION },
      },
    ])
  })
})

/**
 * The write, captured rather than sent. Nothing in any describe below reaches
 * Azure DevOps.
 *
 * `replies` because one of these writes reads first — `castVote` asks who the
 * token belongs to and what the reviewer list looks like before it sends
 * anything — and a capture whose `get` rejects everything could only ever test
 * the refusals.
 */
function capture(replies: Record<string, Reply> = {}) {
  const writes: Array<{
    method: string
    path: string
    body: unknown
    params: Record<string, QueryValue>
  }> = []

  const client: AdoClient = {
    ...fakeClient(replies).client,
    write: (method, path, body, params = {}) => {
      writes.push({ method, path, body, params })

      return Promise.resolve(null)
    },
  }

  return { client, writes }
}

describe('renaming a pull request', () => {
  it('patches the pull request with the title alone, at the client api-version', async () => {
    const { client, writes } = capture()

    await setTitle(client, REF, 'move the logging sink off the shared account')

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: PR,
        // **One key, and the assertion is on the whole object for that reason.**
        // This same PATCH completes, abandons, retargets and undrafts a pull
        // request, so anything that leaked into this body would be a rename with a
        // side effect — `status: 'abandoned'` slipping in here closes somebody's
        // work. The body is pinned so that cannot happen quietly.
        body: { title: 'move the logging sink off the shared account' },
        // No override: the pull request resource takes the client's plain 7.1,
        // unlike `policy/evaluations` above.
        params: {},
      },
    ])
  })
})

describe('completing a pull request', () => {
  it('patches the pull request to completed, squashed, at the tip it was read at', async () => {
    const { client, writes } = capture()

    await completePullRequest(client, REF, 'f'.repeat(40), 'Merged PR 1: a thing\n\nwhy')

    // Asserted whole rather than field by field, because both what this request
    // contains and what it must *not* contain are the point: no `bypassPolicy`,
    // and no `squashMerge` beside the strategy that deprecates it. Confirmed
    // against Microsoft's "Pull Requests - Update" reference at api-version 7.1.
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: PR,
        body: {
          status: 'completed',
          lastMergeSourceCommit: { commitId: 'f'.repeat(40) },
          completionOptions: {
            mergeStrategy: 'squash',
            mergeCommitMessage: 'Merged PR 1: a thing\n\nwhy',
            deleteSourceBranch: true,
          },
        },
        // No override: 7.1 is the client's own default, and it is the version the
        // documented shape above belongs to.
        params: {},
      },
    ])
  })

  it('sends the sha it was given rather than one of its own', async () => {
    const { client, writes } = capture()
    // The whole guard: ADO compares this to the source branch's real tip and
    // refuses when they differ, so a value invented here would defeat it.
    const tip = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'

    await completePullRequest(client, REF, tip, 'Merged PR 1: a thing')

    expect((writes[0].body as { lastMergeSourceCommit: unknown }).lastMergeSourceCommit).toEqual({
      commitId: tip,
    })
  })

  it('sends the commit message unchanged, blank line and all', async () => {
    const { client, writes } = capture()
    // Composed on the page; this layer must not reflow it. The blank line is what
    // makes the first line a subject in every tool that reads the commit.
    const message = 'Merged PR 24698: move the logging sink\n\nwhy this exists\n\n- and a list'

    await completePullRequest(client, REF, 'f'.repeat(40), message)

    expect(
      (writes[0].body as { completionOptions: { mergeCommitMessage: unknown } }).completionOptions
        .mergeCommitMessage,
    ).toBe(message)
  })

  it('always asks for the source branch to be deleted', async () => {
    const { client, writes } = capture()

    await completePullRequest(client, REF, 'f'.repeat(40), 'Merged PR 1: a thing')

    // Not a parameter and not a preference: every merge sent from this app takes
    // the branch with it, and the confirmation dialog says so.
    expect(
      (writes[0].body as { completionOptions: { deleteSourceBranch: unknown } }).completionOptions
        .deleteSourceBranch,
    ).toBe(true)
  })
})

/**
 * What `castVote` reads before it writes: who the token is, and who is on the
 * pull request. The viewer is a reviewer here, which is the ordinary case.
 */
const VOTING: Record<string, Reply> = {
  '_apis/connectionData': REPLIES['_apis/connectionData'],
  '/pullRequests/24698': detail({
    reviewers: [{ id: ME, displayName: 'Paul DeVito', vote: 0 }],
  }),
}

describe('isVote', () => {
  it('accepts the five integers ADO has and nothing between them', () => {
    expect([10, 5, 0, -5, -10].every(isVote)).toBe(true)
    // 1 and -1 matter: a caller doing arithmetic on a vote, or reading a boolean
    // as one, lands on exactly these.
    expect([1, -1, 11, 100, -100, 0.5].some(isVote)).toBe(false)
  })

  it('rejects the things a request body arrives as', () => {
    // `'10'` in particular: a form or a query string hands over the right vote as
    // the wrong type, and ADO would take it as no vote at all.
    expect(['10', null, undefined, true, {}, [], NaN].some(isVote)).toBe(false)
  })
})

describe('casting a vote', () => {
  it.each([10, 5, 0, -5, -10] as const)('puts %d on the viewers own reviewer entry', async (vote) => {
    const { client, writes } = capture(VOTING)

    expect(await castVote(client, REF, vote)).toBeNull()
    expect(writes).toEqual([
      {
        method: 'PUT',
        // The vote lives on the reviewer sub-resource; there is no vote field on
        // the pull request itself.
        path: `${PR}/reviewers/${ME}`,
        // One key, pinned whole for `setTitle`'s reason: this same PUT carries
        // `isRequired` and creates reviewers, and anything that leaked in here
        // would make a vote change the review itself.
        body: { vote },
        params: {},
      },
    ])
  })

  it('addresses the vote to the token, never to a reviewer it was shown', async () => {
    // A colleague first on the list, and a colleague who is *also* a reviewer — the
    // shape a "vote as someone else" attempt would need to succeed. There is no
    // parameter for whose vote it is, so there is nothing for it to travel in.
    const { client, writes } = capture({
      ...VOTING,
      '/pullRequests/24698': detail({
        reviewers: [
          { id: COLLEAGUE, displayName: 'Naveen Angali', vote: 10 },
          { id: ME, displayName: 'Paul DeVito', vote: 0 },
        ],
      }),
    })

    await castVote(client, REF, -10)

    expect(writes[0].path).toBe(`${PR}/reviewers/${ME}`)
    expect(writes[0].path).not.toContain(COLLEAGUE)
  })

  it('takes the identity from ADO on each vote rather than from the reviewer list', async () => {
    // The same PR read twice under two different tokens: the path follows the
    // token, so the reviewer list is never what decides whose vote this is.
    const { client, writes } = capture({
      ...VOTING,
      '_apis/connectionData': {
        authenticatedUser: { id: COLLEAGUE, providerDisplayName: 'Naveen Angali' },
      },
      '/pullRequests/24698': detail({
        reviewers: [
          { id: ME, displayName: 'Paul DeVito', vote: 0 },
          { id: COLLEAGUE, displayName: 'Naveen Angali', vote: 0 },
        ],
      }),
    })

    await castVote(client, REF, 5)

    expect(writes[0].path).toBe(`${PR}/reviewers/${COLLEAGUE}`)
  })

  it('matches the reviewer list case-insensitively, as ADO returns it', async () => {
    const { client, writes } = capture({
      ...VOTING,
      '/pullRequests/24698': detail({
        reviewers: [{ id: ME.toUpperCase(), displayName: 'Paul DeVito', vote: 0 }],
      }),
    })

    expect(await castVote(client, REF, 10)).toBeNull()
    // The token's casing, not the list's: the id ADO answered `connectionData`
    // with is the one its own routes are addressed by.
    expect(writes[0].path).toBe(`${PR}/reviewers/${ME}`)
  })

  it('refuses when ADO will not say who the token belongs to, and writes nothing', async () => {
    const { client, writes } = capture({
      ...VOTING,
      // Note 4's failure: an expired token comes back as a sign-in page rather
      // than a 401, and this is what that looks like once parsed.
      '_apis/connectionData': {},
    })

    expect(await castVote(client, REF, 10)).toBe(
      'Azure DevOps did not say who this token belongs to, so there is no vote of yours to set.',
    )
    expect(writes).toEqual([])
  })

  it('refuses when the viewer is not on the pull request at all', async () => {
    const { client, writes } = capture({
      ...VOTING,
      '/pullRequests/24698': detail({
        reviewers: [{ id: COLLEAGUE, displayName: 'Naveen Angali', vote: 0 }],
      }),
    })

    // Not a permissions guess: ADO's PUT *creates* the reviewer it addresses, so
    // an unguarded vote here would quietly add the viewer to somebody's review.
    expect(await castVote(client, REF, 10)).toContain('You are not a reviewer on this pull request')
    expect(writes).toEqual([])
  })

  it('votes when a team is the reviewer and the viewer is not listed yet', async () => {
    const { client, writes } = capture({
      ...VOTING,
      '/pullRequests/24698': detail({
        reviewers: [{ id: CONTRIBUTORS, displayName: '[Products]\\Contributors', isContainer: true }],
      }),
    })

    // The dominant case on this org — a container on 119 of 163 active pull
    // requests — and the one ADO itself resolves: the PUT is how a member of the
    // group appears on the list at all.
    expect(await castVote(client, REF, 5)).toBeNull()
    expect(writes[0].path).toBe(`${PR}/reviewers/${ME}`)
  })
})

describe('putting somebody on the pull request, and taking them off', () => {
  it('puts the reviewer on with `isRequired` and nothing else — no vote', async () => {
    const { client, writes } = capture()

    await addReviewer(client, REF, COLLEAGUE, false)

    expect(writes).toEqual([
      {
        method: 'PUT',
        // The same path `castVote` writes to, which is the whole reason this body
        // is pinned whole (note 10).
        path: `${PR}/reviewers/${COLLEAGUE}`,
        // **`vote` must not be here at all.** The documented body carries
        // `vote: 0`, and `0` is a value on that scale — "no vote" — so sending it
        // against somebody who has already approved would silently clear their
        // approval. Omitting it is the only body that means "just be a reviewer".
        body: { isRequired: false },
        params: {},
      },
    ])
  })

  it('carries a required reviewer as required', async () => {
    const { client, writes } = capture()

    await addReviewer(client, REF, COLLEAGUE, true)

    expect(writes[0].body).toEqual({ isRequired: true })
  })

  it('deletes the reviewer entry, with no body to be misread', async () => {
    const { client, writes } = capture()

    await removeReviewer(client, REF, COLLEAGUE)

    expect(writes).toEqual([
      { method: 'DELETE', path: `${PR}/reviewers/${COLLEAGUE}`, body: undefined, params: {} },
    ])
  })

  it.each([
    ['../../../../pullRequests/24699/reviewers/x'],
    [`${COLLEAGUE}?api-version=7.1&vote=10`],
    ['vssgp.Uy0xLTktMTU1MTM3NDI0NS0x'],
    ['aad.YWFhYWFhYWEtMTExMS0yMjIyLTMzMzMtNDQ0NDQ0NDQ0NDQ0'],
    [''],
    [COLLEAGUE.slice(0, -1)],
  ])('refuses %o rather than concatenating it into a path', async (id) => {
    const { client, writes } = capture()

    // Both directions, because both build the path: a caller who can choose the
    // segment can choose the *target* of the write, and one of these strings is a
    // vote smuggled in as a query string. The descriptors are refused for a second
    // reason — `reviewers/{descriptor}` answers 400 (identity-contract).
    await expect(addReviewer(client, REF, id, false)).rejects.toThrow(
      'A reviewer is addressed by identity id, and that is not one.',
    )
    await expect(removeReviewer(client, REF, id)).rejects.toThrow(
      'A reviewer is addressed by identity id, and that is not one.',
    )
    expect(writes).toEqual([])
  })

  it('takes the id in either casing, because ADO answers both', async () => {
    const { client, writes } = capture()

    await addReviewer(client, REF, COLLEAGUE.toUpperCase(), false)

    // Passed through as given rather than normalised: the caller read this id off
    // an ADO response, and ADO's own routes take it as it answered it.
    expect(writes[0].path).toBe(`${PR}/reviewers/${COLLEAGUE.toUpperCase()}`)
  })

  it('reads nothing first, for `abandon`’s reason', async () => {
    const { client, writes } = capture()

    await addReviewer(client, REF, COLLEAGUE, false)
    await removeReviewer(client, REF, COLLEAGUE)

    // `capture()` with no replies rejects every `get`. Unlike `castVote`, which
    // must read to find out whose vote it is, neither of these has anything to
    // resolve — the caller named the person.
    expect(writes).toHaveLength(2)
  })
})

describe('abandoning and reactivating', () => {
  it('patches the status to abandoned and nothing else', async () => {
    const { client, writes } = capture()

    await abandon(client, REF)

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: PR,
        // Whole-object again, and here it is load-bearing twice over: this route
        // also takes `completed`, and it also takes `lastMergeSourceCommit`. A
        // body with more in it than this is a different action.
        body: { status: 'abandoned' },
        params: {},
      },
    ])
  })

  it('patches the status back to active, with no completion options anywhere near it', async () => {
    const { client, writes } = capture()

    await reactivate(client, REF)

    expect(writes).toEqual([{ method: 'PATCH', path: PR, body: { status: 'active' }, params: {} }])
  })

  it('reads nothing first, because ADO is the only judge of either', async () => {
    const { client, writes } = capture()

    await abandon(client, REF)
    await reactivate(client, REF)

    // `capture()` with no replies rejects every `get`, so these two resolving at
    // all is the assertion: neither pre-flights a permission check whose answer
    // would be stale by the time the write went out.
    expect(writes).toHaveLength(2)
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
