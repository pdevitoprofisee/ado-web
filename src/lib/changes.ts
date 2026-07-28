import { useQuery } from '@tanstack/react-query'

import { iterationChangesQuery } from '@/server/pull-request-fn'

import type { ChangeSet, FileList, PullRequestRef } from '@/server/pull-request'

// Which changes the Files section is showing. Two views over the same pull
// request:
//
//   combined — every file that differs from the merge base. GitHub's default,
//              ADO's `$compareTo=0`, and what arrives with the page.
//   update k — only what push k changed, `$compareTo=k-1`.
//
// They do not agree, and not because either is wrong. Measured on !24766 (39
// updates): the combined diff holds 294 files, the union of all 39 updates holds
// 299. Six files were touched by an update and then reverted, so they are real
// history and no longer a change; one file appears in the combined diff and in no
// update at all, which is the target branch having moved under the PR. Neither
// view can be derived from the other, which is the argument for having both.

/** Combined, or one update. Named rather than a bare `number | null`, because "the latest update" and "everything" are different questions with the same answer on a one-push PR. */
export type ChangeView = { readonly kind: 'combined' } | { readonly kind: 'update'; readonly iterationId: number }

export const COMBINED: ChangeView = { kind: 'combined' }

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
 * returned as it stands and no request goes out. Only an update costs a call, and
 * `enabled` is what keeps it that way.
 *
 * Switching views is cheap on the second axis too: the blob cache is
 * content-addressed, so a file whose bytes appear in both views is already there,
 * and T-021's viewed marks hang on a blob sha — so a file read in the combined
 * view shows as read in the update that introduced it, when the shas match.
 */
export function useChanges(ref: PullRequestRef, view: ChangeView, combined: FileList): ViewedChanges {
  const update = view.kind === 'update' ? view.iterationId : null

  const query = useQuery({
    queryKey: ['pr-changes', ref.repositoryId, ref.id, update],
    queryFn: () =>
      iterationChangesQuery({
        data: {
          projectId: ref.projectId,
          repositoryId: ref.repositoryId,
          id: ref.id,
          iterationId: update!,
          // What "this update" means: measured from the push before it. Update 1
          // compares against 0, the merge base, so the arithmetic is uniform and
          // there is no first-update special case.
          compareTo: update! - 1,
        },
      }),
    enabled: update !== null,
    // An iteration is immutable — a new push is a new iteration, never an edit to
    // an old one — so this answer cannot go stale. The page polls; without this
    // it would poll a set of files that cannot change.
    staleTime: Infinity,
    // And it cannot be worth fetching twice, so it outlives being unmounted. The
    // gesture this covers is real: reading update 3, flipping to combined to check
    // something, flipping back. Under a finite `gcTime` that is a second call for
    // an answer that was already right.
    gcTime: Infinity,
  })

  if (update === null) return { changes: combined, pending: false, error: null }

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
