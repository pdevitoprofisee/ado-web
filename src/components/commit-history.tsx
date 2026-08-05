import { Link } from '@tanstack/react-router'

import { age } from './pr-list'
import { COMMIT_PAGE_SIZE } from '@/lib/local-git-contract'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'
import type { CommitPage, LocalCommit } from '@/lib/local-git-contract'

// One page of a history, as a list. Split out of the route for `repo-list.tsx`'s
// reason: the route's other job is fetching, and a list is only testable on its
// own once it has nothing to fetch.
//
// **A list and not a graph.** Drawing the topology is a different feature and the
// destination has never asked for it, so a merge is a row with a badge on it
// rather than two lines converging. What the badge buys is the one thing the
// reader needs before clicking: a merge's diff has to choose a side, and knowing
// that before the diff is what stops the choice being invisible.
//
// Every cell here comes out of the one `git log` the page already ran. No
// ahead/behind, no per-commit file count, no signature check: each of those is
// another spawn per row, and fifty of them is the difference between a page and a
// wait.

/** "There are none" and "you scrolled off the end" are different facts. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

/**
 * What kind of commit this is, when it is not the ordinary kind.
 *
 * Read off `parents.length` rather than a boolean on the record, because that is
 * how the contract says it: a derived flag beside the thing it is derived from is
 * a second thing to keep in agreement.
 *
 * Navy for a merge and teal for a root, and neither is amber: nothing here is
 * wrong or unusual — 26.4% of the sample is a merge — and amber in this palette
 * means "look at this before you trust it".
 */
function Kind({ commit }: { commit: LocalCommit }) {
  const badge = 'prof-badge tracking-label shrink-0 px-1.5 py-0.5 text-2xs leading-none uppercase'

  if (commit.parents.length === 0) {
    return <span className={cn(badge, 'prof-badge--teal')}>first commit</span>
  }
  if (commit.parents.length > 1) {
    return <span className={cn(badge, 'prof-badge--navy')}>merge</span>
  }

  return null
}

/**
 * One commit.
 *
 * **The subject is truncated and is not in a `title`.** `%s` folds the whole
 * first *paragraph* of a message rather than its first line, and `platform` holds
 * one that is 46,490 characters long with 1,079 tabs in it — a `title` carrying
 * that is a tooltip the size of a page. The date goes in the `title` instead, as
 * it does on the branch diff, and the whole subject is one click away on the
 * commit's own page, which has room to wrap it.
 */
function Row({ slug, page, commit }: { slug: string; page: CommitPage; commit: LocalCommit }) {
  return (
    <li
      // How a test reads which commit a row is, and the only stable identifier a
      // row has: two commits can share a subject, an author and a second.
      data-commit-sha={commit.sha}
      className="border-border flex border-b last:border-b-0 hover:bg-accent/50 hover:rounded-sm"
    >
      <Link
        to="/repos/$repo/commit/$sha"
        params={{ repo: slug, sha: commit.sha }}
        // The ref and the offset travel with the click so that the way back is
        // the page you were on rather than the top of the branch HEAD is on.
        // `page.ref.name` and not the pin the URL arrived with: this is the ref
        // the server resolved, which is the history actually being shown.
        search={{ ref: page.ref.name, skip: page.skip === 0 ? undefined : page.skip }}
        title={commit.committedAt}
        // `rounded-sm` on the link and not only on the row, for `pr-list.tsx`'s
        // reason: Prof's focus ring is a box-shadow that follows whatever radius
        // it finds, and this is the element the keyboard focuses all day.
        className="flex min-w-0 flex-1 items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-sm"
      >
        <code className="text-muted-foreground shrink-0 font-mono text-xs">
          {commit.abbreviated}
        </code>
        <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
        <Kind commit={commit} />
        <span className="text-muted-foreground hidden shrink-0 truncate text-xs sm:block sm:max-w-40">
          {commit.authorName}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">{age(commit.committedAt)}</span>
      </Link>
    </li>
  )
}

/**
 * Newer and older, and where in the history this page sits.
 *
 * **Two links and no page numbers**, because there is no total: counting a
 * 90,000-commit history is a second walk of all of it for a number that buys a
 * page number nobody asked for. `more` is the n+1 probe, so "older" is offered
 * only when a commit was actually seen beyond this page.
 *
 * The step is `COMMIT_PAGE_SIZE` in both directions and never
 * `commits.length` — the last page of a history is short, and stepping back by
 * its length lands on a page overlapping the one before it.
 */
function Paging({ slug, page }: { slug: string; page: CommitPage }) {
  const newer = Math.max(0, page.skip - COMMIT_PAGE_SIZE)
  const link = 'text-ink hover:text-teal-600 underline underline-offset-4'
  const to = (skip: number) => ({
    to: '/repos/$repo/commits' as const,
    params: { repo: slug },
    search: { ref: page.ref.name, skip: skip === 0 ? undefined : skip },
  })

  if (page.skip === 0 && !page.more) return null

  return (
    <nav aria-label="History paging" className="text-muted-foreground flex gap-4 px-2 text-xs">
      {page.skip > 0 ? (
        <Link {...to(newer)} className={link}>
          newer
        </Link>
      ) : null}
      {page.more ? (
        <Link {...to(page.skip + COMMIT_PAGE_SIZE)} className={link}>
          older
        </Link>
      ) : null}
      {/* One-based, because the numbers beside a list are a place in it and not
          an offset. Stated because there is no page number to state instead. */}
      {page.commits.length > 0 ? (
        <span className="tabular-nums">
          {page.skip + 1}–{page.skip + page.commits.length}
        </span>
      ) : null}
    </nav>
  )
}

export function CommitHistory({
  slug,
  page,
}: {
  /** The repository, for every row's link. */
  slug: string
  page: CommitPage
}) {
  return (
    <section className="w-full" aria-label="History">
      {/* Labelled, because the flex gap between the word and the ref is
          whitespace only to the eye. `.annotation` then carries the style, so the
          heading reads as the label on a drawing rather than as a second title. */}
      <h2
        aria-label={`Commits on ${page.ref.name}`}
        className="annotation flex items-baseline gap-2"
      >
        Commits
        <span className="text-muted-foreground font-mono normal-case">{page.ref.name}</span>
      </h2>
      <div className="sketch-rule mt-1 mb-1.5" aria-hidden />

      {page.commits.length === 0 ? (
        page.skip === 0 ? (
          // A ref points at a commit, so this is close to unreachable — and it is
          // still the honest sentence for the one output git gives here, which is
          // zero bytes and exit 0 either way.
          <Empty>
            <span className="font-mono">{page.ref.name}</span> has no commits.
          </Empty>
        ) : (
          <Empty>
            This history is shorter than{' '}
            <span className="font-mono tabular-nums">{page.skip}</span> commits — there is nothing
            this far back.
          </Empty>
        )
      ) : (
        // The list is a sheet raised off the desk. `p-1` is the gutter that keeps
        // a washed row's organic corners — and its focus ring — off the box's own
        // edge, which `overflow-hidden` would have clipped instead.
        <ul aria-label="Commits" className="sketch-box sketch-box--quiet p-1">
          {page.commits.map((commit) => (
            <Row key={commit.sha} slug={slug} page={page} commit={commit} />
          ))}
        </ul>
      )}

      <div className="mt-2">
        <Paging slug={slug} page={page} />
      </div>
    </section>
  )
}
