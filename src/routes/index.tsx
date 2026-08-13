import { useId, useMemo, useReducer, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TextField, ToggleButton } from 'react-aria-components'
import { BoardMathIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { inboxQuery } from '@/server/inbox-fn'
import { CADENCE, useCadence } from '@/lib/cadence'
import { INBOX_KEY, dropInboxRow, settleMergedRow } from '@/lib/inbox-cache'
import { pageTitle } from '@/lib/page-title'
import { useResolveCallout } from '@/lib/pipeline-callout'
import { inReadingOrder, useGroupByRepository } from '@/lib/pr-grouping'
import { SEARCHES, filterPullRequests } from '@/lib/pr-search'
import { useRequeueRow } from '@/lib/requeue'
import { useRoomyRows } from '@/lib/row-density'
import { toggleTheme, useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { MergeDialog } from '@/components/merge-dialog'
import { PullRequestSection, useInboxSelection } from '@/components/pr-list'
import { useHydration } from '@/components/use-hydration'
import { useObserve } from '@/components/notifications/use-notifications'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'

import type { KeyboardEvent, ReactNode } from 'react'
import type { AddressableRow } from '@/components/pr-list'
import type { PullRequestRow } from '@/server/inbox'
import type { Role, WatchedPullRequest } from '@/server/notifications'

export const Route = createFileRoute('/')({
  component: Home,
  // "Inbox" and not "ado-web", which the root already says: the tab has to
  // distinguish this page from the five others, not name the app twice.
  head: () => pageTitle('Inbox'),
})

/** The rows of one inbox section, as much of them as detection can use. */
function watchable(rows: readonly PullRequestRow[], role: Role): WatchedPullRequest[] {
  return rows.flatMap((row) =>
    row.commitId && row.projectId && row.repositoryId
      ? [
          {
            prId: row.id,
            title: row.title,
            projectId: row.projectId,
            repositoryId: row.repositoryId,
            role,
            commitId: row.commitId,
          },
        ]
      : [],
  )
}

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

/**
 * How a remembered view preference is drawn in this toolbar.
 *
 * `data-selected` is React Aria's, and it is styled up to the filled `default`
 * variant rather than left as an outline with a wash: these are the controls on
 * the page that stay switched on across sessions, and they have to be legible as
 * "on" at a glance the next morning.
 */
const TOGGLE = cn(
  buttonVariants({ variant: 'outline', size: 'sm' }),
  'data-[selected]:border-primary data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[selected]:hover:border-ink-900 data-[selected]:hover:bg-ink-900',
)

/**
 * The controls that decide what the sections below show: what has been typed, how
 * the rows are arranged, and how much room each one gets.
 *
 * One row, above both sections, because every control here acts on both sections
 * — a search box per section would be two boxes asking the same question, and an
 * arrangement toggle per section would let the page hold two answers to "how is
 * this arranged".
 */
function InboxControls({
  query,
  onQuery,
  grouped,
  onGrouped,
  roomy,
  onRoomy,
  listId,
}: {
  query: string
  onQuery: (next: string) => void
  grouped: boolean
  onGrouped: (next: boolean) => void
  roomy: boolean
  onRoomy: (next: boolean) => void
  /** What the box controls, for anyone who cannot see the sections move. */
  listId: string
}) {
  // Escape is handled here rather than through `nav.back`, because the command
  // layer deliberately ignores keys typed into a text field (`isTextEntry`). In
  // the box, "never mind" means the search rather than the selection — and it
  // takes two presses to leave, which is the right order: clearing the filter is
  // the more common intent and the more destructive one to get wrong.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    if (query === '') {
      event.currentTarget.blur()
      return
    }
    onQuery('')
  }

  return (
    <div className="flex w-full items-center gap-3">
      {/* **Not autofocused**, the same deliberate choice `org-repo-list.tsx`
          records: the command layer ignores every key typed into a text field,
          so a focused box would take `j`, `k` and Enter away from the list for
          as long as it held focus. It is the first focusable thing in the main
          content, so it is one Tab away. */}
      <TextField
        aria-label={`Search pull requests by ${SEARCHES}`}
        value={query}
        onChange={onQuery}
        className="max-w-sm flex-1"
      >
        <Input
          type="search"
          placeholder="Title, repository or description"
          aria-controls={listId}
          onKeyDown={onKeyDown}
        />
      </TextField>

      {/* Toggle buttons rather than the header's `dark mode` link, and the
          difference is on purpose: that one names where a press *goes*, because
          a theme has no state to show — the sheet you are on already tells you.
          These have state worth showing, so each names its arrangement and holds
          `aria-pressed`. Naming the destination here would give one control two
          labels for one setting.

          Both name what they do to the rows rather than which of two views is
          on, because both are off by default: a label that read `Condensed rows`
          would be a control that is switched off while describing what you are
          looking at.

          Grouping keeps the right-hand end it has always had, and the newer
          toggle takes the space that opened up to its left. */}
      <ToggleButton isSelected={roomy} onChange={onRoomy} className={cn(TOGGLE, 'ml-auto')}>
        Two-line rows
      </ToggleButton>
      <ToggleButton isSelected={grouped} onChange={onGrouped} className={TOGGLE}>
        Group by repository
      </ToggleButton>
    </div>
  )
}

