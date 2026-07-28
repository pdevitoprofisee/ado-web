import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { FileThreadList } from './file-thread-list'

import type { Comment, FileThreads, Thread } from '@/lib/comment-contract'

const comment = (id: number, content: string): Comment => ({
  id,
  parentCommentId: null,
  author: { id: 'writer', displayName: 'Ada Lovelace', uniqueName: null, imageUrl: null },
  content,
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  lastContentUpdatedDate: null,
  isDeleted: false,
  commentType: 'text',
  likedBy: [],
})

const thread = (id: number, body: string, resolution: Thread['resolution'] = 'open'): Thread => ({
  id,
  status: resolution === 'open' ? 'active' : 'fixed',
  resolution,
  kind: 'human',
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments: [comment(id, body)],
  properties: {},
})

const threads = (
  byRightLine: Record<number, readonly Thread[]>,
  unanchored: readonly Thread[] = [],
): FileThreads => ({
  path: '/src/app.ts',
  byRightLine: new Map(Object.entries(byRightLine).map(([line, list]) => [Number(line), list])),
  unanchored,
})

const PATH = '/src/app.ts'

const ITERATION = { firstComparingIteration: 1, secondComparingIteration: 2, changeTrackingId: null }

describe('FileThreadList', () => {
  it('renders the threads no diff row could hold, and says why they are here', () => {
    render(<FileThreadList path={PATH} threads={threads({ 20: [thread(1, 'anchored')] }, [thread(2, 'orphan')])} />)

    expect(screen.getByText('orphan')).toBeInTheDocument()
    expect(screen.getByText(/could not be placed on a line/)).toBeInTheDocument()
    // The anchored one is a row in the diff; showing it twice would read as two
    // comments.
    expect(screen.queryByText('anchored')).not.toBeInTheDocument()
  })

  it('renders every thread when there is no diff for them to sit in', () => {
    // A binary file, a 40 MB bundle, a fetch that lost. A comment on one of those
    // is still a comment somebody needs to read.
    render(<FileThreadList path={PATH} threads={threads({ 20: [thread(1, 'anchored')] }, [thread(2, 'orphan')])} all />)

    expect(screen.getByText('anchored')).toBeInTheDocument()
    expect(screen.getByText('orphan')).toBeInTheDocument()
    expect(screen.queryByText(/could not be placed on a line/)).not.toBeInTheDocument()
  })

  it('hides the done ones on the same flag the row model takes', () => {
    // Or "hide done" would clear the diff and leave the list above it full of
    // resolved threads.
    render(
      <FileThreadList
        path={PATH}
        threads={threads({}, [thread(1, 'still open'), thread(2, 'settled', 'done')])}
        hideDone
      />,
    )

    expect(screen.getByText('still open')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument()
  })

  it('renders nothing at all with no threads and nothing to offer', () => {
    const { container } = render(<FileThreadList path={PATH} threads={null} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('opens a thread on the file, against the iteration being looked at', async () => {
    const onNewThread = vi.fn().mockResolvedValue(undefined)
    render(
      <FileThreadList
        path={PATH}
        threads={threads({})}
        actions={{ viewerId: 'writer', onNewThread }}
        iterationContext={ITERATION}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Comment on this file' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'New comment on /src/app.ts' }),
      'This whole file wants splitting.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    // File-level: `context` names the file and no position. A draft on a *line*
    // would need a second new `DiffRow` kind, which round 4 does not add.
    expect(onNewThread).toHaveBeenCalledWith({
      content: 'This whole file wants splitting.',
      context: {
        filePath: '/src/app.ts',
        rightStart: null,
        rightEnd: null,
        leftStart: null,
        leftEnd: null,
      },
      iterationContext: ITERATION,
      status: 'active',
    })
  })

  it('offers no composer when there is nowhere to send a new thread', () => {
    render(<FileThreadList path={PATH} threads={threads({}, [thread(1, 'read only')])} />)

    expect(screen.getByText('read only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Comment on this file' })).not.toBeInTheDocument()
  })
})
