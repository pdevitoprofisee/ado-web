import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useObserve } from './use-notifications'

import type { ReactNode } from 'react'
import type { Notification, WatchedPullRequest } from '@/server/notifications'

vi.mock('@/server/notifications-fn', () => ({
  notificationsQuery: vi.fn(),
  markNotificationsRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  observeNotifications: vi.fn(),
}))

vi.mock('@/lib/notify', () => ({ announce: vi.fn() }))

const { observeNotifications } = await import('@/server/notifications-fn')
const { announce } = await import('@/lib/notify')

const watched: WatchedPullRequest = {
  prId: 3302,
  title: 'disable sql auditing',
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  role: 'reviewer',
  commitId: 'a'.repeat(40),
}

const announced = (kind: Notification['kind']): Notification => ({
  key: `${kind}:3302:abc`,
  kind,
  prId: 3302,
  title: 'disable sql auditing',
  detail: 'A check is failing',
  projectId: watched.projectId,
  repositoryId: watched.repositoryId,
  createdAt: 1,
  read: false,
})

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  return { invalidate, wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(observeNotifications).mockResolvedValue({ announced: [], unread: 0 })
})

describe('observing a poll', () => {
  it('waits for a poll to have come back', async () => {
    const { wrapper } = harness()

    renderHook(() => useObserve([watched], 0), { wrapper })

    await waitFor(() => expect(observeNotifications).not.toHaveBeenCalled())
  })

  it('hands the rows over and plays what came back', async () => {
    vi.mocked(observeNotifications).mockResolvedValue({
      announced: [announced('build')],
      unread: 1,
    })
    const { invalidate, wrapper } = harness()

    renderHook(() => useObserve([watched], 1000), { wrapper })

    await waitFor(() =>
      expect(observeNotifications).toHaveBeenCalledWith({ data: { pullRequests: [watched] } }),
    )
    // The sound comes from what the server says has not been announced yet, and
    // from nothing else — that is the only place that knows whether the other
    // detection path already played this.
    await waitFor(() => expect(announce).toHaveBeenCalledWith(['build']))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] })
  })

  it('observes once per poll, whatever the rows do in between', async () => {
    const { wrapper } = harness()
    const { rerender } = renderHook(
      ({ rows, at }: { rows: WatchedPullRequest[]; at: number }) => useObserve(rows, at),
      { wrapper, initialProps: { rows: [watched], at: 1000 } },
    )

    await waitFor(() => expect(observeNotifications).toHaveBeenCalledTimes(1))

    // A new array with the same content, and then a genuinely different row: a
    // re-render is not a poll, so neither is an observation.
    rerender({ rows: [{ ...watched }], at: 1000 })
    rerender({ rows: [{ ...watched, prId: 3303 }], at: 1000 })
    expect(observeNotifications).toHaveBeenCalledTimes(1)

    rerender({ rows: [{ ...watched, prId: 3303 }], at: 2000 })
    await waitFor(() => expect(observeNotifications).toHaveBeenCalledTimes(2))
    // And it sends what the rows say *now*, not what they said when the poll it
    // is keyed on started.
    expect(observeNotifications).toHaveBeenLastCalledWith({
      data: { pullRequests: [{ ...watched, prId: 3303 }] },
    })
  })

  it('refreshes the panel even when the observation fails', async () => {
    vi.mocked(observeNotifications).mockRejectedValue(new Error('the server function failed'))
    const { invalidate, wrapper } = harness()

    renderHook(() => useObserve([watched], 1000), { wrapper })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] }))
    expect(announce).not.toHaveBeenCalled()
  })
})
