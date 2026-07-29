import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { UnfoldMoreIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { LineText } from './line-text'
import { ThreadCard } from '@/components/comments/thread-card'
import { THREAD_ROW_ESTIMATE } from '@/lib/comment-contract'
import { cn } from '@/lib/utils'

import type {
  DiffLayout,
  DiffLine,
  DiffRow,
  FileBlobs,
  HighlightToken,
  HighlightedLines,
} from '@/lib/diff-contract'
import type { ThreadActions } from '@/components/comments/thread-actions'

// The diff, on screen. Everything above it — fetching, diffing, flattening,
// tokenising — has already happened; this file's whole job is to put a flat row
// array into the DOM without putting all of it into the DOM.
//
// The reason it exists at all: the ADO web UI renders every line of every file
// at once, and react-diff-view's own benchmark is 26,072 ms for a 375-file
// diff. Nothing on npm virtualizes a diff. So this does.

/**
 * One row of diff, in pixels.
 *
 * Fixed, and that is the design: the diff does not soft-wrap, so every row of
 * code is exactly one line tall and the virtualizer measures none of them.
 * Measuring is what makes a virtualized list stutter — a wrapped 5,000-line
 * file would mean 5,000 layout reads on the way past — and the file that big is
 * the one this component was written for. Long lines scroll sideways instead.
 *
 * T-025 added the one exception, and it is an exception rather than a change of
 * policy: a thread row wraps prose and cannot be predicted, so it alone gets
 * `measureElement` and starts at `THREAD_ROW_ESTIMATE`. Thread rows are the rare
 * kind — 12 anchored threads across four whole pull requests — so the sentence
 * above stays true of every row that is actually numerous.
 *
 * Keep in step with `leading-5` on the row.
 */
const ROW_HEIGHT = 20

const MARK: Record<DiffLine['op'], string> = { context: ' ', add: '+', delete: '-' }

/** What a `\t` renders to, and what `columnsIn` therefore counts one as. */
const TAB = 8

/** The gutter and the marker column in front of the text, in `rem`: `w-12` + `w-3`. */
const CELL_CHROME = '3.75rem'

/** How wide `text` renders, in characters — the font is monospace, so that is a width. */
function columnsIn(text: string): number {
  let columns = text.length
  // A tab advances to the next 8-column stop; counted flat as 8, which overshoots
  // by at most seven characters of scroll and never undershoots.
  for (let at = text.indexOf('\t'); at !== -1; at = text.indexOf('\t', at + 1)) {
    columns += TAB - 1
  }
  return columns
}

/**
 * How wide one side-by-side column has to be, as a CSS length.
 *
 * Side-by-side needs a number here, and `flex-1` cannot supply one. Every row is
 * its own flex container — that is what a virtualized list is — so two halves
 * sized by `flex: 1 1 0%` inside a `w-max` row each take half of *that row's*
 * content width. A 200-column line therefore widened its own row and nothing
 * else: its text ran out over the pane beside it, and the right-hand column
 * started at a different x on every long line, which is the one thing a
 * side-by-side diff exists to do correctly.
 *
 * Sizing both columns to the file's widest line fixes both at once. Every row
 * gets the same two definite widths, so the columns line up; the width is enough
 * for the longest line in the file, so nothing overflows a pane; and the row is
 * still `w-max`, so the panel scrolls sideways exactly as far as the file is wide.
 *
 * Unified needs none of this: one column of text, last in the row, growing the
 * row it is in. That is already right.
 */
function columnWidth(rows: readonly DiffRow[]): string {
  let widest = 0
  for (const row of rows) {
    if (row.kind !== 'line') continue
    for (const line of [row.left, row.right]) {
      if (line === null) continue
      widest = Math.max(widest, columnsIn(line.text))
    }
  }

  return `calc(${widest}ch + ${CELL_CHROME})`
}

/**
 * The sentence for a file with no diff to show, or `null` when it has one.
 *
 * Every branch here is a real T-016 outcome rather than a failure, and the view
 * has to name which: an empty diff pane looks identical whether the file is a
 * PNG, a 40 MB bundle, a rename that moved no bytes, or a fetch that lost. Only
 * the last of those is something going wrong.
 */
export function blobNotice(blobs: FileBlobs): string | null {
  const sides = [blobs.before, blobs.after]

  // Ahead of the rest deliberately: a side that failed is the only one of these
  // worth acting on, so it should not be hidden behind a quieter explanation.
  const failed = sides.find((side) => side.kind === 'failed')
  if (failed?.kind === 'failed') {
    return `Azure DevOps did not return this file: ${failed.message}`
  }

  // Before the size and binary checks: on a pure rename both sides are absent,
  // and it is the one case where "unchanged" is true of the bytes and false of
  // the file.
  if (blobs.renamedOnly) return 'Renamed. The contents did not change.'

  const binary = sides.find((side) => side.kind === 'binary')
  if (binary !== undefined) return 'Binary file. There is nothing to show as text.'

  const large = sides.find((side) => side.kind === 'too-large')
  if (large?.kind === 'too-large') {
    return `Too large to diff — ${large.bytes.toLocaleString()} bytes.`
  }

  // An add has no before and a delete has no after; both still have a diff.
  // Neither side is the case with nothing in it at all.
  if (blobs.before.kind === 'absent' && blobs.after.kind === 'absent') {
    return 'Nothing to show for this file.'
  }

  return null
}

/**
 * A delete is coloured by the line it used to be, everything else by the line
 * it now is — which is also which side's tokens apply, since the two sides were
 * tokenised separately and a line number only indexes one of them.
 */
function tokensFor(
  line: DiffLine,
  before: HighlightedLines | null,
  after: HighlightedLines | null,
): readonly HighlightToken[] | null {
  if (line.op === 'delete') {
    return line.oldLine === null ? null : (before?.[line.oldLine - 1] ?? null)
  }

  return line.newLine === null ? null : (after?.[line.newLine - 1] ?? null)
}

/**
 * `className` carries the sheet the numbers sit on, decided by the caller.
 *
 * Prof's gutter is the sunken sheet beside the code, but a tinted row has to
 * keep its own wash all the way to the left edge or the eye stops reading the
 * colour as "this whole line changed" — so `bg-muted` is the caller's call, not
 * this component's. Passed as a class rather than as a boolean because the same
 * hook carries the division from the code, and one prop beats two.
 */
function Gutter({ line, className }: { line: number | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        // Secondary ink, not `--ink-300`: placeholder ink on the sunken gutter
        // measures 2.1:1, and a line number you have to hunt for is the one
        // thing in a gutter that has a job. `--ink-500` clears 4.5:1 there and
        // still sits behind the code beside it — 4.6 against the code's 9.9 on
        // paper, 7.2 against 12.3 in chalk. Both numbers move with the theme;
        // the ordering, which is the part that matters, does not.
        'text-ink-500 w-12 shrink-0 grow-0 basis-12 pr-2 text-right tabular-nums select-none',
        className,
      )}
    >
      {line ?? ''}
    </span>
  )
}

