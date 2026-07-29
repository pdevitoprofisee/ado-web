import { useMemo, useReducer, useRef } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { inboxQuery } from '@/server/inbox-fn'
import { CADENCE, useCadence } from '@/lib/cadence'
import { toggleTheme, useTheme } from '@/lib/theme'
import { PullRequestSection, useInboxSelection } from '@/components/pr-list'
import { useHydration } from '@/components/use-hydration'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

export const Route = createFileRoute('/')({ component: Home })

/**
 * The visible half of dark mode, in the one line on the page that already
 * collects app-level affordances.
 *
 * Here and not in `pr-detail`'s header, which is about the pull request: its
 * toggles are statements about this reading pass, and which sheet the app is
 * drawn on outlives every pull request. The `t` key is bound in the shell, so
 * the diff is not stranded without it.
 *
 * Labelled with where it goes rather than where it is — the sheet you are
 * looking at already tells you that — and drawn as the `connections` link
 * beside it, because the two are the same kind of thing: quiet, textual and one
 * click from the rest of the page.
 */
function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      className="text-ink hover:text-teal-600 underline underline-offset-4"
    >
      {next} mode
    </button>
  )
}

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

  // Both sections as one list, in the order they are read — "Mine" first,
  // matching the order they are rendered in below. Hydration wants it because
  // "visible first" is a property of the page, not of a list: the top of
  // "Assigned to me" is above the fold long before the bottom of "Mine" is, and
  // `j`/`k` want it for the same reason. Reordering the sections without
  // reordering this array is the one edit that breaks both silently.
  const rows = useMemo(
    () => [...(inbox?.mine ?? []), ...(inbox?.assignedToMe ?? [])],
    [inbox],
  )
  const { hydrationOf, registerList } = useHydration(rows, generation)
  const selectedId = useInboxSelection(rows)

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        {/* The drawn underline goes on an inline span, not on the block: it is
            sized to 100% of its element, so on the <h1> it would rule the whole
            page. It also costs 8px of padding-bottom, which the header's baseline
            alignment absorbs. */}
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="sketch-underline sketch-underline--teal">ado-web</span>
        </h1>
        <p className="text-muted-foreground text-xs">
          {/* Ahead of `connections`, because it goes somewhere you read rather
              than somewhere you configure — and the inbox is the only page that
              can reasonably own the way in: it is where "what happened to my
              other pull requests" is asked from. */}
          <Link to="/history" className="text-ink hover:text-teal-600 underline underline-offset-4">
            history
          </Link>
          {' · '}
          <Link
            to="/onboarding"
            className="text-ink hover:text-teal-600 underline underline-offset-4"
          >
            connections
          </Link>
          {' · '}
          <ThemeToggle />
          {' · '}
          <Kbd>?</Kbd> for shortcuts
        </p>
      </header>

      {/* A box rather than a bare line, so the first second of the app is a page
          with a placeholder drawn on it and not a page missing its content. */}
      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Loading the inbox…
        </p>
      ) : null}

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
          {/* "Mine" first: the pull requests you are shepherding are the ones
              you came to check on, and a review request you have not been asked
              about twice can wait until after them. `rows` above must stay in
              this order — it is what hydration and `j`/`k` read the page as. */}
          <PullRequestSection
            title="Mine"
            rows={inbox.mine}
            empty="You have no open pull requests."
            hydration={hydrationOf}
            listRef={registerList}
            selectedId={selectedId}
          />
          <PullRequestSection
            title="Assigned to me"
            rows={inbox.assignedToMe}
            empty="Nothing waiting on you."
            hydration={hydrationOf}
            listRef={registerList}
            selectedId={selectedId}
          />

          {/* The metadata under the inbox is divided from it by a drawn rule; a
              1px border here would be the one printed line on the page. */}
          <div className="sketch-rule w-full" aria-hidden />

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
                against — see T-008. Set as an annotation, not as more prose:
                it is a gauge reading sitting beside a sentence. */}
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
