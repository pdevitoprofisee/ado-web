import { useMutation, useQueryClient } from '@tanstack/react-query'

import { squashMerge } from '@/server/pull-request-fn'

import { pullRequestKey } from './requeue'

import type { PullRequestRef } from '@/server/pull-request'

// The page's other write: complete the pull request, squashed.
//
// **Nothing here is optimistic**, for a harder reason than `requeue.ts`' one.
// Whether the merge happened is Azure DevOps' answer, not ours — it re-checks
// every policy and re-compares the source tip after we ask — so drawing the PR
// as completed before it says so would be inventing the one fact the reviewer
// came to the page to establish. The page goes quiet, the write goes out, the
// page re-reads.

/** One button's worth of state: what pressing it does, and what came back. */
export interface SquashMerge {
  /** Sends the completion. `lastMergeSourceCommit` is the tip the page was read at. */
  readonly run: (lastMergeSourceCommit: string) => void
  readonly isPending: boolean
  /**
   * What Azure DevOps said, verbatim, or `null`.
   *
   * Verbatim on purpose: a refused completion names the policy, or says the
   * source branch has been updated, and no sentence of ours could carry that.
   * Cleared by `dismiss` so a closed-and-reopened dialog does not still show the
   * last attempt's refusal.
   */
  readonly error: string | null
  readonly dismiss: () => void
}

/**
 * @param onMerged Run once, after the re-read, when ADO accepted the merge — the
 * caller's cue to close its confirmation. Here rather than in the component so
 * the dialog cannot close on a write that failed.
 */
export function useSquashMerge(ref: PullRequestRef, onMerged: () => void): SquashMerge {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (lastMergeSourceCommit: string) => {
      const result = await squashMerge({ data: { ...ref, lastMergeSourceCommit } })
      // The server function answers a refusal rather than throwing one; react-query
      // only calls something a failure if it rejects. Reconciled here, as in
      // `useRequeue`.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure too: a completion whose response was lost may well have merged
    // (`ado-client.ts` note 2), and only the re-read knows. Awaited, so what the
    // reviewer sees next is the pull request's real state rather than the state it
    // had when they pressed.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
    onSuccess: onMerged,
  })

  return {
    run: (lastMergeSourceCommit) => mutation.mutate(lastMergeSourceCommit),
    isPending: mutation.isPending,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}
