import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { pullRequestQuery } from '@/server/pull-request-fn'
import { sonarReportQuery } from '@/server/sonar-fn'
import { CADENCE, useCadence } from '@/lib/cadence'
import { readLineTarget } from '@/lib/line-link'
import { pageTitle } from '@/lib/page-title'
import { pullRequestKey } from '@/lib/requeue'
import { sonarKey } from '@/lib/sonar-resolve'
import { useCommand } from '@/commands/command-provider'
import { PullRequestDetailView } from '@/components/pr-detail'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

import type { DetailTab } from '@/components/pr-detail'
import type { DiffLayout } from '@/lib/diff-contract'

// One pull request. Addressed by GUIDs rather than by the `Project/_git/Repo`
// names ADO puts in its own URLs, because those are what the inbox row already
// carries and what the server function validates by shape — a GUID cannot hold
// a traversal sequence, and all three are interpolated into an ADO path.
//
// **The fetch is a `useQuery` in the component, deliberately not a route
// loader.** `router.tsx` sets `defaultPreload: 'intent'`, so a loader here
// would fire this page's five ADO calls on *hover*, and running a cursor down
// the inbox would spend hundreds of calls on pull requests nobody opened.

export const Route = createFileRoute('/pr/$projectId/$repositoryId/$prId')({
  component: PullRequestPage,
  // The number, drawn the way the rest of the app draws one — `!1234`, which is
  // ADO's own shorthand and what `pr-list` puts in its link titles. Not the pull
  // request's *title*, which would be the better tab if it were reachable: `head`
  // is handed params and loader data, and the paragraph above records why the
  // fetch here is a `useQuery` in the component and not a loader. Two open review
  // tabs are still told apart by their numbers.
  head: ({ params }) => pageTitle(`!${params.prId}`),
})

function PullRequestPage() {
  const { projectId, repositoryId, prId } = Route.useParams()
  const navigate = useNavigate()
  // A poll here is worth more than on the inbox: this is the page you leave
  // open while a build finishes. Same tiering, so a page left open overnight
  // stops rather than asking until morning.
  const refetchInterval = useCadence(CADENCE.pullRequest)

  // Here rather than in the detail view because the page has to widen for it.
  // Two 80-column halves do not fit in the 896px this page is set at, and
  // shrinking the diff to fit is the one thing side-by-side cannot survive.
  const [layout, setLayout] = useState<DiffLayout>('unified')

  // Same reason, one step earlier: a diff tab adds a file tree beside the diff,
  // which the reading width for prose cannot hold either. Not in the URL — a tab
  // is where you are looking, not what the page is, and putting it there would
  // fill the back button with it.
  //
  // The one exception is a permalink, which is somebody else saying where to
  // look. Opening it on the details tab would land the reader on the page and
  // leave the line they were sent to one click away and unnamed.
  const [tab, setTab] = useState<DetailTab>(() =>
    readLineTarget() === null ? 'details' : 'combined',
  )

  // The URL is the one input nobody validated — it can be typed, pasted, or
  // stale. Checked here so a bad id is answered with a sentence instead of a
  // server round trip that throws.
  const id = Number(prId)
  const addressable = Number.isSafeInteger(id) && id > 0

  const query = useQuery({
    // Shared with `useRequeue`, which invalidates this after a build is requeued.
    queryKey: pullRequestKey({ projectId, repositoryId, id }),
    queryFn: () => pullRequestQuery({ data: { projectId, repositoryId, id } }),
    enabled: addressable,
    refetchInterval,
    staleTime: CADENCE.pullRequest,
  })

  // Its own query, and deliberately not polled. This is one ADO call plus three
  // to five SonarCloud ones, and findings only move when a new analysis lands —
  // which the page's own poll is already what tells you about. Sonar publishes no
  // rate-limit budget at all, so the cheapest thing to do with it is ask less.
  const sonar = useQuery({
    // Shared with `useSonarResolve`, which invalidates this after a finding is
    // triaged.
    queryKey: sonarKey({ projectId, repositoryId, id }),
    queryFn: () => sonarReportQuery({ data: { projectId, repositoryId, id } }),
    enabled: addressable,
    staleTime: CADENCE.pullRequest,
  })

  // Esc means "back to the list" here, which is the one place the registry's
  // `nav.back` has somewhere to go. On the inbox it clears the selection.
  useCommand('nav.back', () => void navigate({ to: '/' }))

  const result = query.data

  return (
    <main
      className={cn(
        'mx-auto flex flex-col items-start gap-5 p-8',
        // **One width for all three tabs.** This used to narrow to prose width on
        // the details tab, which meant the header card, the title and the tab strip
        // itself all resized when you switched — so the tab you were aiming at
        // moved while you were clicking it, and every switch was a 150px shove in
        // both directions. Nothing under here caps its measure either: a page that
        // holds still while its content changes width is still a page that jumps.
        //
        // The split-layout widening stays, and is not the same problem: it changes
        // width because you asked for room, from a control that is on screen when
        // you ask, and it does not change when the tab does.
        layout === 'split' ? 'max-w-[1600px]' : 'max-w-[1200px]',
      )}
    >
      <header className="flex w-full items-baseline justify-between gap-4">
        {/* Hover finds the brand navy rather than plain heading ink: this is the
            one link on the page's chrome, and Prof spends `--primary` on exactly
            that. */}
        <Link
          to="/"
          className="text-muted-foreground hover:text-primary flex items-center gap-1.5 text-sm"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} aria-hidden />
          Inbox
        </Link>
        <p className="text-muted-foreground text-xs">
          <Kbd>Esc</Kbd> to go back
        </p>
      </header>

      {!addressable ? (
        <Alert variant="destructive">
          <AlertTitle>That is not a pull request number</AlertTitle>
          <AlertDescription>
            {/* The one place on this page where the offending text is quoted
                back at you, so it is drawn as a chip rather than left to the
                browser's generic monospace. `bg-muted` inside a tinted alert
                still reads: the wash under it is a pen tint, not a surface. */}
            <code className="bg-muted rounded-sm px-1 py-0.5 font-mono">{prId}</code> is not a
            number, so there is nothing to look up. Check the link, or{' '}
            <Link to="/">go back to the inbox</Link>.
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isPending && addressable ? (
        <p className="text-muted-foreground text-sm">
          Loading <span className="font-mono">!{prId}</span>…
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

      {result?.notFound ? (
        <Alert variant="destructive">
          <AlertTitle>No pull request !{prId} here</AlertTitle>
          <AlertDescription>
            Either the link is wrong or it is in a repository this token cannot read. A
            deleted or moved pull request looks the same from here.
          </AlertDescription>
        </Alert>
      ) : null}

      {result?.connected && result.error && !result.notFound ? (
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

      {result?.pullRequest ? (
        <PullRequestDetailView
          pr={result.pullRequest}
          prRef={{ projectId, repositoryId, id }}
          failed={result.failed}
          sonar={sonar.data ?? null}
          layout={layout}
          onLayoutChange={setLayout}
          tab={tab}
          onTabChange={setTab}
        />
      ) : null}

      {/* The same budget line the inbox carries, for the same reason: this page
          is five calls where the inbox is two, and it polls. `.annotation`
          because that is what the line is — a note in the margin about the page
          rather than part of it, and mono keeps the count from reflowing the
          words after it as it climbs. */}
      {result?.rateLimit ? (
        <footer className="annotation w-full">
          <span title={`≥ ${result.rateLimit.cost.toFixed(4)} TSTU billed`}>
            {result.rateLimit.calls} ADO calls this session
          </span>
        </footer>
      ) : null}
    </main>
  )
}
