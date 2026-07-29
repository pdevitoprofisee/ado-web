import { useMutation, useQueryClient } from '@tanstack/react-query'

import { pullRequestKey } from './requeue'
import { setMyVote } from '@/server/pull-request-fn'

import type { PullRequestDetail, PullRequestRef, Vote } from '@/server/pull-request'

// The header's third write: where you stand on this pull request.
//
// Nothing here is optimistic, `merge.ts`' rule and `conversation.ts`' before it,
// and on this control it is the whole point. A vote drawn as cast before ADO has
// taken it is a reviewer told their approval is standing when it may not be — and
// the one thing this page must never do about a vote is overstate it. So the group
// goes quiet, the write goes out, and the badge changes when the re-read says so.
//
// The same reason runs the other way for the reset notice: after voting, "a push
// reset your approval" stays on screen until the re-read disagrees. Re-rendering
// the vote as freshly cast would paper over exactly the fact the notice exists for.

/**
 * The viewer's own vote, as the page last read it.
 *
 * `null` when we cannot say whose vote is whose — an unresolved viewer, which is
 * `PullRequestDetail.viewerId`'s documented `null`. `0` when the viewer is not in
 * the reviewer list at all, because that is what no reviewer row means: no vote.
 * On this org that is the common case rather than an edge — a group is the
 * reviewer, and a person appears only once they have voted.
 *
 * Case-insensitively, because ADO is not consistent about GUID casing between
 * endpoints (`inbox.ts`). A mismatch here would draw somebody's own approval as
 * "no vote" and offer to cast it again.
 */
export function viewerVote(
  pr: Pick<PullRequestDetail, 'reviewers' | 'viewerId'>,
): number | null {
  const me = pr.viewerId
  if (me === null || me === '') return null

  const mine = pr.reviewers.find(
    (reviewer) => reviewer.id !== '' && reviewer.id.toLowerCase() === me.toLowerCase(),
  )

  return mine?.vote ?? 0
}

/**
 * Why voting is not on offer, as a sentence, or `null` when it is.
 *
 * `mergeBlocker`'s shape and its philosophy: the page judges from the state it
 * has, and the server judges again from ADO's own answer. The ticket asks for
 * exactly this — "refused with a reason rather than hidden when it does not
 * apply" — so every branch here is a sentence that goes next to a disabled
 * control rather than a control that quietly is not there.
 *
 * The two judgements are not the same rule written twice. This one is about what
 * to *offer*, and it is allowed to be a beat out of date. `castVote`'s is about
 * what to *send*, is made against a fresh read, and covers the one case this side
 * cannot be trusted on: a `PUT` on a reviewer who does not exist yet creates one,
 * so a stale screen could turn a vote into an add-reviewer write.
 */
export function voteBlocker(
  pr: Pick<PullRequestDetail, 'status' | 'reviewers' | 'viewerId'>,
): string | null {
  if (pr.status !== 'active') {
    if (pr.status === 'completed') {
      return 'This pull request has been completed, so its votes are a record of what happened.'
    }
    if (pr.status === 'abandoned') {
      return 'This pull request has been abandoned. Reactivate it to vote on it again.'
    }

    // ADO's word as-is, `mergeBlocker`'s reason: narrowing a fourth status into
    // one of the two above is how a page tells somebody the wrong thing about
    // their own pull request.
    return `Azure DevOps says this pull request is ${pr.status === '' ? 'in a state it did not name' : pr.status}, not active.`
  }
  if (pr.viewerId === null || pr.viewerId === '') {
    return 'Azure DevOps did not say who this token belongs to, so a vote cannot be attributed.'
  }

  // A team on the pull request is how most reviewing reaches you here:
  // `[Products]\Contributors` is a reviewer on 119 of 163 active PRs, and a member
  // of it is legitimately absent from this list until they vote — ADO's own PUT is
  // what adds them. So a container present means "yours to vote on as far as this
  // page can tell", and ADO settles the membership question itself.
  const me = pr.viewerId.toLowerCase()
  const mine = pr.reviewers.some(
    (reviewer) => reviewer.id !== '' && reviewer.id.toLowerCase() === me,
  )
  const viaTeam = pr.reviewers.some((reviewer) => reviewer.isContainer)

  if (!mine && !viaTeam) {
    return 'You are not a reviewer on this pull request, so there is no vote of yours to set.'
  }

  return null
}

/** One vote group's worth of state: what pressing does, which one is in flight, what came back. */
export interface VoteControl {
  readonly run: (vote: Vote) => void
  /**
   * The vote being written, or `null`. The value rather than a boolean, so the
   * button that was pressed can say so while the other four are simply disabled —
   * a spinner on the whole group tells you something is happening but not what.
   */
  readonly pending: Vote | null
  /** ADO's words, verbatim, or the server's refusal. Cleared by the next attempt. */
  readonly error: string | null
}

export function useVote(ref: PullRequestRef): VoteControl {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (vote: Vote) => {
      const result = await setMyVote({ data: { ...ref, vote } })
      // A refusal the server *returns* is still a failure the group has to report;
      // react-query only calls something a failure if it rejects. Reconciled here,
      // as in `useRequeue` and `useSquashMerge`.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // On failure as well: a write whose response was lost may well have been
    // applied (`ado-client.ts` note 2), and only the re-read knows which vote ADO
    // is holding. Awaited, so the group comes back enabled with the badge already
    // showing what was recorded rather than a beat before it.
    onSettled: () => client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
  })

  const asked = mutation.variables

  return {
    run: (vote) => mutation.mutate(vote),
    pending: mutation.isPending && asked !== undefined ? asked : null,
    error: mutation.error === null ? null : mutation.error.message,
  }
}
