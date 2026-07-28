import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChangedFileDiff } from './changed-file'

import type { ReactElement } from 'react'
import type { FileBlobs } from '@/lib/diff-contract'
import type { ChangedFile } from '@/server/pull-request'

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

// Same reason as diff-view.test.tsx: virtual-core's `getRect` reads
// `offsetWidth`/`offsetHeight`, and jsdom reports 0 for both.
beforeEach(() => {
  call.mockReset()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
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
      projectId="11111111-1111-1111-1111-111111111111"
      repositoryId="22222222-2222-2222-2222-222222222222"
      id={24698}
      file={FILE}
      layout="unified"
      {...props}
    />
  )
}

const header = () => screen.getByRole('button', { name: /log\.ts/ })

describe('ChangedFileDiff', () => {
  it('fetches nothing until the file is opened', () => {
    // The reason the panel takes `defaultOpen`. Forty files rendered eagerly is
    // eighty ADO calls spent before anyone said which file they cared about.
    draw(panel())

    expect(call).not.toHaveBeenCalled()
    expect(header()).toHaveAttribute('aria-expanded', 'false')
  })

  it('fetches once when opened, and shows the diff it came back with', async () => {
    call.mockResolvedValue(answer(BLOBS))
    draw(panel())

    await userEvent.click(header())

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

    await userEvent.click(header())
    await waitFor(() => expect(screen.getByRole('region', { name: FILE.path })).toBeInTheDocument())
    await userEvent.click(header())
    await userEvent.click(header())

    expect(screen.getByRole('region', { name: FILE.path })).toHaveTextContent('is here')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('says the file is loading rather than that it is empty', async () => {
    // The placeholder blobs are absent on both sides, and `blobNotice` would
    // otherwise call a file nobody has fetched yet "nothing to show".
    call.mockReturnValue(new Promise(() => {}))
    draw(panel())

    await userEvent.click(header())

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByText('Nothing to show for this file.')).toBeNull()
  })

  it('shows what went wrong when the call could not be made', async () => {
    call.mockResolvedValue(answer(null, 'No Azure DevOps token is stored yet.'))
    draw(panel())

    await userEvent.click(header())

    await waitFor(() =>
      expect(screen.getByText('No Azure DevOps token is stored yet.')).toBeVisible(),
    )
    expect(screen.queryByRole('region', { name: FILE.path })).toBeNull()
  })

  it('shows what went wrong when the server function itself threw', async () => {
    call.mockRejectedValue(new Error('fetch failed'))
    draw(panel())

    await userEvent.click(header())

    await waitFor(() => expect(screen.getByText('fetch failed')).toBeVisible())
  })

  it('reprojects an open file when the layout changes, without fetching again', async () => {
    call.mockResolvedValue(answer(BLOBS))
    const { rerender } = draw(panel())

    await userEvent.click(header())
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

    await userEvent.click(header())

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

    await userEvent.click(screen.getByRole('button', { name: /sink\.ts/ }))

    await waitFor(() =>
      expect(screen.getByText('Renamed. The contents did not change.')).toBeVisible(),
    )
    expect(screen.getByRole('button', { name: /← \/src\/drain\.ts/ })).toBeInTheDocument()
  })

  it('marks a file viewed without having ever opened it', async () => {
    // Progress has to be recordable from the list, which means the checkbox
    // works on a file whose bytes were never fetched.
    const onViewedChange = vi.fn()
    draw(panel({ onViewedChange }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))

    expect(onViewedChange).toHaveBeenCalledWith(true)
    expect(call).not.toHaveBeenCalled()
  })
})
