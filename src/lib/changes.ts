import { useQuery } from '@tanstack/react-query'

import { iterationChangesQuery, prCommitChangesQuery } from '@/server/pull-request-fn'

import type { Thread, VoteEvent } from './comment-contract'
import type { ChangeSet, FileList, Iteration, PullRequestRef } from '@/server/pull-request'

// Which changes the Files section is showing. Four views over the same pull
// request:
//
//   combined — every file that differs from the merge base. GitHub's default,
//              ADO's `$compareTo=0`, and what arrives with the page.
//   update k — only what push k changed, `$compareTo=k-1`.
//   since    — an arbitrary range, `$compareTo=j` against head. What a reviewer
//              coming back to a 39-push pull request is actually asking.
//   commit   — what one commit changed against its first parent. Not an
//              iteration at all, so it is asked of the repository instead.
//
// The first two do not agree, and not because either is wrong. Measured on
// !24766 (39 updates): the combined diff holds 294 files, the union of all 39
// updates holds 299. Six files were touched by an update and then reverted, so
// they are real history and no longer a change; one file appears in the combined
// diff and in no update at all, which is the target branch having moved under the
// PR. Neither view can be derived from the other, which is the argument for
// having both — and the same argument is why the range is asked for as a range
// rather than assembled here out of the updates it spans.

/** Everything between two iterations. `compareTo` is carried rather than derived, which is the whole difference from `update`. */
export interface SinceView {
  readonly kind: 'since'
  readonly iterationId: number
  readonly compareTo: number
}

/** Combined, one update, or a range. Named rather than a bare `number | null`, because "the latest update" and "everything" are different questions with the same answer on a one-push PR. */
export type ChangeView =
  | { readonly kind: 'combined' }
  | { readonly kind: 'update'; readonly iterationId: number }
  | SinceView
  | { readonly kind: 'commit'; readonly commitId: string }

export const COMBINED: ChangeView = { kind: 'combined' }

/** The two iterations a view spans, or `null` for the combined diff and a commit, which span none. */
export interface Range {
  readonly iterationId: number
  readonly compareTo: number
}

/**
 * The pair a view names, as ADO is asked for it.
 *
 * The one place a view becomes two numbers. `update` keeps its arithmetic here and
 * nowhere else — measured from the push before it, update 1 against 0, the merge
 * base, so there is no first-update special case — and a range says both ends for
 * itself. Blurring the two would mean a `compareTo` that sometimes means "one back"
 * and sometimes means what it says.
 *
 * Exported because the diff is not the only thing that needs the pair: a comment
 * started on these rows is anchored against the same two iterations the rows were
 * asked for, or "line 40" means line 40 of a file nobody is looking at.
 */
export function viewRange(view: ChangeView): Range | null {
  if (view.kind === 'combined' || view.kind === 'commit') return null
  if (view.kind === 'update') return { iterationId: view.iterationId, compareTo: view.iterationId - 1 }

  return { iterationId: view.iterationId, compareTo: view.compareTo }
}

const EMPTY: ChangeSet = { files: [], truncated: false }

export interface ViewedChanges {
  readonly changes: ChangeSet
  /** An update still loading. The combined view is never pending — it came with the page. */
  readonly pending: boolean
  /** Why the update could not be read, or `null`. The combined view reports through `PullRequestDetail.errors`. */
  readonly error: string | null
}

/**
 * The file list for the selected view.
 *
 * The combined list is not fetched — it is already in hand, so `combined` is
 * returned as it stands and no request goes out. Only a range costs a call, and
 * `enabled` is what keeps it that way.
 *
 * Switching views is cheap on the second axis too: the blob cache is
 * content-addressed, so a file whose bytes appear in both views is already there,
 * and T-021's viewed marks hang on a blob sha — so a file read in the combined
 * view shows as read in the update that introduced it, when the shas match.
 */
export function useChanges(ref: PullRequestRef, view: ChangeView, combined: FileList): ViewedChanges {
  const range = viewRange(view)
  const commitId = view.kind === 'commit' ? view.commitId : null
  const pr = { projectId: ref.projectId, repositoryId: ref.repositoryId, id: ref.id }

  const query = useQuery({
    queryKey:
      commitId !== null
        ? ['pr-commit-changes', ref.repositoryId, commitId]
        : ['pr-changes', ref.repositoryId, ref.id, range?.iterationId ?? null, range?.compareTo ?? null],
    queryFn: () =>
      commitId !== null
        ? prCommitChangesQuery({ data: { ...pr, commitId } })
        : iterationChangesQuery({
            data: { ...pr, iterationId: range!.iterationId, compareTo: range!.compareTo },
          }),
    enabled: range !== null || commitId !== null,
    // An iteration is immutable — a new push is a new iteration, never an edit to
    // an old one — so this answer cannot go stale. A range is two iterations, and a
    // commit is a commit, so both are immutable for the same reason. The page
    // polls; without this it would poll a set of files that cannot change.
    staleTime: Infinity,
    // And it cannot be worth fetching twice, so it outlives being unmounted. The
    // gesture this covers is real: reading update 3, flipping to combined to check
    // something, flipping back. Under a finite `gcTime` that is a second call for
    // an answer that was already right.
    gcTime: Infinity,
  })

  if (view.kind === 'combined') return { changes: combined, pending: false, error: null }

  return {
    // `EMPTY` rather than the combined list while an update loads: showing every
    // file in the pull request under a heading that says "Update 4" is the one
    // mistake this whole feature exists to avoid.
    changes: query.data?.changes ?? EMPTY,
    pending: query.isPending,
    // Two ways to fail and both are the same sentence to the reader: the server
    // function catches an ADO error and returns it, and the call itself can fail
    // to arrive at all.
    error: query.data?.error ?? query.error?.message ?? null,
  }
}

