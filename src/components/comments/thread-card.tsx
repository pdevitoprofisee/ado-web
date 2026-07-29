import { useState } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { CommentView } from './comment'
import { Composer } from './composer'
import { ThreadStatusControl, statusLabel } from './thread-status'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { Comment, Thread } from '@/lib/comment-contract'
import type { ThreadActions } from './thread-actions'

// One conversation. The card the diff drops under a line, and the same card the
// file-level list renders.

/**
 * Comments in reading order, with each reply under what it replies to.
 *
 * `parentCommentId` is a tree and the array is flat, but only 3 of 56 sampled
 * threads had a second comment at all and none had a third level — so this
 * flattens rather than nests: one pass that keeps the API's order and moves a
 * reply to sit after its parent. A deleted parent is still a parent, which is
 * the whole reason the tombstone exists.
 */
function ordered(comments: readonly Comment[]): readonly Comment[] {
  if (comments.length < 2) return comments
  const children = new Map<number, Comment[]>()
  const roots: Comment[] = []
  for (const comment of comments) {
    const parent = comment.parentCommentId
    // A reply to a comment that is not in the thread is a root, not a lost
    // comment. `offset` is not always 1 and neither, apparently, is a parent id.
    if (parent === null || !comments.some((other) => other.id === parent)) {
      roots.push(comment)
      continue
    }
    const kin = children.get(parent)
    if (kin === undefined) children.set(parent, [comment])
    else kin.push(comment)
  }
  const out: Comment[] = []
  function walk(comment: Comment): void {
    out.push(comment)
    for (const child of children.get(comment.id) ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

/**
 * A done thread, in place.
 *
 * In place rather than gone: the line it hangs on is why it exists, and a
 * resolved conversation that vanishes takes with it the answer to "why is this
 * code like this". One row tall, so the file reads as code again, and it opens
 * where it sits. Anyone who wants them actually gone has "hide done", which
 * takes the row out of the model rather than styling it away.
 */
export function DoneStub({
  threads,
  onOpen,
}: {
  threads: readonly Thread[]
  onOpen: () => void
}) {
  const first = threads[0]
  const comments = threads.reduce((total, thread) => total + thread.comments.length, 0)
  return (
    // No sheet and no outline: the stub is one line of ink, and a tint band
    // starting 48px in from the gutter would read as a row of the diff that had
    // been coloured rather than as a conversation folded away.
    //
    // The tick is the only coloured mark on it, and it is the whole message — the
    // words beside it stay in secondary ink so a column of stubs scans as quiet.
    <div className="text-muted-foreground flex items-center gap-2 px-2 py-0.5 text-xs">
      <HugeiconsIcon icon={Tick02Icon} size={12} className="text-pen-green shrink-0" aria-hidden />
      <span>
        {threads.length === 1
          ? statusLabel(first.status)
          : `${threads.length} threads resolved`}
        {' · '}
        {comments === 1 ? '1 comment' : `${comments} comments`}
      </span>
      <Button variant="ghost" size="xs" onPress={onOpen}>
        Show
      </Button>
    </div>
  )
}

/** Where a bot's or ADO's own thread says who it is, since there is no avatar. */
function kindBadge(thread: Thread): string | null {
  if (thread.kind === 'bot') return 'bot'
  if (thread.kind === 'system') return 'system'
  return null
}

/**
 * How this thread is drawn, and the two axes are the point: **the sheet says who
 * is talking, the outline says how much it wants from you.**
 *
 * A person's words sit on the raised card. A machine's — Sonar's, or ADO's own
 * activity trail — sit on the sunken sheet, because neither is a conversation.
 * On top of that, an unanswered question gets the brand pen at full weight, a
 * settled one drops to the quiet line, and the activity trail gets no outline at
 * all: a vote or a push is a log line, and boxing it in the same ink as a
 * colleague's question puts the two on a footing they do not share.
 *
 * `bg-paper-1` rather than `bg-muted`, which is the one semantic token `.dark`
 * re-points — `--muted` becomes `--paper-2` on a board, where it reads as lifted
 * off the page. "Sunken" has to stay sunken in both themes or the axis says
 * nothing.
 *
 * No `shadow-card` on any of them. A graphite lift is right for a sheet lying on
 * the page and wrong for something wedged into a scrolling column of code: three
 * of these inside one diff would read as floating over the file rather than as
 * part of it.
 */
function shell(thread: Thread): string {
  if (thread.kind === 'system') return 'bg-paper-1'
  if (thread.kind === 'bot') return 'border-border border-[1.5px] bg-paper-1'
  return thread.resolution === 'open'
    ? 'border-ink border-[1.5px] bg-card'
    : 'border-border border-[1.5px] bg-card'
}

function ThreadBody({ thread, actions }: { thread: Thread; actions?: ThreadActions }) {
  const [replying, setReplying] = useState(false)
  const onReply = actions?.onReply

  const comments = ordered(thread.comments)
  const last = comments[comments.length - 1]

  return (
    // `rounded-lg`, because this is a panel and not a control — bare `rounded` is
    // the one step of the scale the sketch radii are *not* mapped onto, so what
    // used to be here was a mechanical 4px corner in the middle of a hand-drawn
    // page. `px-2 py-1` survives the change: the widest corner of `sketch-md`
    // eats about two horizontal pixels at the height the status buttons sit at,
    // which the padding already covers, and this list can run to dozens.
    <div className={cn('rounded-lg px-2 py-1', shell(thread))}>
      <div className="flex items-baseline gap-2">
        {kindBadge(thread) === null ? null : (
          // The same mark `pr-detail` gives the little words that qualify a row:
          // `.annotation` inside a pen at construction weight. Deliberately not
          // `.prof-badge` — a badge is ~22px against this header's 16px line box,
          // and buying six pixels on every system thread for a word the sheet
          // under it already implies is the wrong trade in a long list.
          <span className="annotation rounded-sm border-[1.5px] border-ink-150 px-1">
            {kindBadge(thread)}
          </span>
        )}
        <ThreadStatusControl thread={thread} actions={actions} className="ml-auto" />
      </div>

      {/* Full strength, not the `/40` that was here: an alpha fraction tuned
          against a dark app is nothing at all against warm paper. A drawn
          `.sketch-rule` was the other option and is wrong twice over — it costs
          6px per boundary, and only 3 of 56 sampled threads had a second comment
          to divide, so the mark would be paying for a case that is rare and
          quiet. Two comments in one conversation want a construction line, not a
          chapter break. */}
      <div className="divide-border divide-y">
        {comments.map((comment) => (
          <CommentView
            key={comment.id}
            comment={comment}
            threadId={thread.id}
            actions={actions}
          />
        ))}
      </div>

      {/* `NewReply.parentCommentId` is a number and not nullable, so a reply
          needs something to hang on. A thread with no comments left to name is
          not repliable — and it is not a thing the census contained. */}
      {onReply === undefined || last === undefined ? null : replying ? (
        <div className="pt-1">
          <Composer
            label={`Reply to thread ${thread.id}`}
            submitLabel="Reply"
            placeholder="Reply"
            autoFocus
            onSubmit={async (content) => {
              // Threaded under the last comment rather than the first, so a
              // conversation reads in the order it happened. `parentCommentId`
              // is what ADO orders on, not the publish date.
              await onReply({
                threadId: thread.id,
                parentCommentId: last.id,
                content,
              })
              setReplying(false)
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        <div className="pt-0.5">
          <Button variant="ghost" size="xs" onPress={() => setReplying(true)}>
            Reply
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The conversations on one line, or the one conversation in a list.
 *
 * A list rather than a single thread because two people commenting on the same
 * line is one row for the virtualizer to measure instead of two. All-done
 * collapses to a stub; a mix renders the open ones and stubs the rest, because
 * hiding an open reply behind a "resolved" summary is how a question goes
 * unanswered.
 */
export function ThreadCard({
  threads,
  actions,
  className,
}: {
  threads: readonly Thread[]
  actions?: ThreadActions
  className?: string
}) {
  // Local, not in the row model: showing a resolved thread is looking at it, and
  // it should not survive a scroll away and back as a change to the file's rows.
  const [shown, setShown] = useState(false)

  const open = threads.filter((thread) => thread.resolution === 'open')
  const done = threads.filter((thread) => thread.resolution === 'done')
  const stubbed = shown ? [] : done

  return (
    <div className={cn('flex w-full flex-col gap-1 py-1 pl-12 pr-2', className)}>
      {[...open, ...(shown ? done : [])].map((thread) => (
        <ThreadBody key={thread.id} thread={thread} actions={actions} />
      ))}
      {stubbed.length === 0 ? null : (
        <DoneStub threads={stubbed} onOpen={() => setShown(true)} />
      )}
    </div>
  )
}
