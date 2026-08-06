import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  CommentAdd01Icon,
  Link01Icon,
  LinkSquare02Icon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { LineText } from './line-text'
import { Composer } from '@/components/comments/composer'
import { ThreadCard } from '@/components/comments/thread-card'
import { COMPOSER_ROW_ESTIMATE, THREAD_ROW_ESTIMATE } from '@/lib/comment-contract'
import { rowIndexForLine } from '@/lib/diff-rows'
import { cn } from '@/lib/utils'

import type { ReactNode } from 'react'
import type {
  DiffLayout,
  DiffLine,
  DiffRow,
  HighlightToken,
  HighlightedLines,
  NotedBlobs,
} from '@/lib/diff-contract'
import type { IterationContext } from '@/lib/comment-contract'
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
 * T-037 added the second, for the same reason and with a harder bound on how many
 * there can be: a composer is prose being typed, and `RowModel.composer` holds one
 * anchor, so there is at most one of these in the file. See `measured`.
 *
 * Keep in step with `leading-5` on the row.
 */
const ROW_HEIGHT = 20

/**
 * Whether the virtualizer is allowed to read this row's real height.
 *
 * One predicate rather than the same two-arm test written at each of the four
 * places that need it — the estimate, `data-index`, the `ref`, and the row's own
 * class and style — because those four have to agree. A row measured without
 * `data-index` has its measurement filed under the wrong index, and a row given a
 * fixed `height` measures its estimate straight back and never converges.
 */
function measured(row: DiffRow): boolean {
  return row.kind === 'thread' || row.kind === 'composer'
}

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
 *
 * `source` is who the bytes were asked of — "Azure DevOps", or a repository on
 * this disk. Required, and not defaulted to the service that happened to be
 * first: the one sentence that reads it is an accusation, and a wrong name in it
 * sends someone to check a network they never used.
 */
