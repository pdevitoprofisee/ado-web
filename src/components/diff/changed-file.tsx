import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { FileDiffPanel } from './file-diff'
import { diffFile } from '@/lib/diff'
import { buildRows, expandGap, setLayout } from '@/lib/diff-rows'
import { fileAnchor } from '@/lib/file-anchor'
import { sharedHighlighter } from '@/lib/highlight/shared'
import { useNearViewport } from '@/lib/near-viewport'
import { fileBlobsQuery } from '@/server/blob-fn'

import type { RowModel } from '@/lib/diff-rows'
import type { DiffLayout, FileBlobs, HighlightedLines } from '@/lib/diff-contract'
import type { ChangedFile } from '@/server/pull-request'

// Where the four phase-3 pieces meet: fetch the two blobs, diff them, flatten
// the diff into rows, ask the worker for colours, and hand the lot to the view.
// One instance per changed file.
//
// The order matters more than the joins do. Rows exist before tokens do and the
// view renders without them, because a diff you can read in grey now beats a
// diff you can read in colour in a second — the highlighter answers into a
// second render, and `LineText` is built to be given `null`.

/** The empty side of an add, a delete, a binary, or a refusal — all diff as nothing. */
const NO_LINES: readonly string[] = []

function linesOf(blobs: FileBlobs, side: 'before' | 'after'): readonly string[] {
  const blob = blobs[side]
  return blob.kind === 'text' ? blob.lines : NO_LINES
}

export function ChangedFileDiff({
  projectId,
  repositoryId,
  id,
  file,
  layout,
  conflicted = false,
  viewed = false,
  onViewedChange,
}: {
  projectId: string
  repositoryId: string
  id: number
  file: ChangedFile
  layout: DiffLayout
  conflicted?: boolean
  viewed?: boolean
  onViewedChange?: (viewed: boolean) => void
}) {
  // Monotonic on purpose — "has been opened", not "is open". Closing a file
  // should not throw away what it cost two calls to fetch, and the query cache
  // is keyed by content so reopening it is free either way.
  const [opened, setOpened] = useState(false)

  // The other trigger, and on a page where every file starts expanded it is the
  // one that does the work. Files are open from the top of the list to the
  // bottom, but a 294-file pull request cannot spend 588 ADO calls to say so, so
  // a panel fetches when it is nearly on screen. Scrolling is the gesture that
  // means "I am reading this now"; clicking a header is only what is left for a
  // file already scrolled past and shut.
  const [wrapper, near] = useNearViewport<HTMLDivElement>()

  const query = useQuery({
    // Keyed by the shas rather than by the pull request: the same blob pair in
    // another PR, or in this one after a rebase that did not touch this file,
    // is the same answer.
    queryKey: ['file-blobs', repositoryId, file.path, file.objectId, file.originalObjectId],
    queryFn: () =>
      fileBlobsQuery({
        data: {
          projectId,
          repositoryId,
          id,
          path: file.path,
          objectId: file.objectId,
          originalObjectId: file.originalObjectId,
        },
      }),
    enabled: opened || near,
    // A blob is addressed by the sha of its own content, so this answer cannot
    // go stale. Refetching one would spend a call to be told the same thing.
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const blobs = query.data?.blobs ?? null

  // State adjusted during render rather than in an effect: the model is derived
  // from `blobs` and `layout`, but expansions live in it too, so it cannot be a
  // `useMemo` — a click has to be able to change it. Rebuilding here means the
  // first render after new blobs already has its rows, with no flash of the
  // previous file's diff.
  const [model, setModel] = useState<RowModel | null>(null)
  const [source, setSource] = useState<FileBlobs | null>(null)

  if (blobs !== source) {
    setSource(blobs)
    setModel(
      blobs === null
        ? null
        : buildRows(diffFile(linesOf(blobs, 'before'), linesOf(blobs, 'after')), linesOf(blobs, 'after'), layout),
    )
  } else if (model !== null && model.layout !== layout) {
    // Switching sides keeps the expansions: `setLayout` reprojects the same
    // reveals rather than starting the file over.
    setModel(setLayout(model, layout))
  }

  const [tokens, setTokens] = useState<{
    before: HighlightedLines | null
    after: HighlightedLines | null
  }>({ before: null, after: null })

  useEffect(() => {
    if (blobs === null) return

    // Both sides, because a delete's text only exists on the before side and
    // the view colours a deleted line from there.
    let live = true
    const highlighter = sharedHighlighter()
    setTokens({ before: null, after: null })

    void Promise.all([
      highlighter.highlight(file.path, linesOf(blobs, 'before')),
      highlighter.highlight(file.path, linesOf(blobs, 'after')),
    ]).then(([before, after]) => {
      // The file may have been closed, or another may have arrived first.
      // Dropping late tokens matters beyond tidiness: `LineText` would discard
      // them anyway once their lengths stopped matching, so the only thing a
      // late `setTokens` buys is a wasted render.
      if (live) setTokens({ before, after })
    })

    return () => {
      live = false
    }
  }, [blobs, file.path])

  const failure =
    query.error !== null
      ? query.error.message
      : query.data !== undefined && query.data.blobs === null
        ? (query.data.error ?? 'Azure DevOps did not answer.')
        : null

  return (
    // The observer needs an element, and `scroll-mt` is what keeps the tree's
    // jump from parking a file's header flush against the top of the window.
    <div ref={wrapper} id={fileAnchor(file.path)} className="scroll-mt-2">
      <FileDiffPanel
        blobs={
          blobs ?? {
            path: file.path,
            // Nothing has been fetched yet, and `absent` is the honest word for
            // it. The panel shows a notice rather than an empty diff, and the
            // notice below replaces it the moment there is something to say.
            before: { kind: 'absent' },
            after: { kind: 'absent' },
            renamedOnly: false,
          }
        }
        diff={model?.diff ?? { hunks: [], added: 0, removed: 0, gaveUp: false }}
        rows={model?.rows ?? []}
        layout={layout}
        originalPath={file.originalPath}
        conflicted={conflicted}
        viewed={viewed}
        // No `defaultOpen`, which is the panel's own default of "open unless
        // already read" — files are expanded from the start, and the ones you
        // marked read on the last pass stay out of the way. Decided once, on
        // mount, so it relies on the marks being in hand by then: the page holds
        // the list back until its `useViewedFiles` has answered.
        onViewedChange={onViewedChange}
        onOpenChange={(open) => {
          if (open) setOpened(true)
        }}
        // A disabled query reports `isPending`, so this covers both waits with
        // one word: the file below the fold that has not asked yet, and the one
        // that has. Both are "the bytes are on their way", and the alternative
        // is `blobNotice` calling an unfetched file empty.
        pending={query.isPending}
        failure={failure}
        before={tokens.before}
        after={tokens.after}
        onExpand={(row) =>
          setModel((current) => (current === null ? current : expandGap(current, row.key, 'all')))
        }
      />
    </div>
  )
}
