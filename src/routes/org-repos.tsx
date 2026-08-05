import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { orgRepositoriesQuery } from '@/server/repositories-fn'
import { pageTitle } from '@/lib/page-title'
import { OrgRepositoryList } from '@/components/org-repo-list'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export const Route = createFileRoute('/org-repos')({
  component: OrgRepositoriesPage,
  head: () => pageTitle('Org repositories'),
})

/**
 * The organisation's repositories.
 *
 * **A new address, not `/repos`.** That one is the repositories on this disk and it
 * stays that way: the map is explicit that two descriptions of one route is how
 * they drift. The two link to each other and neither claims to be the other's list.
 *
 * No child route here on purpose. If one is ever added, this file has to become
 * `org-repos_.tsx` — the trailing-underscore trap T-045 walked into, where a child
 * route silently makes the parent a layout and the page stops rendering.
 */
function OrgRepositoriesPage() {
  const query = useQuery({
    queryKey: ['org-repositories'],
    queryFn: () => orgRepositoriesQuery(),
    // One call, 100 KB, and it only changes when somebody creates a repository.
    // The app-wide hour is exactly right for that, so there is nothing to
    // override — no `gcTime: 0` like the local list, which is re-read because you
    // cloned something in another window, and no Refresh button, because leaving
    // and coming back is already a refetch on focus.
  })
  const result = query.data
  const repositories = result?.repositories ?? null

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          {/* The underline goes on an inline span for the reason index.tsx
              records: it is sized to 100% of its element, so on the <h1> it
              would rule the whole page. */}
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="sketch-underline sketch-underline--teal">Org repositories</span>
          </h1>
          <p className="text-muted-foreground text-xs">
            Every git repository in the Azure DevOps organisation, in one call. Nothing on this
            page reads your disk.
          </p>
        </div>
        <p className="text-muted-foreground text-xs">
          <Link to="/" className="text-ink hover:text-teal-600 underline underline-offset-4">
            inbox
          </Link>
          {' · '}
          <Link to="/repos" className="text-ink hover:text-teal-600 underline underline-offset-4">
            your repositories
          </Link>
        </p>
      </header>

      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Asking Azure DevOps for the list…
        </p>
      ) : null}

      {/* Not connected is a setup step, so it says where to go rather than
          reading as a failure. */}
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

      {repositories ? (
        <>
          <OrgRepositoryList rows={repositories.rows} returned={repositories.returned} />

          <div className="sketch-rule w-full" aria-hidden />

          <footer className="text-muted-foreground flex w-full items-center gap-3 text-xs">
            {/* The absence, stated once, where somebody would otherwise go looking
                for the column. */}
            <span>
              One request to <span className="font-mono">_apis/git/repositories</span>, across every
              project. There is no "last updated" — a repository in Azure DevOps carries no
              timestamp at all.
            </span>
          </footer>
        </>
      ) : null}
    </main>
  )
}
