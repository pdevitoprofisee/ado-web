import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { DiffView, blobNotice } from './diff-view'
import { cn } from '@/lib/utils'

import type {
  DiffLayout,
  DiffRow,
  FileBlobs,
  FileDiff,
  HighlightedLines,
} from '@/lib/diff-contract'

// One file's worth of diff, with the chrome around it: what it is called, how
// much of it moved, whether it has been read, and whether it is open.
//
// Separate from `DiffView` because the view is the expensive part. A 300-file
// PR mounts 300 of these headers and — until each is opened — zero virtualizers,
// which is the only reason a PR that size is openable at all.

/** `+12 −3`, or nothing at all for a file whose bytes did not move. */
function Counts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null

  return (
    <span
      className="shrink-0 tabular-nums"
      aria-label={`${added} added, ${removed} removed`}
    >
      {added > 0 ? <span className="text-diff-add-fg">+{added}</span> : null}
      {added > 0 && removed > 0 ? ' ' : null}
      {removed > 0 ? <span className="text-diff-delete-fg">−{removed}</span> : null}
    </span>
  )
}

export function FileDiffPanel({
  blobs,
  diff,
  rows,
  layout,
  viewed = false,
  onViewedChange,
  before = null,
  after = null,
  onExpand,
}: {
  blobs: FileBlobs
  diff: FileDiff
  /** T-018's flattening of `diff`, passed in rather than recomputed here. */
  rows: readonly DiffRow[]
  layout: DiffLayout
  viewed?: boolean
  /** Absent on a file whose viewed state nobody is keeping — the box goes away. */
  onViewedChange?: (viewed: boolean) => void
  before?: HighlightedLines | null
  after?: HighlightedLines | null
  onExpand?: (row: Extract<DiffRow, { kind: 'gap' }>) => void
}) {
  // Seeded from `viewed` and then owned here: a file marked read closes, and
  // reopening it does not mark it unread. Those are two different statements —
  // "I have looked at this" and "I am looking at it now" — and tying them
  // together in one flag means one of the two is always being told wrong.
  const [open, setOpen] = useState(!viewed)

  const notice = diff.gaveUp
    ? 'This file was too large or too tangled to diff in reasonable time.'
    : blobNotice(blobs)

  const cut = blobs.path.lastIndexOf('/')

  return (
    // Deliberately unnamed: `DiffView` inside it is a region labelled with this
    // same path, and two landmarks with one name is worse than one. The header
    // button is what announces which file this is.
    <section className="border-border/60 rounded-md border">
      <div className="flex items-baseline gap-2 px-2 py-1.5 font-mono text-xs">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 self-center" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0 self-center" aria-hidden />
          )}
          {/* Same rule as the file list: the directory gives way, never the
              name, because the end of a 90-column path is the part that says
              which file this is. */}
          <span className="text-muted-foreground truncate">{blobs.path.slice(0, cut + 1)}</span>
          <span className={cn('shrink-0', viewed && 'text-muted-foreground')}>
            {blobs.path.slice(cut + 1)}
          </span>
        </button>

        <Counts added={diff.added} removed={diff.removed} />

        {onViewedChange === undefined ? null : (
          <label className="text-muted-foreground flex shrink-0 items-center gap-1 select-none">
            <input
              type="checkbox"
              checked={viewed}
              onChange={(event) => {
                onViewedChange(event.target.checked)
                setOpen(!event.target.checked)
              }}
              className="size-3"
            />
            Viewed
          </label>
        )}
      </div>

      {!open ? null : notice !== null ? (
        <p className="text-muted-foreground border-border/60 border-t px-2 py-1.5 text-xs">
          {notice}
        </p>
      ) : (
        <DiffView
          rows={rows}
          layout={layout}
          label={blobs.path}
          before={before}
          after={after}
          onExpand={onExpand}
        />
      )}
    </section>
  )
}