/** One side of one line: number, marker, text. The unit both layouts are built from. */
function Cell({
  line,
  number,
  tokens,
  className,
  width,
}: {
  line: DiffLine | null
  /** Which of the line's two numbers this column shows. */
  number: number | null
  tokens: readonly HighlightToken[] | null
  className?: string
  /**
   * The column's own width, from `columnWidth` — set in side-by-side and absent
   * in unified, where there is one column and it is the row. It lands on
   * `flex-basis` rather than `width` so a file narrower than the panel still has
   * its two halves grow to fill it evenly.
   */
  width?: string
}) {
  return (
    <span
      style={width === undefined ? undefined : { flexBasis: width }}
      className={cn(
        'flex min-w-0 flex-1 items-baseline',
        line === null
          ? // Not a gap and not a zero-height row: side-by-side needs a blank
            // of the same height opposite an unmatched line, or the two columns
            // stop lining up from that point down. Full-strength `bg-muted`
            // rather than the fraction this used to carry, which was legible
            // against a dark app and is nothing at all against paper.
            //
            // A `hatch-cross` void is the more Prof answer and was tried: in
            // split every changed line has a blank opposite it, so half the
            // pane fills with drawn texture, and it is a tiled background image
            // on the one component that must not get more expensive per row.
            'bg-muted'
          : line.op === 'add'
            ? 'diff-add'
            : line.op === 'delete'
              ? 'diff-delete'
              : undefined,
        className,
      )}
    >
      <Gutter
        line={number}
        className={cn(line?.op === 'context' && 'bg-muted', 'border-border border-r')}
      />
      <span aria-hidden className="w-3 shrink-0 select-none">
        {line === null ? '' : MARK[line.op]}
      </span>
      <span className="whitespace-pre">
        {line === null ? '' : <LineText text={line.text} tokens={tokens} edits={line.edits} />}
      </span>
    </span>
  )
}

