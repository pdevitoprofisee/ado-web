import { QueryClient } from '@tanstack/react-query'

// The query client's defaults, which on this app are an Azure DevOps call budget
// rather than a performance preference. Every query here is a server function
// that spends real calls — the pull request page is five of them — so the cost of
// a default is measured in calls, and the two that were wrong out of the box are
// fixed here rather than at each `useQuery`.
//
// Left alone deliberately:
//
//   staleTime — 0, and every query that fetches ADO sets its own. The two polling
//     surfaces set theirs to their cadence so a remount does not stack a fetch on
//     top of the poll; the immutable ones set `Infinity`.
//   refetchOnWindowFocus — on, and `useCadence` depends on it: a hidden tab stops
//     polling entirely, which is only safe because coming back to it refetches.

export function getContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Five minutes is the default, and it is the wrong unit for this app. An
        // iteration's file list and a blob cannot change — they are keyed by a
        // push and by a content sha — so once fetched they should last as long as
        // the tab does. Five minutes means inbox, another pull request, and back
        // re-buys answers that were already correct. The queries that must not go
        // stale still say so themselves; this only stops the cache being emptied
        // underneath them.
        gcTime: 60 * 60_000,
        // Three retries with backoff turns one refused ADO call into four. The
        // failures this app actually sees are 401 on a rotated PAT and 404 on a
        // repository the token cannot read, and neither improves on the second
        // ask. One retry is left for a dropped connection.
        retry: 1,
      },
    },
  })

  return {
    queryClient,
  }
}
export default function TanstackQueryProvider() {}
