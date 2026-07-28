import type {
  Comment,
  CommentDelete,
  CommentEdit,
  NewReply,
  NewThread,
  StatusChange,
} from '@/lib/comment-contract'

// The seam between the conversation on screen and the four writes behind it.
//
// T-024 owns the writes; T-025 and T-026 own what asks for them. One object
// passed down, rather than five callbacks threaded through `FileDiffPanel` and
// `DiffView` — neither of those has any business knowing what a `StatusChange`
// is, and both would have to grow a prop every time the conversation learns a
// new verb.
//
// **Every handler is optional, and optional means "not offered".** A thread with
// no `onReply` renders with no reply box, the same way `FileDiffPanel` takes the
// checkbox away when nobody is keeping the viewed flag. That is what lets the
// diff render a conversation read-only — which is exactly what it does while the
// server layer is somebody else's branch.
//
// **Every handler returns a promise, and rejection is the error message.** This
// is the whole of "a failed submit keeps the text": the composer awaits, and a
// rejection leaves the paragraph where it was with the reason next to it. A
// void callback could not do that without a second prop to report failure
// through, and `useViewedFiles`' "nothing on error" is the wrong trade here —
// a viewed tick that silently fails costs a tick, a reply that silently fails
// costs someone's paragraph.

export interface ThreadActions {
  /**
   * `pr.viewerId`. Edit and delete are offered on this person's comments only,
   * and refused again on the server — a hidden button is not a rule (T-024).
   */
  readonly viewerId: string | null
  readonly onReply?: (input: NewReply) => Promise<void>
  /**
   * Never called as a side effect of a reply. Replying to a done thread must not
   * silently reactivate it, so reopening is its own visible action and the two
   * cannot be combined by accident.
   */
  readonly onStatusChange?: (input: StatusChange) => Promise<void>
  readonly onEdit?: (input: CommentEdit) => Promise<void>
  readonly onDelete?: (input: CommentDelete) => Promise<void>
  /**
   * A new thread on the file rather than on a line — see `FileThreadList`. A
   * line-anchored new thread would need a draft row in the row model, and
   * `DiffRow` took its one permitted addition this round.
   */
  readonly onNewThread?: (input: NewThread) => Promise<void>
}

/**
 * A comment this person wrote and has not already deleted.
 *
 * The deleted half matters: ADO soft-deletes, so a tombstone still carries its
 * author, and offering "edit" on a comment whose `content` is `null` would be
 * offering to edit nothing.
 */
export function isOwn(comment: Comment, viewerId: string | null): boolean {
  return viewerId !== null && !comment.isDeleted && comment.author.id === viewerId
}
