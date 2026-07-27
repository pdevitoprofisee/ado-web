import { useMemo, useReducer, useRef } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { inboxQuery } from '@/server/inbox-fn'
import { CADENCE, useCadence } from '@/lib/cadence'
import { PullRequestSection } from '@/components/pr-list'
import { useHydration } from '@/components/use-hydration'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const refetchInterval = useCadence(CADENCE.inbox)
  // Set by Refresh and consumed by the next run, so the button and the poll can
  // share one query key while meaning different things by it.
  const forceFresh = useRef(false)
  // The same intent, aimed at the other cache: hydration is keyed by commit and
  // a poll never re-asks for a row that has not been pushed to.
  const [generation, refreshed] = useReducer((n: number) => n + 1, 0)
  const query = useQuery({
    queryKey: ['inbox'],
    queryFn: () => {
      const fresh = forceFresh.current
      forceFresh.current = false

      return inboxQuery({ data: { fresh } })
    },
    refetchInterval,
    // The poll is the freshness mechanism; without this, every remount would
    // refetch on top of it.
    staleTime: CADENCE.inbox,
  })
  const result = query.data
  const inbox = result?.inbox ?? null

  // One hook across both sections, because "visible first" is a property of the
  // page, not of a list: the top of "Mine" is above the fold long before the
  // bottom of "Assigned to me" is.
  const { hydrationOf, registerList } = useHydration(
    useMemo(() => [...(inbox?.assignedToMe ?? []), ...(inbox?.mine ?? [])], [inbox]),
    generation,
  )

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">ado-web</h1>
        <p className="text-muted-foreground text-xs">
          <Link to="/onboarding" className="underline underline-offset-4">
            connections
          </Link>
          {' · '}
          <Kbd>?</Kbd> for shortcuts
        </p>
      </header>

      {query.isPending ? <p className="text-muted-foreground text-sm">Loading the inbox…</p> : null}

      {result && !result.connected ? (
        <Alert>
          <AlertTitle>Not connected yet</AlertTitle>
          <AlertDescription>
            Add an Azure DevOps personal access token in{' '}
            <Link to="/onboarding">connections</Link> and the inbox will fill in.
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

      {inbox ? (
        <>
          <PullRequestSection
            title="Assigned to me"
            rows={inbox.assignedToMe}
            empty="Nothing waiting on you."
            hydration={hydrationOf}
            listRef={registerList}
          />
          <PullRequestSection
            title="Mine"
            rows={inbox.mine}
            empty="You have no open pull requests."
            hydration={hydrationOf}
            listRef={registerList}
          />

          <footer className="text-muted-foreground flex w-full items-center gap-3 text-xs">
            {/* The team list is shown because it is the entire reason "Assigned
                to me" is not empty: on this account every assignment is
                team-mediated, so an inbox that looks wrong is usually this. */}
            <span>
              {inbox.identity.displayName ?? inbox.identity.id} ·{' '}
              {inbox.teams.length > 0
                ? inbox.teams.map((team) => team.name).join(', ')
                : 'no teams'}{' '}
              · {inbox.scanned} active PRs scanned
              {inbox.hidden > 0 ? ` · ${inbox.hidden} hidden as over 3 years old` : ''}
            </span>
            {/* The budget, in the only unit that is actually observable. ADO
                sends no `X-RateLimit-Remaining` on any endpoint we call, so a
                running call count is what "left open overnight" gets checked
                against — see T-008. */}
            {result?.rateLimit ? (
              <span title={`≥ ${result.rateLimit.cost.toFixed(4)} TSTU billed`}>
                {result.rateLimit.calls} ADO calls this session
              </span>
            ) : null}
            <Button
              className="ml-auto"
              onPress={() => {
                forceFresh.current = true
                refreshed()
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
