import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { INBOX_KEY } from './inbox-cache'
import { useRename } from './rename'
import { pullRequestKey } from './requeue'
import { renamePullRequest } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { PullRequestRow } from '@/server/inbox'
import type { InboxResult } from '@/server/inbox-fn'
import type { PullRequestRef } from '@/server/pull-request'

// The two things this hook exists to get right, neither of which the header can be
// asked about: that a refusal Azure DevOps *returned* becomes a rejection the field
// can catch, and that the page re-reads the pull request either way.

vi.mock('@/server/pull-request-fn', () => ({
  renamePullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

/** An inbox holding this pull request under the name it is about to lose. */
function withInbox(title: string): QueryClient {
  const client = new QueryClient()
  const row = { id: REF.id, title } as PullRequestRow
  client.setQueryData<InboxResult>(INBOX_KEY, {
    inbox: {
      identity: { id: 'me', displayName: 'Paul DeVito' },
      teams: [],
      mine: [row],
      assignedToMe: [],
      scanned: 1,
      hidden: 0,
    },
    error: null,
    connected: true,
    rateLimit: null,
  })

  return client
}

const inboxTitle = (client: QueryClient) =>
  client.getQueryData<InboxResult>(INBOX_KEY)?.inbox?.mine[0]?.title

function mount(client: QueryClient) {
  const { result } = renderHook(() => useRename(REF), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })

  return result
}

describe('useRename', () => {
  it('sends the title with the pull request it belongs to, then re-reads the page', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')

    await mount(client).current('move the logging sink off the shared account')

    expect(vi.mocked(renamePullRequest)).toHaveBeenCalledWith({
      data: { ...REF, title: 'move the logging sink off the shared account' },
    })
    // The same key the route builds its detail query with, which is the whole
    // reason `pullRequestKey` is a function in one file rather than an array in
    // two.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('rejects with what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(renamePullRequest).mockResolvedValueOnce({
      ok: false,
      // The shape `AdoError` produces, detail and all — this sentence is what ends
      // up under the field, so it must survive the trip unedited.
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')

    await expect(mount(client).current('a title somebody else owns')).rejects.toThrow(
      'TF401027: You need the Contribute permission.',
    )

    // Not belt-and-braces: a write can be refused on the way back after it landed,
    // so the only trustworthy title is the one that comes from a fresh read.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('puts the new title on the inbox row, so the table is not stale on the way back', async () => {
    const client = withInbox('old name')
    const invalidated = vi.spyOn(client, 'invalidateQueries')

    await mount(client).current('move the logging sink off the shared account')

    expect(inboxTitle(client)).toBe('move the logging sink off the shared account')
    // Written *and* marked stale: the row above is this one field, and the poll
    // is what answers for the rest of it.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: INBOX_KEY })
  })

  it('keeps the old inbox row on a refusal, and still re-reads the inbox', async () => {
    vi.mocked(renamePullRequest).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403.',
      connected: true,
    })

    const client = withInbox('old name')
    const invalidated = vi.spyOn(client, 'invalidateQueries')

    await expect(mount(client).current('a title somebody else owns')).rejects.toThrow('403')

    // Nothing here knows whether the write landed, so the row says what the last
    // read said and the invalidation goes and finds out.
    expect(inboxTitle(client)).toBe('old name')
    expect(invalidated).toHaveBeenCalledWith({ queryKey: INBOX_KEY })
  })

  it('rejects with something sayable when the refusal came with no reason', async () => {
    vi.mocked(renamePullRequest).mockResolvedValueOnce({ ok: false, error: null, connected: true })

    await expect(mount(new QueryClient()).current('a new title')).rejects.toThrow(
      'Azure DevOps did not say why.',
    )
  })
})
