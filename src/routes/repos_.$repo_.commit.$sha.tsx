import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { CommitDiff } from '@/components/commit-diff'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { pageTitle } from '@/lib/page-title'
import { cn } from '@/lib/utils'
import { commitChangesQuery } from '@/server/local-git-fn'

import type { DiffLayout } from '@/lib/diff-contract'

// One commit's diff. The route's job is the fetch and the two widths; the page
// body is `commit-diff.tsx`, split out for `repo-list.tsx`'s reason.
//
// **Both underscores again**, per `repos_.$repo_.commits.tsx`: neither `/repos`
// nor `/repos/$repo` has an `<Outlet />`, so a nested spelling would change the
// address and leave the previous page on the screen.

/**
 * `?ref=`, `?skip=` and `?parent=`, all optional.
 *
 * The first two are not this page's own state at all — they are the history page's,
 * carried so the way back is the page you came from rather than the top of
 * whatever branch `HEAD` is on. Nothing here reads them except the link out, which
 * is why an unreadable one is dropped rather than argued with.
 *
 * `parent` is this page's own, and it is the one search key in the app that
 * genuinely changes what is fetched: a merge has more than one parent, so the diff
 * has to name a side. It is 1-based because git is — `HEAD^1` is the first
 * parent — and it is absent for the first parent so the default and the explicit
 * choice are one address rather than two.
 */
export interface CommitSearch {
  readonly ref?: string
  readonly skip?: number
  readonly parent?: number
}

/** `undefined` and not `null`, which is what keeps the key out of the URL entirely. */
function pinned(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A positive integer, or `undefined`.
 *
 * A number **and** a numeric string, because both really arrive: a `<Link
 * search={{ skip: 50 }}>` hands over a number and the same address typed into the
 * bar arrives as text. One rule serves both keys — an offset of 0 is the top,
 * which is the absent case, and a parent 0 does not exist, so for both of them
 * "not a positive integer" and "not given" are the same answer.
 *
 * A too-high `parent` is deliberately **not** rejected here. The server knows how
 * many parents the commit has and says so — "This commit has no parent 3 — it has
 * 2." — and that sentence on the page is worth more than a thrown search error,
 * which is an error boundary and not a page.
 */
function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number <= 0) return undefined

  return number
}

/** Exported for its test: the route around it is a fetch, and this is not. */
export function commitSearch(search: Record<string, unknown>): CommitSearch {
  return {
    ref: pinned(search.ref),
    skip: positive(search.skip),
    parent: positive(search.parent),
  }
}

export const Route = createFileRoute('/repos_/$repo_/commit/$sha')({
  component: CommitPage,
  validateSearch: commitSearch,
  // The abbreviation and the repository. The subject would be the better name and
  // cannot be one: it is not known until the fetch lands, and `%s` folds a whole
  // paragraph — the longest in the sample is 46,490 characters.
  head: ({ params }) => pageTitle(`${params.sha.slice(0, 7)} · ${params.repo}`),
})

function CommitPage() {
  const { repo, sha } = Route.useParams()
  const { ref, skip, parent } = Route.useSearch()

  // Here rather than in the view, for the branch diff's reason: the page has to
  // widen for it, and the view cannot widen the page.
  const [layout, setLayout] = useState<DiffLayout>('unified')

  const query = useQuery({
    // The parent in the key as `null` rather than `undefined`: parent 1 and parent
    // 2 of a merge are two different diffs of one commit.
    queryKey: ['commit-changes', repo, sha, parent ?? null],
    queryFn: () => commitChangesQuery({ data: { slug: repo, sha, parent: parent ?? null } }),
    // `gcTime: 0`, as everywhere the disk is the source. A commit is immutable, so
    // this is the one page where a cache would be sound — but the repository
    // around it is not: the commit can be pruned out from under the page by a
    // rebase and a `gc` in the other window.
    gcTime: 0,
  })

  const result = query.data
  const changes = result?.changes ?? null

  // The way back, with whatever the history page sent. Built once because both the
  // header and the failure alert offer it, and they must not disagree about where
  // back is.
  const history = {
    to: '/repos/$repo/commits' as const,
    params: { repo },
    search: { ref, skip },
  }

  return (
    <main
      className={cn(
        'mx-auto flex flex-col items-start gap-5 p-8',
        // The pull request page's two widths, and the same control asks for them.
        layout === 'split' ? 'max-w-[1600px]' : 'max-w-[1200px]',
      )}
    >
      <header className="flex w-full flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {/* On an inline span, per index.tsx: the underline is sized to 100% of
              its element, so on the <h1> it would rule the whole page. */}
          <span className="sketch-underline sketch-underline--teal">{repo}</span>
        </h1>
        <p className="text-muted-foreground flex gap-3 text-xs">
          <Link {...history} className="text-ink hover:text-teal-600 underline underline-offset-4">
            commits
          </Link>
          <Link to="/repos" className="text-ink hover:text-teal-600 underline underline-offset-4">
            repositories
          </Link>
        </p>
      </header>

      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Reading <span className="font-mono">{sha.slice(0, 7)}</span>…
        </p>
      ) : null}

      {/* **Fails closed with words**, and this is the page where that matters
          most: a branch rewritten in a terminal after the link was made leaves a
          sha that resolves to nothing, and the sentence for it is the server's
          own — "This repository has no commit with that id." Nothing here falls
          back to a neighbouring commit, and the offer is the history it came
          from, which still exists. */}
      {result?.error ? (
        <Alert variant="destructive">
          <AlertTitle>That commit could not be read</AlertTitle>
          <AlertDescription>
            <p>{result.error}</p>
            <p>
              <Link {...history}>Back to this repository's history</Link>
            </p>
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
        <CommitDiff slug={repo} changes={changes} layout={layout} onLayoutChange={setLayout} />
      ) : null}
    </main>
  )
}
