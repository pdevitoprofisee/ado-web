import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { pullRequestKey } from './requeue'
import { WORK_ITEM_DEBOUNCE_MS } from './work-item-contract'
import { attachWorkItem, workItemSearchQuery, workItemsQuery } from '@/server/work-items-fn'

import type { PullRequestRef } from '@/server/pull-request'

// The work items section's client half: one read for the rows, one read per
// search, and the one write that links a ticket to this pull request.
//
// Not optimistic, `reviewers.ts`' rule and for the same reason one step over: a row
// drawn before ADO has taken the patch says a ticket is on this pull request when
// the board still says it is not, and the person who finds that out is whoever
// looks for the pull request from the ticket and does not find it. So the picker
// goes quiet, the write goes out, and the list changes when the re-read says so.

/** The work items on one pull request. Flat tuple, like every other key in the app. */
export const workItemsKey = (ref: PullRequestRef) =>
  ['work-items', ref.projectId, ref.repositoryId, ref.id] as const

/**
 * One search, keyed by the project and the query.
 *
 * The pull request is not in the key: two pull requests in the same project asking
 * the same question have the same answer, and a key that named the review would pay
 * two calls to learn it twice.
 */
export const workItemSearchKey = (projectId: string, query: string) =>
  ['work-item-search', projectId, query] as const

/**
 * How long a search answer is believed: five minutes.
 *
 * Long enough that backspacing through a query costs nothing — every prefix is
 * already in the cache on the way back — and short enough that a ticket created
 * while the picker is open is findable without a reload.
 */
const SEARCH_STALE_MS = 5 * 60_000

export function workItemsOptions(ref: PullRequestRef) {
  return queryOptions({
    queryKey: workItemsKey(ref),
    queryFn: () => workItemsQuery({ data: ref }),
  })
}

export function useWorkItems(ref: PullRequestRef) {
  return useQuery(workItemsOptions(ref))
}

export function workItemSearchOptions(projectId: string, query: string) {
  return queryOptions({
    queryKey: workItemSearchKey(projectId, query),
    queryFn: () => workItemSearchQuery({ data: { projectId, query } }),
    staleTime: SEARCH_STALE_MS,
    // The previous matches stay on screen while the next answer is in flight. The
    // alternative is a list that empties on every keystroke and fills back in, which
    // reads as "nothing matches" for as long as the round trip takes.
    placeholderData: keepPreviousData,
  })
}

/**
 * `value`, once it has stopped changing for `delay` milliseconds.
 *
 * Here rather than in a shared module because it is the only debounce in the app:
 * the reviewer picker matches one cached snapshot locally and needs none, and this
 * picker needs one because every keystroke is WIQL plus a batch call.
 * `WORK_ITEM_DEBOUNCE_MS` carries the reasoning for the number.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)

    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}

/**
 * What the picker's list reads from, for what has been typed so far.
 *
 * The debounce is in here rather than at the call site so that the field stays a
 * field: it holds the query, this holds when the query is worth asking about.
 */
export function useWorkItemSearch(projectId: string, query: string) {
  const settled = useDebounced(query, WORK_ITEM_DEBOUNCE_MS)

  return useQuery(workItemSearchOptions(projectId, settled))
}

/** Attaching a ticket: what pressing does, which one is in flight, what came back. */
export interface Attach {
  readonly run: (workItemId: number) => void
  /**
   * The work item id being written, or `null` — the value rather than a boolean,
   * `Invite`'s reason: the picker can name what it is waiting on.
   */
  readonly pending: number | null
  readonly error: string | null
  readonly dismiss: () => void
}

export function useAttachWorkItem(ref: PullRequestRef): Attach {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (workItemId: number) => {
      const result = await attachWorkItem({ data: { ...ref, workItemId } })
      // A refusal the server *returns* is still a failure this control has to
      // report; react-query only calls something a failure if it rejects.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure as well, `useInviteReviewer`'s rule: a write whose response was
    // lost may well have been applied (`ado-client.ts` note 2), and only the re-read
    // knows whether the link is there.
    //
    // Both reads, because a link changes two sections. The rows come from
    // `workItemsKey`; the work item policy — "not yet met" for as long as nothing is
    // attached — is one of the evaluations in the detail read. Invalidating only the
    // first leaves a row in this section sitting under a blocking policy that says
    // there is none, which is the state this write exists to end.
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: workItemsKey(ref) }),
        client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
      ])
    },
  })

  return {
    run: (workItemId) => mutation.mutate(workItemId),
    pending: mutation.isPending && mutation.variables !== undefined ? mutation.variables : null,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}
