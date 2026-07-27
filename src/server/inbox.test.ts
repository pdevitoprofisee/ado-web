// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { listActivePullRequests, loadInbox, partition } from './inbox'

import type { AdoClient, QueryValue } from './ado-client'

const ME = 'ba11ca22-79d4-65e2-8401-70ab29e1a5e2'
const TEAM = 'b53a4272-130f-4541-9d37-d566e39c95d0'
const OTHER_TEAM = 'ffffffff-0000-4000-8000-000000000000'
const COLLEAGUE = '87843bfc-6cf0-64be-bd4a-bb9bd6e801df'

const IDENTITY = { id: ME, displayName: 'Paul DeVito' }
const TEAMS = [{ id: TEAM, name: 'SaaS \\ DevOps Team' }]

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
}

/** Replies are looked up by path; `pullrequests` gets one reply per page, in order. */
function fakeClient(replies: Record<string, unknown | unknown[]>) {
  const calls: Call[] = []
  const cursors = new Map<string, number>()

  const client: AdoClient = {
    org: 'Contoso',
    async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, params })
      const reply = replies[path]
      if (reply === undefined) throw new Error(`unexpected call to ${path}`)
      if (!Array.isArray(reply)) return reply as T

      const index = cursors.get(path) ?? 0
      cursors.set(path, index + 1)

      return (reply[index] ?? { value: [] }) as T
    },
    fanOut: async (items, task) => Promise.all(items.map(task)),
    rateLimit: () => ({
      remaining: null,
      limit: null,
      delay: null,
      resetAt: null,
      throttledUntil: null,
      throttled: false,
    }),
  }

  return { client, calls }
}

const pr = (id: number, over: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  createdBy: { id: COLLEAGUE, displayName: 'Naveen Angali' },
  repository: { name: 'PC.IAC.Modules', project: { name: 'SaaS' } },
  targetRefName: 'refs/heads/main',
  creationDate: `2026-07-${String(id).padStart(2, '0')}T00:00:00Z`,
  isDraft: false,
  lastMergeSourceCommit: { commitId: `commit-${id}` },
  ...over,
})

const page = (...prs: unknown[]) => ({ count: prs.length, value: prs })

describe('paging', () => {
  it('advances by the requested $top and stops only on an empty page', async () => {
    // The middle page is short. Under the usual `count < $top` idiom this run
    // would stop at 2 PRs and silently lose the third — the service filters for
    // permissions *after* applying $top, so a short page is not the last page.
    const { client, calls } = fakeClient({
      '_apis/git/pullrequests': [page(pr(1), pr(2)), page(pr(3)), page()],
    })

    const all = await listActivePullRequests(client)

    expect(all.map((p) => p.pullRequestId)).toEqual([1, 2, 3])
    expect(calls.map((c) => c.params.$skip)).toEqual([0, 1000, 2000])
    expect(calls.every((c) => c.params.$top === 1000)).toBe(true)
    expect(calls.every((c) => c.params['searchCriteria.status'] === 'active')).toBe(true)
  })

  it('dedupes by pullRequestId across pages', async () => {
    const { client } = fakeClient({
      '_apis/git/pullrequests': [page(pr(1), pr(2)), page(pr(2), pr(3)), page()],
    })

    expect((await listActivePullRequests(client)).map((p) => p.pullRequestId)).toEqual([1, 2, 3])
  })

  it('treats a missing value array as the end, not as a crash', async () => {
    const { client } = fakeClient({ '_apis/git/pullrequests': [page(pr(1)), {}] })

    expect(await listActivePullRequests(client)).toHaveLength(1)
  })
})

