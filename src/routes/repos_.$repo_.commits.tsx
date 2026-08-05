import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { CommitHistory } from '@/components/commit-history'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { pageTitle } from '@/lib/page-title'
import { commitsQuery } from '@/server/local-git-fn'

// One page of a repository's history. The route's job is the fetch; the list is
// `commit-history.tsx`, split out for `repo-list.tsx`'s reason.
//
// **`repos_.$repo_.commits` and the URL is still `/repos/$repo/commits`.** Both
// underscores are load-bearing and for the same reason: a segment without one
// nests, and a nested route renders inside its parent's `<Outlet />`. `repos.tsx`
// has none, so `repos.$repo.commits` would resolve, change the address, and leave
// the repositories list on the screen — which is exactly the trap T-045 fell into
// with one segment. `$repo_` opts this out of `/repos/$repo` as well, because the
// branch diff is not a layout either and a history is not drawn inside a diff.

/**
 * `?ref=` and `?skip=`, both optional.
 *
 * The branch diff's rules, applied to a history. Absent `ref` means *resolve
 * now* — the branch `HEAD` is on — and present means the URL named one. Nothing
 * is persisted: the address is the only memory these pages have, so a link is
 * shareable within the one machine this app runs on and nothing silently walks a
 * different branch than the one the link said.
 *
 * `skip` is a place in the history rather than a pin, so it has a real default and
 * an unreadable value falls back to it. That is the opposite of `ref`, and the
 * difference is what the wrong answer costs: a bad offset shows the top of the
 * history, which is where a reader without an offset was going anyway, whereas a
 * bad ref would show the history of something other than what was asked for.
 */
export interface CommitsSearch {
  readonly ref?: string
  readonly skip?: number
}

/** `undefined` and not `null`, which is what keeps the key out of the URL entirely. */
function pinned(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * An offset, or `undefined` for the top of the history.
 *
 * A number **and** a numeric string are both accepted because both really arrive:
 * a `<Link search={{ skip: 50 }}>` hands over a number, and the same address typed
 * into the bar arrives as text. Zero, a negative, a fraction and a word all become
 * `undefined`, which is the top — and the server refuses a negative offset in
 * words anyway, because `--skip=-1` is a flag that `gitArgs`' leading-dash rule
 * cannot see.
 */
function offset(value: unknown): number | undefined {
  const skip = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(skip) || skip <= 0) return undefined

  return skip
}

/** Exported for its test: the route around it is a fetch, and this is not. */
export function commitsSearch(search: Record<string, unknown>): CommitsSearch {
  return { ref: pinned(search.ref), skip: offset(search.skip) }
}

export const Route = createFileRoute('/repos_/$repo_/commits')({
  component: CommitsPage,
  validateSearch: commitsSearch,
  // The repository and the word, not the ref beside it in the heading: `?ref=` is
  // allowed to be absent, and a tab whose name depended on it would go blank on
  // the common URL.
  head: ({ params }) => pageTitle(`${params.repo} commits`),
})

function CommitsPage() {
  const { repo } = Route.useParams()
  const { ref, skip } = Route.useSearch()

  const query = useQuery({
    // The pin as `null` rather than `undefined`, and the offset with its real
    // default: the history of a named ref and the history of whatever HEAD is on
    // are genuinely different answers, and page 3 is a different answer again.
    queryKey: ['commits', repo, ref ?? null, skip ?? 0],
    queryFn: () => commitsQuery({ data: { slug: repo, ref: ref ?? null, skip: skip ?? 0 } }),
    // `gcTime: 0` and no `staleTime`, exactly as the branch diff reads its change
    // set: you commit and rebase in a terminal, which is another window, so coming
    // back here is a focus and the client's default refetch is what makes this
    // page current. A history of what your disk held ten minutes ago is the one
    // thing it must not be.
    gcTime: 0,
  })

  const result = query.data
  const page = result?.page ?? null

  return (
    <main className="mx-auto flex max-w-4xl flex-col items-start gap-5 p-8">
      <header className="flex w-full flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {/* On an inline span, per index.tsx: the underline is sized to 100% of
              its element, so on the <h1> it would rule the whole page. */}
          <span className="sketch-underline sketch-underline--teal">{repo}</span>
        </h1>
        <p className="text-muted-foreground flex gap-3 text-xs">
          <Link
            to="/repos/$repo"
            params={{ repo }}
            search={{}}
            className="text-ink hover:text-teal-600 underline underline-offset-4"
          >
            branch diff
          </Link>
          <Link to="/repos" className="text-ink hover:text-teal-600 underline underline-offset-4">
            repositories
          </Link>
        </p>
      </header>

      {query.isPending ? (
        <p className="sketch-box sketch-box--quiet text-muted-foreground w-full px-3 py-2 text-sm">
          Reading the history of <span className="font-mono">{repo}</span>…
        </p>
      ) : null}

      {/* **Fails closed with words.** A branch deleted in the terminal after the
          link was made comes back as "No branch named `x` in this repository."
          from the whitelist, and nothing here quietly walks something else
          instead — the sentence is the server's, and the only thing added is a
          click to the history that would have been walked had nothing been
          pinned. */}
      {result?.error ? (
        <Alert variant="destructive">
          <AlertTitle>That history could not be read</AlertTitle>
          <AlertDescription>
            <p>{result.error}</p>
            {ref === undefined && skip === undefined ? (
              <p>
                <Link to="/repos">Back to your repositories</Link>
              </p>
            ) : (
              <p>
                <Link to="/repos/$repo/commits" params={{ repo }} search={{}}>
                  Walk this repository's own branch from the top
                </Link>{' '}
                instead.
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

      {page ? <CommitHistory slug={repo} page={page} /> : null}
    </main>
  )
}
