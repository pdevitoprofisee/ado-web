import { useMemo } from 'react'

import { age } from './pr-list'
import { ChangedFileDiff } from './diff/changed-file'
import { FileTree } from './diff/file-tree'
import { LayoutToggle } from './diff/layout-toggle'
import { localDiffSource } from '@/lib/blob-query'
import { buildFileTree, treeFiles } from '@/lib/file-tree'
import { TARGET_RUNG_LABEL } from '@/lib/local-git-contract'
import { useLocalViewedFiles } from '@/lib/viewed'
import { fileViewedKey } from '@/lib/viewed-key'

import type { ReactNode } from 'react'
import type { DiffLayout } from '@/lib/diff-contract'
import type { DiffPair, LocalChangeSet } from '@/lib/local-git-contract'
import type { ChangedFile } from '@/server/pull-request'

// The whole-branch diff, as a page body. Split out of the route for the reason
// `repo-list.tsx` is: the route's other job is fetching, and this is only
// testable on its own once it has nothing to fetch.
//
// **The diff itself is not written here.** `ChangedFileDiff` renders every file,
// exactly as the pull request page renders them — the same sidebar, the same
// side-by-side toggle, the same expand-context, the same highlighting — and the
// only thing that differs is where the bytes come from, which is
// `localDiffSource`'s whole job. Nothing about the body should be recognisably
// local, because nothing about it is.
//
// What is deliberately withheld is the conversation. `threads`,
// `threadActions` and `iterationContext` all default to `null` on the panel, and
// leaving them off is what takes the compose buttons off every row: a diff read
// off this disk offers no invitation to write a comment that would go nowhere.

/** Half of the pair the app repeats rather than shares; see `repo-list.tsx`. The
    other half is not here: a failure on this page is the change set failing, and
    that is an `Alert` in the route, above everything. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

/**
 * A merge conflict is a fact about a pull request being merged, and nothing here
 * is being merged. Hoisted so the tree's prop is a stable empty set rather than a
 * new one on every render.
 */
const NO_CONFLICTS: ReadonlySet<string> = new Set()

/** See `pr-detail.tsx`'s twin: a change entry with no blob on either side cannot be marked. */
function isViewed(viewed: ReadonlySet<string>, file: ChangedFile): boolean {
  const key = fileViewedKey(file)
  return key !== null && viewed.has(key)
}

/**
 * The two refs, and how the right-hand one was chosen.
 *
 * **Stated, not offered on hover.** The URL is the only memory this page has —
 * `?target=` pins one and nothing persists it — and the mitigation agreed for
 * that is exactly this: a reader who cannot see what the diff is against cannot
 * know that they pinned `release/9.1` yesterday.
 *
 * The base's age is here for the same reason and is the harder half: this app
 * never fetches, so `origin/main` is as old as the last time you did, and a diff
 * against a three-week-old base is a diff with three weeks of other people's
 * work in it. Nothing can fix that from here — judging it is the reader's, and
 * stating it is this line's.
 */
function Diffed({ diffed }: { diffed: DiffPair }) {
  return (
    <p className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <span className="text-ink font-mono">{diffed.branch.name}</span>
      <span aria-hidden>→</span>
      <span className="font-mono">{diffed.base.name}</span>
      {/* The rung's wording is the contract's and not this file's, because the
          repositories list prints the same fact and two wordings for one fact is
          how they drift. Absent when the URL pinned the target: no rung was
          climbed, so naming one would be a claim nobody made. */}
      {diffed.rung === null ? (
        <span>pinned in the URL</span>
      ) : (
        <span>{TARGET_RUNG_LABEL[diffed.rung]}</span>
      )}
      <span aria-hidden>·</span>
      {/* `age` is the inbox's, so a base that moved seven days ago reads the same
          here as a pull request that opened seven days ago. The exact timestamp
          is on the title, because "7d ago" is what you triage on and the date is
          what you check afterwards. */}
      <span title={diffed.baseCommittedAt}>base last committed {age(diffed.baseCommittedAt)}</span>
    </p>
  )
}

/**
 * What is not in the diff, because it is not committed.
 *
 * The one number on this page that is about the working tree rather than about
 * history, and it earns its place by answering the question a whole-branch diff
 * otherwise invites: "my change is missing" and "my change is not committed" look
 * identical until something says six files are uncommitted.
 *
 * It arrives separately from the change set — `status --porcelain=v2` is 107–216
 * ms — so it renders as nothing at all while it is in flight rather than as a
 * zero that is about to become a six.
 */