describe('partition', () => {
  const split = (prs: unknown[]) =>
    partition(prs as never, IDENTITY, TEAMS, 'Contoso')

  it('puts a PR reviewed by a team I belong to under Assigned to me', () => {
    const { assignedToMe, mine } = split([
      pr(1, { reviewers: [{ id: TEAM, displayName: '[SaaS]\\DevOps Team', isContainer: true }] }),
    ])

    expect(assignedToMe.map((r) => r.id)).toEqual([1])
    expect(assignedToMe[0].viaTeam).toBe('SaaS \\ DevOps Team')
    expect(mine).toEqual([])
  })

  it('ignores a container reviewer that is a team I am not on', () => {
    const { assignedToMe } = split([
      pr(1, { reviewers: [{ id: OTHER_TEAM, isContainer: true }] }),
    ])

    expect(assignedToMe).toEqual([])
  })

  it('does not mistake a user whose id happens to match a team for team membership', () => {
    // `isContainer` is the only thing separating the two, and dropping the check
    // is the kind of edit that still passes every other test here.
    const { assignedToMe } = split([pr(1, { reviewers: [{ id: TEAM, isContainer: false }] })])

    expect(assignedToMe).toEqual([])
  })

  it('includes me as a direct reviewer, with no team attribution', () => {
    const { assignedToMe } = split([pr(1, { reviewers: [{ id: ME }] })])

    expect(assignedToMe.map((r) => r.id)).toEqual([1])
    expect(assignedToMe[0].viaTeam).toBeNull()
  })

  it('matches identities case-insensitively', () => {
    const { assignedToMe, mine } = split([
      pr(1, { reviewers: [{ id: TEAM.toUpperCase(), isContainer: true }] }),
      pr(2, { createdBy: { id: ME.toUpperCase(), displayName: 'Paul DeVito' } }),
    ])

    expect(assignedToMe.map((r) => r.id)).toEqual([1])
    expect(mine.map((r) => r.id)).toEqual([2])
  })

  it('keeps Mine to PRs I actually authored', () => {
    const { mine } = split([
      pr(1, { createdBy: { id: ME, displayName: 'Paul DeVito' } }),
      pr(2),
      pr(3, { createdBy: { id: `${ME}x`, displayName: 'Impostor' } }),
    ])

    expect(mine.map((r) => r.id)).toEqual([1])
  })

  it('never files my own PR under Assigned to me, even when my team reviews it', () => {
    const { assignedToMe, mine } = split([
      pr(1, {
        createdBy: { id: ME, displayName: 'Paul DeVito' },
        reviewers: [{ id: TEAM, isContainer: true }, { id: ME }],
      }),
    ])

    expect(mine.map((r) => r.id)).toEqual([1])
    expect(assignedToMe).toEqual([])
  })

  it('leaves out PRs that are neither mine nor assigned to me', () => {
    const { assignedToMe, mine } = split([pr(1, { reviewers: [{ id: COLLEAGUE }] })])

    expect(assignedToMe).toEqual([])
    expect(mine).toEqual([])
  })

  it('sorts each section newest first', () => {
    const { mine } = split([
      pr(5, { createdBy: { id: ME } }),
      pr(9, { createdBy: { id: ME } }),
      pr(7, { createdBy: { id: ME } }),
    ])

    expect(mine.map((r) => r.id)).toEqual([9, 7, 5])
  })

  it('flattens a row to the fields the list renders', () => {
    const { assignedToMe } = split([pr(3302, { reviewers: [{ id: TEAM, isContainer: true }] })])

    expect(assignedToMe[0]).toMatchObject({
      id: 3302,
      title: 'PR 3302',
      project: 'SaaS',
      repository: 'PC.IAC.Modules',
      author: 'Naveen Angali',
      targetBranch: 'main',
      isDraft: false,
      commitId: 'commit-3302',
      url: 'https://dev.azure.com/Contoso/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    })
  })
})

describe('loadInbox', () => {
  it('asks each endpoint for the api-version it actually needs', async () => {
    const { client, calls } = fakeClient({
      '_apis/connectionData': { authenticatedUser: { id: ME, providerDisplayName: 'Paul DeVito' } },
      '_apis/teams': { value: [{ id: TEAM, name: 'DevOps Team', projectName: 'SaaS' }] },
      '_apis/git/pullrequests': [page(pr(1, { reviewers: [{ id: TEAM, isContainer: true }] })), page()],
    })

    const inbox = await loadInbox(client)

    // Both are preview-only; the plain 7.1 is a 400 that no bad-token test sees.
    const version = (path: string) => calls.find((c) => c.path === path)?.params['api-version']
    expect(version('_apis/connectionData')).toBe('7.1-preview.1')
    expect(version('_apis/teams')).toBe('7.1-preview.3')
    expect(calls.find((c) => c.path === '_apis/teams')?.params.$mine).toBe(true)

    expect(inbox.identity).toEqual(IDENTITY)
    expect(inbox.teams).toEqual([{ id: TEAM, name: 'SaaS \\ DevOps Team' }])
    expect(inbox.assignedToMe.map((r) => r.id)).toEqual([1])
    expect(inbox.scanned).toBe(1)
  })

  it('refuses to build an inbox with no identity to build it around', async () => {
    const { client } = fakeClient({
      '_apis/connectionData': {},
      '_apis/teams': { value: [] },
      '_apis/git/pullrequests': [page()],
    })

    await expect(loadInbox(client)).rejects.toThrow(/no authenticated user/)
  })

  it('survives an account on no teams', async () => {
    const { client } = fakeClient({
      '_apis/connectionData': { authenticatedUser: { id: ME } },
      '_apis/teams': {},
      '_apis/git/pullrequests': [page(pr(1, { reviewers: [{ id: TEAM, isContainer: true }] })), page()],
    })

    const inbox = await loadInbox(client)

    expect(inbox.teams).toEqual([])
    expect(inbox.assignedToMe).toEqual([])
  })
})
