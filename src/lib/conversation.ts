import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { CADENCE, useCadence } from './cadence'
import { fileThreads } from '@/server/threads'
import {
  changeThreadStatus,
  deleteThreadComment,
  editThreadComment,
  replyToThread,
  startThread,
  threadsQuery,
} from '@/server/threads-fn'

import type { ThreadActions } from '@/components/comments/thread-actions'
import type { FileThreads, Thread, VoteEvent } from './comment-contract'
import type { PullRequestRef } from '@/server/pull-request'
import type { WriteResult } from '@/server/threads-fn'

// The conversation's client half: one read, five writes, and the grouping that
// cannot cross the wire.
//
// `fileThreads` is imported from `@/server/threads` and that is deliberate, not a
// leak — every import in that file is `import type`, precisely so the grouping can
// run here. `FileThreads` holds a `ReadonlyMap`, which a server function would
// serialise as `{}`, so the map has to be built on this side of the boundary out
// of the plain `ThreadList` the read returns.
//
// **Nothing here is optimistic, and that is a deviation from T-024's "the
// optimistic path matches `useViewedFiles`".** Two reasons, both about what we
// know at the moment of the click:
//
//   - A viewed tick is a local SQLite row whose outcome is known before the call
//     goes out. A comment is a remote object whose id, `publishedDate` and — for a
//     status change — final state only Azure DevOps can say.
//   - We have `pr.viewerId` and no display name to go with it, so an invented
//     comment would render under the author "unknown" for as long as it took the
//     write to land. Showing someone their own paragraph attributed to nobody is
//     worse than showing it a moment later.
//
// So each write awaits its round trip, then awaits a re-read, and the paragraph
// appears when the composer clears. What T-024 actually protects — a failed write
// never silently eats the text — is the rejection contract below, not the
// optimism.

/** The empty answer, so a page whose conversation has not arrived still renders. */
const NONE: readonly Thread[] = []
const NO_VOTES: readonly VoteEvent[] = []
const NO_FILES: ReadonlyMap<string, FileThreads> = new Map()

export interface Conversation {
  /** Human threads, in ADO's order. Bot and system threads are already out. */
  readonly threads: readonly Thread[]
  /** Anchored threads, by path — what a file's diff rows are built from. */
  readonly files: ReadonlyMap<string, FileThreads>
  /**
   * Threads on the pull request rather than on a file. `fileThreads` drops these
   * (they have no path to key on), so they are separated here or they are lost:
   * 44 of the 56 threads T-022 sampled were these.
   */
  readonly onPullRequest: readonly Thread[]
  readonly openCount: number
  /** Excluded from `threads`, and said out loud rather than silently dropped. */
  readonly systemCount: number
  readonly botCount: number
  /** The dated votes out of those system threads. What `lastReview` measures from. */
  readonly votes: readonly VoteEvent[]
  readonly pending: boolean
  /** Why the conversation could not be read, or `null`. The diff beside it still reviews. */
  readonly error: string | null
  readonly connected: boolean
  readonly actions: ThreadActions
}

/**
 * The conversation for one pull request.
 *
 * Polled at the page's own cadence, unlike the viewed marks and the iteration
 * changes, which are pinned to `Infinity` because they cannot change. A
 * conversation is the one thing on this page that *does* change while you read
 * it — somebody answering the question you asked is the reason to keep the tab
 * open — so this is the second poll on the page, and it is two ADO calls a tick.
 */
export function useConversation(ref: PullRequestRef, viewerId: string | null): Conversation {
  const client = useQueryClient()
  const refetchInterval = useCadence(CADENCE.pullRequest)

  const key = ['threads', ref.repositoryId, ref.id] as const

  const query = useQuery({
    queryKey: key,
    queryFn: () => threadsQuery({ data: ref }),
    refetchInterval,
    staleTime: CADENCE.pullRequest,
  })

  // Identity matters more than usual here, and TanStack Query's structural
  // sharing is what supplies it: a poll that changes nothing returns the *same*
  // array object, so the memo below does not recompute and `setThreads` in the row
  // model identity-returns. Without that, every thirty seconds would rebuild the
  // rows of all 294 files in a large pull request to arrive at what they already
  // were. Do not switch this query to `structuralSharing: false`.
  const threads = query.data?.threads?.threads ?? NONE

  // Grouped once per answer rather than once per file panel: a 294-file pull
  // request would otherwise walk the whole thread list 294 times.
  const files = useMemo(
    () => (threads.length === 0 ? NO_FILES : fileThreads(threads)),
    [threads],
  )

  const onPullRequest = useMemo(
    () => threads.filter((thread) => thread.context === null),
    [threads],
  )

  const actions = useMemo<ThreadActions>(() => {
    /**
     * The rejection contract the composer is built on: resolve means it landed,
     * reject means the text stays where it is with this sentence beside it.
     *
     * `ok` and not "no error" — a write refused before it was sent (not
     * connected, not your comment) reports `ok: false` with a reason, and
     * treating that as success is exactly how a reply appears to have been
     * posted and is not there on the next read.
     */
    const settle = async (result: WriteResult): Promise<void> => {
      if (!result.ok) {
        throw new Error(result.error ?? 'Azure DevOps did not say why the write failed.')
      }

      // Awaited, so the composer stays busy until the thread is actually back.
      // Clearing it a beat earlier means a gap where the paragraph is neither in
      // the box nor on the page.
      await client.invalidateQueries({ queryKey: key })
    }

    return {
      viewerId,
      onReply: async (input) => settle(await replyToThread({ data: { ...ref, ...input } })),
      onStatusChange: async (input) =>
        settle(await changeThreadStatus({ data: { ...ref, ...input } })),
      onEdit: async (input) => settle(await editThreadComment({ data: { ...ref, ...input } })),
      onDelete: async (input) => settle(await deleteThreadComment({ data: { ...ref, ...input } })),
      // `status` is dropped rather than sent: it is `'active'` by the contract's
      // own type, and the server asserts it. Sending it would be offering the
      // client a say in something it has no say in.
      onNewThread: async (input) =>
        settle(
          await startThread({
            data: {
              ...ref,
              content: input.content,
              context: input.context,
              iterationContext: input.iterationContext,
            },
          }),
        ),
    }
    // `key` is derived from `ref`'s two fields, so listing them is listing it.
  }, [client, ref.projectId, ref.repositoryId, ref.id, viewerId])

  return {
    threads,
    files,
    onPullRequest,
    openCount: query.data?.threads?.openCount ?? 0,
    systemCount: query.data?.threads?.systemCount ?? 0,
    botCount: query.data?.threads?.botCount ?? 0,
    votes: query.data?.threads?.votes ?? NO_VOTES,
    pending: query.isPending,
    // Two ways to fail and one sentence for both, as `useChanges` does: the
    // server function catching an ADO error, and the call not arriving at all.
    error: query.data?.error ?? query.error?.message ?? null,
    connected: query.data?.connected ?? true,
    actions,
  }
}
