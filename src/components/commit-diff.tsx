import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'

import { age } from './pr-list'
import { ChangedFileDiff } from './diff/changed-file'
import { FileTree } from './diff/file-tree'
import { LayoutToggle } from './diff/layout-toggle'
import { localDiffSource } from '@/lib/blob-query'
import { buildFileTree, treeFiles } from '@/lib/file-tree'

import type { ReactNode } from 'react'
import type { DiffLayout } from '@/lib/diff-contract'
import type { CommitChangeSet, DiffedAgainst, LocalCommit } from '@/lib/local-git-contract'
import type { ChangedFile } from '@/server/pull-request'

// One commit's diff, as a page body. Split out of the route for `branch-diff.tsx`'s
// reason, and built the same way for the same reason twice over.
//
// **The diff itself is not written here.** `ChangedFileDiff` renders every file
// exactly as the pull request page renders them — the same sidebar, the same
// side-by-side toggle, the same expand-context, the same highlighting — and the
// only thing that differs is where the bytes come from, which is
// `localDiffSource`'s whole job. Nothing about the body should be recognisably a
// commit, because nothing about it is.
//
// What is withheld is the conversation, again: `threads`, `threadActions` and
// `iterationContext` are all left off, and that is what takes the compose buttons
// off every row. There is no Sonar, no check, no vote and no policy either, for a
// simpler reason than choice — a commit on your disk has none of them to read.
//
// **And the viewed marks are withheld too**, which is the one place this page is
// deliberately poorer than the branch diff. A mark is keyed on a blob id and hung
// on a branch; hanging one on a commit that a rebase will replace is a mark that
// rots, and nobody has asked to track having read a commit. Omitting
// `onViewedChange` is what takes the checkbox off the panel rather than leaving a
// tick that would go nowhere.

/** Half of the pair the app repeats rather than shares; see `repo-list.tsx`. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

/** A merge conflict is a fact about a pull request being merged, and nothing here is. */
const NO_CONFLICTS: ReadonlySet<string> = new Set()

/** No marks on this page at all, so the tree's predicate is a constant. */
const NONE = (_file: ChangedFile) => false

/**
 * Who wrote it, when, and which commit it is.
 *
 * **The subject is clamped rather than truncated to one line.** `%s` folds the
 * whole first *paragraph* of a message, so a subject can be 46,490 characters
 * long — and this is the page that owes the reader the whole of it, so it wraps
 * and stops at three lines instead of ending in an ellipsis after sixty.
 *
 * **The timestamp is printed and not reformatted.** `%cI` comes back in the
 * committer's own UTC offset, un-normalised and mixed within one repository, so
 * rewriting it into local time would be this page inventing a fact. The age beside
 * it is what you scan; the string is what you check.
 *
 * `select-all` on the sha: one click takes the whole of it, which is the gesture
 * this identifier exists for. The full 40 hex is in the `title` and in the
 * address bar — the abbreviation is git's own `%h`, whose length git chooses per
 * repository.
 */
function Identity({ commit }: { commit: LocalCommit }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <p className="text-ink line-clamp-3 text-base">{commit.subject}</p>
      <p className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="text-ink" title={commit.authorEmail}>
          {commit.authorName}
        </span>
        <span aria-hidden>·</span>
        <span>committed {age(commit.committedAt)}</span>
        <time dateTime={commit.committedAt} className="font-mono">
          {commit.committedAt}
        </time>
        <span aria-hidden>·</span>
        <code className="text-ink font-mono select-all" title={commit.sha}>
          {commit.abbreviated}
        </code>
      </p>
    </div>
  )
}

/**
 * Which parent this diff is against, and how to see the other side.
 *
 * **The one thing on this page that can quietly show you less than the truth.** A
 * merge has two parents, so "the diff of this commit" has no meaning until one is
 * chosen — and a diff silently taken against the first parent omits everything the
 * merge brought in from the other side. 26.4% of the sample is a merge, so this is
 * a sentence the page needs most of the time rather than an edge case.
 *
 * Stating it is not enough on its own, which is why the other parents are links: a
 * reader told that something is hidden and given no way to look at it has been
 * warned and not helped. The switch is a URL, as everything else on these pages
 * is, and parent 1 spells itself as the absent `?parent=` so the default and the
 * explicit first parent are one address rather than two.
 *
 * A single parent says nothing at all — the ordinary case has nothing to choose —
 * and a root says the one thing that explains why every file below is new.
 */
