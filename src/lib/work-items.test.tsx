import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { pullRequestKey } from './requeue'
import {
  useAttachWorkItem,
  useDebounced,
  useWorkItemSearch,
  useWorkItems,
  workItemSearchKey,
  workItemsKey,
} from './work-items'
import { attachWorkItem, workItemSearchQuery, workItemsQuery } from '@/server/work-items-fn'

import type { ReactNode } from 'react'
import type { PullRequestRef } from '@/server/pull-request'

// The client half: the two keys, the only debounce in the app, and the write.
//
// The debounce is the reason this file exists and `reviewers.test.tsx` has no
// equivalent. Every keystroke here is two ADO calls, so what is *not* asked is as
// much of the behaviour as what is.

vi.mock('@/server/work-items-fn', () => ({
  workItemsQuery: vi.fn(async () => ({ items: [], total: 0, error: null, connected: true })),
  workItemSearchQuery: vi.fn(async () => ({ items: [], error: null, connected: true })),
  attachWorkItem: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

// `requeue.ts` owns the detail key this write invalidates, and it sits next to a
// server function that reaches SQLite. `checks.test.tsx`' mock, for its reason.
vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'

const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(workItemSearchQuery).mockClear()
  vi.mocked(workItemsQuery).mockClear()
  vi.mocked(attachWorkItem).mockClear()
})

/** `reviewers.test.tsx`' harness: the client is the test's, so it can be spied on. */
function mount<T, P>(hook: (props: P) => T, client: QueryClient, initialProps: P) {
  return renderHook(hook, {
    initialProps,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

const quiet = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

describe('the keys', () => {
  it('names the pull request in the attached-items key', () => {
    expect(workItemsKey(REF)).toEqual(['work-items', PROJECT, REPOSITORY, 24698])
  })

  it('leaves the pull request out of the search key', () => {
    // Two pull requests in the same project asking the same question have the same
    // answer. A key that named the review would pay two calls to learn it twice.
    expect(workItemSearchKey(PROJECT, 'login')).toEqual(['work-item-search', PROJECT, 'login'])
  })
})

describe('useWorkItems', () => {
  it('asks for one pull request and reports what came back', async () => {
    vi.mocked(workItemsQuery).mockResolvedValueOnce({
      items: [
        { id: 162828, title: 'Fix the login', state: 'Active', type: 'Bug', url: 'https://x/1' },
      ],
      total: 2,
      error: null,
      connected: true,
    })

    const { result } = mount(() => useWorkItems(REF), quiet(), undefined)

    await waitFor(() => expect(result.current.data?.total).toBe(2))
    expect(vi.mocked(workItemsQuery)).toHaveBeenCalledWith({ data: REF })
    expect(result.current.data?.items).toHaveLength(1)
  })
})

describe('useDebounced', () => {
  it('holds the new value until it has stopped changing', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 150), {
      initialProps: { value: 'l' },
    })

    expect(result.current).toBe('l')

    rerender({ value: 'lo' })
    expect(result.current).toBe('l')

    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(result.current).toBe('l')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe('lo')
  })

  it('starts the wait again on every keystroke, so typing asks nothing', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 150), {
      initialProps: { value: 'l' },
    })

    for (const value of ['lo', 'log', 'logi', 'login']) {
      rerender({ value })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(result.current).toBe('l')
    }

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBe('login')
  })
})

