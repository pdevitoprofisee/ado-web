import { useState } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { DiffView, blobNotice } from './diff-view'
import { FileThreadList } from '@/components/comments/file-thread-list'
import { cn } from '@/lib/utils'

import type { ChangeKind } from './file-tree'
import type { FileThreads, IterationContext } from '@/lib/comment-contract'
import type { ThreadActions } from '@/components/comments/thread-actions'
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

/**
 * The pill a file's kind gets in its header — and `edit` deliberately has none.
 *
 * A `.prof-badge` carries a visible outline, so a pill is a claim on attention;
 * 294 of them saying "edited" would be chrome with no information in it, and the
 * `+`/`−` counts beside it already say the file was edited. The three kinds left
 * are the ones the diff body cannot tell you: a file that is new, one that is
 * gone, and one that moved.
 */
const KIND_BADGE: Partial<Record<ChangeKind, { label: string; tone: string }>> = {
  add: { label: 'added', tone: 'prof-badge--teal' },
  delete: { label: 'deleted', tone: 'prof-badge--red' },
  rename: { label: 'renamed', tone: 'prof-badge--navy' },
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
  kind = null,
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
  onCompose,
  threads = null,
  threadActions,
  hideDone = false,
  iterationContext = null,
  jumped = null,
  arrival = 0,
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
  /**
   * What happened to the file, already reduced to one kind by `changeKind` in
   * `file-tree.tsx`. Optional because `FileBlobs` cannot answer it — the flag set
   * lives on `ChangedFile`, which only the caller holds — and a panel handed raw
   * blobs (a test, a single-file view) should not have to invent one.
   */
  kind?: ChangeKind | null
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
  /**
   * Open a composer on a right-side line, or `null` to close it. Passed straight
   * through: the composer is a row, so only whoever owns the row model can add one.
   */
  onCompose?: (line: number | null) => void
  /**
   * This file's conversations. The anchored ones are already in `rows` — the
   * caller built those with `buildRows(…, threads)` — and this is passed as well
   * for the ones no row can hold, and for the case where there are no rows.
   */
  threads?: FileThreads | null
  threadActions?: ThreadActions
  /**
   * The same flag the caller passed to `buildRows`. Passed on so the list above
   * the diff hides the same threads the diff does; the panel does not filter
   * `rows` itself, because a hidden thread must not be a measured row.
   */
  hideDone?: boolean
  /** Which iterations a new thread on this file is written against. */
  iterationContext?: IterationContext | null
  /**
   * The right-side line a jump landed on. Passed straight through for the same
   * reason `rows` is: the row model is the caller's, and this is one of its inputs.
   */
  jumped?: number | null
  /** How many jumps the caller has answered. Straight through, like `jumped`. */
  arrival?: number
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
  const badge = kind === null ? undefined : KIND_BADGE[kind]

  return (
    // Deliberately unnamed: `DiffView` inside it is a region labelled with this
    // same path, and two landmarks with one name is worse than one. The header
    // button is what announces which file this is.
    //
    // `--quiet`: this is the only drawn box in a column of up to 294 of them, and
    // the full `.sketch-box` pen plus its graphite lift, stacked that many times,
    // turns a page of files into a page of outlines. Soft-line edges and no shadow
    // keep each file legible as one panel without any of them shouting.
    //
    // `overflow-hidden` is what makes the box read as drawn rather than as a frame
    // with content escaping it: the diff body inside scrolls both ways, and without
    // the clip its rows would run out past the organic corners.
    <section className="sketch-box sketch-box--quiet overflow-hidden">
      <div className="flex items-baseline gap-2 px-2 py-1.5 font-mono text-xs">
        <button
          type="button"
          onClick={() => show(!open)}
          aria-expanded={open}
          title={blobs.path}
          // `rounded-sm` so the global focus box-shadow traces sketch corners
          // rather than drawing a mechanical rectangle around the filename.
          className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-sm text-left"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            size={12}
            className="shrink-0 self-center"
            aria-hidden
          />
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

        {/* Badges are `self-center`, not baseline-aligned: a pill's baseline is its
            label's, so aligning it with the surrounding text hangs the outline low
            and the whole row starts to look like it slipped. */}
        {badge === undefined ? null : (
          // Readable, not `aria-hidden`: "added" and "deleted" are the one thing
          // the counts beside it cannot say — a new file and a rewritten one both
          // read as "+40 −0" — and this pill is where that fact lives.
          <span className={cn('prof-badge shrink-0 self-center', badge.tone)}>{badge.label}</span>
        )}

        {conflicted ? (
          <span className="prof-badge prof-badge--red shrink-0 self-center">conflict</span>
        ) : null}

        <Counts added={diff.added} removed={diff.removed} />

        {onViewedChange === undefined ? null : (
          // Teal for read, and both halves of the control say it: `accent-*` tints
          // the native box, which is worth keeping native here because a checkbox
          // that behaves exactly like a checkbox is one less thing between the
          // reader and 294 files. The label follows the box so the state survives
          // being seen out of the corner of an eye.
          <label
            className={cn(
              'flex shrink-0 items-center gap-1 select-none',
              viewed ? 'text-teal-600' : 'text-muted-foreground',
            )}
          >
            <input
              type="checkbox"
              checked={viewed}
              onChange={(event) => {
                onViewedChange(event.target.checked)
                show(!event.target.checked)
              }}
              className="accent-teal-500 size-3"
            />
            Viewed
          </label>
        )}
      </div>

      {!open ? null : (
        <>
          {/* A drawn break where the old design put `border-t`. It costs 6px, which
              is affordable exactly once per panel — hence one rule under the header
              rather than one above every footer. */}
          <div aria-hidden className="sketch-rule" />
          {notice !== null ? (
            <>
              <p className="text-muted-foreground px-2 py-1.5 text-xs">{notice}</p>
              {/* `all`, because there is no diff for an anchored thread to sit in.
                  A comment on a binary file is still a comment. */}
              <FileThreadList
                path={blobs.path}
                threads={threads}
                actions={threadActions}
                hideDone={hideDone}
                all
                iterationContext={iterationContext}
              />
            </>
          ) : (
            <>
              {/* Above the diff rather than below it: these are the threads that
                  have no line, and the bottom of a 70vh scroller is where a comment
                  goes to be missed. */}
              <FileThreadList
                path={blobs.path}
                threads={threads}
                actions={threadActions}
                hideDone={hideDone}
                iterationContext={iterationContext}
              />
              <DiffView
                rows={rows}
                layout={layout}
                label={blobs.path}
                before={before}
                after={after}
                onExpand={onExpand}
                onCompose={onCompose}
                threadActions={threadActions}
                iterationContext={iterationContext}
                jumped={jumped}
                arrival={arrival}
              />
              {noNewline === null ? null : (
                // The marker is part of the file's text, not chrome around it, so
                // it sits on the same sunken sheet the gutters use with no rule
                // between: `git diff` prints it as the last line of the diff.
                <p className="text-muted-foreground bg-muted px-2 py-1 font-mono text-xs">
                  {noNewline}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