function Against({
  slug,
  commit,
  against,
}: {
  slug: string
  commit: LocalCommit
  against: DiffedAgainst
}) {
  if (against.kind === 'only') return null

  if (against.kind === 'root') {
    return (
      <p className="text-muted-foreground text-xs">
        <span className="prof-badge prof-badge--teal tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase">
          first commit
        </span>{' '}
        Nothing comes before it, so every file below is new.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-pen-amber text-xs">
        A merge of {against.of} parents. This diff is against parent {against.index} only — what the
        other side brought in is not below.
      </p>
      <nav
        aria-label="Merge parents"
        className="text-muted-foreground flex flex-wrap items-baseline gap-x-3 text-xs"
      >
        {commit.parents.map((parent, at) => {
          const index = at + 1
          const label = `parent ${index}`
          const short = parent.slice(0, 7)

          return index === against.index ? (
            <span key={parent} aria-current="true" className="text-ink font-mono">
              {label} {short}
            </span>
          ) : (
            <Link
              key={parent}
              to="/repos/$repo/commit/$sha"
              params={{ repo: slug, sha: commit.sha }}
              // The updater form, so the ref and the offset that make the way back
              // work survive a parent switch without this component having to be
              // told what they are.
              search={(prev) => ({ ...prev, parent: index === 1 ? undefined : index })}
              className="hover:text-teal-600 font-mono underline underline-offset-4"
            >
              {label} {short}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

export function CommitDiff({
  slug,
  changes,
  layout,
  onLayoutChange,
}: {
  /** The source's name in a failure sentence, and half of every blob's cache key. */
  slug: string
  changes: CommitChangeSet
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
}) {
  const nodes = useMemo(() => buildFileTree(changes.files), [changes.files])
  const ordered = useMemo(() => treeFiles(nodes), [nodes])

  // Memoised, unlike `adoDiffSource`, because building one walks the file list:
  // the source has to look a `ChangedFile` back up to find the two modes that
  // keep a gitlink away from `cat-file`. See `localDiffSource`.
  const source = useMemo(() => localDiffSource(slug, changes.files), [slug, changes.files])

  return (
    <div className="flex w-full flex-col gap-3">
      <Identity commit={changes.commit} />
      <Against slug={slug} commit={changes.commit} against={changes.against} />

      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-4 text-xs">
        {/* Mono for the number, because it is the one figure on this line and it
            sits beside a word that would otherwise shift under it. */}
        <span>
          <span className="font-mono tabular-nums">{changes.files.length}</span>{' '}
          {changes.files.length === 1 ? 'file' : 'files'}
        </span>
        <LayoutToggle layout={layout} onLayoutChange={onLayoutChange} />
      </div>

      {/* `-M` gave up and git said so on stderr while exiting 0, so every rename
          below is drawn as an add and a delete. Said once here rather than
          guessed at file by file. */}
      {changes.renameDetectionSkipped ? (
        <p className="text-pen-amber text-xs">
          Too many changes to detect renames, so a moved file appears as an add and a delete.
        </p>
      ) : null}

      {/* **Zero bytes from `diff` is data here, and it means two different
          things.** An ordinary commit with no files is an empty commit, which is a
          thing people make on purpose. A merge with no files against this parent
          is a merge that took nothing from this side, which is a fact about the
          merge and not about the commit — and the reader has the other parent one
          click above. */}
      {changes.files.length === 0 ? (
        changes.against.kind === 'nth' ? (
          <Empty>Nothing changed against parent {changes.against.index}.</Empty>
        ) : (
          <Empty>This commit changed no files.</Empty>
        )
      ) : (
        <div className="flex w-full items-start gap-6">
          <FileTree nodes={nodes} viewed={NONE} conflicted={NO_CONFLICTS} />

          {/* `min-w-0` because the diff inside is wide and a flex child defaults
              to its content's width, which would push the tree off the screen. */}
          <ul aria-label="Changed files" className="flex min-w-0 flex-1 flex-col gap-1">
            {ordered.map((file) => (
              <li key={file.path}>
                {/* `viewed` and `onViewedChange` are both withheld, which is what
                    takes the checkbox off the panel — see the note at the top.
                    `threads`, `threadActions` and `iterationContext` are withheld
                    for the branch diff's reason: there is no conversation on a
                    commit on your disk. */}
                <ChangedFileDiff diffSource={source} file={file} layout={layout} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {changes.truncated ? (
        <p className="text-muted-foreground text-xs">
          Only the first {changes.files.length} files are shown. There are more.
        </p>
      ) : null}
    </div>
  )
}
