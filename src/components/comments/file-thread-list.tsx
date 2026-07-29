import { useState } from 'react'

import { Composer } from './composer'
import { ThreadCard } from './thread-card'
import { Button } from '@/components/ui/button'

import type { FileThreads, IterationContext, Thread } from '@/lib/comment-contract'
import type { ThreadActions } from './thread-actions'

// The conversations a diff row cannot hold, above the diff.
//
// Two reasons a thread ends up here. It is **unanchored** — a left-side anchor,
// or a line past the end of the blob we fetched — in which case there is no row
// for it and the alternative to this list is losing it. Or the file has **no diff
// on screen at all**: a PNG, a 40 MB bundle, a fetch that lost. `FileDiffPanel`
// renders a sentence instead of a `DiffView` in those cases, and a comment on a
// binary file is still a comment somebody needs to read.

/** Every thread on the file, anchored or not, in line order then id order. */
function everything(threads: FileThreads): readonly Thread[] {
  const out: Thread[] = [...threads.unanchored]
  for (const line of [...threads.byRightLine.keys()].sort((a, b) => a - b)) {
    out.push(...(threads.byRightLine.get(line) ?? []))
  }
  return out
}

export function FileThreadList({
  path,
  threads,
  actions,
  hideDone = false,
  all = false,
  iterationContext = null,
}: {
  /**
   * The file this list is under, as ADO spells it — leading slash and all.
   *
   * Its own prop and not `threads.path`, because the common case is a file with
   * no threads at all: `threads` is `null` there, and a composer that cannot name
   * its file writes a comment about the *pull request* instead of about the file.
   */
  path: string
  threads: FileThreads | null
  actions?: ThreadActions
  /**
   * The same flag the row model takes. Applied here too, or "hide done" would
   * clear the diff and leave the list above it full of resolved threads.
   */
  hideDone?: boolean
  /**
   * Render every thread on the file rather than only the unanchored ones. Set
   * when there is no diff for the anchored ones to sit in.
   */
  all?: boolean
  /**
   * Which iterations a new thread is written against. `null` posts against the
   * latest, which is wrong whenever the reviewer is looking at anything else —
   * so the caller that knows should say.
   */
  iterationContext?: IterationContext | null
}) {
  const [composing, setComposing] = useState(false)
  const onNewThread = actions?.onNewThread

  const listed = threads === null ? [] : all ? everything(threads) : threads.unanchored
  const shown = hideDone ? listed.filter((thread) => thread.resolution === 'open') : listed

  if (shown.length === 0 && onNewThread === undefined) return null

  return (
    // No top border at all, where there used to be one. This list is rendered
    // directly under `FileDiffPanel`'s `.sketch-rule`, so the old `border-t` put a
    // 1px machine line hard against a 6px drawn one — two separators saying the
    // same thing, one of them badly. The panel draws its break once, under the
    // header; below this, the diff's sunken gutters are their own edge. Padding is
    // what separates the list from both.
    <div className="flex flex-col gap-1 px-2 py-1.5">
      {shown.length === 0 ? null : (
        <>
          {!all && threads !== null ? (
            <p className="text-muted-foreground text-xs">
              {shown.length === 1 ? 'This comment' : 'These comments'} could not be placed on a
              line in this diff.
            </p>
          ) : null}
          {/* One card per thread rather than one card for the list: these are not
              on a shared line, so grouping them would imply they are about the
              same thing. */}
          {shown.map((thread) => (
            <ThreadCard key={thread.id} threads={[thread]} actions={actions} className="pl-0" />
          ))}
        </>
      )}

      {onNewThread === undefined ? null : composing ? (
        <Composer
          label={`New comment on ${path}`}
          autoFocus
          onSubmit={async (content) => {
            // A file-level thread: `context` names the file and no position.
            // A thread on a *line* is started from the line, in `DiffView` —
            // T-037 added the `ComposerRow` that made it possible. This stays the
            // home of the comment that is about the file rather than about any
            // line of it, which is also why `setComposer` refuses an anchorless
            // context instead of forwarding one here.
            await onNewThread({
              content,
              context: {
                filePath: path,
                rightStart: null,
                rightEnd: null,
                leftStart: null,
                leftEnd: null,
              },
              iterationContext,
              status: 'active',
            })
            setComposing(false)
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <div>
          <Button variant="ghost" size="xs" onPress={() => setComposing(true)}>
            Comment on this file
          </Button>
        </div>
      )}
    </div>
  )
}
