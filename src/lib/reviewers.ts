import { useMutation, useQueryClient } from '@tanstack/react-query'

import { pullRequestKey } from './requeue'
import { inviteReviewer, withdrawReviewer } from '@/server/pull-request-fn'

import type { ReviewerCandidate } from './identity-contract'
import type { PullRequestRef, Reviewer } from '@/server/pull-request'

// Who is on the pull request: the two writes, and the one piece of arithmetic
// they need.
//
// Not optimistic, `vote.ts`' rule and for a sharper version of its reason. A row
// drawn as added before ADO has taken it says somebody has been asked to review
// when they have not been told anything, and the person who would find that out is
// the author, days later, wondering why nobody looked. So the field goes quiet,
// the write goes out, and the list changes when the re-read says so.

/**
 * The people worth offering, out of the directory.
 *
 * Whoever is already on the pull request is removed, because `PUT` on a reviewer
 * who is already there is not an error the user would learn anything from — see
 * `addReviewer`, where whether it upserts or 400s is one of the unproven parts.
 * Offering somebody who is already in the list above the field is a UI inviting a
 * request whose best outcome is nothing happening.
 *
 * Case-insensitively, `viewerVote`'s reason: ADO answers the same GUID lower case
 * from `_apis/identities` and upper case elsewhere, and comparing as written would
 * offer half the reviewer list back.
 *
 * A **container** on the pull request is not a reason to hide anybody. Groups
 * outnumber people on this org and `[Products]\Contributors` is a reviewer on 119
 * of 163 active PRs, so "already covered by a team you are in" is true of nearly
 * everybody — and it is exactly the case where the author wants a *named* person
 * asked. Only the person's own row hides them.
 */
export function offerable(
  people: readonly ReviewerCandidate[],
  reviewers: readonly Reviewer[],
): readonly ReviewerCandidate[] {
  const on = new Set(reviewers.map((reviewer) => reviewer.id.toLowerCase()))

  return people.filter((person) => !on.has(person.identityId.toLowerCase()))
}

/**
 * Whether somebody can be taken off from here, and the sentence saying why not.
 *
 * Two refusals, and neither is a permission check — ADO owns that answer, and
 * `removeReviewer` deliberately does not guess at it. These are about what the
 * removal would *destroy*:
 *
 *   - **A vote.** Remove a reviewer who has approved and their approval goes with
 *     them; re-adding brings them back at "no vote", and nothing in ADO remembers.
 *     That is not something to offer behind a one-click `×`, and it is not
 *     something a confirmation dialog makes better either, because the honest
 *     answer is that this app has no way to put it back.
 *   - **A policy's reviewer.** A container is on the pull request because a branch
 *     policy put it there, so removing it is a write the next policy evaluation
 *     undoes. Offering it would be offering a button that appears not to work.
 *
 * Returned as a sentence rather than a boolean so the control can say it. `null`
 * means it can go.
 */
export function withdrawBlocker(reviewer: Reviewer): string | null {
  if (reviewer.isContainer) {
    return 'A team is on this pull request because a branch policy put it there, and removing it here would not last.'
  }
  if (reviewer.vote !== 0) {
    return 'This reviewer has voted, and removing them would discard their vote. Azure DevOps is where to undo that.'
  }

  return null
}

/** Asking somebody: what pressing does, who is in flight, what came back. */
export interface Invite {
  readonly run: (person: ReviewerCandidate, isRequired: boolean) => void
  /**
   * The identity id being written, or `null` — the value rather than a boolean,
   * `VoteControl`'s reason: the field can name who it is waiting on.
   */
  readonly pending: string | null
  readonly error: string | null
  readonly dismiss: () => void
}

export function useInviteReviewer(ref: PullRequestRef): Invite {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (asked: { readonly reviewerId: string; readonly isRequired: boolean }) => {
      const result = await inviteReviewer({ data: { ...ref, ...asked } })
      // A refusal the server *returns* is still a failure this control has to
      // report; react-query only calls something a failure if it rejects.
      // Reconciled here, as in `useVote` and `useRequeue`.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure as well, `useVote`'s rule: a write whose response was lost may
    // well have been applied (`ado-client.ts` note 2), and only the re-read knows
    // whether the reviewer is there. Awaited, so the list is ADO's answer by the
    // time the field comes back.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  return {
    // The candidate rather than an id, so the call site cannot pass a descriptor
    // by mistake: `ReviewerCandidate.identityId` is the field that crossed the gap
    // and `descriptor` is the one that would 400 (identity-contract).
    run: (person, isRequired) => mutation.mutate({ reviewerId: person.identityId, isRequired }),
    pending:
      mutation.isPending && mutation.variables !== undefined
        ? mutation.variables.reviewerId
        : null,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}

/** Taking somebody off. `Invite`'s shape, one field lighter — there is nothing to require. */
export interface Withdraw {
  readonly run: (reviewerId: string) => void
  readonly pending: string | null
  readonly error: string | null
  readonly dismiss: () => void
}

export function useWithdrawReviewer(ref: PullRequestRef): Withdraw {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (reviewerId: string) => {
      // `isRequired` is sent because the request shape carries it and the removal
      // does not read it — see `ReviewerRequest`. `false` rather than the row's own
      // value, so nothing about this call could be mistaken for changing it.
      const result = await withdrawReviewer({ data: { ...ref, reviewerId, isRequired: false } })
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  return {
    run: (reviewerId) => mutation.mutate(reviewerId),
    pending: mutation.isPending && mutation.variables !== undefined ? mutation.variables : null,
    error: mutation.error === null ? null : mutation.error.message,
    dismiss: () => mutation.reset(),
  }
}
