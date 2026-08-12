import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INBOX_KEY, dropInboxRow, retitleInboxRow, settleMergedRow } from './inbox-cache'

import type { PullRequestRow } from '@/server/inbox'
import type { InboxResult } from '@/server/inbox-fn'

// What the table shows when you come back to it, which is the one thing this
// file is for: the cached row, not the pull request Azure DevOps holds.

const row = (id: number, title: string): PullRequestRow => ({
  id,
  title,
  description: '',
  project: 'SaaS',
  repository: 'PC.IAC.Modules',
  author: 'Naveen Angali',
  targetBranch: 'main',
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  commitId: 'abc123',
  url: `https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/${id}`,
  viaTeam: null,
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  conflicted: false,
  myVote: 0,
  reviewers: [],
  closed: null,
})

const result = (mine: PullRequestRow[], assignedToMe: PullRequestRow[]): InboxResult => ({
  inbox: {
    identity: { id: 'me', displayName: 'Paul DeVito' },
    teams: [],
    mine,
    assignedToMe,
    scanned: mine.length + assignedToMe.length,
    hidden: 0,
  },
  error: null,
  connected: true,
  rateLimit: null,
})

const seeded = (data: InboxResult): QueryClient => {
  const client = new QueryClient()
  client.setQueryData(INBOX_KEY, data)

  return client
}

const titles = (client: QueryClient) => {
  const inbox = client.getQueryData<InboxResult>(INBOX_KEY)?.inbox

  return [...(inbox?.mine ?? []), ...(inbox?.assignedToMe ?? [])].map((one) => one.title)
}

describe('retitleInboxRow', () => {
  it('renames the row and leaves every other one alone', () => {
    const client = seeded(result([row(3301, 'old name'), row(3302, 'another')], []))

    retitleInboxRow(client, 3301, 'move the logging sink off the shared account')

    expect(titles(client)).toEqual(['move the logging sink off the shared account', 'another'])
  })

  it('reaches the section a review request is in, not only my own pull requests', () => {
    const client = seeded(result([], [row(3303, 'old name')]))

    retitleInboxRow(client, 3303, 'new name')

    expect(titles(client)).toEqual(['new name'])
  })

  it('does nothing when the inbox has never been read', () => {
    const client = new QueryClient()

    retitleInboxRow(client, 3301, 'new name')

    expect(client.getQueryData(INBOX_KEY)).toBeUndefined()
  })

  it('leaves a failed inbox as it found it', () => {
    const client = seeded({
      inbox: null,
      error: 'Azure DevOps answered 500.',
      connected: true,
      rateLimit: null,
    })

    retitleInboxRow(client, 3301, 'new name')

    expect(client.getQueryData<InboxResult>(INBOX_KEY)?.error).toBe('Azure DevOps answered 500.')
  })
})

describe('dropInboxRow', () => {
  it('takes the merged row off the table and leaves every other one alone', () => {
    const client = seeded(result([row(3301, 'merged'), row(3302, 'another')], []))

    dropInboxRow(client, 3301)

    expect(titles(client)).toEqual(['another'])
  })

  it('reaches the section a review request is in', () => {
    const client = seeded(result([row(3302, 'mine')], [row(3303, 'merged')]))

    dropInboxRow(client, 3303)

    expect(titles(client)).toEqual(['mine'])
  })

  it('does nothing when the inbox has never been read', () => {
    const client = new QueryClient()

    dropInboxRow(client, 3301)

    expect(client.getQueryData(INBOX_KEY)).toBeUndefined()
  })
})

describe('settleMergedRow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * The inbox as the route holds it: one query, read, with somebody watching it.
   *
   * The observer is what makes the re-read happen. An invalidation refetches the
   * queries a page is drawing and only marks the rest stale, so a cache seeded by
   * hand would answer this whole ladder without calling Azure DevOps once — and
   * the test would pass on a function that does nothing.
   */
  const watched = async (read: () => Promise<InboxResult>) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = { queryKey: INBOX_KEY, queryFn: read, staleTime: Infinity }
    // The route's own staleness, and the reason the subscription below costs no
    // read: the poll is the freshness mechanism there, so only an invalidation
    // re-reads. Without it, watching the query would count as a second read.
    await client.fetchQuery(options)
    new QueryObserver(client, options).subscribe(() => {})

    return client
  }

  const OPEN = () => result([row(3301, 'merged'), row(3302, 'another')], [])
  const CLOSED = () => result([row(3302, 'another')], [])

  it('re-reads the table once the completion has had time to land', async () => {
    const read = vi.fn().mockResolvedValueOnce(OPEN()).mockResolvedValue(CLOSED())
    const client = await watched(read)

    dropInboxRow(client, 3301)
    const settled = settleMergedRow(client, 3301)

    await vi.advanceTimersByTimeAsync(1_500)
    await settled

    // Twice: the read the table was drawn from, and the one that agrees with it.
    expect(read).toHaveBeenCalledTimes(2)
    expect(titles(client)).toEqual(['another'])
  })

  // The reason this waits at all: ADO answers the completion before it applies it,
  // so its next list can still hold the pull request the reviewer just merged.
  it('does not put the row back while Azure DevOps is still completing it', async () => {
    const read = vi.fn().mockResolvedValueOnce(OPEN()).mockResolvedValueOnce(OPEN()).mockResolvedValue(CLOSED())
    const client = await watched(read)

    dropInboxRow(client, 3301)
    const settled = settleMergedRow(client, 3301)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(read).toHaveBeenCalledTimes(2)
    // The read said "still open", and it is older than the acceptance in hand.
    expect(titles(client)).toEqual(['another'])

    await vi.advanceTimersByTimeAsync(3_000)
    await settled

    expect(read).toHaveBeenCalledTimes(3)
    expect(titles(client)).toEqual(['another'])
  })

  it('stops after two reads, and the row stays off the table', async () => {
    const read = vi.fn().mockResolvedValue(OPEN())
    const client = await watched(read)

    dropInboxRow(client, 3301)
    const settled = settleMergedRow(client, 3301)

    await vi.advanceTimersByTimeAsync(4_500)
    await settled

    // Two reads and no more: the alternative to a bounded wait is a poll loop
    // over every open pull request in the org.
    expect(read).toHaveBeenCalledTimes(3)
    // Azure DevOps has not caught up, and its acceptance is the better evidence.
    // The inbox's own poll is what puts the row back if it really did not merge.
    expect(titles(client)).toEqual(['another'])
  })
})
