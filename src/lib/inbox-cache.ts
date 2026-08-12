import type { QueryClient } from '@tanstack/react-query'
import type { PullRequestRow } from '@/server/inbox'
import type { InboxResult } from '@/server/inbox-fn'

// The inbox rows, seen from the pages that *write* to a pull request.
//
// The inbox is polled every two minutes and nothing else re-reads it, so a write
// made on the detail page leaves the table saying the old thing until the next
// tick. That is two minutes of a renamed pull request wearing its former name in
// the list you came back to. This file is how a write says so.

/**
 * The key `routes/index.tsx` builds the inbox query with.
 *
 * Here rather than there for `pullRequestKey`'s reason: a key that is read in one
 * file and invalidated in another must be the same key in both.
 */
export const INBOX_KEY = ['inbox'] as const

/**
 * Puts a confirmed title on the cached row, in both sections.
 *
 * Not optimism — the caller has Azure DevOps' acceptance in hand. It is the
 * invalidation beside it that is slow: an inbox refetch lists every active pull
 * request in the org, so the table would paint the old name and correct itself a
 * second later. That flicker is the bug reported over again, in miniature.
 *
 * A miss is a no-op. The inbox is absent until it is read once, and a pull
 * request opened from a link was never in it.
 */
export function retitleInboxRow(client: QueryClient, id: number, title: string): void {
  client.setQueryData<InboxResult>(INBOX_KEY, (previous) => {
    if (!previous?.inbox) return previous

    const retitle = (rows: readonly PullRequestRow[]): PullRequestRow[] =>
      rows.map((row) => (row.id === id ? { ...row, title } : row))

    return {
      ...previous,
      inbox: {
        ...previous.inbox,
        mine: retitle(previous.inbox.mine),
        assignedToMe: retitle(previous.inbox.assignedToMe),
      },
    }
  })
}

/**
 * Takes a merged pull request off the cached table, in both sections.
 *
 * {@link retitleInboxRow}'s reason, one step further: the inbox lists every open
 * pull request in the org, so the refetch that would prove this one closed takes
 * seconds — and the row it is about is a row the reviewer just completed. The
 * table drops it on Azure DevOps' acceptance, which is a fact and not a guess.
 *
 * A miss is a no-op, so merging from the detail page costs nothing here.
 */
export function dropInboxRow(client: QueryClient, id: number): void {
  client.setQueryData<InboxResult>(INBOX_KEY, (previous) => {
    if (!previous?.inbox) return previous

    const without = (rows: readonly PullRequestRow[]): PullRequestRow[] =>
      rows.filter((row) => row.id !== id)

    return {
      ...previous,
      inbox: {
        ...previous.inbox,
        mine: without(previous.inbox.mine),
        assignedToMe: without(previous.inbox.assignedToMe),
      },
    }
  })
}

/** Whether the cached table still holds this pull request. */
function holds(client: QueryClient, id: number): boolean {
  const inbox = client.getQueryData<InboxResult>(INBOX_KEY)?.inbox
  if (!inbox) return false

  return [...inbox.mine, ...inbox.assignedToMe].some((row) => row.id === id)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long the table waits for the completion to land, between re-reads.
 *
 * `requeue.ts` measured this on the other write and records it at length: Azure
 * DevOps answers the PATCH before it has acted on it. A completed pull request
 * keeps `status: active` while its completion is queued, so the inbox read taken
 * the moment the merge returns still lists the row.
 */
const SETTLE_MS = [1_500, 3_000]

/**
 * Re-reads the table until Azure DevOps agrees the merged pull request is closed.
 *
 * Call it after {@link dropInboxRow}, and the two are one act: the row is already
 * gone, and this is the correction rather than the removal. A read that still
 * lists the row is a read older than the acceptance in hand, so the row goes
 * again rather than reappearing for a second — which is why this drops on every
 * turn instead of once.
 *
 * Bounded at two more reads, {@link SETTLE_MS} apart. A pull request Azure DevOps
 * still lists after four seconds stays off the table until the inbox's own poll
 * re-reads it: the acceptance is the better evidence of the two, a completion
 * queue is slow more often than it fails, and putting the row back for two
 * minutes is the flicker this whole function exists to avoid.
 */
export async function settleMergedRow(client: QueryClient, id: number): Promise<void> {
  for (const wait of SETTLE_MS) {
    await sleep(wait)
    // Invalidate rather than refetch: this re-reads the table the reviewer is
    // looking at, and only marks it stale when they have gone somewhere else.
    await client.invalidateQueries({ queryKey: INBOX_KEY })
    if (!holds(client, id)) return

    dropInboxRow(client, id)
  }
}
