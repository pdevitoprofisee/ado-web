import { useMutation, useQueryClient } from '@tanstack/react-query'

import { requeuePolicy } from '@/server/pull-request-fn'

import type { Policy, PullRequestRef } from '@/server/pull-request'

// The checklist's one verb: ask Azure DevOps to run a build policy again.
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