// ---------------------------------------------------------------------------
// Which iteration "my last review" names.
// ---------------------------------------------------------------------------
//
// ADO does not store it. `reviewers[].vote` is a standing number with no date on
// it, so the moment has to be reconstructed from things that are dated: a
// `VoteUpdate` system thread, and my own comments. Whichever is later is when I
// last looked, and the iteration that was head at that moment is where the range
// starts.
//
// **The vote trail nearly was not available.** `toThreadList` drops every system
// thread from `threads` and keeps only a count of them, so the 32-of-56 activity
// trail this derivation needs was being parsed and thrown away. It is now carried
// out as `ThreadList.votes` — a list of dates, not threads, because a vote is not
// a conversation and the diff must not have to step over one.
//
// Both signals can be missing, and on most pull requests both are: a reviewer who
// has never touched this one is the ordinary case. That is `none` with a sentence,
// not a date guessed from something else.

/** What the sentence on the page is about: what I did, and when ADO stamped it. */
export interface ReviewBasis {
  /** The middle of the sentence — "your approval", "your comment". */
  readonly what: string
  readonly at: string
}

export type LastReview =
  /** Nothing to measure from. The reason is shown; no range is offered. */
  | { readonly kind: 'none'; readonly reason: string }
  /** I reviewed, and nothing has been pushed since. Its own sentence, not an empty file list. */
  | { readonly kind: 'current'; readonly basis: ReviewBasis }
  | { readonly kind: 'behind'; readonly basis: ReviewBasis; readonly view: SinceView }

/**
 * ADO's five vote integers as the noun a sentence needs.
 *
 * `voteWord` in `pr-detail.tsx` spells the same integers as verbs, for the
 * reviewer list. Neither reads well in the other's place: "since your approved"
 * and "Naveen approval" are both wrong.
 */
function voteNoun(vote: number): string {
  switch (vote) {
    case 10:
      return 'your approval'
    case 5:
      return 'your approval with suggestions'
    case -5:
      return 'your waiting-for-author vote'
    case -10:
      return 'your rejection'
    default:
      return 'your vote'
  }
}

/** ADO is not consistent about GUID casing between endpoints, and this is an identity comparison. */
const mine = (id: string, viewerId: string): boolean =>
  id !== '' && id.toLowerCase() === viewerId.toLowerCase()

/** `null` for a date ADO did not send or did not send as a date. */
function stamp(iso: string): number | null {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/**
 * When I last reviewed, and therefore what to compare against now.
 *
 * A vote wins a tie with a comment of the same instant: ADO writes the vote
 * thread when the vote is cast, so the two coinciding means I voted on my own
 * comment, and the vote is the stronger statement about having read the code.
 *
 * The range's near end is the newest iteration created **no later than** that
 * moment — what was head when I looked. Not the iteration a comment was anchored
 * to: `iterationContext` is on anchored threads only, 12 of 56, and a vote has
 * none at all, so it would answer for a minority of the cases and leave the rest
 * to a second rule.
 */
export function lastReview(
  viewerId: string | null,
  threads: readonly Thread[],
  votes: readonly VoteEvent[],
  iterations: readonly Iteration[],
): LastReview {
  if (viewerId === null || viewerId === '') {
    return {
      kind: 'none',
      reason: 'Azure DevOps did not say who you are, so there is no review of yours to find.',
    }
  }

  let basis: ReviewBasis | null = null
  let reviewedAt = -Infinity

  for (const vote of votes) {
    const at = stamp(vote.at)
    if (at === null || !mine(vote.voterId, viewerId) || at < reviewedAt) continue

    reviewedAt = at
    basis = { what: voteNoun(vote.vote), at: vote.at }
  }

  for (const thread of threads) {
    for (const comment of thread.comments) {
      const at = stamp(comment.publishedDate)
      // `<=` and not `<`: a vote already claimed the tie above.
      if (at === null || comment.isDeleted || !mine(comment.author.id, viewerId) || at <= reviewedAt) {
        continue
      }

      reviewedAt = at
      basis = { what: 'your comment', at: comment.publishedDate }
    }
  }

  if (basis === null) {
    return {
      kind: 'none',
      reason: 'You have not voted or commented here, so there is nothing to measure from.',
    }
  }

  let head = 0
  let dated = 0
  let compareTo = 0

  for (const iteration of iterations) {
    if (iteration.id > head) head = iteration.id

    const created = stamp(iteration.createdAt)
    if (created === null) continue

    dated += 1
    if (created <= reviewedAt && iteration.id > compareTo) compareTo = iteration.id
  }

  if (head === 0) {
    return { kind: 'none', reason: 'This pull request has no updates to compare.' }
  }
  // Undated updates would leave `compareTo` at zero, and zero is the merge base —
  // a valid pair that answers the combined diff. Under a heading naming a range
  // that is the wrong answer the range check in `pull-request-fn.ts` exists to
  // stop, arrived at from the other side.
  if (dated === 0) {
    return { kind: 'none', reason: 'Azure DevOps did not date these updates, so a range cannot be placed against them.' }
  }
  if (compareTo >= head) return { kind: 'current', basis }

  return { kind: 'behind', basis, view: { kind: 'since', iterationId: head, compareTo } }
}