function Dirty({ count, error }: { count: number | null; error: string | null }) {
  if (error !== null) {
    return <span className="text-pen-amber">uncommitted files could not be counted</span>
  }
  if (count === null || count === 0) return null

  return (
    <span className="text-pen-amber">
      <span className="font-mono tabular-nums">{count}</span> uncommitted, not shown below
    </span>
  )
}

export function BranchDiff({
  slug,
  changes,
  dirtyCount,
  dirtyError,
  layout,
  onLayoutChange,
}: {
  /** The source's name in a failure sentence, and half of every blob's cache key. */
  slug: string
  changes: LocalChangeSet
  /** `null` while the count is still being taken — see `Dirty`. */
  dirtyCount: number | null
  dirtyError: string | null
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
}) {
  // Read here rather than passed in, as the pull request page reads its own: the
  // branch the marks hang on is the *resolved* one, which arrives with the change
  // set and is not in the URL on the common `/repos/$repo` with nothing after it.
  // A route holding this hook would have to key it on a branch it does not know
  // yet.
  const { keys: viewed, pending: viewedPending, setViewed } = useLocalViewedFiles(
    slug,
    changes.diffed.branch.name,
  )

  const nodes = useMemo(() => buildFileTree(changes.files), [changes.files])
  const ordered = useMemo(() => treeFiles(nodes), [nodes])

  // Memoised, unlike `adoDiffSource`, because building one walks the file list:
  // the source has to look a `ChangedFile` back up to find the two modes that
  // keep a gitlink away from `cat-file`. See `localDiffSource`.
  const source = useMemo(() => localDiffSource(slug, changes.files), [slug, changes.files])

  const read = changes.files.filter((file) => isViewed(viewed, file)).length
  const isRead = (file: ChangedFile) => isViewed(viewed, file)

  // **The legitimate empty case.** Eleven of nineteen repositories here sit on
  // their own default branch, where a whole-branch diff is correctly empty — and
  // an empty file list is not an answer to that, it is the same blank space a
  // repository with twelve commits and a broken read would show. The two are told
  // apart by the commits, not by the files: same tip, same diff, nothing to say.
  const isTarget = changes.diffed.branch.commit === changes.diffed.base.commit

  return (
    <div className="flex w-full flex-col gap-3">
      <Diffed diffed={changes.diffed} />

      {/* Progress, the counts, and the layout on one line, above everything —
          the same line the pull request page carries, minus the controls that
          only mean something where there is a conversation. */}
      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-4 text-xs">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* Mono for both, because these are the numbers you come back to the
              page for: on a shared advance width they tick in place instead of
              shifting the words after them. */}
          <span className="font-mono tabular-nums">
            {read} of {changes.files.length} read
          </span>
          <span>
            <span className="font-mono tabular-nums">{changes.commits}</span>{' '}
            {changes.commits === 1 ? 'commit' : 'commits'}
          </span>
          <Dirty count={dirtyCount} error={dirtyError} />
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

      {isTarget ? (
        <Empty>
          This branch <em>is</em> the target — there is nothing to compare.
        </Empty>
      ) : changes.files.length === 0 ? (
        <Empty>
          No files changed, across{' '}
          <span className="font-mono tabular-nums">{changes.commits}</span>{' '}
          {changes.commits === 1 ? 'commit' : 'commits'}.
        </Empty>
      ) : null}

      {viewedPending ? (
        // One tick against a local SQLite table, and the pull request page waits
        // the same tick for the same reason: a panel decides whether to start
        // expanded when it mounts, so the list cannot mount before the marks it
        // would be deciding against.
        <p className="text-muted-foreground text-xs">Loading…</p>
      ) : (
        <div className="flex w-full items-start gap-6">
          <FileTree nodes={nodes} viewed={isRead} conflicted={NO_CONFLICTS} />

          {/* `min-w-0` because the diff inside is wide and a flex child defaults
              to its content's width, which would push the tree off the screen. */}
          <ul aria-label="Changed files" className="flex min-w-0 flex-1 flex-col gap-1">
            {ordered.map((file) => (
              <li key={file.path}>
                {/* `threads`, `threadActions` and `iterationContext` are all
                    withheld rather than passed as null, which is the same thing
                    to the panel and a clearer statement here: there is no
                    conversation on a branch on your disk, so there are no
                    compose buttons on any row. */}
                <ChangedFileDiff
                  diffSource={source}
                  file={file}
                  layout={layout}
                  viewed={isRead(file)}
                  onViewedChange={(next) => setViewed(file, next)}
                />
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
