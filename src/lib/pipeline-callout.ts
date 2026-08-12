import { useCallback } from 'react'

import { changeThreadStatus } from '@/server/threads-fn'

import type { RefreshRow } from '@/components/use-hydration'
import type { PullRequestRow } from '@/server/inbox'

// The inbox's one write: close the Azure Pipelines callout on a row without
// opening the pull request.
//
// It earns a place in a table that is otherwise all links because it is the one
// comment on a pull request that nobody has to read. The coverage callout is
// re-posted per run, it says the same thing every time, and it is drawn as a
// colleague's comment — see `readPipelineThreads` for why the bot rule misses it
// — so it sits on the row as "somebody is waiting on you" until it is resolved
// one PR at a time.
//
// A promise the caller awaits rather than a `useMutation`, `useSonarResolve`'s
// reason and the same shape: the busy-and-error state belongs to the row that was
// pressed, and one mutation held here would be one mutation for a whole inbox.
//
// Nothing is optimistic. `fixed` is Azure DevOps' word for the button the
// conversation page calls Resolve, and the badge only drops once ADO says it did.

/** What a row is handed: itself, and the callout threads hydration found on it. */
export type ResolveCallout = (
  row: PullRequestRow,
  threads: readonly number[],
) => Promise<void>

/**
 * Resolves every callout thread on one row, then waits for the row to have been
 * re-read.
 *
 * Rejects with what ADO said, so the row can print it: a refusal the server
 * *returns* rather than throws is still a failure, and `ok` is the only field that
 * says so.
 *
 * `refresh` is `useHydration`'s, and it is the whole reason this is not two lines
 * in the component — the badges the write invalidates come from the server's cache
 * on a commit that has not moved, so nothing else on the page would correct them
 * for fifteen minutes.
 */
export function useResolveCallout(refresh: RefreshRow): ResolveCallout {
  return useCallback(
    async (row, threads) => {
      // The button only exists on a row the detail route can address, so this is
      // a guard rather than a case — but it is stated, because the alternative is
      // sending a request with `undefined` in the path.
      if (row.projectId === null || row.repositoryId === null) {
        throw new Error('Azure DevOps did not send the ids this write is addressed by.')
      }
      const ref = { projectId: row.projectId, repositoryId: row.repositoryId, id: row.id }

      try {
        // One at a time, and it stops at the first refusal. Each thread is its own
        // PATCH, so a row holding six callouts would otherwise fire six writes at
        // once and report whichever failed last; sequentially, the row says what
        // went wrong and the re-read below says how far it got.
        for (const threadId of threads) {
          const result = await changeThreadStatus({
            data: { ...ref, threadId, status: 'fixed' },
          })
          if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
        }
      } finally {
        // Re-read after a failure as well, `useRename`'s rule: a write that timed
        // out on the way back may still have been applied, and this is the only
        // thing that knows. Awaited, so the button stays busy until the badges
        // beside it are the ones ADO holds.
        //
        // **Only the row is re-read.** `INBOX_KEY` is left alone, unlike every
        // other write in this app: the list call carries titles, votes and merge
        // state, and resolving a comment changes none of them. Invalidating it
        // would be an org-wide list call to redraw identical rows.
        await refresh(row)
      }
    },
    [refresh],
  )
}
