import { useState } from 'react'

import { Composer } from './composer'
import { isMine, isOwn } from './thread-actions'
import { Avatar } from '@/components/avatar'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { age } from '@/components/pr-list'
import { cn } from '@/lib/utils'

import type { Comment } from '@/lib/comment-contract'
import type { ThreadActions } from './thread-actions'

// One comment. Author, when, body, and — on your own — edit and delete.
//
// **Drawn as a conversation: your words on the right, everybody else's on the
// left.** The alternative, and what this was, is a flat stack where the only clue
// to who is talking is a name in 11px grey above each body — which is fine for
// the 53 of 56 threads that have one comment and useless for the back-and-forth
// where it matters. Side is the cheapest possible answer to "who said that", and
// it is free: no ink, no chrome, nothing to read.
//
// The image is the avatar now, where ADO has one. T-030 measured that a comment
// author's `imageUrl` is the `MemberAvatars` form on 42 of 42 — the form that
// answers 200 with no auth header at all — so it loads straight from the browser
// with no proxy and no credential. It is still `Avatar` and not an `<img>`,
// because a reviewer's `imageUrl` is the *other* form and rendering either on
// trust is how you get a broken glyph; see `avatar.tsx`.
//
// Two things this still does not render. **No like control**: `usersLiked` was
// present on 59 of 59 sampled comments and non-empty on none of them, and the
// `POST .../likes` route has never been authorised against a real person's
// comment — reading likes is proven, writing one is not, so nothing here writes
// one. **No @mention picker**: T-022 declined to probe `graph/subjectquery`, so
// there is no identity search to build one on. Mentions already *written* are
// resolved and drawn; see `markdown.tsx`.

/**
 * A soft-deleted comment.
 *
 * A tombstone rather than a gap, because 3 of the 56 sampled threads had replies
 * and 7 of 59 comments were deleted: dropping a deleted parent orphans whatever
 * was said under it. ADO removes the `content` key entirely rather than emptying
 * it, so there is nothing to show but the fact.
 */
function Tombstone({ comment }: { comment: Comment }) {
  return (
    <p className="text-muted-foreground text-xs italic">
      {comment.author.displayName} deleted this comment.
    </p>
  )
}

/** `edited` when the body changed after it was posted, and nothing when it did not. */
function edited(comment: Comment): boolean {
  return (
    comment.lastContentUpdatedDate !== null &&
    comment.lastContentUpdatedDate !== comment.publishedDate
  )
}

export function CommentView({
  comment,
  threadId,
  actions,
}: {
  comment: Comment
  /** Every write is addressed by thread and comment; the comment does not carry it. */
  threadId: number
  actions?: ThreadActions
}) {
  const [editing, setEditing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Two questions, not one. `mine` decides which side of the thread this is drawn
  // on and ignores deletion; `own` decides what can be done to it and does not.
  // A read-only render — the diff before the write layer is wired, `actions`
  // absent — has no viewer, so every comment falls to the left. That is right:
  // with nobody logged in there is no "mine" to be on the other side of.
  const mine = actions !== undefined && isMine(comment, actions.viewerId)
  const own = actions !== undefined && isOwn(comment, actions.viewerId)
  const onEdit = own ? actions?.onEdit : undefined
  const onDelete = own ? actions?.onDelete : undefined

  if (editing && onEdit !== undefined) {
    return (
      <div className="py-1">
        <Composer
          label={`Edit comment by ${comment.author.displayName}`}
          initial={comment.content ?? ''}
          submitLabel="Save"
          autoFocus
          onSubmit={async (content) => {
            await onEdit({ threadId, commentId: comment.id, content })
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    // `items-start`, so the blob sits beside the first line of a long body rather
    // than halfway down it, and `flex-row-reverse` — not `justify-end` — because
    // reversing puts the avatar on the outside edge on both sides, which is what
    // makes the two columns mirror instead of both leaning left.
    <div className={cn('flex items-start gap-2 py-1', mine && 'flex-row-reverse')}>
      {/* `mt-0.5` against the header's 16px line box: a 20px circle on a text
          baseline hangs, the same problem `ReviewerRow` fixes with `items-center`.
          Sized here rather than inside `Avatar`, so the box exists before the
          image does and a face arriving late moves nothing. */}
      <Avatar
        href={comment.author.imageUrl}
        name={comment.author.displayName}
        className="mt-0.5 size-5"
      />

      {/* Capped rather than full width, or a one-word reply would draw a bubble
          across the whole card and the sides would stop reading as sides. 85%
          leaves the other column's avatar visible at the far edge, which is the
          cue that there *is* another column. */}
      <div className="flex min-w-0 max-w-[85%] flex-col gap-0.5">
        <div
          className={cn(
            'text-muted-foreground flex items-baseline gap-2 text-xs',
            mine && 'flex-row-reverse',
          )}
        >
          <span className="text-foreground font-medium">{comment.author.displayName}</span>
          <span title={comment.publishedDate}>{age(comment.publishedDate)}</span>
          {edited(comment) ? <span>edited</span> : null}
          {comment.likedBy.length === 0 ? null : (
            // Read-only, and a count rather than a control for the reason above.
            <span title={comment.likedBy.map((person) => person.displayName).join(', ')}>
              {comment.likedBy.length} liked
            </span>
          )}
          {onEdit === undefined && onDelete === undefined ? null : (
            // No `ml-auto` any more. This column is content-width, so there is no
            // slack left to push the buttons into — and these only ever render on
            // your own comment, which is the reversed row, where `ml-auto` would
            // have thrown them to the far left of it.
            <span className="flex items-baseline gap-1">
              {onEdit === undefined ? null : (
                <Button variant="ghost" size="xs" onPress={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {onDelete === undefined ? null : (
                <Button
                  variant="ghost"
                  size="xs"
                  onPress={() => {
                    setFailure(null)
                    onDelete({ threadId, commentId: comment.id }).catch((cause: unknown) => {
                      // Said out loud rather than swallowed. A delete that appears
                      // to work and did not is a comment somebody thinks they took
                      // back.
                      setFailure(
                        cause instanceof Error
                          ? cause.message
                          : 'Azure DevOps did not delete that comment.',
                      )
                    })
                  }}
                >
                  Delete
                </Button>
              )}
            </span>
          )}
        </div>

        {/* The bubble, and it is a fill with no outline. A 1.5px pen around this
            would be a box inside the card's own 1.5px box inside the diff — three
            nested rectangles for one sentence. Tone carries it instead: the teal
            wash this system already uses for "yours / the one you are on" against
            the sunken sheet everybody else gets.

            `bg-paper-1` and not `bg-muted`, which is the one semantic token
            `.dark` re-points to `--paper-2` — sunken has to stay sunken in both
            themes, the same rule `shell()` follows a file over. */}
        <div className={cn('rounded-lg px-2 py-1', mine ? 'bg-accent' : 'bg-paper-1')}>
          {comment.content === null ? (
            <Tombstone comment={comment} />
          ) : (
            // The same renderer the description uses, so raw HTML in somebody
            // else's comment is escaped rather than parsed. `mentions` is what
            // turns the `@<GUID>` ADO stores into a name. See `markdown.tsx`.
            <Markdown mentions={comment.mentions}>{comment.content}</Markdown>
          )}
        </div>

        {failure === null ? null : (
          <p role="alert" className="text-destructive text-xs">
            {failure}
          </p>
        )}
      </div>
    </div>
  )
}
