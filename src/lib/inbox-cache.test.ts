import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { INBOX_KEY, retitleInboxRow } from './inbox-cache'

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
