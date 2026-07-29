import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { announce } from '@/lib/notify'
import {
  markAllNotificationsRead,
  markNotificationsRead,
  notificationsQuery,
  observeNotifications,
} from '@/server/notifications-fn'

import type { UseQueryResult } from '@tanstack/react-query'
import type { NotificationsResult } from '@/server/notifications-fn'
import type { WatchedPullRequest } from '@/server/notifications'

// The client half of T-039: one query for the panel, one effect that lets the
// server take a diff, and two writes for read state.
//
// **There is no interval in this file.** The panel's query is refetched when
// something invalidates it — an observation, a mark, or the window regaining
// focus, which is on by default (see `root-provider.tsx`). The observation itself
// rides the inbox poll: `useObserve` fires once per inbox *result*, not on a
// clock of its own, so a hidden tab that has stopped polling detects nothing and
// announces nothing, and coming back to it catches up in one call.

export const notificationsKey = ['notifications'] as const

export function useNotifications(): UseQueryResult<NotificationsResult> {
  return useQuery({ queryKey: notificationsKey, queryFn: () => notificationsQuery() })
}

/**
 * Hands the inbox's rows to the server after every poll, then plays whatever came
 * back.
 *
 * Keyed on `updatedAt` — the poll's own timestamp — rather than on a fingerprint
 * of the rows, and that is deliberate. Two of the four events are detected during
 * *hydration*, which happens after this and writes rows this call knows nothing
 * about; keying on the rows would mean a vote sat silent until the next time
 * something about the inbox changed. Once per poll of a local SQLite table costs
 * nothing and makes the sound follow the detection by at most one cadence.
 *
 * The rows themselves are read from a ref so that changing them cannot re-fire
 * the effect on its own — the poll decides when, the rows only decide what.
 */
export function useObserve(
  pullRequests: readonly WatchedPullRequest[],
  updatedAt: number,
): void {
  const client = useQueryClient()
  const latest = useRef(pullRequests)
  latest.current = pullRequests

  useEffect(() => {
    // 0 is "no poll has come back yet", and there is nothing to diff against a
    // page that has not loaded.
    if (updatedAt === 0) return

    let cancelled = false

    void (async () => {
      try {
        const result = await observeNotifications({
          data: { pullRequests: latest.current },
        })
        if (cancelled) return

        // One sound for the batch, and only for events nobody has been told about
        // yet — the server decides that, because it is the only place that knows
        // whether the other detection path already announced this.
        announce(result.announced.map((item) => item.kind))
      } catch {
        // A failed observation is a notification that arrives one poll later. It
        // is not worth an alert on the page it happened on.
      } finally {
        if (!cancelled) await client.invalidateQueries({ queryKey: notificationsKey })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, updatedAt])
}

/**
 * Marks specific notifications read or unread.
 *
 * `onSettled`, not `onSuccess`, and awaited: the badge is a count the server
 * owns, and a failed write leaves a row whose state on screen is now a guess.
 */
export function useMarkRead() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { keys: readonly string[]; read: boolean }) =>
      markNotificationsRead({ data: { keys: [...input.keys], read: input.read } }),
    onSettled: () => client.invalidateQueries({ queryKey: notificationsKey }),
  })
}

export function useMarkAllRead() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSettled: () => client.invalidateQueries({ queryKey: notificationsKey }),
  })
}
