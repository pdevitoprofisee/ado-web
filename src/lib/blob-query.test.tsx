import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileBlobsOptions, useWarmDiff } from './blob-query'

import type { FileBlobsRequest, FileBlobsResult } from '@/server/blob-fn'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// What the warmer is allowed to spend, and where it puts what it bought. The
// server function is mocked because it is the network; everything else — the
// ordering, the cap, the cache — is the real thing, because those three are the
// entire feature.
//
// The proof that the panel *reads* these entries lives in
// `components/diff/changed-file.test.tsx`, where a panel that never comes into
// view paints a diff anyway. It has to be there: the claim is about two callers
// agreeing, and a test that called `fileBlobsOptions` for both sides would agree
// with itself no matter what the panel did.
vi.mock('@/server/blob-fn', () => ({ fileBlobsQuery: vi.fn() }))

const { fileBlobsQuery } = await import('@/server/blob-fn')
const call = vi.mocked(fileBlobsQuery)

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24766,
}

const file = (path: string): ChangedFile => ({
  path,
  changeType: ['edit'],
  originalPath: null,
  objectId: 'a'.repeat(40),
  originalObjectId: 'b'.repeat(40),
})

/** Zero-padded so that alphabetical order and payload order are the same thing. */
const numbered = (count: number): readonly ChangedFile[] =>
  Array.from({ length: count }, (_, at) => file(`/src/file-${String(at + 1).padStart(2, '0')}.ts`))

const ANSWER: FileBlobsResult = {
  blobs: { path: '/src/file-01.ts', before: { kind: 'absent' }, after: { kind: 'absent' }, renamedOnly: false },
  error: null,
  connected: true,
  rateLimit: null,
}

/**
 * Which paths were asked for, in the order they were asked for.
 *
 * The cast is the wire's own shape: `fileBlobsQuery` validates its input rather
 * than typing it, so what arrives at the mock is `unknown` as far as TypeScript
 * is concerned.
 */
const warmed = (): string[] =>
  call.mock.calls.map(([input]) => (input as { data: FileBlobsRequest }).data.path)

function Warm({ files, enabled = true }: { files: readonly ChangedFile[]; enabled?: boolean }) {
  useWarmDiff(REF, files, enabled)

  return null
}

function warmer(files: readonly ChangedFile[], enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const draw = (next: { files: readonly ChangedFile[]; enabled?: boolean }) => (
    <QueryClientProvider client={client}>
      <Warm {...next} />
    </QueryClientProvider>
  )
  const view = render(draw({ files, enabled }))

  return { client, rerender: (next: { files: readonly ChangedFile[]; enabled?: boolean }) => view.rerender(draw(next)), unmount: view.unmount }
}

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue(ANSWER)
  // Synchronous, so every assertion below is about which calls went out rather
  // than about when. Whether idle is `requestIdleCallback` or a timer is
  // `idle.ts`' business and is tested there.
  vi.stubGlobal('requestIdleCallback', (work: () => void) => {
    work()

    return 1
  })
  vi.stubGlobal('cancelIdleCallback', () => {})
})

afterEach(() => {
  // Unmounted here rather than left to the library's own hook, which runs *after*
  // this one: a hook tearing down looks for `cancelIdleCallback`, and jsdom has
  // neither half of the pair to fall back on once the stubs are gone.
  cleanup()
  vi.unstubAllGlobals()
})

describe('useWarmDiff', () => {
  it('warms the top of the list and stops there', async () => {
    // The cap written out rather than imported. A test that read the constant
    // would follow it wherever it went, including to 294 — and the number is the
    // thing being asserted, because two calls a file is what makes it a number at
    // all.
    warmer(numbered(20))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(6))
    expect(warmed()).toEqual([
      '/src/file-01.ts',
      '/src/file-02.ts',
      '/src/file-03.ts',
      '/src/file-04.ts',
      '/src/file-05.ts',
      '/src/file-06.ts',
    ])

    // And it stays stopped: the seventh file is not a slow arrival, it is a file
    // that waits for somebody to scroll to it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).toHaveBeenCalledTimes(6)
  })

  it('warms the order the diff tab renders in, not the order ADO answered in', async () => {
    // `treeFiles` puts directories above loose files, so the list you see opens
    // with `/src/a.ts` however ADO ordered its change entries. Warming the
    // payload's first files would warm files nobody sees first.
    warmer([file('/z.ts'), file('/src/a.ts')])

    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(warmed()).toEqual(['/src/a.ts', '/z.ts'])
  })

  it('leaves what it fetched under the key the query is defined by', async () => {
    const files = numbered(2)
    const { client } = warmer(files)

    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    for (const one of files) {
      expect(client.getQueryData(fileBlobsOptions(REF, one).queryKey)).toEqual(ANSWER)
    }
  })

  it('does not spend a call on a file that is already in the cache', async () => {
    const files = numbered(6)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // A file the reader already opened, or a blob pair another pull request in
    // this repository brought in. `staleTime: Infinity` is what makes the entry
    // an answer and not merely a recent one.
    client.setQueryData(fileBlobsOptions(REF, files[0]).queryKey, ANSWER)

    render(
      <QueryClientProvider client={client}>
        <Warm files={files} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(call).toHaveBeenCalledTimes(5))
    expect(warmed()).not.toContain(files[0].path)
  })

  it('does not warm the same diff again on every poll', async () => {
    // The page re-reads itself every ~30 s and react-query hands back a fresh
    // array each time. The files in it have not moved, and neither should this.
    const { rerender } = warmer(numbered(6))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(6))
    rerender({ files: numbered(6) })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).toHaveBeenCalledTimes(6)
  })

  it('warms nothing until there is a file list to warm', async () => {
    // A pull request whose changes call failed has no files, and this is the one
    // state where doing nothing is the whole of the correct behaviour.
    const { rerender } = warmer([])

    expect(call).not.toHaveBeenCalled()

    rerender({ files: numbered(2) })
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  })

  it('does nothing at all while a diff tab is on screen', async () => {
    // The panels there fetch the same keys as they come into view. Two things
    // warming one diff is not twice as warm — it is 12 calls queued in front of
    // the screenful somebody is reading.
    warmer(numbered(6), false)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).not.toHaveBeenCalled()
  })

  it('stops mid-list when the reader switches to the diff tab', async () => {
    // Held open one file in, so that switching tabs has something to interrupt.
    const release: Array<() => void> = []
    call.mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve(ANSWER))) as Promise<FileBlobsResult>,
    )

    const { rerender } = warmer(numbered(6))
    expect(call).toHaveBeenCalledTimes(1)

    rerender({ files: numbered(6), enabled: false })
    release[0]()

    // The first file finishes — the call was already out and its answer is worth
    // keeping — and the loop then finds that nobody is waiting on the rest.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).toHaveBeenCalledTimes(1)
  })
})
