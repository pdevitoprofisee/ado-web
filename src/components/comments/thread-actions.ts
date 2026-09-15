import type {
  Comment,
  CommentDelete,
  CommentEdit,
  LikeChange,
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
  /**
   * A like on any comment, including a stranger's — the one write here that is
   * meant to land on somebody else's words, so there is no ownership test in
   * front of it.
   */
  readonly onLike?: (input: LikeChange) => Promise<void>
}

/**
 * A comment this person wrote — which side of the conversation it is drawn on.
 *
 * Case-insensitive, as `threads.ts`' `sameIdentity` is and for the same measured
 * reason: ADO does not agree with itself about GUID casing between endpoints, so
 * a `===` here would silently draw somebody's own comments as a stranger's on
 * whichever endpoint disagreed with `connectionData`.
 *
 * Deletion is not consulted. Your own tombstone is still yours, and moving it to
 * the other side of the thread when you delete it would say a different person
 * had written it.
 */
export function isMine(comment: Comment, viewerId: string | null): boolean {
  return (
    viewerId !== null &&
    viewerId !== '' &&
    comment.author.id.toLowerCase() === viewerId.toLowerCase()
  )
}

/**
 * A comment this person wrote and has not already deleted.
 *
 * The deleted half matters: ADO soft-deletes, so a tombstone still carries its
 * author, and offering "edit" on a comment whose `content` is `null` would be
 * offering to edit nothing. That is the whole difference from `isMine`, which is
 * about where the comment sits rather than about what can be done to it.
 */
export function isOwn(comment: Comment, viewerId: string | null): boolean {
  return !comment.isDeleted && isMine(comment, viewerId)
}

/**
 * Whether this person's like is already on the comment.
 *
 * ADO sends no "you liked this" flag, only the list of who did, so the answer is
 * a search of `likedBy` — case-insensitively, for `isMine`'s measured reason. A
 * `===` here would draw the button unlit on a comment the viewer had already
 * liked, and the next click would send a `POST` that changes nothing.
 */
export function likedByMe(comment: Comment, viewerId: string | null): boolean {
  return (
    viewerId !== null &&
    viewerId !== '' &&
    comment.likedBy.some((who) => who.id.toLowerCase() === viewerId.toLowerCase())
  )
}
