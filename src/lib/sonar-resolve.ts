import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { resolveSonarFinding } from '@/server/sonar-fn'

import type { SonarActions } from '@/components/sonar/panel'
import type { PullRequestRef } from '@/server/pull-request'

// The findings panel's one write: triage a finding without leaving this page.
//
// A promise the caller awaits rather than a `useMutation`, for `useRename`'s
// reason — the busy-and-error state belongs to the row that was clicked, and a
// mutation held up here would be one mutation for a panel that can hold three
// hundred rows.
//
// **Only the Sonar query is re-read**, even though the write touches Azure DevOps
// too. The thread it closes is a bot thread, and `toThreadList` counts those and
// then drops them — so nothing the conversation draws changes, and `botCount`
// counts a resolved Sonar comment exactly as it counted an open one. Re-reading
// the conversation would be two ADO calls to redraw the same numbers.

/** Shared with the route, which owns the query this write invalidates. */
export const sonarKey = (ref: PullRequestRef) =>
  ['sonar', ref.projectId, ref.repositoryId, ref.id] as const

/**
 * Triages one finding, then waits for the panel to have re-read the list.
 *
 * Returns Sonar's answer rather than throwing on a refusal: the two halves of
 * this write fail separately, and the row prints a different sentence for "Sonar
 * said no" than for "Sonar agreed and the comment is still open". A call that
 * never arrived still rejects, and the row reports that as a failure.
 */
export function useSonarResolve(ref: PullRequestRef): SonarActions {
  const client = useQueryClient()

  return useMemo<SonarActions>(
    () => ({
      onResolve: async (request) => {
        try {
          return await resolveSonarFinding({ data: { ...ref, ...request } })
        } finally {
          // Re-read after a refusal as well, `useRename`'s rule: a transition
          // that timed out on the way back may still have been applied, and the
          // list is the only thing that knows. Awaited, so the button stays busy
          // until the row it is in is the row Sonar holds.
          await client.invalidateQueries({ queryKey: sonarKey(ref) })
        }
      },
    }),
    [client, ref.projectId, ref.repositoryId, ref.id],
  )
}
