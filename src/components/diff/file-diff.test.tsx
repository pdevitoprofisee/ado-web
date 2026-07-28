import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileDiffPanel } from './file-diff'

import type { DiffRow, FileBlobs, FileDiff } from '@/lib/diff-contract'

// Same reason as diff-view.test.tsx: virtual-core's `getRect` reads
// `offsetWidth`/`offsetHeight`, and jsdom reports 0 for both.
beforeEach(() => {
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

const BLOBS: FileBlobs = {
  path: 'src/server/pull-request.ts',
  before: { kind: 'text', lines: ['was here'], bytes: 9, noFinalNewline: false },
  after: { kind: 'text', lines: ['is here'], bytes: 8, noFinalNewline: false },
  renamedOnly: false,
}

const DIFF: FileDiff = { hunks: [], added: 12, removed: 3, gaveUp: false }

const ROWS: readonly DiffRow[] = [
  { kind: 'hunk', key: 'h1', label: '@@ -1 +1 @@' },
  {
    kind: 'line',
    key: 'a1',
    left: null,
    right: { op: 'add', text: 'is here', oldLine: null, newLine: 1, edits: [] },
  },
]

describe('FileDiffPanel', () => {
  it('opens by default and shows the diff', () => {
    render(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />)

    expect(screen.getByRole('button', { name: /pull-request\.ts/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('region', { name: BLOBS.path })).toHaveTextContent('is here')
  })

  it('mounts no diff at all while collapsed', async () => {
    // The reason the header is a separate component. A 300-file PR that mounted
    // 300 virtualizers on open would not be openable, so a shut file costs a
    // header and nothing else.
    render(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />)

    await userEvent.click(screen.getByRole('button', { name: /pull-request\.ts/ }))

    expect(screen.queryByRole('region', { name: BLOBS.path })).toBeNull()
  })

  it('starts shut for a file already marked viewed', () => {
    render(
      <FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" viewed onViewedChange={vi.fn()} />,
    )

    expect(screen.queryByRole('region', { name: BLOBS.path })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  })

  it('closes the file when it is marked viewed, and reports the change', async () => {
    const onViewedChange = vi.fn()
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
        onViewedChange={onViewedChange}
      />,
    )

    await userEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))

    expect(onViewedChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('region', { name: BLOBS.path })).toBeNull()
  })

  it('lets a viewed file be reopened without marking it unread', async () => {
    // Two different statements — "I have looked at this" and "I am looking at
    // it now". Reopening says only the second.
    const onViewedChange = vi.fn()
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
        viewed
        onViewedChange={onViewedChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /pull-request\.ts/ }))

    expect(screen.getByRole('region', { name: BLOBS.path })).toBeInTheDocument()
    expect(onViewedChange).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  })

  it('has no checkbox when nobody is keeping the flag', () => {
    render(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />)

    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('shows the notice instead of the diff for a file with no text', () => {
    const binary: FileBlobs = { ...BLOBS, after: { kind: 'binary', bytes: 588 } }
    render(<FileDiffPanel blobs={binary} diff={DIFF} rows={[]} layout="unified" />)

    expect(screen.getByText('Binary file. There is nothing to show as text.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: BLOBS.path })).toBeNull()
  })

  it('says so when the diff itself gave up', () => {
    // `gaveUp` is not a blob outcome, so `blobNotice` cannot see it: both sides
    // are perfectly good text and there is still nothing to render.
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={{ ...DIFF, gaveUp: true }}
        rows={[]}
        layout="unified"
      />,
    )

    expect(screen.getByText(/too large or too tangled to diff/)).toBeInTheDocument()
  })

  it('shows where a renamed file came from', () => {
    // `FileBlobs` only knows where the file is now, so without this a rename is
    // a change with nothing on screen to show for it.
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
        originalPath="src/server/pr.ts"
      />,
    )

    expect(screen.getByRole('button', { name: /← src\/server\/pr\.ts/ })).toBeInTheDocument()
  })

  it('says nothing about an origin that is where the file already is', () => {
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
        originalPath={BLOBS.path}
      />,
    )

    expect(screen.queryByText(/←/)).toBeNull()
  })

  it('starts shut when the caller says so, whatever the viewed flag says', () => {
    // The panel that has to fetch its own bytes passes this. Opening is what
    // spends the two ADO calls, so an unread file still starts closed.
    render(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" defaultOpen={false} />)

    expect(screen.queryByRole('region', { name: BLOBS.path })).toBeNull()
  })

  it('tells the caller each time it opens and shuts', async () => {
    const onOpenChange = vi.fn()
    render(
      <FileDiffPanel
        blobs={BLOBS}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
        defaultOpen={false}
        onOpenChange={onOpenChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /pull-request\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: /pull-request\.ts/ }))

    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it('ranks a failure above pending, and pending above the blob notices', () => {
    // The three can all be true at once while a refetch is in flight, and only
    // one of them is worth saying.
    const nothing: FileBlobs = { ...BLOBS, before: { kind: 'absent' }, after: { kind: 'absent' } }
    const { rerender } = render(
      <FileDiffPanel blobs={nothing} diff={DIFF} rows={[]} layout="unified" pending failure="lost" />,
    )
    expect(screen.getByText('lost')).toBeVisible()

    rerender(<FileDiffPanel blobs={nothing} diff={DIFF} rows={[]} layout="unified" pending />)
    expect(screen.getByText('Loading…')).toBeVisible()

    rerender(<FileDiffPanel blobs={nothing} diff={DIFF} rows={[]} layout="unified" />)
    expect(screen.getByText('Nothing to show for this file.')).toBeVisible()
  })

  it('prints the missing-newline marker, and names the side when only one is missing', () => {
    // `noFinalNewline` is a property of a blob and the two blobs can disagree,
    // so there is nowhere in `FileDiff` for it to live — this panel is the
    // lowest thing in the tree that still holds both sides.
    const oneSide: FileBlobs = {
      ...BLOBS,
      after: { kind: 'text', lines: ['is here'], bytes: 7, noFinalNewline: true },
    }
    const { rerender } = render(
      <FileDiffPanel blobs={oneSide} diff={DIFF} rows={ROWS} layout="unified" />,
    )
    expect(screen.getByText('\\ No newline at end of file (after)')).toBeVisible()

    rerender(
      <FileDiffPanel
        blobs={{
          ...oneSide,
          before: { kind: 'text', lines: ['was here'], bytes: 8, noFinalNewline: true },
        }}
        diff={DIFF}
        rows={ROWS}
        layout="unified"
      />,
    )
    expect(screen.getByText('\\ No newline at end of file')).toBeVisible()

    rerender(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />)
    expect(screen.queryByText(/No newline/)).toBeNull()
  })

  it('says a file is one the merge could not resolve', () => {
    const { rerender } = render(
      <FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" conflicted />,
    )
    expect(screen.getByText('conflict')).toBeVisible()

    rerender(<FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />)
    expect(screen.queryByText('conflict')).toBeNull()
  })

  it('counts both directions, and neither when nothing moved', () => {
    const { rerender } = render(
      <FileDiffPanel blobs={BLOBS} diff={DIFF} rows={ROWS} layout="unified" />,
    )
    expect(screen.getByLabelText('12 added, 3 removed')).toBeInTheDocument()

    rerender(
      <FileDiffPanel
        blobs={BLOBS}
        diff={{ ...DIFF, added: 0, removed: 0 }}
        rows={ROWS}
        layout="unified"
      />,
    )
    expect(screen.queryByLabelText(/added/)).toBeNull()
  })
})