function Home() {
  const refetchInterval = useCadence(CADENCE.inbox)
  // Set by Refresh and consumed by the next run, so the button and the poll can
  // share one query key while meaning different things by it.
  const forceFresh = useRef(false)
  // The same intent, aimed at the other cache: a poll re-asks for every row but
  // lets the server answer settled ones from sqlite, and this is how Refresh
  // says "ask Azure DevOps anyway".
  const [generation, refreshed] = useReducer((n: number) => n + 1, 0)
  const query = useQuery({
    // Shared with `useRename`, which corrects this row and marks it stale after
    // a pull request is given a different title.
    queryKey: INBOX_KEY,
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

  const [search, setSearch] = useState('')
  const [grouped, setGrouped] = useGroupByRepository()
  const [roomy, setRoomy] = useRoomyRows()
  const searched = useId()

  // What each section actually draws. The unfiltered arrays stay reachable as
  // `inbox.mine` / `inbox.assignedToMe`, and the headings below use them to say
  // "3 of 9" — a section that silently shrinks under a search reads as pull
  // requests having gone away.
  const mine = useMemo(() => filterPullRequests(inbox?.mine ?? [], search), [inbox, search])
  const assigned = useMemo(
    () => filterPullRequests(inbox?.assignedToMe ?? [], search),
    [inbox, search],
  )

  // Both sections as one list, in the order they are read — "Mine" first,
  // matching the order they are rendered in below, and through `inReadingOrder`
  // so that grouping moves this in step with the page. `j`/`k` want exactly
  // this: reordering the sections, or grouping them, without reordering this
  // array is the one edit that breaks the keyboard silently.
  const selectable = useMemo(
    () => [...inReadingOrder(mine, grouped), ...inReadingOrder(assigned, grouped)],
    [mine, assigned, grouped],
  )
  const selectedId = useInboxSelection(selectable)

  // Hydration gets the *unfiltered* rows, and that difference is the point.
  // `useHydration` keys on the content of what it is handed, so filtering here
  // would make every keystroke a new set of targets and a fresh round trip — and
  // it would leave a row you just revealed by clearing the box wearing no
  // badges. A search narrows what is on screen; finding out what these pull
  // requests are doing is the same work either way. Ungrouped too, and for the
  // same reason: the visible-first ordering this list feeds is only the
  // tiebreak, and the hook settles it by measuring the DOM — where a
  // filtered-out row is simply not present and a grouped one is already in the
  // order the page drew it.
  //
  // `dataUpdatedAt` is the poll's tick, and hydration rides it for the same
  // reason the notification panel below does: the inbox is the only clock in the
  // app, and badges that only ever redraw on a push are badges that go stale
  // quietly.
  const rows = useMemo(
    () => [...(inbox?.mine ?? []), ...(inbox?.assignedToMe ?? [])],
    [inbox],
  )
  const { hydrationOf, registerList, refresh } = useHydration(rows, generation, query.dataUpdatedAt)
  // The inbox's two writes, wired here rather than inside the list because
  // `refresh` is what each one owes the row afterwards — the buttons are in
  // `pr-list`, the cache they correct is this hook's.
  const onResolveCallout = useResolveCallout(refresh)
  const onRequeue = useRequeueRow(refresh)

  // The third write is a dialog rather than a press, so the row it was opened on
  // is state and not an argument. One dialog for the page: a merge needs the
  // pull request read and a commit message written, and hundreds of rows each
  // holding a query for that would read the whole table to draw one button.
  const [merging, setMerging] = useState<AddressableRow | null>(null)
  const client = useQueryClient()

  /**
   * Said the same way in both sections: what was searched, and what it was
   * searched in. Without the second half a missing row reads as the app being
   * wrong rather than as the description having been cut off at 400 characters.
   */
  const noMatch = (subject: string): ReactNode => (
    <>
      No {subject} matches <code className="font-mono">{search}</code>. Searching {SEARCHES}.
    </>
  )

  // What the notification panel is allowed to notice. Built from the two
  // sections separately because which one a row came from is the only place the
  // app knows whether this pull request is mine or one I am reviewing — the list
  // entry carries an author *name* and no author id — and "someone voted on my
  // PR" and "a PR I am reviewing got new commits" are different events.
  //
  // A row missing any of the three ids is skipped rather than defaulted: those
  // are what the panel links with, and a notification you cannot open is worse
  // than one you never got.
  const watched = useMemo(
    () => [
      ...watchable(inbox?.mine ?? [], 'author'),
      ...watchable(inbox?.assignedToMe ?? [], 'reviewer'),
    ],
    [inbox],
  )
  // Handed over once per poll. The inbox is the only clock in the app and this
  // rides it — nothing here starts an interval of its own.
  useObserve(watched, query.dataUpdatedAt)

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        {/* The drawn underline goes on an inline span, not on the block: it is
            sized to 100% of its element, so on the <h1> it would rule the whole
            page. It also costs 8px of padding-bottom, which the header's baseline
            alignment absorbs. */}
        <h1 className="text-2xl font-semibold tracking-tight">
          {/* The app's mark, and the same one the tab draws — see
              `public/favicon.svg`, which is a hand copy of this icon and has to
              be edited alongside it. A chalkboard because that is what the sheet
              under all of this is: Prof's dark mode is chalk on a deep board,
              and in a tab strip of Azure DevOps pages the thing worth being is
              not another git glyph. It also stays out of the way of `pr-list`,
              where the git family is already spent on merge state.

              Inside the <h1> rather than beside it, so the wordmark stays one
              element and the header's baseline alignment keeps working: a flex
              wrapper would hand the header an <svg> as its first item, and an
              icon has no baseline to align the row on. `inline` because
              Tailwind's preflight makes every svg a block, and
              `align-text-bottom` to sit it on the descender — 24px semibold caps
              reach ~17px above the baseline, so a 22px box left on the baseline
              would stand a full 5px proud of the letters.

              `pen-green` and not `ink`, matching the favicon so the tab and the
              header are one mark; and not `teal-500`, which is the colour of the
              underline beside it and would have made the lockup a single hue.
              teal-500 is 2.83:1 on paper-0, and a mark owes 3:1 — pen-green is
              4.01:1 and clears. The two greens sitting a step apart is the cost
              of that; if it ever reads as two attempts at one colour, the fix is
              to bring the underline down to pen-green, not to bring the mark up.
              */}
          <HugeiconsIcon
            icon={BoardMathIcon}
            size={22}
            className="text-pen-green mr-2 inline align-text-bottom"
            aria-hidden
          />
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
          {/* Beside history and not in the `?` sheet: a page you open once a
              session from a link already on screen has no wording worth printing
              there, and every key it would want is one the list itself claims. */}
          <Link to="/repos" className="text-ink hover:text-teal-600 underline underline-offset-4">
            your repositories
          </Link>
          {' · '}
          {/* "your" and "org" rather than one word twice: these are two lists of
              two different things — what is on this disk, and what exists in Azure
              DevOps — and a single label would send people to the wrong one. */}
          <Link
            to="/org-repos"
            className="text-ink hover:text-teal-600 underline underline-offset-4"
          >
            org repositories
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
          <InboxControls
            query={search}
            onQuery={setSearch}
            grouped={grouped}
            onGrouped={setGrouped}
            roomy={roomy}
            onRoomy={setRoomy}
            listId={searched}
          />

          {/* One id over both sections, because the box narrows both and
              `aria-controls` naming only the first would be a lie about the
              second. */}
          <div id={searched} className="flex w-full flex-col gap-5">
            {/* "Mine" first: the pull requests you are shepherding are the ones
                you came to check on, and a review request you have not been asked
                about twice can wait until after them. `selectable` above must
                stay in this order — it is what `j`/`k` read the page as. */}
            <PullRequestSection
              title="Mine"
              rows={mine}
              total={inbox.mine.length}
              grouped={grouped}
              mine
              roomy={roomy}
              empty={
                inbox.mine.length === 0
                  ? 'You have no open pull requests.'
                  : noMatch('pull request of yours')
              }
              hydration={hydrationOf}
              listRef={registerList}
              selectedId={selectedId}
              onResolveCallout={onResolveCallout}
              onRequeue={onRequeue}
              onMerge={setMerging}
            />
            <PullRequestSection
              title="Assigned to me"
              rows={assigned}
              total={inbox.assignedToMe.length}
              grouped={grouped}
              roomy={roomy}
              empty={
                inbox.assignedToMe.length === 0
                  ? 'Nothing waiting on you.'
                  : noMatch('pull request waiting on you')
              }
              hydration={hydrationOf}
              listRef={registerList}
              selectedId={selectedId}
              onResolveCallout={onResolveCallout}
              onRequeue={onRequeue}
              onMerge={setMerging}
            />
          </div>

          {/* Outside both sections, and mounted whether or not a row is chosen:
              the dialog holds the message somebody typed, and Escape has to be
              able to close it without throwing that away.

              The one write on this page that changes the list rather than a row.
              The callout and the requeue correct a row in place; a merged pull
              request is not open any more, so it leaves the table. */}
          <MergeDialog
            row={merging}
            onClose={() => setMerging(null)}
            onMerged={(merged) => {
              setMerging(null)
              dropInboxRow(client, merged.id)
              void settleMergedRow(client, merged.id)
            }}
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
