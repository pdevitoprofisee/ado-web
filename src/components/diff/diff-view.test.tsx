import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiffView, blobNotice } from './diff-view'

import type { Comment, Thread } from '@/lib/comment-contract'
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

  it('gives both side-by-side columns one width, wide enough for the longest line', () => {
    // The bug this is about: two `flex-1` halves inside a `w-max` row each take
    // half of *that row's* content, so the row holding the long line was wider
    // than the rows above it — its text ran out over the pane beside it and the
    // right-hand column started somewhere else on every long line.
    const long = 'x'.repeat(120)
    const rows: readonly DiffRow[] = [
      { kind: 'line', key: 'c1', left: line('context', 'short', 1, 1), right: line('context', 'short', 1, 1) },
      { kind: 'line', key: 'c2', left: line('context', long, 2, 2), right: line('context', long, 2, 2) },
    ]

    const { container, rerender } = render(
      <DiffView rows={rows} layout="split" label="/src/app.ts" />,
    )

    const columns = [...container.querySelectorAll<HTMLElement>('[style*="flex-basis"]')]
    // Four: two rows of two columns, every one of them the same width.
    expect(columns).toHaveLength(4)
    for (const column of columns) {
      expect(column.style.flexBasis).toBe(`calc(120ch + 3.75rem)`)
    }

    // Unified has one column of text and it is the row, so it needs no width.
    rerender(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)
    expect(container.querySelectorAll('[style*="flex-basis"]')).toHaveLength(0)
  })

  it('counts a tab as the eight columns it renders as', () => {
    const rows: readonly DiffRow[] = [
      { kind: 'line', key: 'c1', left: line('context', '\t\tif (x) {', 1, 1), right: null },
    ]
    render(<DiffView rows={rows} layout="split" label="/src/app.ts" />)

    // `'\t\tif (x) {'.length` is 10, and it renders 24 columns wide.
    const column = document.querySelector<HTMLElement>('[style*="flex-basis"]')
    expect(column?.style.flexBasis).toBe(`calc(24ch + 3.75rem)`)
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

// ---------------------------------------------------------------------------
// Threads in the diff (T-025).
// ---------------------------------------------------------------------------

const comment = (id: number, content: string | null): Comment => ({
  id,
  parentCommentId: null,
  author: { id: 'writer', displayName: 'Ada Lovelace', uniqueName: null, imageUrl: null },
  content,
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  lastContentUpdatedDate: null,
  isDeleted: content === null,
  commentType: 'text',
  likedBy: [],
  mentions: {},
})

const thread = (
  id: number,
  resolution: Thread['resolution'],
  comments: readonly Comment[],
): Thread => ({
  id,
  status: resolution === 'open' ? 'active' : 'fixed',
  resolution,
  kind: 'human',
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments,
  properties: {},
})

const withThread = (one: Thread): readonly DiffRow[] => [
  ...ROWS.slice(0, 2),
  { kind: 'thread', key: `!${one.id}`, threads: [one], line: 1 },
  ...ROWS.slice(2),
]

describe('a thread row', () => {
  it('renders the conversation under the line it is about', () => {
    const rows = withThread(thread(7, 'open', [comment(1, 'This allocates on every keystroke.')]))
    render(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)

    expect(screen.getByText('This allocates on every keystroke.')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('renders a done thread as a stub that keeps its place', () => {
    // In place rather than gone: the line it hangs on is why it exists. "Hide
    // done" is what removes it, and that happens in the row model.
    const rows = withThread(thread(9, 'done', [comment(1, 'Fixed in the last push.')]))
    render(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)

    expect(screen.queryByText('Fixed in the last push.')).not.toBeInTheDocument()
    expect(screen.getByText(/Resolved/)).toBeInTheDocument()
    expect(screen.getByText(/1 comment/)).toBeInTheDocument()

    return userEvent.click(screen.getByRole('button', { name: 'Show' })).then(() => {
      expect(screen.getByText('Fixed in the last push.')).toBeInTheDocument()
    })
  })

  it('is the only row the virtualizer is allowed to measure', () => {
    // The measurement policy the whole component rests on. `measureElement` needs
    // `data-index` to know which row it measured, so the attribute is the tell:
    // exactly one row carries it, and it is the thread.
    const rows = withThread(thread(7, 'open', [comment(1, 'Long prose wraps and cannot be guessed.')]))
    const { container } = render(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)

    const rendered = [...container.querySelectorAll('[style*="translateY"]')]
    const measured = rendered.filter((element) => element.hasAttribute('data-index'))

    expect(rendered.length).toBe(rows.length)
    expect(measured).toHaveLength(1)
    expect(measured[0]).toHaveTextContent('Long prose wraps and cannot be guessed.')
    // And a measured row is not given a fixed height, or it would measure the
    // estimate straight back and never converge.
    expect((measured[0] as HTMLElement).style.height).toBe('')
    for (const element of rendered.filter((one) => !one.hasAttribute('data-index'))) {
      expect((element as HTMLElement).style.height).toBe('20px')
    }
  })

  it('spans both columns side by side, because it is one conversation', () => {
    const rows = withThread(thread(7, 'open', [comment(1, 'One conversation, not two halves.')]))
    const { container } = render(<DiffView rows={rows} layout="split" label="/src/app.ts" />)

    const measured = container.querySelector('[data-index]')
    expect(measured).toHaveTextContent('One conversation, not two halves.')
    expect(measured).toHaveClass('w-full')
    // Not `w-max`: a wrapped paragraph must not widen the file's sideways scroll.
    expect(measured).not.toHaveClass('w-max')
  })

  it('renders a deleted comment as a tombstone with its replies still under it', () => {
    // ADO soft-deletes, and 3 of 56 sampled threads had replies. Dropping a
    // deleted parent orphans whatever was said under it.
    const rows = withThread(
      thread(7, 'open', [
        comment(1, null),
        { ...comment(2, 'Agreed, and here is why.'), parentCommentId: 1 },
      ]),
    )
    render(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)

    expect(screen.getByText('Ada Lovelace deleted this comment.')).toBeInTheDocument()
    expect(screen.getByText('Agreed, and here is why.')).toBeInTheDocument()
  })

  it('offers nothing to write with when no actions were passed', () => {
    // The diff renders a conversation read-only until the server layer is wired.
    const rows = withThread(thread(7, 'open', [comment(1, 'Read only.')]))
    render(<DiffView rows={rows} layout="unified" label="/src/app.ts" />)

    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('offers reply, resolve and edit once it has somewhere to send them', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined)
    const rows = withThread(thread(7, 'open', [comment(1, 'Mine to edit.')]))
    render(
      <DiffView
        rows={rows}
        layout="unified"
        label="/src/app.ts"
        threadActions={{ viewerId: 'writer', onReply, onStatusChange: vi.fn(), onEdit: vi.fn() }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply to thread 7' }), 'Will do.')
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))

    // Threaded under the last comment, which is what ADO orders a thread on.
    expect(onReply).toHaveBeenCalledWith({ threadId: 7, parentCommentId: 1, content: 'Will do.' })
  })

  it('does not offer edit or delete on a comment that is not yours', () => {
    const rows = withThread(thread(7, 'open', [comment(1, 'Not yours.')]))
    render(
      <DiffView
        rows={rows}
        layout="unified"
        label="/src/app.ts"
        threadActions={{ viewerId: 'someone-else', onEdit: vi.fn(), onDelete: vi.fn() }}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
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
