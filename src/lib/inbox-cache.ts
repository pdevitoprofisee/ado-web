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
