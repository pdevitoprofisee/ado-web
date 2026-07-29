import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { pullRequestKey } from './requeue'
import { useVote, viewerVote, voteBlocker } from './vote'
import { setMyVote } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { PullRequestDetail, PullRequestRef, Reviewer } from '@/server/pull-request'

// Which vote is the viewer's, whether they may change it, and what the hook does
// with the answer. The first two are pure and branchy enough to be worth asking
// directly; the third is here for `useRename`'s two reasons — a refusal ADO
// *returned* has to become a rejection, and the page re-reads either way.

vi.mock('@/server/pull-request-fn', () => ({
  setMyVote: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  id: ME,
  displayName: 'Paul DeVito',
  vote: 0,
  isContainer: false,
  isRequired: true,
  votedFor: [],
  ...over,
})

/** Only the three fields either function reads. */
const pr = (
  over: Partial<Pick<PullRequestDetail, 'status' | 'reviewers' | 'viewerId'>> = {},
): Pick<PullRequestDetail, 'status' | 'reviewers' | 'viewerId'> => ({
  status: 'active',
  reviewers: [reviewer()],
  viewerId: ME,
  ...over,
})

describe('viewerVote', () => {
  it('finds the viewers own vote and no one elses', () => {
    expect(
      viewerVote(
        pr({ reviewers: [reviewer({ id: COLLEAGUE, vote: -10 }), reviewer({ vote: 5 })] }),
      ),
    ).toBe(5)
  })

  it('reads a reviewer who is not on the list as no vote, which is what it means', () => {
    // The common case here, not an edge: a group is the reviewer and a person
    // appears only once they have voted.
    expect(viewerVote(pr({ reviewers: [reviewer({ id: COLLEAGUE, vote: 10 })] }))).toBe(0)
  })

  it('matches ids case-insensitively, because ADO does not keep them consistent', () => {
    expect(viewerVote(pr({ reviewers: [reviewer({ id: ME.toUpperCase(), vote: 10 })] }))).toBe(10)
  })

  it('says it does not know when nobody could say who is looking', () => {
    // `null`, not `0`: drawing an unresolved viewer as "no vote" would offer to
    // cast one on their behalf.
    expect(viewerVote(pr({ viewerId: null }))).toBeNull()
    expect(viewerVote(pr({ viewerId: '' }))).toBeNull()
  })
})

describe('voteBlocker', () => {
  it('offers a vote to a reviewer on an active pull request', () => {
    expect(voteBlocker(pr())).toBeNull()
  })

  it('offers one when a team is the reviewer and the viewer is not listed', () => {
    expect(
      voteBlocker(pr({ reviewers: [reviewer({ id: 'team-1', isContainer: true })] })),
    ).toBeNull()
  })

  it('refuses on a pull request that is no longer being decided', () => {
    expect(voteBlocker(pr({ status: 'completed' }))).toContain('has been completed')
    expect(voteBlocker(pr({ status: 'abandoned' }))).toContain('Reactivate it to vote on it again')
  })

  it('repeats an unfamiliar status rather than guessing which of the three it is', () => {
    expect(voteBlocker(pr({ status: 'notSet' }))).toBe(
      'Azure DevOps says this pull request is notSet, not active.',
    )
    expect(voteBlocker(pr({ status: '' }))).toBe(
      'Azure DevOps says this pull request is in a state it did not name, not active.',
    )
  })

  it('refuses when the vote could not be attributed to anybody', () => {
    expect(voteBlocker(pr({ viewerId: null }))).toContain('did not say who this token belongs to')
  })

  it('refuses when the viewer is not on the pull request at all', () => {
    expect(voteBlocker(pr({ reviewers: [reviewer({ id: COLLEAGUE })] }))).toContain(
      'You are not a reviewer on this pull request',
    )
  })
})

function mount(client: QueryClient) {
  const { result } = renderHook(() => useVote(REF), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })

  return result
}

describe('useVote', () => {
  it('sends the vote with the pull request it belongs to, then re-reads the page', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const vote = mount(client)

    vote.current.run(-5)

    await waitFor(() => expect(vi.mocked(setMyVote)).toHaveBeenCalledWith({ data: { ...REF, vote: -5 } }))
    // The same key the route's detail query uses, so the badge and the pressed
    // button both come from ADO's answer rather than from the press.
    await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) }))
  })

  it('names the vote that is in flight, not merely that one is', async () => {
    // Held open deliberately: with the whole group disabled, which vote was
    // pressed is the only thing the page can still say, and a write that resolves
    // in the same tick never has an in-flight state to look at.
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(setMyVote).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    const vote = mount(new QueryClient())

    vote.current.run(10)
    await waitFor(() => expect(vote.current.pending).toBe(10))

    land({ ok: true, error: null, connected: true })
    await waitFor(() => expect(vote.current.pending).toBeNull())
  })

  it('reports what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(setMyVote).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const vote = mount(client)

    vote.current.run(10)

    await waitFor(() =>
      expect(vote.current.error).toBe(
        'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      ),
    )
    // A vote whose response was lost may well have been recorded, so the re-read
    // happens on the failure too.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('has something to say when the refusal came with no reason', async () => {
    vi.mocked(setMyVote).mockResolvedValueOnce({ ok: false, error: null, connected: true })
    const vote = mount(new QueryClient())

    vote.current.run(0)

    await waitFor(() => expect(vote.current.error).toBe('Azure DevOps did not say why.'))
  })
})
