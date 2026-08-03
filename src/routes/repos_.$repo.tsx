import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { BranchDiff } from '@/components/branch-diff'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import { dirtyCountQuery, localChangesQuery } from '@/server/local-git-fn'

import type { DiffLayout } from '@/lib/diff-contract'

// The branch diff. The route's job is the two fetches and the two widths; the
// page body is `branch-diff.tsx`, split out for `repo-list.tsx`'s reason.
//
// **`repos_` with the underscore, and the URL is still `/repos/$repo`.** Named
// `repos.$repo.tsx` this becomes a *child* of `/repos`, and a child renders
// inside its parent's `<Outlet />` — which the repositories list has none of, so
// the address resolved, the URL changed, and the page stayed the list. The
// trailing underscore opts one segment out of nesting: same path, no parent.
// `repos.tsx` could have grown an `<Outlet />` and an index route instead, but
// the list is not a layout and the diff is not drawn inside it.

/**
 * `?branch=` and `?target=`, both optional.
 *
 * **The first `validateSearch` in this app**, and it exists because the URL is
 * the only memory this page has. Absent means *resolve now* — the branch from
 * `HEAD`, the target off the ladder — and present means pinned. Nothing is
 * persisted: no preferences table, no `localStorage`, because a remembered
 * target silently diffs against a stale base when a repository's default moves,
 * and the mitigation for that is the header, which states the pair always.
 *
 * Neither is checked against anything here. A ref is looked up in the set the
 * server just enumerated for this repository (T-043's whitelist), so the only
 * thing this can usefully reject is the shape — and the only wrong shape is the
 * empty one: `?branch=` with nothing after it is a URL that lost its value
 * somewhere, and reading it as "use HEAD" would show a diff of something other
 * than what the link said. Dropped rather than thrown, because a thrown search
 * error is an error boundary, and this page is meant to be the thing that says
 * what went wrong.
 */
export interface BranchDiffSearch {
  readonly branch?: string
  readonly target?: string
}

/** `undefined` and not `null`, which is what keeps the key out of the URL entirely. */
function pinned(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Exported for its test: the route around it is a fetch, and this is not. */
export function branchDiffSearch(search: Record<string, unknown>): BranchDiffSearch {
  return { branch: pinned(search.branch), target: pinned(search.target) }
}

export const Route = createFileRoute('/repos_/$repo')({
  component: BranchDiffPage,
  validateSearch: branchDiffSearch,
})

function BranchDiffPage() {
  const { repo } = Route.useParams()
  const { branch, target } = Route.useSearch()

  // Here rather than in the view, for the reason the pull request route holds
  // its own: the page has to widen for it, and the view cannot widen the page.
  const [layout, setLayout] = useState<DiffLayout>('unified')

  const query = useQuery({
    // Both pins in the key, as `null` rather than `undefined`: the pinned and
    // the resolved diff of one repository are genuinely different answers, and
    // the pair `(branch, target)` is the whole of what makes them different.
    queryKey: ['local-changes', repo, branch ?? null, target ?? null],
    queryFn: () =>
      localChangesQuery({ data: { slug: repo, branch: branch ?? null, target: target ?? null } }),
    // `gcTime: 0` and no `staleTime`, exactly as `/repos` reads its scan, and
    // for the same reason twice over: you commit and switch branches in a
    // terminal, which is another window, so coming back here is a focus and the
    // client's default refetch is what makes this page current. A diff of what
    // your disk held ten minutes ago is the one thing it must not be.
    gcTime: 0,
  })

  // Its own query because it is the slow one — `status --porcelain=v2` is
  // 107–216 ms — and the diff must not wait behind it. The view draws nothing at
  // all while it is in flight rather than a zero that is about to become a six.
  const dirty = useQuery({
    queryKey: ['dirty-count', repo],
    queryFn: () => dirtyCountQuery({ data: { slug: repo } }),
    gcTime: 0,
  })

  const result = query.data
  const changes = result?.changes ?? null

  // A pinned ref that has gone is the case the way out is for, so it is only
  // offered when something was pinned. With nothing in the search there is no
  // default to fall back *to* — the failure is the repository or the ladder —
  // and a link to the page you are already on is not an escape.
  const isPinned = branch !== undefined || target !== undefined

  return (
    <main
      className={cn(
        'mx-auto flex flex-col items-start gap-5 p-8',
        // The pull request page's two widths, and the same control asks for
        // them. Not `/repos`' `max-w-4xl`: two 80-column halves do not fit in
        // 896px, and shrinking the diff to fit is the one thing side-by-side
        // cannot survive.
        layout === 'split' ? 'max-w-[1600px]' : 'max-w-[1200px]',
      )}
    >
      <header className="flex w-full items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {/* On an inline span, per index.tsx: the underline is sized to 100% of
              its element, so on the <h1> it would rule the whole page. */}
          <span className="sketch-underline sketch-underline--teal">{repo}</span>
        </h1>
        {/* No `Esc to go back` line beside it. The command sheet is a fixed set
            that a test pins to exactly what the two lists and the pull request
            page claim, and a whole-branch diff was not asked to grow it. The
            link is the way out. */}
        <p className="text-muted-foreground text-xs">
          <Link to="/repos" className="text-ink hover:text-teal-600 underline underline-offset-4">
            repositories
          </Link>
        </p>
      </header>

      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Reading <span className="font-mono">{repo}</span>…
        </p>
      ) : null}

      {/* **Fails closed with words.** A branch deleted in the terminal after the
          link was made comes back as "No branch named `x` in this repository."
          from the whitelist, and nothing here quietly diffs something else
          instead — the sentence is the server's, and the only thing added is a
          click to the diff that would have been taken had nothing been pinned. */}
      {result?.error ? (
        <Alert variant="destructive">
          <AlertTitle>That diff could not be taken</AlertTitle>
          <AlertDescription>
            <p>{result.error}</p>
            {isPinned ? (
              <p>
                <Link to="/repos/$repo" params={{ repo }} search={{}}>
                  Diff this repository's own branch against its target
                </Link>{' '}
                instead.
              </p>
            ) : (
              <p>
                <Link to="/repos">Back to your repositories</Link>
              </p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>The server function failed</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {changes ? (
        <BranchDiff
          slug={repo}
          changes={changes}
          dirtyCount={dirty.data?.count ?? null}
          // A returned failure and a thrown one read the same to the line that
          // prints them: the count was not taken. Which of the two it was is not
          // a distinction the header has room to make.
          dirtyError={dirty.isError ? dirty.error.message : (dirty.data?.error ?? null)}
          layout={layout}
          onLayoutChange={setLayout}
        />
      ) : null}
    </main>
  )
}
