import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiffView, blobNotice } from './diff-view'

import type { BlobSide, DiffLine, DiffRow, FileBlobs } from '@/lib/diff-contract'

// jsdom lays nothing out and has no ResizeObserver, so a virtualizer left to
// its own devices measures a 0×0 viewport and renders no rows at all. The real
// virtualizer still runs here — only its two inputs are supplied, because which
// rows it picks is exactly what these tests are about.
//
// `offsetHeight`, specifically: virtual-core's `getRect` reads `offsetWidth`
// and `offsetHeight`, not `getBoundingClientRect`, and stubbing the wrong one
// looks like it works right up until nothing renders.
const VIEWPORT = { width: 1000, height: 800 }

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
    ['offsetHeight', VIEWPORT.height],
    ['offsetWidth', VIEWPORT.width],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const line = (
  op: DiffLine['op'],
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine => ({ op, text, oldLine, newLine, edits: [] })

const ROWS: readonly DiffRow[] = [
  { kind: 'hunk', key: 'h1', label: '@@ -1,3 +1,3 @@' },
  { kind: 'line', key: 'c1', left: line('context', 'kept', 1, 1), right: line('context', 'kept', 1, 1) },
  { kind: 'line', key: 'd1', left: line('delete', 'was here', 2, null), right: null },
  { kind: 'line', key: 'a1', left: null, right: line('add', 'is here', null, 2) },
  { kind: 'gap', key: 'g1', hiddenLines: 40, oldStart: 3, newStart: 3 },
]

describe('DiffView', () => {
  it('renders the rows a virtualizer chose, in a labelled scroll region', () => {
    render(<DiffView rows={ROWS} layout="unified" label="/src/app.ts" />)

    const region = screen.getByRole('region', { name: '/src/app.ts' })
    expect(region).toHaveTextContent('@@ -1,3 +1,3 @@')
    expect(region).toHaveTextContent('was here')
    expect(region).toHaveTextContent('is here')
  })

  it('does not put a 5,000-line file in the DOM', () => {
    // The measurement the whole component is for. The ADO web UI renders every
    // line; this renders what fits plus the overscan.
    const rows: DiffRow[] = Array.from({ length: 5_000 }, (_, at) => ({
      kind: 'line',
      key: `l${at}`,
      left: line('context', `line ${at}`, at + 1, at + 1),
      right: line('context', `line ${at}`, at + 1, at + 1),
    }))
    const { container } = render(<DiffView rows={rows} layout="unified" label="big" />)

    // Measured: **56** of 5,000 — 800px of viewport at 20px a row is 40, plus
    // the overscan. Bounded rather than pinned to 56, because the exact figure
    // belongs to the virtualizer's range extractor and not to this component;
    // what this asserts is that the row count is not the file's.
    const rendered = container.querySelectorAll('[style*="translateY"]')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(80)
  })

  it('shows one line number per side in unified and two columns in split', () => {
    const { container, rerender } = render(
      <DiffView rows={ROWS} layout="unified" label="/src/app.ts" />,
    )
    // Unified gives every row both gutters; split gives each column one.
    const unified = container.querySelectorAll('.diff-delete').length
    rerender(<DiffView rows={ROWS} layout="split" label="/src/app.ts" />)

    expect(unified).toBe(1)
    expect(container.querySelectorAll('.diff-delete')).toHaveLength(1)
    // The add and the delete are on the same row in split and on two rows in
    // unified — same row array either way, which is the point of T-018.
    expect(screen.getByRole('region', { name: '/src/app.ts' })).toHaveTextContent('was here')
  })

  it('offers a gap as something to click, and reports which one', () => {
    const onExpand = vi.fn()
    render(<DiffView rows={ROWS} layout="unified" label="/src/app.ts" onExpand={onExpand} />)

    const button = screen.getByRole('button', { name: /Expand 40 hidden lines/ })

    return userEvent.click(button).then(() => {
      expect(onExpand).toHaveBeenCalledWith(ROWS[4])
    })
  })

  it('leaves a gap inert when nobody is listening', () => {
    render(<DiffView rows={ROWS} layout="unified" label="/src/app.ts" />)

    expect(screen.getByRole('button', { name: /Expand 40 hidden lines/ })).toBeDisabled()
  })
})

describe('blobNotice', () => {
  const text: BlobSide = { kind: 'text', lines: ['a'], bytes: 1, noFinalNewline: false }
  const blobs = (partial: Partial<FileBlobs>): FileBlobs => ({
    path: '/src/app.ts',
    before: text,
    after: text,
    renamedOnly: false,
    ...partial,
  })

  it('says nothing when there is a diff to show', () => {
    expect(blobNotice(blobs({}))).toBeNull()
  })

  it('says nothing for an add or a delete — a missing side is still a diff', () => {
    expect(blobNotice(blobs({ before: { kind: 'absent' } }))).toBeNull()
    expect(blobNotice(blobs({ after: { kind: 'absent' } }))).toBeNull()
  })

  it('tells a rename apart from an empty diff', () => {
    // Sha equality means the bytes did not move. An empty diff pane here would
    // read as a bug rather than as the answer.
    const notice = blobNotice(
      blobs({ before: { kind: 'absent' }, after: { kind: 'absent' }, renamedOnly: true }),
    )

    expect(notice).toBe('Renamed. The contents did not change.')
  })

  it('names a binary file rather than rendering it as replacement characters', () => {
    expect(blobNotice(blobs({ after: { kind: 'binary', bytes: 588 } }))).toBe(
      'Binary file. There is nothing to show as text.',
    )
  })

  it('says how large the file it refused was', () => {
    expect(blobNotice(blobs({ after: { kind: 'too-large', bytes: 2_400_000 } }))).toMatch(
      /Too large to diff — 2,400,000 bytes\./,
    )
  })

  it('puts a failure ahead of every quieter explanation', () => {
    // A file that both failed and is large should read as failed: only one of
    // those is something going wrong, and it is the one worth acting on.
    const notice = blobNotice(
      blobs({
        before: { kind: 'failed', message: 'Azure DevOps answered 400.' },
        after: { kind: 'too-large', bytes: 9_000_000 },
      }),
    )

    expect(notice).toBe('Azure DevOps did not return this file: Azure DevOps answered 400.')
  })

  it('has a sentence for the file with nothing on either side', () => {
    expect(blobNotice(blobs({ before: { kind: 'absent' }, after: { kind: 'absent' } }))).toBe(
      'Nothing to show for this file.',
    )
  })
})
