import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { pullRequestKey } from './requeue'
import { offerable, useInviteReviewer, useWithdrawReviewer, withdrawBlocker } from './reviewers'
import { inviteReviewer, withdrawReviewer } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { ReviewerCandidate } from './identity-contract'
import type { PullRequestRef, Reviewer } from '@/server/pull-request'

// Who may be offered, who may be taken off, and what the two hooks do with the
// answers. The first two are pure and are where the judgement lives; the hooks are
// here for `useVote`'s two reasons — a refusal ADO *returned* has to become a
// rejection, and the page re-reads either way — plus one of their own: `pending`
// names the person, because the field says so out loud.

vi.mock('@/server/pull-request-fn', () => ({
  inviteReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  withdrawReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const JORDAN = 'fbfd3dd4-1a1a-4b4b-8c8c-0d0d0d0d0d0d'
const MARJORIE = 'aa11bb22-3c3c-4d4d-9e9e-5f5f5f5f5f5f'

const candidate = (over: Partial<ReviewerCandidate> = {}): ReviewerCandidate => ({
  identityId: JORDAN,
  descriptor: 'aad.amFja3Nvbg',
  kind: 'user',
  displayName: 'Jordan Vincent',
  uniqueName: 'jordan.vincent@profisee.com',
  avatarHref: '',
  ...over,
})

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  id: JORDAN,
  displayName: 'Jordan Vincent',
  vote: 0,
  isContainer: false,
  isRequired: false,
  votedFor: [],
  avatarHref: null,
  ...over,
})

const names = (people: readonly ReviewerCandidate[]) => people.map((person) => person.displayName)

describe('offerable', () => {
  it('offers the whole directory when nobody is on the pull request yet', () => {
    const people = [candidate(), candidate({ identityId: MARJORIE, displayName: 'Marjorie Chen' })]

    expect(names(offerable(people, []))).toEqual(['Jordan Vincent', 'Marjorie Chen'])
  })

  it('drops somebody who is already a reviewer', () => {
    const people = [candidate(), candidate({ identityId: MARJORIE, displayName: 'Marjorie Chen' })]

    expect(names(offerable(people, [reviewer()]))).toEqual(['Marjorie Chen'])
  })

  it('matches ids case-insensitively, because ADO does not keep them consistent', () => {
    // `_apis/identities` answers lower case and the pull request's reviewer list
    // answers upper; comparing as written would offer half the list straight back.
    expect(offerable([candidate()], [reviewer({ id: JORDAN.toUpperCase() })])).toEqual([])
    expect(
      offerable([candidate({ identityId: JORDAN.toUpperCase() })], [reviewer()]),
    ).toEqual([])
  })

  it('keeps offering people when a team is the reviewer', () => {
    // The common case on this org rather than an edge: `[Products]\Contributors` is
    // a reviewer on most active pull requests, and it is exactly then that the
    // author wants a named person asked.
    const people = [candidate(), candidate({ identityId: MARJORIE, displayName: 'Marjorie Chen' })]
    const team = reviewer({ id: '9d0f0e0e-2222-3333-4444-555555555555', isContainer: true })

    expect(names(offerable(people, [team]))).toEqual(['Jordan Vincent', 'Marjorie Chen'])
  })
})

describe('withdrawBlocker', () => {
  it('lets a reviewer who has not voted go', () => {
    expect(withdrawBlocker(reviewer())).toBeNull()
  })

  it('refuses a team, because a branch policy would put it back', () => {
    expect(withdrawBlocker(reviewer({ isContainer: true }))).toContain('would not last')
  })

  it('refuses anybody who has voted, in either direction', () => {
    for (const vote of [10, 5, -5, -10]) {
      expect(withdrawBlocker(reviewer({ vote }))).toContain('would discard their vote')
    }
  })

  it('refuses a required reviewer no differently from an optional one', () => {
    // `isRequired` is not one of the two reasons: a required reviewer who has not
    // voted is removable, and ADO is the one that decides whether the policy allows
    // it. Guessing here would hide a control that works.
    expect(withdrawBlocker(reviewer({ isRequired: true }))).toBeNull()
  })
})

/** `vote.test.tsx`' harness, twice: the client is the test's, so it can be spied on. */
function mount<T>(hook: () => T, client: QueryClient) {
  const { result } = renderHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })

  return result
}

