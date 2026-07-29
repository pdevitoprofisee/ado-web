import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { lifecycleAction, useAbandon, useReactivate } from './lifecycle'
import { pullRequestKey } from './requeue'
import { abandonPullRequest, reactivatePullRequest } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { PullRequestDetail, PullRequestRef } from '@/server/pull-request'

// Which of the two verbs a pull request is up for, and what the two hooks do with
// it. The confirmation itself is the header's business and is tested there; what is
// here is the part no component can be asked about — that the dialog is only told
// to close when ADO actually took it, and that the page re-reads either way.

vi.mock('@/server/pull-request-fn', () => ({
  abandonPullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  reactivatePullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'

/** Only the three fields the decision reads. */
const pr = (
  over: Partial<Pick<PullRequestDetail, 'status' | 'author' | 'viewerId'>> = {},
): Pick<PullRequestDetail, 'status' | 'author' | 'viewerId'> => ({
  status: 'active',
  author: { id: ME, displayName: 'Paul DeVito', avatarHref: null },
  viewerId: ME,
  ...over,
})

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('lifecycleAction', () => {
  it('offers abandon on your own active pull request', () => {
    expect(lifecycleAction(pr())).toEqual({ kind: 'abandon', blocker: null })
  })

  it('offers reactivate on the one kind of pull request that can be reactivated', () => {
    expect(lifecycleAction(pr({ status: 'abandoned' }))).toEqual({
      kind: 'reactivate',
      blocker: null,
    })
  })

  it('names the verb in the refusal, so the sentence matches the button beside it', () => {
    expect(lifecycleAction(pr({ viewerId: COLLEAGUE })).blocker).toBe(
      "Abandoning somebody else's pull request is a decision to make in Azure DevOps.",
    )
    expect(lifecycleAction(pr({ status: 'abandoned', viewerId: COLLEAGUE })).blocker).toBe(
      "Reactivating somebody else's pull request is a decision to make in Azure DevOps.",
    )
  })

  it('answers with the status before the ownership on a finished pull request', () => {
    // Being told "this is not yours" about work you merged yesterday is the wrong
    // sentence, so the status is checked first even for a stranger's pull request.
    expect(lifecycleAction(pr({ status: 'completed', viewerId: COLLEAGUE })).blocker).toBe(
      'This pull request has already been completed.',
    )
  })

  it('repeats a status it does not recognise rather than guessing at it', () => {
    expect(lifecycleAction(pr({ status: 'notSet' })).blocker).toBe(
      'Azure DevOps says this pull request is notSet, not active.',
    )
    expect(lifecycleAction(pr({ status: '' })).blocker).toBe(
      'Azure DevOps says this pull request is in a state it did not name, not active.',
    )
  })

  it('will not claim a pull request is yours when nobody could say who you are', () => {
    expect(lifecycleAction(pr({ viewerId: null })).blocker).toContain(
      'did not say who this token belongs to',
    )
  })
})

describe('useAbandon', () => {
  it('sends the pull request, re-reads it, then closes the confirmation', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const closed = vi.fn()
    const { result } = renderHook(() => useAbandon(REF, closed), { wrapper: wrapper(client) })

    result.current.run()

    await waitFor(() => expect(closed).toHaveBeenCalled())
    expect(vi.mocked(abandonPullRequest)).toHaveBeenCalledWith({ data: REF })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('leaves the confirmation open on a refusal, and reports it in ADOs words', async () => {
    vi.mocked(abandonPullRequest).mockResolvedValueOnce({
      ok: false,
      error: 'TF401027: You need the Contribute to pull requests permission.',
      connected: true,
    })

    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const closed = vi.fn()
    const { result } = renderHook(() => useAbandon(REF, closed), { wrapper: wrapper(client) })

    result.current.run()

    await waitFor(() =>
      expect(result.current.error).toBe(
        'TF401027: You need the Contribute to pull requests permission.',
      ),
    )
    // The dialog is where the refusal is written, so closing it would throw away
    // the answer the reviewer pressed the button for.
    expect(closed).not.toHaveBeenCalled()
    // Re-read anyway: a write whose response was lost may already have closed it.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('forgets the last refusal when the dialog is dismissed', async () => {
    vi.mocked(abandonPullRequest).mockResolvedValueOnce({
      ok: false,
      error: 'TF401027: You need the Contribute to pull requests permission.',
      connected: true,
    })
    const { result } = renderHook(() => useAbandon(REF, vi.fn()), {
      wrapper: wrapper(new QueryClient()),
    })

    result.current.run()
    await waitFor(() => expect(result.current.error).not.toBeNull())

    result.current.dismiss()

    // So reopening the confirmation does not still show it.
    await waitFor(() => expect(result.current.error).toBeNull())
  })
})

describe('useReactivate', () => {
  it('sends the pull request and re-reads it', async () => {
    const client = new QueryClient()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useReactivate(REF), { wrapper: wrapper(client) })

    result.current.run()

    await waitFor(() => expect(vi.mocked(reactivatePullRequest)).toHaveBeenCalledWith({ data: REF }))
    await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) }))
  })

  it('reports a refusal without anything to dismiss it from', async () => {
    vi.mocked(reactivatePullRequest).mockResolvedValueOnce({
      ok: false,
      error: null,
      connected: true,
    })
    const { result } = renderHook(() => useReactivate(REF), { wrapper: wrapper(new QueryClient()) })

    result.current.run()

    await waitFor(() => expect(result.current.error).toBe('Azure DevOps did not say why.'))
  })
})
