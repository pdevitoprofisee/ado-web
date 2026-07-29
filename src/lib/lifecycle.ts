import { useMutation, useQueryClient } from '@tanstack/react-query'

import { pullRequestKey } from './requeue'
import { abandonPullRequest, reactivatePullRequest } from '@/server/pull-request-fn'

import type { PullRequestDetail, PullRequestRef } from '@/server/pull-request'

// Closing a pull request without merging it, and opening it again.
//
// Two hooks rather than one with a direction, `pull-request.ts`' reason: this
// route's status field also takes `completed`, and a single lifecycle hook is one
// argument away from being the merge. They also differ in the thing that matters
// most about them — one asks first and the other does not — and a shared hook
// would have had to hold that difference as a flag.
//
// Nothing is optimistic, as everywhere else on this page. Redrawing the header as
// abandoned before ADO says so would be inventing the fact the whole control is
// about, and the status is what every other affordance up there keys on.

/**
 * Which of the two the header offers, and why it is not on offer.
 *
 * One function rather than two blockers, because the two questions are one: an
 * abandoned pull request is the *only* one you can reactivate, so "which verb"
 * and "is it allowed" are answered by the same status. `mergeBlocker`'s contract
 * otherwise — a sentence to put beside a disabled control, never a reason to
 * remove the control, which is what the ticket asks for.
 *
 * Ownership last, after status, deliberately: a completed pull request is
 * completed whoever opened it, and being told "this is not yours" about work you
 * merged yesterday is the wrong sentence. And ownership is *this app's* rule
 * rather than a claim about ADO's — a project administrator may well be allowed to
 * close somebody else's pull request, and this app declining to offer it from a
 * header is not the same as saying ADO would refuse.
 */
export function lifecycleAction(
  pr: Pick<PullRequestDetail, 'status' | 'author' | 'viewerId'>,
): { readonly kind: 'abandon' | 'reactivate'; readonly blocker: string | null } {
  const kind = pr.status === 'abandoned' ? 'reactivate' : 'abandon'
  const verb = kind === 'abandon' ? 'Abandoning' : 'Reactivating'

  if (kind === 'abandon' && pr.status !== 'active') {
    if (pr.status === 'completed') {
      return { kind, blocker: 'This pull request has already been completed.' }
    }

    // ADO's word as-is, `mergeBlocker`'s reason: guessing which of the three
    // states a fourth value means is how a page tells somebody the wrong thing
    // about their own pull request.
    return {
      kind,
      blocker: `Azure DevOps says this pull request is ${pr.status === '' ? 'in a state it did not name' : pr.status}, not active.`,
    }
  }
  if (pr.viewerId === null || pr.viewerId === '') {
    return {
      kind,
      blocker:
        'Azure DevOps did not say who this token belongs to, so this app cannot tell whether this pull request is yours.',
    }
  }
  // Case-insensitively: ADO is not consistent about GUID casing between endpoints
  // (`inbox.ts`), and a mismatch here would tell an author their own pull request
  // is somebody else's.
  if (pr.author.id.toLowerCase() !== pr.viewerId.toLowerCase()) {
    return {
      kind,
      blocker: `${verb} somebody else's pull request is a decision to make in Azure DevOps.`,
    }
  }

  return { kind, blocker: null }
}

/** One button's worth of state, and its confirmation's. `useSquashMerge`'s shape. */
export interface Abandon {
  readonly run: () => void
  readonly isPending: boolean
  /**
   * What ADO said, verbatim, or `null`. Verbatim because a refusal here is a
   * permission answer — who may close somebody's pull request is ADO's model, not
   * ours — and no sentence of ours could carry it. Cleared by `dismiss`, so a
   * reopened dialog does not still show the last attempt's refusal.
   */
  readonly error: string | null
  readonly dismiss: () => void
}

/**
 * Abandon the pull request, then wait for the page to have re-read it.
 *
 * @param onAbandoned Run once, after the re-read, when ADO took it — the caller's
 * cue to close its confirmation. Here rather than in the component so the dialog
 * cannot close on a write that failed.
 */
export function useAbandon(ref: PullRequestRef, onAbandoned: () => void): Abandon {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await abandonPullRequest({ data: ref })
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure too, `useSquashMerge`'s rule: a write whose response was lost may
    // already have closed the pull request (`ado-client.ts` note 2), and only the
    // re-read knows. Awaited, so what the reviewer sees next is the pull request's
    // real state rather than the state it had when they pressed.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
    onSuccess: onAbandoned,
  })

  return {
    run: () => mutation.mutate(),
    isPending: mutation.isPending,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}

/** No `dismiss`: there is no dialog to reopen, so nothing holds a stale refusal. */
export interface Reactivate {
  readonly run: () => void
  readonly isPending: boolean
  readonly error: string | null
}

/**
 * Put an abandoned pull request back.
 *
 * **No confirmation, and that is a decision rather than an omission.** The ticket
 * draws the line at what is correctable: a vote does not confirm because voting
 * again fixes it, and abandoning does because it closes work other people are
 * waiting on. Reactivating is on the correctable side of that same line — it
 * reopens work rather than closing it, nothing about it is destructive, and
 * abandoning again undoes it exactly. A dialog in front of it would be a dialog
 * asking whether you meant to press the button you pressed.
 *
 * No `onSuccess` callback either, for the same reason: there is no dialog to
 * close. The header redraws off the re-read.
 */
export function useReactivate(ref: PullRequestRef): Reactivate {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await reactivatePullRequest({ data: ref })
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  return {
    run: () => mutation.mutate(),
    isPending: mutation.isPending,
    error: mutation.error === null ? null : mutation.error.message,
  }
}
