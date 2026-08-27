import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { AdoError } from './ado-client'
import { resolveIdentity } from './inbox'
import { pullRequestRef } from './pull-request-fn'
import {
  createThread,
  deleteComment,
  editComment,
  guardOwnComment,
  isSettableStatus,
  loadThreads,
  postReply,
  setCommentLike,
  setThreadStatus,
} from './threads'

import type { AdoClient, RateLimit } from './ado-client'
import type { PullRequestRef } from './pull-request'
import type {
  Comment,
  FilePosition,
  IterationContext,
  SettableThreadStatus,
  Thread,
  ThreadContext,
  ThreadList,
} from '../lib/comment-contract'

// The conversation's server functions: one read and the writes behind it.
//
// Every input is validated by shape for the reason `pull-request-fn.ts` spells
// out — three of these values are interpolated into an Azure DevOps path — and
// the writes add a second reason on top of it. A read with a wrong id answers
// 404 and the reviewer retries. A write with a wrong id **changes something**,
// and there is no undo button on someone else's pull request. So a thread id
// that is not a positive integer is refused here rather than sent.
//
// Each write is its own function rather than one with a verb parameter, because
// the map is explicit that replying must never be able to change a status: a
// single `mutateThread({ content?, status? })` is exactly the shape in which a
// reply silently reopens a thread somebody had marked fixed. Keeping them apart
// makes that mistake unrepresentable rather than merely discouraged.

/**
 * What the conversation panel renders from.
 *
 * `notFound` separate from `error` for `pull-request-fn.ts`'s reason, and
 * `threads: null` with `connected: true` is the case the map's "a failing threads
 * call costs the conversation and nothing else" is about — the diff beside it
 * still reviews.
 */
