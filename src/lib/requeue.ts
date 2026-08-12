import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { requeuePolicy } from '@/server/pull-request-fn'

import type { RefreshRow } from '@/components/use-hydration'
import type { HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'
import type { Policy, PullRequestRef } from '@/server/pull-request'

// The one verb the build policies have: ask Azure DevOps to run one again. Two
// callers, because the same write is offered in two places — the detail page's
// checklist, a row at a time, and the inbox table, a pull request at a time.
//
// **Nothing here is optimistic**, for `conversation.ts`' reason and one of its
// own. A requeue's outcome is not a field we could invent — the row's next state
// is a build id ADO has not minted yet — and pretending the row says "running"
// while the service still says "not yet met" would be showing a reviewer a build
// that does not exist. So the button goes quiet, the write goes out, the page
// re-reads, and the row changes when the row has changed.

/** The evaluation and the outcome the checklist needs to draw one row's control. */
export interface Requeue {
  /** Asks for another run. A policy whose `requeueId` is null is not one to pass. */
  readonly ask: (policy: Policy) => void
  /** `Policy.id` of the row whose requeue is in flight, or `null`. */
  readonly pendingId: string | null
  /**
   * The row whose last requeue failed, and what was said about it.
   *
   * Carried per row rather than as one page-level message because the checklist
   * can hold several build policies, and "that did not work" belongs against the
   * one you pressed.
   */
  readonly failure: { readonly id: string; readonly message: string } | null
}

/**
 * The key `pr.$projectId.$repositoryId.$prId.tsx` builds its detail query with.
 *
 * Here rather than there because a key that is written in one place and
 * invalidated in another has to be the same key in both, and this is the file
 * that cares — the route only ever reads it.
 */
export const pullRequestKey = (ref: PullRequestRef) =>
  ['pull-request', ref.projectId, ref.repositoryId, ref.id] as const

export function useRequeue(ref: PullRequestRef): Requeue {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (policy: Policy) => {
      if (policy.requeueId === null) throw new Error('That policy has no build to requeue.')

      const result = await requeuePolicy({
        data: { projectId: ref.projectId, evaluationId: policy.requeueId },
      })
      // The server function answers a refusal rather than throwing one, so that
      // the wire carries a shape; react-query only calls something a failure if
      // it rejects. This is where those two facts are reconciled.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')

      return policy.id
    },
    // On failure as well as on success, which is not belt-and-braces: a write
    // that timed out on the way back may well have been applied (`ado-client.ts`
    // note 2), and the re-read is the only thing that knows. Awaited, so the
    // button stays disabled until the checklist it is in has been redrawn —
    // otherwise it comes back enabled a beat before the row it acted on updates,
    // which reads as "nothing happened, press it again".
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  const asked = mutation.variables

  return {
    ask: (policy) => mutation.mutate(policy),
    pendingId: mutation.isPending && asked !== undefined ? asked.id : null,
    failure:
      mutation.error === null || asked === undefined
        ? null
        : { id: asked.id, message: mutation.error.message },
  }
}

/** The inbox row's requeue: the whole row's builds, in one press. */
export type RequeueRow = (
  row: PullRequestRow,
  evaluations: readonly string[],
) => Promise<void>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long the row waits for the queue to move, between re-reads.
 *
 * A requeue is an instruction to a queue, not a change of state: ADO answers the
 * PATCH before the evaluation it addresses has left `broken`. So the read taken
 * the moment the write returns is a read of a service that has not acted yet —
 * measured, and it is the button that looks like it did nothing until you press
 * Refresh.
 *
 * Two more reads, spaced, and the row stops as soon as the answer changes. The
 * ceiling is about four seconds and three reads, because the alternative to a
 * bounded wait is either a wrong row or a poll loop, and a row that is still
 * unchanged after four seconds is corrected by the inbox's own cadence — a broken
 * build makes the row blocked, and a blocked row's cache expires inside one poll.
 */
const SETTLE_MS = [1_500, 3_000]

/** Whether two re-reads of the same row said the same thing. */
const same = (a: HydrationResult | undefined, b: HydrationResult | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The same write from the inbox table, where the unit is a pull request rather
 * than a policy row.
 *
 * A promise the pressed row awaits, and not `useMutation` as {@link useRequeue}
 * uses: one mutation is one page-wide pending flag, and the inbox draws hundreds
 * of rows that each need their own. `pipeline-callout.ts` makes the same choice
 * for the same reason, and the two are deliberately the same shape.
 *
 * The refusal is *returned* by the server function, so a rejection is made here —
 * the row prints it. It stops at the first one rather than pressing on: a
 * refusal on the first build is almost always a permission the rest share, and
 * the alternative is one press queueing what it can and reporting one failure.
 *
 * `refresh` is awaited on both paths, and it is the only thing that can correct
 * the row. A requeue moves no commit, so the cache entry this row was drawn from
 * is still valid by its own test and nothing else would re-read it. On the way out
 * of a refusal it runs once — a write that failed has no queue to wait for, and a
 * write that failed on the way back may still have landed. On the way out of a
 * success it runs until the row moves, per {@link SETTLE_MS}.
 */
export function useRequeueRow(refresh: RefreshRow): RequeueRow {
  return useCallback(
    async (row, evaluations) => {
      const projectId = row.projectId
      if (projectId === null) {
        throw new Error('Azure DevOps did not send the project this write is addressed by.')
      }

      try {
        for (const evaluationId of evaluations) {
          const result = await requeuePolicy({ data: { projectId, evaluationId } })
          if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
        }
      } catch (reason) {
        await refresh(row)
        throw reason
      }

      let last = await refresh(row)
      for (const wait of SETTLE_MS) {
        await sleep(wait)
        const next = await refresh(row)
        if (!same(last, next)) return
        last = next
      }
    },
    [refresh],
  )
}
