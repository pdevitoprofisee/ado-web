import { useRef } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { historyQuery } from '@/server/history-fn'
import { CADENCE } from '@/lib/cadence'
import { PullRequestSection, useInboxSelection } from '@/components/pr-list'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/history')({ component: HistoryPage })

function HistoryPage() {
  // Set by Refresh and consumed by the next run, exactly as on the inbox, so the
  // button and the query can share one key while meaning different things by it.
  const forceFresh = useRef(false)
  const query = useQuery({
    queryKey: ['history'],
    queryFn: () => {
      const fresh = forceFresh.current
      forceFresh.current = false

      return historyQuery({ data: { fresh } })
    },
    // No `refetchInterval`: nothing on this page changes on its own. Refresh is
    // the whole freshness mechanism, and the long stale time is what stops a
    // second visit from paying for the same two calls again.
    staleTime: CADENCE.history,
  })
  const result = query.data
  const history = result?.history ?? null
  // One section, so this is the section — but `j`/`k` are the app's way of moving
  // through a list of pull requests, and a page of them that ignored them would
  // read as broken rather than as out of scope.
  const selectedId = useInboxSelection(history?.rows ?? [])

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          {/* The underline goes on an inline span for the reason index.tsx
              records: it is sized to 100% of its element, so on the <h1> it
              would rule the whole page. */}
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="sketch-underline sketch-underline--teal">History</span>
          </h1>
          <p className="text-muted-foreground text-xs">
            Pull requests you wrote that are finished — completed or abandoned.
          </p>
        </div>
        <p className="text-muted-foreground text-xs">
          <Link to="/" className="text-ink hover:text-teal-600 underline underline-offset-4">
            inbox
          </Link>
        </p>
      </header>

      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Loading your closed pull requests…
        </p>
      ) : null}

      {result && !result.connected ? (
        <Alert>
          <AlertTitle>Not connected yet</AlertTitle>
          <AlertDescription>
            Add an Azure DevOps personal access token in{' '}
            <Link to="/onboarding">connections</Link> and this page will fill in.
          </AlertDescription>
        </Alert>
      ) : null}

      {result?.connected && result.error ? (
        <Alert variant="destructive">
          <AlertTitle>Azure DevOps did not answer</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>The server function failed</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {history ? (
        <>
          {/* No `hydration` prop, and that is the design: a closed pull request
              has no check state worth 1+N calls. Every row renders its outcome
              in the cell the inbox reserves for badges. */}
          <PullRequestSection
            title="Closed"
            rows={history.rows}
            empty="You have no completed or abandoned pull requests."
            selectedId={selectedId}
          />

          <div className="sketch-rule w-full" aria-hidden />

          <footer className="text-muted-foreground flex w-full items-center gap-3 text-xs">
            {/* Both halves of the bound are stated, and the second one is stated
                only when it is true. `capped` means ADO filled a request to the
                brim, so there is older history behind this page; its absence is
                *not* proof of completeness — this endpoint returns short pages
                even when more exist — so the sentence claims neither. */}
            <span>
              {history.rows.length} closed · newest {history.perOutcome} of each outcome
              {history.capped
                ? ` · Azure DevOps had at least that many, so there is older history this page does not reach`
                : ''}
            </span>
            {result?.rateLimit ? (
              <span
                className="annotation"
                title={`≥ ${result.rateLimit.cost.toFixed(4)} TSTU billed`}
              >
                {result.rateLimit.calls} ADO calls this session
              </span>
            ) : null}
            <Button
              className="ml-auto"
              onPress={() => {
                forceFresh.current = true
                void query.refetch()
              }}
              isDisabled={query.isFetching}
            >
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </footer>
        </>
      ) : null}
    </main>
  )
}