describe('useWorkItemSearch', () => {
  it('asks for what was typed first, and then only for what typing settled on', async () => {
    const { rerender } = mount(
      ({ query }: { query: string }) => useWorkItemSearch(PROJECT, query),
      quiet(),
      { query: 'l' },
    )

    rerender({ query: 'lo' })
    rerender({ query: 'log' })
    rerender({ query: 'login' })

    await waitFor(() =>
      expect(vi.mocked(workItemSearchQuery)).toHaveBeenCalledWith({
        data: { projectId: PROJECT, query: 'login' },
      }),
    )

    // The first render's value is asked for straight away — an open picker with an
    // empty field is a request for what is recent — and nothing in between is.
    const asked = vi
      .mocked(workItemSearchQuery)
      .mock.calls.map((call) => (call[0] as { data: { query: string } }).data.query)
    expect(asked).toEqual(['l', 'login'])
  })

  it('asks for what is recent when the field is empty', async () => {
    mount(() => useWorkItemSearch(PROJECT, ''), quiet(), undefined)

    await waitFor(() =>
      expect(vi.mocked(workItemSearchQuery)).toHaveBeenCalledWith({
        data: { projectId: PROJECT, query: '' },
      }),
    )
  })

  it('keeps the previous matches on screen while the next answer is in flight', async () => {
    vi.mocked(workItemSearchQuery).mockResolvedValueOnce({
      items: [
        { id: 91, title: 'Fix the login', state: 'Active', type: 'Bug', url: 'https://x/91' },
      ],
      error: null,
      connected: true,
    })

    const { result, rerender } = mount(
      ({ query }: { query: string }) => useWorkItemSearch(PROJECT, query),
      quiet(),
      { query: 'log' },
    )

    await waitFor(() => expect(result.current.data?.items).toHaveLength(1))

    let land: (answer: {
      items: never[]
      error: null
      connected: boolean
    }) => void = () => {}
    vi.mocked(workItemSearchQuery).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    rerender({ query: 'logi' })
    await waitFor(() => expect(result.current.isFetching || result.current.isPlaceholderData))
    // The list does not empty and fill back in. An empty list reads as "nothing
    // matches" for as long as the round trip takes.
    expect(result.current.data?.items).toHaveLength(1)

    land({ items: [], error: null, connected: true })
  })
})

describe('useAttachWorkItem', () => {
  it('sends the pull request and the number, then re-reads the section', async () => {
    const client = quiet()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = mount(() => useAttachWorkItem(REF), client, undefined)

    result.current.run(162828)

    await waitFor(() =>
      expect(vi.mocked(attachWorkItem)).toHaveBeenCalledWith({
        data: { ...REF, workItemId: 162828 },
      }),
    )
    await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: workItemsKey(REF) }))
  })

  it('re-reads the detail as well, because the work item policy lives there', async () => {
    const client = quiet()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = mount(() => useAttachWorkItem(REF), client, undefined)

    result.current.run(162828)

    await waitFor(() =>
      expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) }),
    )
  })

  it('names the work item in flight, not merely that one is', async () => {
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(attachWorkItem).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    const { result } = mount(() => useAttachWorkItem(REF), quiet(), undefined)

    result.current.run(162828)
    await waitFor(() => expect(result.current.pending).toBe(162828))

    land({ ok: true, error: null, connected: true })
    await waitFor(() => expect(result.current.pending).toBeNull())
  })

  it('reports what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(attachWorkItem).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401326: You do not have permission.)',
      connected: true,
    })

    const client = quiet()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = mount(() => useAttachWorkItem(REF), client, undefined)

    result.current.run(162828)

    await waitFor(() =>
      expect(result.current.error).toBe(
        'Azure DevOps answered 403. (TF401326: You do not have permission.)',
      ),
    )
    // A `PATCH` whose response was lost may well have been applied, so both re-reads
    // happen on the failure too.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: workItemsKey(REF) })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
  })

  it('has something to say when the refusal came with no reason', async () => {
    vi.mocked(attachWorkItem).mockResolvedValueOnce({ ok: false, error: null, connected: true })

    const { result } = mount(() => useAttachWorkItem(REF), quiet(), undefined)

    result.current.run(162828)

    await waitFor(() => expect(result.current.error).toBe('Azure DevOps did not say why.'))
  })

  it('forgets a refusal when it is dismissed, because the field stays open', async () => {
    vi.mocked(attachWorkItem).mockResolvedValueOnce({ ok: false, error: 'No.', connected: true })

    const { result } = mount(() => useAttachWorkItem(REF), quiet(), undefined)

    result.current.run(162828)
    await waitFor(() => expect(result.current.error).toBe('No.'))

    result.current.dismiss()
    await waitFor(() => expect(result.current.error).toBeNull())
  })
})