const mountInvite = (client: QueryClient) => mount(() => useInviteReviewer(REF), client)

const mountWithdraw = (client: QueryClient) => mount(() => useWithdrawReviewer(REF), client)

describe('useInviteReviewer', () => {
  it('sends the identity id and the flag, then re-reads the page', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const invite = mountInvite(client)

    invite.current.run(candidate(), false)

    await waitFor(() =>
      expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
        // `identityId`, not `descriptor`: `reviewers/{id}` answers 400 for a
        // descriptor (identity-contract), and the hook taking the whole candidate is
        // what makes that impossible to get wrong at the call site.
        data: { ...REF, reviewerId: JORDAN, isRequired: false },
      }),
    )
    await waitFor(() =>
      expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) }),
    )
  })

  it('carries `isRequired` when it is asked for, rather than deciding for itself', async () => {
    const client = new QueryClient()
    const invite = mountInvite(client)

    invite.current.run(candidate({ identityId: MARJORIE }), true)

    await waitFor(() =>
      expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
        data: { ...REF, reviewerId: MARJORIE, isRequired: true },
      }),
    )
  })

  it('names the person in flight, not merely that somebody is', async () => {
    // Held open deliberately, `useVote`'s reason: a write that resolves in the same
    // tick never has an in-flight state to look at, and "Asking Jordan Vincent…" is
    // the whole point of `pending` being an id.
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(inviteReviewer).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    const client = new QueryClient()
    const invite = mountInvite(client)

    invite.current.run(candidate(), false)
    await waitFor(() => expect(invite.current.pending).toBe(JORDAN))

    land({ ok: true, error: null, connected: true })
    await waitFor(() => expect(invite.current.pending).toBeNull())
  })

  it('reports what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(inviteReviewer).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const invite = mountInvite(client)

    invite.current.run(candidate(), false)

    await waitFor(() =>
      expect(invite.current.error).toBe(
        'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      ),
    )
    // A `PUT` whose response was lost may well have added them, so the re-read
    // happens on the failure too.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('has something to say when the refusal came with no reason', async () => {
    vi.mocked(inviteReviewer).mockResolvedValueOnce({ ok: false, error: null, connected: true })

    const client = new QueryClient()
    const invite = mountInvite(client)

    invite.current.run(candidate(), false)

    await waitFor(() => expect(invite.current.error).toBe('Azure DevOps did not say why.'))
  })

  it('forgets a refusal when it is dismissed, because the field stays open', async () => {
    vi.mocked(inviteReviewer).mockResolvedValueOnce({ ok: false, error: 'No.', connected: true })

    const client = new QueryClient()
    const invite = mountInvite(client)

    invite.current.run(candidate(), false)
    await waitFor(() => expect(invite.current.error).toBe('No.'))

    invite.current.dismiss()
    await waitFor(() => expect(invite.current.error).toBeNull())
  })
})

describe('useWithdrawReviewer', () => {
  it('sends the id, says nothing about requiring them, and re-reads', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const withdraw = mountWithdraw(client)

    withdraw.current.run(JORDAN)

    await waitFor(() =>
      expect(vi.mocked(withdrawReviewer)).toHaveBeenCalledWith({
        // `isRequired: false` because the request shape carries it and the `DELETE`
        // does not read it — pinned whole so it cannot quietly start meaning
        // something.
        data: { ...REF, reviewerId: JORDAN, isRequired: false },
      }),
    )
    await waitFor(() =>
      expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) }),
    )
  })

  it('names the reviewer being taken off', async () => {
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(withdrawReviewer).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    const client = new QueryClient()
    const withdraw = mountWithdraw(client)

    withdraw.current.run(MARJORIE)
    await waitFor(() => expect(withdraw.current.pending).toBe(MARJORIE))

    land({ ok: true, error: null, connected: true })
    await waitFor(() => expect(withdraw.current.pending).toBeNull())
  })

  it('reports a refusal, and still re-reads', async () => {
    vi.mocked(withdrawReviewer).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 404.',
      connected: true,
    })

    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const withdraw = mountWithdraw(client)

    withdraw.current.run(JORDAN)

    await waitFor(() => expect(withdraw.current.error).toBe('Azure DevOps answered 404.'))
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })
})
