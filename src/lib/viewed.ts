import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fileViewedKey } from './viewed-key'
import { markViewed, viewedQuery } from '@/server/viewed-fn'

import type { ViewedListResult } from '@/server/viewed-fn'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// The file list's half of T-021. `@/server/viewed` is the store; this is the
// set the page reads and the tick that changes it.
//
// The whole mark round-trips to local SQLite, which is fast but not free and
// not synchronous, so the cache is written first and the call is sent after.
// Ticking a checkbox has to land on the frame it was clicked on — a checkbox
// that lags is a checkbox you click twice.

/** The empty answer, so a page that has not loaded its marks yet still renders. */
const NONE: ReadonlySet<string> = new Set()

export interface ViewedFiles {
  /** Keys, not paths. Test a row with `fileViewedKey`. */
  readonly keys: ReadonlySet<string>
  /**
   * The marks have not arrived yet.
   *
   * Worth waiting on rather than treating as "nothing is marked", because a file
   * panel decides whether to start expanded once, when it mounts: rendering the
   * list a tick early opens all forty files on a pull request that was half read
   * yesterday, and nothing shuts them again. False once the read fails, too — a
   * broken marks table should cost the marks, not the diff.
   */
  readonly pending: boolean
  readonly setViewed: (file: ChangedFile, viewed: boolean) => void
}

export function useViewedFiles(ref: PullRequestRef): ViewedFiles {
  const client = useQueryClient()

  // No `projectId`: the server function does not take one, so putting it in the
  // key would only invalidate the same answer twice.
  const key = ['viewed', ref.repositoryId, ref.id] as const

  const query = useQuery({
    queryKey: key,
    queryFn: () => viewedQuery({ data: { repositoryId: ref.repositoryId, id: ref.id } }),
    // Nothing else writes this table, and the mutation below already updates the
    // cache, so a refetch could only ever return what is already here. The pull
    // request page polls; without this it would poll this too.
    staleTime: Infinity,
  })

  const mutation = useMutation({
    mutationFn: (input: { file: ChangedFile; viewed: boolean }) =>
      markViewed({
        data: {
          repositoryId: ref.repositoryId,
          id: ref.id,
          path: input.file.path,
          objectId: input.file.objectId,
          originalObjectId: input.file.originalObjectId,
          viewed: input.viewed,
        },
      }),
    // Nothing on error. A failed mark leaves the box ticked and the row missing,
    // which is wrong — but silently un-ticking a box the reviewer just ticked is
    // worse, and the honest fix is a message this page has nowhere to put yet.
    // Written down rather than papered over; see T-021's resolution.
    onSuccess: (result) => {
      client.setQueryData<ViewedListResult>(key, (current) => {
        const keys = new Set(current?.keys ?? [])
        if (result.viewed) keys.add(result.key)
        else keys.delete(result.key)

        return { keys: [...keys] }
      })
    },
  })

  // Optimistic without `onMutate`: the mutation's own variables are enough,
  // because the last click wins either way and the server's answer replaces this
  // a moment later. `pending` is a single mutation's state — clicking two boxes
  // quickly keeps both, because each `setQueryData` above is applied to the
  // result of the one before it.
  const pending = mutation.variables
  const optimistic = pending === undefined ? null : fileViewedKey(pending.file)

  let keys: ReadonlySet<string> = query.data ? new Set(query.data.keys) : NONE

  if (optimistic !== null && mutation.isPending) {
    const next = new Set(keys)
    if (pending!.viewed) next.add(optimistic)
    else next.delete(optimistic)
    keys = next
  }

  return {
    keys,
    pending: query.isPending,
    setViewed: (file, viewed) => {
      // A change entry with a blob on neither side has nothing for a mark to be
      // about, and `markViewed` rejects it. Nothing in a live payload has ever
      // been one, so this is a guard rather than a case.
      if (fileViewedKey(file) === null) return
      mutation.mutate({ file, viewed })
    },
  }
}
