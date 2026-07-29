import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChangedFileDiff } from './changed-file'
import { useWarmDiff } from '@/lib/blob-query'
import { fileAnchor } from '@/lib/file-anchor'

import type { ReactElement } from 'react'
import type { FileBlobs } from '@/lib/diff-contract'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// The seam between the four phase-3 pieces, tested with three of them real. The
// blob call is mocked because it is the network; the diff, the row model and
// the view are the actual ones, because a test that mocked those would only be
// checking that props travel.
vi.mock('@/server/blob-fn', () => ({ fileBlobsQuery: vi.fn() }))
vi.mock('@/lib/highlight/shared', () => ({
  sharedHighlighter: () => ({ highlight: async () => [], dispose: () => {} }),
}))

const { fileBlobsQuery } = await import('@/server/blob-fn')
const call = vi.mocked(fileBlobsQuery)

/**
 * Whether the stubbed observer says its target is on screen.
 *
 * `true` for most of this file, because the list expands every panel from the
 * start and a panel that is being read is a panel that fetches. The two tests
 * about *not* fetching set it false — which is also jsdom's own answer, since it
 * implements no `IntersectionObserver` at all.
 */
let inView = true

// Same reason as diff-view.test.tsx: virtual-core's `getRect` reads
// `offsetWidth`/`offsetHeight`, and jsdom reports 0 for both.
beforeEach(() => {
  call.mockReset()
  inView = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // Synchronous where the real one is not, which is the point: `observe` is
  // called from an effect, so the panel knows on its first commit whether it is
  // being looked at and the test needs no extra tick to find out.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly notify: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (!inView) return
        this.notify(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )
  for (const [property, value] of [
    ['offsetHeight', 800],
    ['offsetWidth', 1000],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The three GUIDs the route addresses the page by, shared with the warmer below. */
const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const FILE: ChangedFile = {
  path: '/src/log.ts',
  changeType: ['edit'],
  originalPath: null,
  objectId: 'a'.repeat(40),
  originalObjectId: 'b'.repeat(40),
}

const BLOBS: FileBlobs = {
  path: FILE.path,
  before: { kind: 'text', lines: ['keep', 'was here'], bytes: 14, noFinalNewline: false },
  after: { kind: 'text', lines: ['keep', 'is here'], bytes: 13, noFinalNewline: false },
  renamedOnly: false,
}

function answer(blobs: FileBlobs | null, error: string | null = null) {
  return { blobs, error, connected: true, rateLimit: null }
}

function draw(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function panel(props: Partial<Parameters<typeof ChangedFileDiff>[0]> = {}) {
  return (
    <ChangedFileDiff
      projectId={REF.projectId}
      repositoryId={REF.repositoryId}
      id={REF.id}
      file={FILE}
      layout="unified"
      {...props}
    />
  )
}

const header = () => screen.getByRole('button', { name: /log\.ts/ })

describe('ChangedFileDiff', () => {
  it('is open from the start but fetches nothing until it is looked at', async () => {
    // Both halves of the same bargain. Files are expanded so that scrolling the
    // list reads like a diff instead of like a directory, and the bytes are still
    // deferred, because a 294-file pull request expanded eagerly is 588 ADO calls
    // spent before anyone has read a line.
    inView = false
    draw(panel())

    expect(header()).toHaveAttribute('aria-expanded', 'true')
    expect(call).not.toHaveBeenCalled()

    // The header is the other trigger, and on a file already scrolled past and
    // shut it is the only one left.
    await userEvent.click(header())
    await userEvent.click(header())

    expect(call).toHaveBeenCalledTimes(1)
  })

  it('can be found by the file tree, which jumps by id rather than by ref', () => {
    inView = false
    const { container } = draw(panel())

    expect(container.querySelector(`#${fileAnchor(FILE.path)}`)).not.toBeNull()
  })

  it('fetches once when it comes into view, and shows the diff it came back with', async () => {
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith({
      data: {
        projectId: '11111111-1111-1111-1111-111111111111',
        repositoryId: '22222222-2222-2222-2222-222222222222',
        id: 24698,
        path: FILE.path,
        objectId: FILE.objectId,
        originalObjectId: FILE.originalObjectId,
      },
    })
  })

  it('does not refetch a file that is closed and opened again', async () => {
    // The ticket asks for both halves of this: opening does not refetch what is
    // already here, and closing does not throw away what it cost to get.
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    await userEvent.click(header())
    await userEvent.click(header())

    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('says the file is loading rather than that it is empty', () => {
    // The placeholder blobs are absent on both sides, and `blobNotice` would
    // otherwise call a file nobody has fetched yet "nothing to show".
    call.mockReturnValue(new Promise(() => {}))
    draw(panel())

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByText('Nothing to show for this file.')).toBeNull()
  })

  it('shows what went wrong when the call could not be made', async () => {
    call.mockResolvedValue(answer(null, 'No Azure DevOps token is stored yet.'))
    draw(panel())

    await waitFor(() =>
      expect(screen.getByText('No Azure DevOps token is stored yet.')).toBeVisible(),
    )
    expect(screen.queryByRole('region', { name: FILE.path })).toBeNull()
  })

  it('shows what went wrong when the server function itself threw', async () => {
    call.mockRejectedValue(new Error('fetch failed'))
    draw(panel())

    await waitFor(() => expect(screen.getByText('fetch failed')).toBeVisible())
  })

  it('reprojects an open file when the layout changes, without fetching again', async () => {
    call.mockResolvedValue(answer(BLOBS))
    const { rerender } = draw(panel())

    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(<QueryClientProvider client={client}>{panel({ layout: 'split' })}</QueryClientProvider>)

    // Side by side puts the delete and the add on one row, so the two texts
    // that were on separate rows in unified are now on the same one.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('was here'),
    )
    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
  })

  it('renders a non-text outcome as itself instead of as an empty diff', async () => {
    call.mockResolvedValue(
      answer({ ...BLOBS, before: { kind: 'absent' }, after: { kind: 'binary', bytes: 750 } }),
    )
    draw(panel())

    await waitFor(() =>
      expect(screen.getByText('Binary file. There is nothing to show as text.')).toBeVisible(),
    )
    expect(screen.queryByRole('region', { name: FILE.path })).toBeNull()
  })

  it('renders a rename that moved no bytes as a rename', async () => {
    const renamed: ChangedFile = {
      ...FILE,
      path: '/src/sink.ts',
      changeType: ['rename'],
      originalPath: '/src/drain.ts',
    }
    call.mockResolvedValue(
      answer({
        path: renamed.path,
        before: { kind: 'absent' },
        after: { kind: 'absent' },
        renamedOnly: true,
      }),
    )
    draw(panel({ file: renamed }))

    await waitFor(() =>
      expect(screen.getByText('Renamed. The contents did not change.')).toBeVisible(),
    )
    expect(screen.getByRole('button', { name: /← \/src\/drain\.ts/ })).toBeInTheDocument()
  })

  it('starts shut on a file already marked read', () => {
    // What "expanded by default" has to mean on a page you come back to: the
    // panel's own default is "open unless already read", and the pass you did
    // yesterday should still be out of the way.
    inView = false
    draw(panel({ viewed: true }))

    expect(header()).toHaveAttribute('aria-expanded', 'false')
    expect(call).not.toHaveBeenCalled()
  })

  it('paints a file the page warmed, without asking for it itself', async () => {
    // Both sides of the prefetch in one test, which is the only place they can be
    // held honest: `useWarmDiff` writes, this panel reads, and a key spelled
    // differently in either would look like a warm cache while being two entries
    // and two sets of calls. The panel is never scrolled to and never clicked, so
    // its own query is disabled — whatever it renders, it did not fetch.
    inView = false
    call.mockResolvedValue(answer(BLOBS))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Warm() {
      useWarmDiff(REF, [FILE], true)

      return null
    }

    const warming = render(
      <QueryClientProvider client={client}>
        <Warm />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    // Leaving the page the warmer lives on must not throw the bytes away: that is
    // what `gcTime: Infinity` is for, and it is half of what makes this a warm-up
    // rather than a race.
    warming.unmount()

    render(<QueryClientProvider client={client}>{panel()}</QueryClientProvider>)

    await waitFor(() =>
      expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here'),
    )
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('marks a file viewed without its bytes ever arriving', async () => {
    // Progress has to be recordable from the list, which means the checkbox
    // works on a file whose bytes were never fetched.
    inView = false
    const onViewedChange = vi.fn()
    draw(panel({ onViewedChange }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))

    expect(onViewedChange).toHaveBeenCalledWith(true)
    expect(call).not.toHaveBeenCalled()
  })
})
