import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { repositoriesQuery } from '@/server/local-git-fn'
import { RepositoryList, useRepoSelection } from '@/components/repo-list'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import type { RepositoryEntry } from '@/lib/local-git-contract'

export const Route = createFileRoute('/repos')({ component: RepositoriesPage })

/** Stable identity, so the selection's `useMemo` is not rebuilt every render. */
const NONE: readonly RepositoryEntry[] = []

function RepositoriesPage() {
  const query = useQuery({
    queryKey: ['repositories'],
    queryFn: () => repositoriesQuery(),
    // `gcTime: 0` against the app-wide hour, and no `staleTime`, which together
    // mean this list is **never cached across a scan**: leaving the page throws
    // it away, arriving re-reads it, and the client's default refetch-on-focus
    // covers the case this page is actually for — you clone or switch branches
    // in a terminal, which is another window, and coming back here is a focus.
    //
    // That is also why there is no Refresh button beside the two the inbox and
    // the history page carry. Theirs forces a fresh answer past an ETag; there
    // is no cache here for a button to get past, so it would be a control whose
    // only effect is the one that already happened on the way in.
    gcTime: 0,
  })
  const result = query.data
  const scan = result?.scan ?? null
  const selectedSlug = useRepoSelection(scan?.repositories ?? NONE)

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          {/* The underline goes on an inline span for the reason index.tsx
              records: it is sized to 100% of its element, so on the <h1> it
              would rule the whole page. */}
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="sketch-underline sketch-underline--teal">Repositories</span>
          </h1>
          <p className="text-muted-foreground text-xs">
            The git repositories on this disk. Nothing on this page asks Azure DevOps anything.
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
          Reading your repositories…
        </p>
      ) : null}

      {/* One unreadable repository is a row in the list. Reaching this means the
          scan itself did not happen — `git` could not be started, or a root
          could not be read at all. */}
      {result?.error ? (
        <Alert variant="destructive">
          <AlertTitle>The scan did not finish</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>The server function failed</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {scan ? (
        <>
          <RepositoryList scan={scan} selectedSlug={selectedSlug} />

          <div className="sketch-rule w-full" aria-hidden />

          <footer className="text-muted-foreground flex w-full items-center gap-3 text-xs">
            {/* Where it looked, always — a count of repositories means nothing
                without the directory it counted them in, and this page has four
                different ways of being empty that all turn on that directory. */}
            <span>
              {scan.repositories.length} under{' '}
              <span className="font-mono">{scan.roots.map((root) => root.path).join(' · ')}</span> ·
              one level deep, re-read whenever this window is focused
            </span>
          </footer>
        </>
      ) : null}
    </main>
  )
}