export function blobNotice(blobs: NotedBlobs, source: string): string | null {
  // A source that already knows why there are no bytes wins, per the sentence on
  // `LocalFileBlobs.note`: it can say "Submodule at abc1234" or "Mode changed,
  // 100644 → 100755", and everything computed below can only say "nothing to
  // show". The precedence over `failed` costs nothing live — a gitlink never
  // reaches `cat-file` at all, and a mode flip has the same sha on both sides,
  // so the two of them succeed or fail together and never disagree with a note.
  if (blobs.note != null) return blobs.note

  const sides = [blobs.before, blobs.after]

  // Ahead of the rest deliberately: a side that failed is the only one of these
  // worth acting on, so it should not be hidden behind a quieter explanation.
  const failed = sides.find((side) => side.kind === 'failed')
  if (failed?.kind === 'failed') {
    return `${source} did not return this file: ${failed.message}`
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

/**
 * The teal wash the app uses for "this is what you are about to press", opaque so
 * it reads against whichever of the three row tints is under it. Hidden until the
 * row is hovered or the control itself is focused, and hidden with `opacity`
 * rather than by not rendering it: each one stays in the tab order, so the whole
 * affordance is reachable without a pointer.
 */
const LINE_ACTION =
  'bg-accent text-ink flex size-4 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100'

/**
 * What you can do to one line, over the left edge of the new-side gutter: start a
 * thread on it, copy a link to it, open it in Azure DevOps.
 *
 * Buttons on the row rather than keys in the registry, because the registry's
 * commands act on a selection and the diff has no line cursor for one to act on —
 * there is nothing for `c` to mean until the pointer or the tab order has said
 * which line.
 *
 * The row's geometry never moves: 5,000 rows that reflow on hover is the one
 * thing this component cannot afford. Absolutely positioned for the same reason —
 * a flex child here would push every line of code sideways.
 *
 * Deliberately absent from a row with no right-side line. A delete has no line in
 * the file as it now stands, ADO would need a left-side anchor for it, and this
 * codebase puts left-side threads in `unanchored` — so no button is the clear
 * refusal, rather than a button that posts a wrong anchor or links to a line that
 * is gone.
 *
 * Each of the three is absent on its own terms too. No `onCompose` is a diff that
 * cannot post; no `adoLineUrl` is the branch compare and the commit pages, which
 * have no Azure DevOps address at all and get no button rather than a dead one.
 */
function LineActions({
  line,
  className,
  onCompose,
  onCopyLink,
  adoLineUrl,
}: {
  line: number
  /** Where the new-side gutter starts: the row in unified, the right `Cell` in split. */
  className?: string
  onCompose?: (line: number) => void
  onCopyLink?: (line: number) => void
  adoLineUrl?: string
}) {
  if (onCompose === undefined && onCopyLink === undefined && adoLineUrl === undefined) return null

  return (
    // Each name says the line, because "Comment" repeated 5,000 times down a tab
    // order says nothing about where you are.
    <span className={cn('absolute top-0 flex items-center gap-px', className)}>
      {onCompose === undefined ? null : (
        <button
          type="button"
          onClick={() => onCompose(line)}
          aria-label={`Comment on line ${line}`}
          title={`Comment on line ${line}`}
          className={LINE_ACTION}
        >
          <HugeiconsIcon icon={CommentAdd01Icon} size={12} aria-hidden />
        </button>
      )}
      {onCopyLink === undefined ? null : (
        <button
          type="button"
          onClick={() => onCopyLink(line)}
          aria-label={`Copy a link to line ${line}`}
          title={`Copy a link to line ${line}`}
          className={LINE_ACTION}
        >
          <HugeiconsIcon icon={Link01Icon} size={12} aria-hidden />
        </button>
      )}
      {adoLineUrl === undefined ? null : (
        <a
          href={adoLineUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open line ${line} in Azure DevOps`}
          title={`Open line ${line} in Azure DevOps`}
          className={LINE_ACTION}
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={12} aria-hidden />
        </a>
      )}
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
  actions,
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
  /**
   * A `LineActions` for this column, or nothing. Passed in rather than decided
   * here because only the right-hand column of a row with a new-side line has one,
   * and `Cell` is not told which of the two columns it is.
   */
  actions?: ReactNode
}) {
  return (
    <span
      style={width === undefined ? undefined : { flexBasis: width }}
      className={cn(
        'flex min-w-0 flex-1 items-baseline',
        // Only so `actions` has something to be positioned against. Harmless on
        // the cells that have none.
        'relative',
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
      {actions}
    </span>
  )
}

/**
 * Everything the composer row needs that is not on the row itself, in one prop.
 *
 * Bundled because `Row` already takes seven and four more would make the composer
 * the biggest thing in a signature it is one arm of. Its absence is also the
 * switch: no bundle, no draft can be written, which is what a `DiffView` with no
 * `onCompose` means.
 */
interface Composing {
  /** Which iterations the new thread is written against. */
  iterationContext: IterationContext | null
  /** What was in the box last time it was open on this line. See `DiffView`. */
  draft: string
  onDraft: (text: string) => void
  /** Close and keep the draft — Cancel, and Escape. */
  onCancel: () => void
  /** Close and forget it: the thread exists now, and the poll will bring it back. */
  onPosted: () => void
}

function Row({
  row,
  layout,
  column,
  before,
  after,
  onExpand,
  threadActions,
  onCompose,
  onCopyLink,
  adoLineUrl,
  composing,
}: {
  row: DiffRow
  layout: DiffLayout
  /** One side-by-side column's width. Unused in unified — see `columnWidth`. */
  column: string
  before: HighlightedLines | null
  after: HighlightedLines | null
  onExpand?: (row: Extract<DiffRow, { kind: 'gap' }>) => void
  threadActions?: ThreadActions
  /** Open a composer on a right-side line. Absent renders no compose buttons. */
  onCompose?: (line: number) => void
  /** Put a link to a right-side line on the clipboard. Absent renders no copy buttons. */
  onCopyLink?: (line: number) => void
  /** This line's Azure DevOps address. Absent renders no open-in-ADO link. */
  adoLineUrl?: (line: number) => string
  composing?: Composing
}) {
  // One row spanning both columns in side-by-side, not one per side: a
  // conversation about a line is one conversation, and splitting it in half
  // would make a two-column diff of a discussion.
  if (row.kind === 'thread') {
    return <ThreadCard threads={row.threads} actions={threadActions} />
  }

  // Same shape as a thread row, and next to one when the line already has a
  // conversation on it: full width, both columns, prose.
  if (row.kind === 'composer') {
    const onNewThread = threadActions?.onNewThread
    // Neither of these can be missing while the row exists — the row model only
    // gains a composer because something called `onCompose` — but the row is a
    // plain data structure and a caller can hand one to a read-only view.
    if (onNewThread === undefined || composing === undefined) return null

    return (
      // `py-1 pr-2 pl-12`, which is exactly what `ThreadCard` indents by: the
      // draft has to start where the conversation it is joining starts, or posting
      // it would shift the box it was written in.
      <div className="w-full py-1 pr-2 pl-12">
        <Composer
          label={`New comment on line ${row.line}`}
          autoFocus
          submitLabel="Comment"
          initial={composing.draft}
          onDraftChange={composing.onDraft}
          onSubmit={async (content) => {
            // `row.context` whole and unexamined: the caller that opened this knew
            // the file's path and chose the anchor, and re-deriving either here is
            // how the two come to disagree.
            await onNewThread({
              content,
              context: row.context,
              iterationContext: composing.iterationContext,
              status: 'active',
            })
            composing.onPosted()
          }}
          onCancel={composing.onCancel}
        />
      </div>
    )
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

  // The right-side line this row could hold a thread on, if it has one. Both
  // layouts read it off the same field, because the row model put it there. The
  // offset differs and only the offset does: in split the right column is its own
  // positioning context and the gutter starts at its left edge, in unified there is
  // one row and the new-side gutter is the second of two.
  const newLine = row.right?.newLine ?? null
  function actionsAt(className: string): ReactNode {
    if (newLine === null) return null
    return (
      <LineActions
        line={newLine}
        className={className}
        onCompose={onCompose}
        onCopyLink={onCopyLink}
        adoLineUrl={adoLineUrl?.(newLine)}
      />
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
          actions={actionsAt('left-0')}
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
        // `relative` for the line's buttons and nothing else — see `actionsAt`.
        'relative flex w-full items-baseline',
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
      {actionsAt('left-12')}
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
  onCompose,
  onCopyLink,
  adoLineUrl,
  iterationContext = null,
  jumped = null,
  arrival = 0,
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
  /**
   * Open a composer on this right-side line, or `null` to close the open one.
   *
   * The same shape as `setComposer`, and for the same reason: the composer is a
   * row, so the caller that owns the row model is the only thing that can put one
   * there. Absent renders no compose buttons at all — a read-only diff.
   */
  onCompose?: (line: number | null) => void
  /**
   * Put a link to this right-side line on the clipboard.
   *
   * Whoever owns the file's path owns this: a row knows its number and nothing
   * about which file it is in, and the acknowledgement has to be said somewhere a
   * reader is looking rather than on a 16px button that has already been let go of.
   */
  onCopyLink?: (line: number) => void
  /**
   * This right-side line's address in Azure DevOps.
   *
   * Absent on a page that has no Azure DevOps address — the branch compare, a
   * commit — where the link is not rendered at all rather than rendered dead.
   */
  adoLineUrl?: (line: number) => string
  /** Which iterations a thread started from a row is written against. */
  iterationContext?: IterationContext | null
  /**
   * The right-side line a jump landed on — `RowModel.jumped`, straight through.
   *
   * Scrolled to and marked. `null` on every file nobody jumped into, which is all
   * of them until somebody clicks a finding.
   */
  jumped?: number | null
  /**
   * How many jumps the caller has answered — see `ChangedFileDiff`.
   *
   * What makes a *second* click on the same finding scroll again. `jumped` cannot
   * say that on its own: asking for the line already marked is an identity-return
   * all the way up, so the line stays 214 and nothing here can tell a repeat click
   * from a re-render. Counting the requests separates them.
   *
   * Defaults to `0` rather than to `undefined`, because the guard compares it to
   * what it last acted on: a prop that is absent has to be *equal* to itself across
   * renders, or every render is a new jump and the poll drags the reader back.
   */
  arrival?: number
}) {
  const scroller = useRef<HTMLDivElement>(null)

  // The draft, kept here rather than inside `Composer`, and this is not a duplicate
  // of that component's own state — it is what survives the box being unmounted.
  // Two things unmount it: closing it, which must not silently eat the paragraph
  // somebody just wrote, and scrolling it out of the virtualizer's overscan window,
  // which is not a decision anybody made at all. Both put the text back when the
  // row comes round again.
  //
  // Carried with its line, so reopening a *different* line starts empty. Inheriting
  // the last line's text would be worse than losing it: it reads as a comment about
  // the line you are now looking at.
  //
  // A ref and not state, deliberately. Nothing on screen is derived from this —
  // `Composer` owns the text while it is open and reads this once, as it mounts —
  // and `useState` would re-render every visible row on every keystroke, which is
  // the one cost this whole component exists to avoid.
  const draft = useRef<{ line: number; text: string } | null>(null)

  // Once per file rather than once per row: it walks every line's text, and a row
  // is rendered again every time it scrolls past. Recomputed when a gap expands,
  // because the lines that arrive with it can be wider than anything above them.
  const column = useMemo(() => (layout === 'split' ? columnWidth(rows) : ''), [rows, layout])

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    // Per-index rather than constant, because a thread row is prose and every
    // other row is one line of code. See `ROW_HEIGHT`.
    estimateSize: (index) => {
      const row = rows[index]
      if (row.kind === 'thread') return THREAD_ROW_ESTIMATE
      if (row.kind === 'composer') return COMPOSER_ROW_ESTIMATE
      return ROW_HEIGHT
    },
    overscan: 16,
    // The whole reason T-018 gives every row a stable key: expanding a gap in
    // the middle of a file shifts every index below it, and keying on index
    // would remount all of them for a click that changed nothing about them.
    getItemKey: (index) => rows[index].key,
  })

  // Which jump this has already carried the reader to. The guard, not the deps: a
  // rebuilt `rows` is the normal state of this component — the thread poll answers
  // every thirty seconds — and an effect that scrolled whenever the rows changed
  // would haul the file back to the finding every half minute, out from under
  // whoever had scrolled away from it. Guarding instead means the rows may change as
  // often as they like, and a mark arriving on a row that did not exist yet (the
  // bytes, a revealed gap) is still followed the moment it does.
  //
  // The request and not the line, because the line cannot tell two of them apart:
  // clicking the same occurrence again — normal, after reading away from it — asks
  // for a line that is already marked, and every layer between here and the model
  // correctly answers that with the object it already had.
  const landed = useRef<number | null>(null)

  useEffect(() => {
    if (jumped === null || landed.current === arrival) return

    // `scrollToIndex` and not `getElementById` on the row, which cannot work here
    // and fails in the quietest possible way: the row for line 214 is in the DOM
    // only if 214 is one of the ~56 lines currently rendered, so a lookup answers
    // `null` for exactly the jumps that had somewhere to go. The virtualizer is the
    // only thing that knows where an unrendered row *would* be.
    const index = rowIndexForLine(rows, jumped)
    if (index === -1) return

    landed.current = arrival
    // Centred rather than at the top, because a finding is read with the lines
    // around it: `align: 'start'` puts the one line you were sent to against the
    // edge of a 70vh window with all of its context below the fold.
    virtual.scrollToIndex(index, { align: 'center' })
  }, [jumped, arrival, rows, virtual])

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
          const row = rows[item.index]
          const tall = measured(row)
          // One number compared per rendered row — 56 of them, not 5,000 — which is
          // why this is a prop and not a flag on `DiffRow`: marking a row in the
          // model would rebuild the file to move a box.
          const here = jumped !== null && row.kind === 'line' && row.right?.newLine === jumped

          return (
            <div
              key={item.key}
              // Measured on thread and composer rows and nowhere else. `data-index`
              // is not decoration: `measureElement` reads it to know which row it
              // just measured, and without it the measurement is applied to the
              // wrong index.
              data-index={tall ? item.index : undefined}
              ref={tall ? virtual.measureElement : undefined}
              className={cn(
                'absolute top-0 left-0',
                tall
                  ? // Full width and not `w-max`: prose wraps, and a row that grows
                    // to fit its widest word would widen the file's horizontal
                    // scroll by the length of a paragraph.
                    'w-full'
                  : // `w-max min-w-full` is what gives the container one
                    // horizontal scrollbar for the whole file instead of one per
                    // line: an absolute child still contributes to its scroll
                    // width.
                    //
                    // `group` is what the line's buttons watch for a hover. On
                    // the row rather than on the button so that pointing anywhere
                    // along the line reveals it — a 16px target you have to find
                    // before it appears is not a target.
                    'group flex w-max min-w-full',
                // An outline and not a border: every row of code is exactly
                // `ROW_HEIGHT` tall and `box-sizing: border-box`, so 1.5px of border
                // would eat 3px out of a 20px line and shift the text of the one row
                // you were sent to look at. An outline draws in the same place and
                // costs no layout at all.
                //
                // Teal at pen weight, and never the only thing that says so: the
                // panel above prints "Jumped to line 214." in words, because a mark
                // that is a colour is a mark half the readers of this diff do not
                // have (see `ChangedFileDiff`).
                here && 'outline-teal-500 outline-[1.5px] -outline-offset-[1.5px]',
              )}
              // Height is set on the rows whose height is known. A measured row
              // must be free to be as tall as it is, or it would measure the
              // estimate back and never converge.
              style={
                tall
                  ? { transform: `translateY(${item.start}px)` }
                  : { height: item.size, transform: `translateY(${item.start}px)` }
              }
            >
              <Row
                row={row}
                layout={layout}
                column={column}
                before={before}
                after={after}
                onExpand={onExpand}
                threadActions={threadActions}
                onCompose={onCompose}
                onCopyLink={onCopyLink}
                adoLineUrl={adoLineUrl}
                // Built for the composer row and no other, so the 5,000 rows that
                // are lines do not each allocate a bundle they will not read.
                composing={
                  row.kind !== 'composer' || onCompose === undefined
                    ? undefined
                    : {
                        iterationContext,
                        draft: draft.current?.line === row.line ? draft.current.text : '',
                        onDraft: (text) => {
                          draft.current = { line: row.line, text }
                        },
                        onCancel: () => onCompose(null),
                        onPosted: () => {
                          draft.current = null
                          onCompose(null)
                        },
                      }
                }
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