function Row({
  row,
  layout,
  column,
  before,
  after,
  onExpand,
  threadActions,
}: {
  row: DiffRow
  layout: DiffLayout
  /** One side-by-side column's width. Unused in unified — see `columnWidth`. */
  column: string
  before: HighlightedLines | null
  after: HighlightedLines | null
  onExpand?: (row: Extract<DiffRow, { kind: 'gap' }>) => void
  threadActions?: ThreadActions
}) {
  // One row spanning both columns in side-by-side, not one per side: a
  // conversation about a line is one conversation, and splitting it in half
  // would make a two-column diff of a discussion.
  if (row.kind === 'thread') {
    return <ThreadCard threads={row.threads} actions={threadActions} />
  }

  if (row.kind === 'hunk') {
    return (
      // A break in the page rather than a grey bar: the `@@` label, then a drawn
      // rule running out to the right edge. The rule costs no row height — it is
      // 6px centred inside the 20px the virtualizer already reserved — which is
      // the only reason `.sketch-rule` is affordable anywhere in this file.
      <span className="bg-muted text-muted-foreground flex w-full items-center gap-2 px-2 select-none">
        {row.label}
        <span aria-hidden className="sketch-rule min-w-8 flex-1" />
      </span>
    )
  }

  if (row.kind === 'gap') {
    const label = `Expand ${row.hiddenLines} hidden ${row.hiddenLines === 1 ? 'line' : 'lines'}`

    return (
      <button
        type="button"
        // Plain element rather than the shadcn `Button`: this is a full-bleed
        // row in a virtualized list, and every variant that component offers
        // would have to be undone to get there.
        onClick={onExpand === undefined ? undefined : () => onExpand(row)}
        disabled={onExpand === undefined}
        // Teal on hover, because `bg-accent` is what the rest of the app uses to
        // say "this is the thing you are about to press". The disabled override
        // holds the band rather than clearing it: an inert gap should look like
        // furniture, and the old `bg-transparent` made it flicker out under the
        // pointer instead.
        className="bg-muted text-muted-foreground hover:bg-accent flex w-full items-baseline gap-1.5 px-2 text-left disabled:hover:bg-muted"
      >
        <HugeiconsIcon icon={UnfoldMoreIcon} size={12} className="shrink-0" aria-hidden />
        {label}
      </button>
    )
  }

  // Unified and side-by-side are the same row read twice. The row model already
  // decided the pairing; the only difference here is how many columns of it get
  // rendered, which is why there is no second code path for either.
  if (layout === 'split') {
    return (
      <>
        <Cell
          line={row.left}
          number={row.left?.oldLine ?? null}
          tokens={row.left === null ? null : tokensFor(row.left, before, after)}
          className="border-border border-r"
          width={column}
        />
        <Cell
          line={row.right}
          number={row.right?.newLine ?? null}
          tokens={row.right === null ? null : tokensFor(row.right, before, after)}
          width={column}
        />
      </>
    )
  }

  // In unified, a change sets exactly one side and a context line sets both to
  // the same line, so either one answers.
  const line = row.left ?? row.right
  if (line === null) return null

  // Only the unchanged line gets the sunken sheet under its numbers; a tinted
  // row keeps its pen all the way across. The division goes on the second
  // gutter, which is where the numbers stop and the code starts.
  const sheet = line.op === 'context' ? 'bg-muted' : undefined

  return (
    <span
      className={cn(
        'flex w-full items-baseline',
        line.op === 'add' ? 'diff-add' : line.op === 'delete' ? 'diff-delete' : undefined,
      )}
    >
      <Gutter line={line.oldLine} className={sheet} />
      <Gutter line={line.newLine} className={cn(sheet, 'border-border border-r')} />
      <span aria-hidden className="w-3 shrink-0 select-none">
        {MARK[line.op]}
      </span>
      <span className="whitespace-pre">
        <LineText text={line.text} tokens={tokensFor(line, before, after)} edits={line.edits} />
      </span>
    </span>
  )
}

