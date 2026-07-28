import { useState } from 'react'

import { Composer } from './composer'
import { isOwn } from './thread-actions'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { age } from '@/components/pr-list'

import type { Comment } from '@/lib/comment-contract'
import type { ThreadActions } from './thread-actions'

// One comment. Author, when, body, and — on your own — edit and delete.
//
// Three things this deliberately does not render. **No avatar**: `imageUrl`
// points at ADO and needs the credential the browser does not have, so the image
// would be a broken one on every comment. **No like control**: `usersLiked` was
// present on 59 of 59 sampled comments and non-empty on none of them, and the
// `POST .../likes` route has never been authorised against a real person's
// comment — reading likes is proven, writing one is not, so nothing here writes
// one. **No @mention picker**: T-022 declined to probe `graph/subjectquery`, so
// there is no identity search to build one on.

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
    <div className="py-1">
      <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
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
          <span className="ml-auto flex items-baseline gap-1">
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

      {comment.content === null ? (
        <Tombstone comment={comment} />
      ) : (
        // The same renderer the description uses, so raw HTML in somebody else's
        // comment is escaped rather than parsed. See `markdown.tsx`.
        <Markdown>{comment.content}</Markdown>
      )}

      {failure === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {failure}
        </p>
      )}
    </div>
  )
}