export interface ThreadsResult {
  readonly threads: ThreadList | null
  /** `null` when the threads loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly notFound: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * What every write answers with.
 *
 * `ok` and not "no error means it worked": a write that was refused before it was
 * sent (not connected, not your comment) and a write Azure DevOps rejected are
 * both failures the optimistic row has to roll back from, and the caller should
 * not have to infer that from which fields are null.
 */
export interface WriteResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * The server's copy of the comment, so the optimistic row can be replaced rather
 * than merely confirmed: the client invents a comment with no id, and only ADO
 * knows the real one. `null` on failure, and also on the unmeasured case where a
 * write answers 200 with no body.
 */
export interface CommentResult extends WriteResult {
  readonly comment: Comment | null
}

/** The whole thread back, because a status change also moves `lastUpdatedDate`. */
export interface ThreadResult extends WriteResult {
  readonly thread: Thread | null
}

/** Every write input addresses a pull request as well as a thread inside it. */
/**
 * A new thread. `NewThread` minus its `status`, which is always `active` and so is
 * the server's to assert rather than the client's to send.
 */
export interface NewThreadRequest extends PullRequestRef {
  readonly content: string
  readonly context: ThreadContext | null
  readonly iterationContext: IterationContext | null
}

export interface ReplyRequest extends PullRequestRef {
  readonly threadId: number
  readonly parentCommentId: number
  readonly content: string
}

export interface StatusRequest extends PullRequestRef {
  readonly threadId: number
  readonly status: SettableThreadStatus | 'active'
}

export interface EditRequest extends PullRequestRef {
  readonly threadId: number
  readonly commentId: number
  readonly content: string
}

export interface DeleteRequest extends PullRequestRef {
  readonly threadId: number
  readonly commentId: number
}

export interface LikeRequest extends PullRequestRef {
  readonly threadId: number
  readonly commentId: number
  /** The state asked for, not a toggle. See `LikeChange`. */
  readonly liked: boolean
}

/**
 * ADO's ids are positive integers and nothing else. Rejected rather than
 * coerced: `Number('12abc')` is `NaN` and `NaN` in a path is the literal string
 * "NaN", which would send a write at a URL that means nothing.
 */
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer.`)
  }

  return value as number
}

/**
 * Empty is refused, and trimming is not this layer's business.
 *
 * A blank comment is a mistake in every case — a stray Enter in the composer —
 * and ADO accepts one, so it has to be caught here or it becomes a comment
 * nobody can read and only the author can delete. Whitespace inside is left
 * alone: markdown is whitespace-sensitive and `SupportsMarkdown` is on.
 */
function content(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('content must not be empty.')
  }

  return value
}

/**
 * One end of an anchor.
 *
 * Both fields are positive integers, and a line of 0 is refused rather than
 * coerced: ADO answers 200 to an anchor on line 0 and puts the thread nowhere a
 * reader will find it, which is the failure mode a validator is for.
 */
function anchor(value: unknown, field: string): FilePosition | null {
  if (value === null || value === undefined) return null

  const raw = value as Record<string, unknown>

  return {
    line: positive(raw.line, `${field}.line`),
    // ADO's own default, and what `position` reads a missing one back as.
    offset: raw.offset === undefined || raw.offset === null ? 1 : positive(raw.offset, `${field}.offset`),
  }
}

/**
 * Where a new thread hangs, or `null` for the pull request itself.
 *
 * `filePath` is checked for being a non-empty string and nothing more. Unlike the
 * three ids, it is **not** interpolated into a URL — it travels in the body — so
 * the traversal argument does not apply; what does apply is that ADO accepts a
 * path that matches no file in the pull request and files the thread against it
 * anyway, and no amount of validation here can tell the difference. The caller
 * passes a path it read out of the change list.
 */
function threadContext(value: unknown): ThreadContext | null {
  if (value === null || value === undefined) return null

  const raw = value as Record<string, unknown>
  if (typeof raw.filePath !== 'string' || raw.filePath === '') {
    throw new Error('context.filePath must be a non-empty string.')
  }

  return {
    filePath: raw.filePath,
    rightStart: anchor(raw.rightStart, 'context.rightStart'),
    rightEnd: anchor(raw.rightEnd, 'context.rightEnd'),
    leftStart: anchor(raw.leftStart, 'context.leftStart'),
    leftEnd: anchor(raw.leftEnd, 'context.leftEnd'),
  }
}

/**
 * Which two iterations the thread is written against.
 *
 * `firstComparingIteration` may be 0 — that is the merge base, which is what the
 * combined view compares against — so this is the one place a non-negative check
 * is right and `positive` is wrong.
 */
function iterationContext(value: unknown): IterationContext | null {
  if (value === null || value === undefined) return null

  const raw = value as Record<string, unknown>
  const iteration = (field: string, of: unknown): number => {
    if (!Number.isSafeInteger(of) || (of as number) < 0) {
      throw new Error(`iterationContext.${field} must be a non-negative integer.`)
    }

    return of as number
  }

  return {
    firstComparingIteration: iteration('firstComparingIteration', raw.firstComparingIteration),
    secondComparingIteration: iteration('secondComparingIteration', raw.secondComparingIteration),
    changeTrackingId:
      raw.changeTrackingId === undefined || raw.changeTrackingId === null
        ? null
        : positive(raw.changeTrackingId, 'iterationContext.changeTrackingId'),
  }
}

export function newThreadRequest(input: unknown): NewThreadRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    ...ref,
    content: content(raw.content),
    context: threadContext(raw.context),
    iterationContext: iterationContext(raw.iterationContext),
  }
}

export function replyRequest(input: unknown): ReplyRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    ...ref,
    threadId: positive(raw.threadId, 'threadId'),
    // Required, not defaulted to the thread's first comment. ADO accepts a
    // second parentless comment on a thread and the conversation renders wrong
    // from then on, so guessing here would produce a valid request and a broken
    // thread.
    parentCommentId: positive(raw.parentCommentId, 'parentCommentId'),
    content: content(raw.content),
  }
}

/**
 * Three of the seven statuses are writable, plus reopening.
 *
 * `closed`, `byDesign` and `unknown` are read-only for a reason worth naming:
 * `closed` is what ADO writes when the pull request completes, `byDesign` is set
 * from the web UI's own menu, and `unknown` is not a state anybody chose. The
 * message lists them so a caller that tries gets told why rather than "invalid".
 */
export function statusRequest(input: unknown): StatusRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (!isSettableStatus(raw.status)) {
    throw new Error(
      'status must be active, fixed, wontFix or pending — closed, byDesign and unknown are read-only.',
    )
  }

  return { ...ref, threadId: positive(raw.threadId, 'threadId'), status: raw.status }
}

export function editRequest(input: unknown): EditRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    ...ref,
    threadId: positive(raw.threadId, 'threadId'),
    commentId: positive(raw.commentId, 'commentId'),
    content: content(raw.content),
  }
}

export function deleteRequest(input: unknown): DeleteRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    ...ref,
    threadId: positive(raw.threadId, 'threadId'),
    commentId: positive(raw.commentId, 'commentId'),
  }
}

/**
 * `liked` is refused unless it is a boolean, and not read as truthy.
 *
 * The two values pick two different HTTP verbs, so a missing field coerced to
 * `false` would send a `DELETE` where the caller meant nothing at all.
 */
export function likeRequest(input: unknown): LikeRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (typeof raw.liked !== 'boolean') {
    throw new Error('liked must be true or false.')
  }

  return {
    ...ref,
    threadId: positive(raw.threadId, 'threadId'),
    commentId: positive(raw.commentId, 'commentId'),
    liked: raw.liked,
  }
}

/** The error rather than `null`, so the message it already carries is the one shown. */
function connectedClient(): AdoClient | NotConnectedError {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return error
    throw error
  }
}

const notConnected = (client: NotConnectedError): WriteResult => ({
  ok: false,
  error: client.message,
  connected: false,
  rateLimit: null,
})

const failure = (client: AdoClient, error: unknown): WriteResult => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  connected: true,
  rateLimit: client.rateLimit(),
})

/**
 * Who the token says is asking — the half of the own-author check that cannot
 * live in `threads.ts`, because resolving it is a value import and that file has
 * to stay importable from the browser bundle.
 *
 * `connectionData`, not the request: a client-supplied `viewerId` is not a check,
 * it is a field the caller fills in. `pull-request.ts` memoises this per client
 * and keeps its map to itself; editing your own comment is rare enough that one
 * extra call is not worth exporting a cache for. Sequential with the guard's own
 * GET rather than `Promise.all`, because two loose requests go past the
 * concurrency cap `client.fanOut` exists to hold.
 */
async function refuseUnlessMine(
  client: AdoClient,
  ref: PullRequestRef,
  threadId: number,
  commentId: number,
): Promise<string | null> {
  const viewer = await resolveIdentity(client)

  return guardOwnComment(client, ref, { threadId, commentId }, viewer.id)
}

export const threadsQuery = createServerFn({ method: 'GET' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<ThreadsResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return {
        threads: null,
        error: client.message,
        connected: false,
        notFound: false,
        rateLimit: null,
      }
    }

    try {
      return {
        threads: await loadThreads(client, data),
        error: null,
        connected: true,
        notFound: false,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        threads: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        // The threads call is the only one that can throw out of `loadThreads` —
        // the statuses call swallows its own failure — so a 404 here means the
        // pull request is not there rather than the conversation being empty.
        notFound: error instanceof AdoError && error.status === 404,
        rateLimit: client.rateLimit(),
      }
    }
  })

/**
 * A thread nobody has started yet.
 *
 * The fifth write. T-024 enumerates four and T-026 needs five — see
 * `createThread` — and it is here rather than folded into `replyToThread` for the
 * same reason the status change is its own function: "answer this thread" and
 * "start a thread about this line" are different acts, and a single function
 * taking an optional `threadId` is the shape in which a reply to thread 7 becomes
 * a brand new thread the moment an id arrives as `undefined`.
 */
export const startThread = createServerFn({ method: 'POST' })
  .validator(newThreadRequest)
  .handler(async ({ data }): Promise<ThreadResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return { ...notConnected(client), thread: null }

    const { content: body, context, iterationContext: iteration, ...ref } = data

    try {
      const thread = await createThread(client, ref, {
        content: body,
        context,
        iterationContext: iteration,
      })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit(), thread }
    } catch (error) {
      return { ...failure(client, error), thread: null }
    }
  })

export const replyToThread = createServerFn({ method: 'POST' })
  .validator(replyRequest)
  .handler(async ({ data }): Promise<CommentResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return { ...notConnected(client), comment: null }

    const { threadId, parentCommentId, content: body, ...ref } = data

    try {
      const comment = await postReply(client, ref, { threadId, parentCommentId, content: body })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit(), comment }
    } catch (error) {
      return { ...failure(client, error), comment: null }
    }
  })

/**
 * A thread's status, and only its status.
 *
 * The reply above cannot reach this and this cannot carry a comment. That is the
 * whole point of there being two functions.
 */
export const changeThreadStatus = createServerFn({ method: 'POST' })
  .validator(statusRequest)
  .handler(async ({ data }): Promise<ThreadResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return { ...notConnected(client), thread: null }

    const { threadId, status, ...ref } = data

    try {
      const thread = await setThreadStatus(client, ref, { threadId, status })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit(), thread }
    } catch (error) {
      return { ...failure(client, error), thread: null }
    }
  })

export const editThreadComment = createServerFn({ method: 'POST' })
  .validator(editRequest)
  .handler(async ({ data }): Promise<CommentResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return { ...notConnected(client), comment: null }

    const { threadId, commentId, content: body, ...ref } = data

    try {
      const refusal = await refuseUnlessMine(client, ref, threadId, commentId)
      if (refusal !== null) {
        const rateLimit = client.rateLimit()

        return { ok: false, error: refusal, connected: true, rateLimit, comment: null }
      }

      const comment = await editComment(client, ref, { threadId, commentId, content: body })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit(), comment }
    } catch (error) {
      return { ...failure(client, error), comment: null }
    }
  })

/**
 * A delete, which ADO makes soft: the comment stays with `isDeleted: true` and no
 * `content`, so there is nothing to hand back and the panel re-reads the thread
 * as a tombstone.
 */
export const deleteThreadComment = createServerFn({ method: 'POST' })
  .validator(deleteRequest)
  .handler(async ({ data }): Promise<WriteResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return notConnected(client)

    const { threadId, commentId, ...ref } = data

    try {
      const refusal = await refuseUnlessMine(client, ref, threadId, commentId)
      if (refusal !== null) {
        return { ok: false, error: refusal, connected: true, rateLimit: client.rateLimit() }
      }

      await deleteComment(client, ref, { threadId, commentId })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit() }
    } catch (error) {
      return failure(client, error)
    }
  })

/**
 * A like, put on or taken off somebody's comment.
 *
 * No `refuseUnlessMine` here, and that is the point of a like: it is the one
 * write in this file that is *supposed* to land on another person's comment. ADO
 * takes the liker from the token, so there is no identity in the request to
 * check and none to forge.
 *
 * Answers 204 with no body, so there is nothing to hand back and the panel
 * re-reads the thread for the new `usersLiked`.
 */
export const likeThreadComment = createServerFn({ method: 'POST' })
  .validator(likeRequest)
  .handler(async ({ data }): Promise<WriteResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return notConnected(client)

    const { threadId, commentId, liked, ...ref } = data

    try {
      await setCommentLike(client, ref, { threadId, commentId, liked })

      return { ok: true, error: null, connected: true, rateLimit: client.rateLimit() }
    } catch (error) {
      return failure(client, error)
    }
  })