export function DiffView({
  rows,
  layout,
  label,
  before = null,
  after = null,
  onExpand,
  threadActions,
}: {
  rows: readonly DiffRow[]
  layout: DiffLayout
  /** Names the scroll region — the file path, on the detail page. */
  label: string
  /** Tokens for each side, indexed by line number − 1. `null` until the worker answers. */
  before?: HighlightedLines | null
  after?: HighlightedLines | null
  onExpand?: (row: Extract<DiffRow, { kind: 'gap' }>) => void
  /**
   * What a conversation in the diff can do. Absent renders every thread
   * read-only, which is what the diff does until the server layer is wired.
   */
  threadActions?: ThreadActions
}) {
  const scroller = useRef<HTMLDivElement>(null)

  // Once per file rather than once per row: it walks every line's text, and a row
  // is rendered again every time it scrolls past. Recomputed when a gap expands,
  // because the lines that arrive with it can be wider than anything above them.
  const column = useMemo(() => (layout === 'split' ? columnWidth(rows) : ''), [rows, layout])

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    // Per-index rather than constant, because a thread row is prose and every
    // other row is one line of code. See `ROW_HEIGHT`.
    estimateSize: (index) =>
      rows[index].kind === 'thread' ? THREAD_ROW_ESTIMATE : ROW_HEIGHT,
    overscan: 16,
    // The whole reason T-018 gives every row a stable key: expanding a gap in
    // the middle of a file shifts every index below it, and keying on index
    // would remount all of them for a click that changed nothing about them.
    getItemKey: (index) => rows[index].key,
  })

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={label}
      // No box of its own any more. `FileDiffPanel` draws one — a pen outline
      // with organic corners — and two drawn boxes one inside the other read as
      // a mistake in a system whose whole signature is linework. The diff runs
      // full-bleed to the panel's inner edge instead.
      className="max-h-[70vh] w-full overflow-auto font-mono text-xs leading-5"
    >
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const thread = rows[item.index].kind === 'thread'

          return (
            <div
              key={item.key}
              // Measured on thread rows and nowhere else. `data-index` is not
              // decoration: `measureElement` reads it to know which row it just
              // measured, and without it the measurement is applied to the
              // wrong index.
              data-index={thread ? item.index : undefined}
              ref={thread ? virtual.measureElement : undefined}
              className={cn(
                'absolute top-0 left-0',
                thread
                  ? // Full width and not `w-max`: a thread wraps, and a row that
                    // grows to fit its widest word would widen the file's
                    // horizontal scroll by the length of a paragraph.
                    'w-full'
                  : // `w-max min-w-full` is what gives the container one
                    // horizontal scrollbar for the whole file instead of one per
                    // line: an absolute child still contributes to its scroll
                    // width.
                    'flex w-max min-w-full',
              )}
              // Height is set on the rows whose height is known. A measured row
              // must be free to be as tall as it is, or it would measure the
              // estimate back and never converge.
              style={
                thread
                  ? { transform: `translateY(${item.start}px)` }
                  : { height: item.size, transform: `translateY(${item.start}px)` }
              }
            >
              <Row
                row={rows[item.index]}
                layout={layout}
                column={column}
                before={before}
                after={after}
                onExpand={onExpand}
                threadActions={threadActions}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
