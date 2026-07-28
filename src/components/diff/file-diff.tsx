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

/**
 * `\ No newline at end of file`, naming the side when only one end lacks one.
 *
 * A footer rather than a row, and here rather than in the diff, because the
 * contract has nowhere to put it: `noFinalNewline` is a property of a blob, the
 * two blobs can disagree, and `DiffLine` has no idea which blob it came from.
 * `git diff` prints the marker under whichever side is missing it; this panel
 * is the lowest thing in the tree that still holds both sides, so it says it.
 */
function noNewlineNotice(blobs: FileBlobs): string | null {
  const before = blobs.before.kind === 'text' && blobs.before.noFinalNewline
  const after = blobs.after.kind === 'text' && blobs.after.noFinalNewline
  if (!before && !after) return null

  const marker = '\\ No newline at end of file'
  if (before && after) return marker
  return `${marker} (${before ? 'before' : 'after'})`
}

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
  originalPath = null,
  conflicted = false,
  viewed = false,
  defaultOpen,
  onViewedChange,
  onOpenChange,
  pending = false,
  failure = null,
  before = null,
  after = null,
  onExpand,
}: {
  blobs: FileBlobs
  diff: FileDiff
  /** T-018's flattening of `diff`, passed in rather than recomputed here. */
  rows: readonly DiffRow[]
  layout: DiffLayout
  /**
   * `ChangedFile.originalPath` — the name the file had before, on a rename.
   * `FileBlobs` carries only where the file is now, so this arrives separately;
   * without it a rename is a change with nothing on screen to show for it.
   */
  originalPath?: string | null
  /** This file is one of the ones the merge cannot resolve. */
  conflicted?: boolean
  viewed?: boolean
  /**
   * Whether the file starts open. Defaults to "open unless already read", which
   * is right for a panel handed its bytes; a panel that has to *fetch* them
   * passes `false`, because opening forty files at once is eighty ADO calls
   * spent before anyone decided which file they cared about.
   */
  defaultOpen?: boolean
  /** Absent on a file whose viewed state nobody is keeping — the box goes away. */
  onViewedChange?: (viewed: boolean) => void
  /**
   * Told each time the file opens or shuts. Open stays owned here — the caller
   * is not deciding, it is finding out, because the thing above this panel is
   * what fetches the bytes and opening the file is the signal to start.
   */
  onOpenChange?: (open: boolean) => void
  /** The bytes are on their way. Outranks every notice below except a failure. */
  pending?: boolean
  /**
   * The fetch itself lost — as against `BlobSide.kind === 'failed'`, which is
   * one side of an answer that did arrive.
   */
  failure?: string | null
  before?: HighlightedLines | null
  after?: HighlightedLines | null
  onExpand?: (row: Extract<DiffRow, { kind: 'gap' }>) => void
}) {
  // Seeded from `viewed` and then owned here: a file marked read closes, and
  // reopening it does not mark it unread. Those are two different statements —
  // "I have looked at this" and "I am looking at it now" — and tying them
  // together in one flag means one of the two is always being told wrong.
  const [open, setOpen] = useState(defaultOpen ?? !viewed)

  function show(next: boolean) {
    setOpen(next)
    onOpenChange?.(next)
  }

  // Order is precedence. A failed fetch outranks everything because it is the
  // only one of these that means something went wrong; `pending` outranks the
  // blob notices because the placeholder blobs a caller passes while waiting
  // are absent on both sides, and "nothing to show for this file" is a wrong
  // thing to say about a file that has not been fetched yet.
  const notice =
    failure !== null
      ? failure
      : pending
        ? 'Loading…'
        : diff.gaveUp
          ? 'This file was too large or too tangled to diff in reasonable time.'
          : blobNotice(blobs)

  const noNewline = notice === null ? noNewlineNotice(blobs) : null

  const cut = blobs.path.lastIndexOf('/')

  return (
    // Deliberately unnamed: `DiffView` inside it is a region labelled with this
    // same path, and two landmarks with one name is worse than one. The header
    // button is what announces which file this is.
    <section className="border-border/60 rounded-md border">
      <div className="flex items-baseline gap-2 px-2 py-1.5 font-mono text-xs">
        <button
          type="button"
          onClick={() => show(!open)}
          aria-expanded={open}
          title={blobs.path}
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
          {originalPath === null || originalPath === blobs.path ? null : (
            // Whole old path, not just its last segment: a rename that only
            // moved the file between directories has the same name at both
            // ends, and the truncated version would read as saying nothing.
            <span className="text-muted-foreground min-w-0 truncate">
              ← {originalPath}
            </span>
          )}
        </button>

        {conflicted ? <span className="text-destructive shrink-0">conflict</span> : null}

        <Counts added={diff.added} removed={diff.removed} />

        {onViewedChange === undefined ? null : (
          <label className="text-muted-foreground flex shrink-0 items-center gap-1 select-none">
            <input
              type="checkbox"
              checked={viewed}
              onChange={(event) => {
                onViewedChange(event.target.checked)
                show(!event.target.checked)
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
        <>
          <DiffView
            rows={rows}
            layout={layout}
            label={blobs.path}
            before={before}
            after={after}
            onExpand={onExpand}
          />
          {noNewline === null ? null : (
            <p className="text-muted-foreground border-border/60 border-t px-2 py-1 font-mono text-xs">
              {noNewline}
            </p>
          )}
        </>
      )}
    </section>
  )
}
