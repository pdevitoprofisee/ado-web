import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ThreadCard } from './thread-card'

import type { Comment, Thread } from '@/lib/comment-contract'

const comment = (id: number, content: string | null, parentCommentId: number | null = null): Comment => ({
  id,
  parentCommentId,
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

const thread = (partial: Partial<Thread> = {}): Thread => ({
  id: 7,
  status: 'active',
  resolution: 'open',
  kind: 'human',
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments: [comment(1, 'The first thing said.')],
  properties: {},
  ...partial,
})

describe('ThreadCard', () => {
  it('puts each reply under what it replies to', () => {
    // The array is flat and `parentCommentId` is the tree. Only 3 of 56 sampled
    // threads had a second comment and none had a third level, so this flattens
    // rather than nests — but it still has to order.
    const one = thread({
      comments: [
        comment(1, 'root'),
        comment(3, 'reply to the second root', 2),
        comment(2, 'second root'),
      ],
    })
    render(<ThreadCard threads={[one]} />)

    const bodies = [...document.querySelectorAll('p')].map((node) => node.textContent)
    expect(bodies).toEqual(['root', 'second root', 'reply to the second root'])
  })

  it('treats a reply to a comment that is not here as a root, not as a loss', () => {
    const one = thread({ comments: [comment(4, 'orphaned', 999)] })
    render(<ThreadCard threads={[one]} />)

    expect(screen.getByText('orphaned')).toBeInTheDocument()
  })

  it('shows a resolved thread as a stub and opens it where it sits', async () => {
    const one = thread({ resolution: 'done', status: 'wontFix' })
    render(<ThreadCard threads={[one]} />)

    expect(screen.queryByText('The first thing said.')).not.toBeInTheDocument()
    expect(screen.getByText(/Won't fix/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Show' }))

    expect(screen.getByText('The first thing said.')).toBeInTheDocument()
    // Opened, not un-resolved: the status is still what it was.
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
  })

  it('never hides an open thread behind a resolved summary', () => {
    // A line with one of each renders the open one and stubs the other. Folding
    // an unanswered question into a "resolved" line is how it goes unanswered.
    const open = thread({ id: 7, comments: [comment(1, 'Still asking.')] })
    const done = thread({ id: 9, resolution: 'done', comments: [comment(2, 'Was asked.')] })
    render(<ThreadCard threads={[open, done]} />)

    expect(screen.getByText('Still asking.')).toBeInTheDocument()
    expect(screen.queryByText('Was asked.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument()
  })

  it('counts the comments a stub is standing in for', () => {
    const done = thread({
      resolution: 'done',
      comments: [comment(1, 'one'), comment(2, 'two', 1)],
    })
    render(<ThreadCard threads={[done]} />)

    expect(screen.getByText(/2 comments/)).toBeInTheDocument()
  })

  it('offers the three statuses that can be written, and no others', () => {
    render(<ThreadCard threads={[thread()]} actions={{ viewerId: null, onStatusChange: vi.fn() }} />)

    for (const name of ['Resolve', "Won't fix", 'Pending']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    // Readable but not settable: guessing at what someone else meant by these on
    // their own pull request is not this app's business.
    for (const name of ['Closed', 'By design']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('reopens a done thread as its own visible action', async () => {
    const onStatusChange = vi.fn().mockResolvedValue(undefined)
    const done = thread({ resolution: 'done', status: 'fixed' })
    render(<ThreadCard threads={[done]} actions={{ viewerId: null, onStatusChange }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    expect(onStatusChange).toHaveBeenCalledWith({ threadId: 7, status: 'active' })
  })

  it('does not reactivate a done thread just because somebody replied', async () => {
    const onStatusChange = vi.fn().mockResolvedValue(undefined)
    const onReply = vi.fn().mockResolvedValue(undefined)
    const done = thread({ resolution: 'done', status: 'fixed' })
    render(<ThreadCard threads={[done]} actions={{ viewerId: null, onReply, onStatusChange }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply to thread 7' }), 'One more thing.')
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))

    expect(onReply).toHaveBeenCalled()
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  it('leaves the status of a system thread to Azure DevOps', () => {
    // A vote or a policy wrote it, and PATCHing it back does not undo the thing
    // it records. Also the common case: 32 of 56 sampled threads were system.
    const system = thread({ kind: 'system', status: null })
    render(<ThreadCard threads={[system]} actions={{ viewerId: null, onStatusChange: vi.fn() }} />)

    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.getByText('No status')).toBeInTheDocument()
    expect(screen.getByText('system')).toBeInTheDocument()
  })

  it('says out loud when a status change did not take', async () => {
    const onStatusChange = vi.fn().mockRejectedValue(new Error('Azure DevOps answered 409.'))
    render(<ThreadCard threads={[thread()]} actions={{ viewerId: null, onStatusChange }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Azure DevOps answered 409.')
  })

  it('edits a comment of your own in place', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ThreadCard threads={[thread()]} actions={{ viewerId: 'writer', onEdit }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByRole('textbox', { name: 'Edit comment by Ada Lovelace' })
    expect(box).toHaveValue('The first thing said.')

    await userEvent.clear(box)
    await userEvent.type(box, 'Better wording.')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onEdit).toHaveBeenCalledWith({ threadId: 7, commentId: 1, content: 'Better wording.' })
    expect(await screen.findByText('The first thing said.')).toBeInTheDocument()
  })

  it('offers nothing to edit on a comment that is already a tombstone', () => {
    // ADO soft-deletes, so a tombstone still carries its author. Offering to edit
    // a comment whose content is `null` would be offering to edit nothing.
    const one = thread({ comments: [comment(1, null)] })
    render(
      <ThreadCard threads={[one]} actions={{ viewerId: 'writer', onEdit: vi.fn(), onDelete: vi.fn() }} />,
    )

    expect(screen.getByText('Ada Lovelace deleted this comment.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('deletes a comment of your own, and says so when it cannot', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('Azure DevOps answered 403.'))
    render(<ThreadCard threads={[thread()]} actions={{ viewerId: 'writer', onDelete }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(onDelete).toHaveBeenCalledWith({ threadId: 7, commentId: 1 })
    expect(await screen.findByRole('alert')).toHaveTextContent('Azure DevOps answered 403.')
  })

  it('reads likes as a count when there is nobody to like as', () => {
    const liked = thread({
      comments: [
        {
          ...comment(1, 'Nice.'),
          likedBy: [{ id: 'x', displayName: 'Grace Hopper', uniqueName: null, imageUrl: null }],
        },
      ],
    })
    render(<ThreadCard threads={[liked]} actions={{ viewerId: 'writer', onReply: vi.fn() }} />)

    expect(screen.getByText('1 liked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /like/i })).not.toBeInTheDocument()
  })

  it('likes a comment, and asks for the state rather than for a toggle', async () => {
    const onLike = vi.fn().mockResolvedValue(undefined)
    render(<ThreadCard threads={[thread()]} actions={{ viewerId: 'reader', onLike }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Like' }))

    expect(onLike).toHaveBeenCalledWith({ threadId: 7, commentId: 1, liked: true })
  })

  it('takes a like back off, matching the viewer’s id however ADO cased it', async () => {
    // `sameIdentity`'s reason: ADO does not agree with itself about GUID casing
    // between endpoints, and a `===` here would draw the button unlit on a
    // comment this person had already liked.
    const onLike = vi.fn().mockResolvedValue(undefined)
    const liked = thread({
      comments: [
        {
          ...comment(1, 'Nice.'),
          likedBy: [{ id: 'READER', displayName: 'Grace Hopper', uniqueName: null, imageUrl: null }],
        },
      ],
    })
    render(<ThreadCard threads={[liked]} actions={{ viewerId: 'reader', onLike }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Unlike' }))

    expect(onLike).toHaveBeenCalledWith({ threadId: 7, commentId: 1, liked: false })
  })

  it('says when a like did not land, and offers no like on a tombstone', async () => {
    const onLike = vi.fn().mockRejectedValue(new Error('Azure DevOps answered 403.'))
    const one = thread({ comments: [comment(1, 'Nice.'), comment(2, null)] })
    render(<ThreadCard threads={[one]} actions={{ viewerId: 'reader', onLike }} />)

    // One button, not two: the deleted comment's words are gone, so there is
    // nothing there to like.
    const buttons = screen.getAllByRole('button', { name: 'Like' })
    expect(buttons).toHaveLength(1)

    await userEvent.click(buttons[0])

    expect(await screen.findByRole('alert')).toHaveTextContent('Azure DevOps answered 403.')
  })

  it('marks a comment that was edited after it was posted', () => {
    const one = thread({
      comments: [{ ...comment(1, 'Reworded.'), lastContentUpdatedDate: '2026-07-02T00:00:00Z' }],
    })
    render(<ThreadCard threads={[one]} />)

    expect(screen.getByText('edited')).toBeInTheDocument()
  })

  it('draws the author’s face, which on a comment is the URL a browser can load', () => {
    // 42 of 42 comment authors carried the `MemberAvatars` form, which answers 200
    // with no auth header at all — so this is the one of ADO's two avatar URLs
    // that goes straight into an `<img src>`.
    const one = thread({
      comments: [{ ...comment(1, 'Hello.'), author: { id: 'writer', displayName: 'Ada Lovelace', uniqueName: null, imageUrl: 'https://dev.azure.com/profisee/_apis/GraphProfile/MemberAvatars/aad.OWY0NTIwYTMtMzc' } }],
    })
    const { container } = render(<ThreadCard threads={[one]} />)

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://dev.azure.com/profisee/_apis/GraphProfile/MemberAvatars/aad.OWY0NTIwYTMtMzc',
    )
    // Underneath it either way, so a slow one does not arrive into a blank circle.
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('refuses a URL that redirects to a sign-in page, and draws the monogram instead', () => {
    const one = thread({
      comments: [{ ...comment(1, 'Hello.'), author: { id: 'writer', displayName: 'Ada Lovelace', uniqueName: null, imageUrl: 'https://dev.azure.com/profisee/_api/_common/identityImage?id=writer' } }],
    })
    const { container } = render(<ThreadCard threads={[one]} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('draws your own comments on the other side of the thread from everyone else’s', () => {
    // The whole of "read it as a conversation": nothing but which side it is on
    // says who is talking, so this is the test that the side is decided at all.
    const both = thread({
      comments: [
        comment(1, 'Theirs.'),
        {
          ...comment(2, 'Mine.'),
          // Upper case where the viewer id below is lower. ADO does not agree with
          // itself about GUID casing between endpoints, so a `===` here would put
          // every one of your own comments on the stranger's side.
          author: { id: 'AAAA-1111', displayName: 'Paul DeVito', uniqueName: null, imageUrl: null },
        },
      ],
    })
    render(<ThreadCard threads={[both]} actions={{ viewerId: 'aaaa-1111' }} />)

    expect(screen.getByText('Mine.').closest('.flex-row-reverse')).not.toBeNull()
    expect(screen.getByText('Theirs.').closest('.flex-row-reverse')).toBeNull()
  })

  it('leaves every comment on one side when there is no viewer to have a side', () => {
    // A read-only render — the diff before the write layer is wired. With nobody
    // signed in there is no "mine", and guessing one would be worse than a stack.
    const both = thread({ comments: [comment(1, 'One.'), comment(2, 'Two.')] })
    render(<ThreadCard threads={[both]} />)

    for (const body of ['One.', 'Two.']) {
      expect(screen.getByText(body).closest('.flex-row-reverse')).toBeNull()
    }
  })

  it('renders a mention as the person it names, and an unresolved one as ADO wrote it', () => {
    const guid = 'fbfd3dd4-4d56-641d-9005-ae776a2d856c'
    const missing = '11111111-2222-3333-4444-555555555555'
    const one = thread({
      comments: [
        {
          ...comment(1, `cc @<${guid.toUpperCase()}> and @<${missing}>`),
          // Keyed lower case, because the body writes the id upper case and
          // `_apis/identities` answers lower.
          mentions: { [guid]: 'Patrick Mize' },
        },
      ],
    })
    const { container } = render(<ThreadCard threads={[one]} />)

    // The chip is its own element, so the name can be styled; the sentence around
    // it is untouched. No name for the second id means the lookup did not answer,
    // and a chip is a claim about who somebody is — so that one stays the
    // characters the comment actually contains rather than becoming a blank tag.
    expect(screen.getByText('@Patrick Mize')).toBeInTheDocument()
    expect(container.querySelector('p')?.textContent).toBe(
      `cc @Patrick Mize and @<${missing}>`,
    )
  })
})
