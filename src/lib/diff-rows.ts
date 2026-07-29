import type { ComposerRow, FileThreads, Thread, ThreadContext } from './comment-contract'
import type { DiffHunk, DiffLayout, DiffLine, DiffRow, FileDiff } from './diff-contract'
import { formatHunkHeader } from './diff'

// Hunks into the flat list a virtualizer can index and measure.
//
// The two layouts are one projection function with one branch in it. That is
// the point of the module: unified and side-by-side disagree about how a run of
// deletes and the adds after it become rows, and about nothing else, so
// everything before that decision — which hunks, which gaps, which lines are
// revealed, what each row is called — is computed once.
//
// Expansion is modelled as a set of revealed line ranges rather than as an edit
// to the row array. Rows are then a pure function of (diff, reveals, layout,
// threads, hideDone), which is what makes the two hard cases fall out instead of
// being handled: expanding the top and the bottom of one gap until the two
// reveals meet is just a union of adjacent ranges, and a row's key never
// depends on where the row sits, so nothing above the click is re-keyed.
//
// T-025 added the middle two inputs, and "hide done" is one of them rather than a
// class on a rendered row for the same reason the reveals are inputs: a hidden
// thread that still occupies a row is a row the virtualizer still measures, and
// a measured row is the expensive kind.
//
// T-037 added the sixth, and it is the only input that is not about the file.
// An open composer looks like local UI state and cannot be kept as any: the rows
// are rebuilt from these inputs every time the thirty-second poll answers, so
// anything outside them is erased by the next tick — with somebody's draft in it.
// A sixth input is what makes the draft survive a poll, and it costs the same
// identity-return every other input already has.
//
// T-038 added the seventh — the line a jump landed on — for that same reason and
// one more: new bytes for the file have to *drop* it. A mark recorded against the
// iteration you were reading points at different code in the next one, and
// `buildRows` is the one door those bytes come through. It is also the only input
// no row is derived from; see `jumpToLine`.

/** Lines revealed by one click, matching what GitHub's expander shows. */
export const GAP_EXPAND_LINES = 20

/** Which end of the gap the revealed lines come off. */
export type GapEnd = 'top' | 'bottom' | 'all'

/** A half-open run of 1-based new-side line numbers. */
export interface Span {
  readonly start: number
  readonly end: number
}

export interface RowModel {
  readonly rows: readonly DiffRow[]
  readonly layout: DiffLayout
  readonly diff: FileDiff
  /**
   * The whole after side. Gaps are unchanged by definition, so this is also the
   * text of the before side there — only the line numbers differ, and those the
   * hunks already carry.
   */
  readonly lines: readonly string[]
  readonly revealed: readonly Span[]
  /** This file's conversations, or `null` for a file nobody has commented on. */
  readonly threads: FileThreads | null
  readonly hideDone: boolean
  /**
   * Where the reviewer is writing a new thread, or `null` when they are not.
   *
   * One field, so one composer at a time comes out of the shape rather than out
   * of a rule somebody has to remember to enforce.
   */
  readonly composer: ThreadContext | null
  /**
   * The right-side line a jump landed on, or `null` when nothing has jumped here.
   *
   * The line that was *asked for*, not one that was found. Sonar's numbers drift
   * from the diff (note 6), so a `jumped` line with no row is the ordinary second
   * outcome of a jump and something the caller has to be able to say out loud —
   * `rowIndexForLine` answering `-1` is the whole of that test.
   */
  readonly jumped: number | null
}

export function buildRows(
  diff: FileDiff,
  lines: readonly string[],
  layout: DiffLayout,
  threads: FileThreads | null = null,
  hideDone: boolean = false,
): RowModel {
  // No composer parameter and no jumped line: a file's rows are never built with a
  // draft already in them, or with a mark. New bytes for this file rebuild through
  // here, which is also what closes a composer anchored to a line that may no
  // longer be the same line — and drops a mark left on one.
  return rebuild(diff, lines, layout, [], threads, hideDone, null, null)
}

/** The same diff and the same expansions, projected the other way. */
export function setLayout(model: RowModel, layout: DiffLayout): RowModel {
  if (layout === model.layout) return model
  return rebuild(
    model.diff,
    model.lines,
    layout,
    model.revealed,
    model.threads,
    model.hideDone,
    model.composer,
    model.jumped,
  )
}

/**
 * The threads arrived, or changed under the file.
 *
 * A separate entry point rather than a rebuild from scratch because threads come
 * from a poll: they land after the bytes, and again every thirty seconds. The
 * expansions and the layout have to survive that, and a reply must not close a
 * gap somebody opened to read the code the reply is about.
 */
export function setThreads(model: RowModel, threads: FileThreads | null): RowModel {
  if (threads === model.threads) return model
  return rebuild(
    model.diff,
    model.lines,
    model.layout,
    model.revealed,
    threads,
    model.hideDone,
    model.composer,
    model.jumped,
  )
}

/** Toggle the per-PR "hide done" flag for this file's rows. */
export function setHideDone(model: RowModel, hideDone: boolean): RowModel {
  if (hideDone === model.hideDone) return model
  return rebuild(
    model.diff,
    model.lines,
    model.layout,
    model.revealed,
    model.threads,
    hideDone,
    model.composer,
    model.jumped,
  )
}

/**
 * Open a composer on a line, or close the one that is open.
 *
 * A transition like the other four rather than a prop on the view, because the
 * composer has to be a row before the virtualizer will place it, and it has to be
 * a row model *input* before it will survive the next poll.
 *
 * A `context` with no `rightStart` is refused rather than coerced. That is the
 * anchor this whole ticket exists for, and a draft about the file rather than
 * about a line already has a home above the diff — see `FileThreadList`. It is
 * also the one shape that could put a thread on line 0, which ADO answers 200 to
 * and then files nowhere (`threads-fn.ts`).
 */
export function setComposer(model: RowModel, context: ThreadContext | null): RowModel {
  const next = context === null || context.rightStart === null ? null : context
  // Compared by anchor rather than by identity: pressing the same line's button
  // twice builds an equal-but-new context, and rebuilding the file's rows for it
  // would be work with nothing on the other side of it.
  if ((next?.rightStart?.line ?? null) === (model.composer?.rightStart?.line ?? null)) return model

  return rebuild(
    model.diff,
    model.lines,
    model.layout,
    model.revealed,
    model.threads,
    model.hideDone,
    next,
    model.jumped,
  )
}

/**
 * Reveal lines out of the gap with this key. Returns the model unchanged — the
 * same object, so a re-render can be skipped — when the key is not a gap or the
 * gap has nothing left to give.
 */
export function expandGap(
  model: RowModel,
  key: string,
  end: GapEnd,
  count: number = GAP_EXPAND_LINES,
): RowModel {
  const gap = model.rows.find((row) => row.kind === 'gap' && row.key === key)
  if (gap === undefined || gap.kind !== 'gap') return model

  const from = gap.newStart
  const to = gap.newStart + gap.hiddenLines
  const take = Math.min(count, gap.hiddenLines)
  if (take <= 0) return model

  const span: Span =
    end === 'all'
      ? { start: from, end: to }
      : end === 'top'
        ? { start: from, end: from + take }
        : { start: to - take, end: to }

  return rebuild(
    model.diff,
    model.lines,
    model.layout,
    union(model.revealed, span),
    model.threads,
    model.hideDone,
    model.composer,
    model.jumped,
  )
}

/**
 * Mark the row a jump landed on, revealing it first if a gap is hiding it.
 *
 * One transition and not two, because a line inside collapsed context has no row
 * at all: expanding the gap that hides it is part of arriving, and a caller left
 * to remember that would find its jump landing on the nearest row that does
 * exist, silently and some hundreds of lines away.
 *
 * The whole gap goes, which is what the gutter's own expander already does (see
 * `changed-file.tsx`): the reveal here is a means of reaching one line, and
 * uncollapsing 20 of the 300 lines it might be inside is landing somewhere else
 * again.
 *
 * The line is recorded whether or not this diff contains it. That is not a lenient
 * fallback — a finding on a line the iteration does not have is the routine second
 * outcome (note 6), and the caller cannot say "line 214 is not in this diff" about
 * a number the model refused to keep.
 */
export function jumpToLine(model: RowModel, line: number | null): RowModel {
  if (line === null) return model.jumped === null ? model : { ...model, jumped: null }

  const gap = model.rows.find(
    (row) => row.kind === 'gap' && row.newStart <= line && line < row.newStart + row.hiddenLines,
  )

  if (gap === undefined || gap.kind !== 'gap') {
    if (model.jumped === line) return model

    // A copy rather than a `rebuild`, and the only place in this module that does
    // that: `jumped` is the one input no row is derived from, so reprojecting the
    // file would walk every line of it to produce an identical row array — and
    // hand the view a *new* one, which is what makes it re-measure the widest line
    // in a 5,000-line file for the sake of a mark on one of them.
    return { ...model, jumped: line }
  }

  return rebuild(
    model.diff,
    model.lines,
    model.layout,
    union(model.revealed, { start: gap.newStart, end: gap.newStart + gap.hiddenLines }),
    model.threads,
    model.hideDone,
    model.composer,
    line,
  )
}

/**
 * Which row shows this right-side line, or `-1` when none does.
 *
 * Right-side only, and that is the whole subtlety: every anchor this app receives
 * is written against the after side — Sonar's `textRange.startLine`,
 * `FileThreads.byRightLine` — and in side-by-side one row carries both sides, so a
 * lookup that matched either would answer with a row whose left number happens to
 * collide.
 *
 * A scan, not an index. Indices move under every insertion `attach` makes, so a map
 * built once would need rebuilding as often as it were read; and a jump is one
 * click, where a few thousand comparisons cost nothing beside the render they are
 * about to cause. Takes rows rather than a model because the view has only rows.
 */
export function rowIndexForLine(rows: readonly DiffRow[], line: number): number {
  return rows.findIndex((row) => row.kind === 'line' && row.right?.newLine === line)
}

function rebuild(
  diff: FileDiff,
  lines: readonly string[],
  layout: DiffLayout,
  revealed: readonly Span[],
  threads: FileThreads | null,
  hideDone: boolean,
  composer: ThreadContext | null,
  jumped: number | null,
): RowModel {
  return {
    rows: attach(project(flatten(diff, lines, revealed), layout), threads, hideDone, composer),
    layout,
    diff,
    lines,
    revealed,
    threads,
    hideDone,
    composer,
    jumped,
  }
}

/** Ranges are kept sorted, disjoint and non-touching, so a gap that closes disappears. */
function union(spans: readonly Span[], added: Span): Span[] {
  const out: Span[] = []
  let { start, end } = added

  for (const span of spans) {
    if (span.end < start) out.push(span)
    else if (span.start > end) {
      out.push({ start, end })
      start = span.start
      end = span.end
    } else {
      start = Math.min(start, span.start)
      end = Math.max(end, span.end)
    }
  }
  out.push({ start, end })

  return out
}

// ---------------------------------------------------------------------------
// Layout-independent flattening.
// ---------------------------------------------------------------------------

type Item =
  | { readonly kind: 'hunk'; readonly hunk: DiffHunk }
  | { readonly kind: 'line'; readonly line: DiffLine }
  | { readonly kind: 'gap'; readonly oldStart: number; readonly newStart: number; readonly hiddenLines: number }

/**
 * Hunks, the lines in them, and what sits between them.
 *
 * No hunks means no rows, and that covers two different situations on purpose:
 * an unchanged file has nothing to show, and a file the diff gave up on has
 * nothing honest to show. Both are the caller's message to write, not a row.
 */
function flatten(diff: FileDiff, lines: readonly string[], revealed: readonly Span[]): Item[] {
  if (diff.hunks.length === 0) return []

  const items: Item[] = []
  let oldNext = 1
  let newNext = 1

  for (const hunk of diff.hunks) {
    between(items, lines, revealed, oldNext, newNext, hunk.newStart - newNext)
    items.push({ kind: 'hunk', hunk })
    for (const line of hunk.lines) items.push({ kind: 'line', line })
    oldNext = hunk.oldStart + hunk.oldCount
    newNext = hunk.newStart + hunk.newCount
  }

  between(items, lines, revealed, oldNext, newNext, lines.length + 1 - newNext)

  return items
}

/** One unhidden region, cut into the parts already revealed and the parts still collapsed. */
function between(
  items: Item[],
  lines: readonly string[],
  revealed: readonly Span[],
  oldFrom: number,
  newFrom: number,
  length: number,
): void {
  let at = newFrom
  const end = newFrom + length

  while (at < end) {
    const span = revealed.find((candidate) => candidate.start <= at && at < candidate.end)
    if (span !== undefined) {
      const until = Math.min(span.end, end)
      for (; at < until; at++) {
        items.push({
          kind: 'line',
          line: {
            op: 'context',
            text: lines[at - 1] as string,
            oldLine: oldFrom + (at - newFrom),
            newLine: at,
            edits: [],
          },
        })
      }
      continue
    }

    const next = revealed.reduce(
      (soonest, candidate) => (candidate.start > at ? Math.min(soonest, candidate.start) : soonest),
      end,
    )
    items.push({
      kind: 'gap',
      oldStart: oldFrom + (at - newFrom),
      newStart: at,
      hiddenLines: next - at,
    })
    at = next
  }
}

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

function project(items: readonly Item[], layout: DiffLayout): DiffRow[] {
  const rows: DiffRow[] = []

  for (let i = 0; i < items.length; ) {
    const item = items[i] as Item

    if (item.kind === 'hunk') {
      rows.push({ kind: 'hunk', key: `@${item.hunk.oldStart},${item.hunk.newStart}`, label: formatHunkHeader(item.hunk) })
      i++
      continue
    }
    if (item.kind === 'gap') {
      rows.push({
        kind: 'gap',
        key: `~${item.oldStart},${item.newStart}`,
        hiddenLines: item.hiddenLines,
        oldStart: item.oldStart,
        newStart: item.newStart,
      })
      i++
      continue
    }

    const run: DiffLine[] = []
    for (; i < items.length && (items[i] as Item).kind === 'line'; i++) {
      run.push((items[i] as { line: DiffLine }).line)
    }
    if (layout === 'unified') unified(rows, run)
    else split(rows, run)
  }

  return rows
}

function unified(rows: DiffRow[], run: readonly DiffLine[]): void {
  for (const line of run) {
    if (line.op === 'context') rows.push(row(line, line))
    else if (line.op === 'delete') rows.push(row(line, null))
    else rows.push(row(null, line))
  }
}

/**
 * The same lines, with each delete set beside the add that replaced it.
 *
 * Pairing is positional within a run, which is the same rule `diff.ts` uses to
 * decide which two lines get intra-line marks — so the marks in the two halves
 * of a row always refer to each other, and a longer run on one side simply runs
 * out, leaving `null` opposite the remainder.
 */
function split(rows: DiffRow[], run: readonly DiffLine[]): void {
  for (let i = 0; i < run.length; ) {
    if ((run[i] as DiffLine).op === 'context') {
      rows.push(row(run[i] as DiffLine, run[i] as DiffLine))
      i++
      continue
    }

    const deletes: DiffLine[] = []
    for (; i < run.length && (run[i] as DiffLine).op === 'delete'; i++) deletes.push(run[i] as DiffLine)
    const adds: DiffLine[] = []
    for (; i < run.length && (run[i] as DiffLine).op === 'add'; i++) adds.push(run[i] as DiffLine)

    for (let p = 0; p < Math.max(deletes.length, adds.length); p++) {
      rows.push(row(deletes[p] ?? null, adds[p] ?? null))
    }
  }
}

/**
 * A row is named by the pair of line numbers it shows, which is exactly what
 * survives an expansion: revealing a gap inserts rows whose numbers were not
 * used before and changes no existing row's numbers. Nothing here depends on
 * position, so nothing above a click is re-keyed.
 */
function row(left: DiffLine | null, right: DiffLine | null): DiffRow {
  return { kind: 'line', key: `${left?.oldLine ?? '-'}/${right?.newLine ?? '-'}`, left, right }
}

// ---------------------------------------------------------------------------
// Threads.
// ---------------------------------------------------------------------------

const NO_THREADS: ReadonlyMap<number, readonly Thread[]> = new Map()

/**
 * A composer row's key, derived from the line it hangs on and nothing else.
 *
 * The same content-derived rule the other four kinds follow, and it cannot
 * collide with the thread row that will replace it once the draft posts: that one
 * is `!<threadId>`.
 */
function composerKey(line: number): string {
  return `+${line}`
}

/**
 * Thread rows, under the lines they hang on. Layout-independent on purpose: in
 * side-by-side a conversation is one row spanning both columns, because it is
 * one conversation and not two halves of one.
 *
 * Placement is by right-side line and only by right-side line, because that is
 * the only anchor live data has: all 12 anchored threads in the census were
 * right-side, `FileThreads.byRightLine` is keyed that way, and a left-side
 * anchor is in `unanchored` before it reaches this function. One row per line
 * rather than one per thread — `ThreadRow.threads` is a list, and two people
 * commenting on the same line is one row to measure instead of two.
 *
 * A thread whose line is inside a collapsed gap attaches to the gap that hides
 * it, so it is somewhere rather than nowhere. Expanding that gap moves it onto
 * its real line without remounting it, because its key is the thread's id and
 * nothing about where the row sits.
 *
 * T-037 puts the composer row through the same cursor, and **under** whatever is
 * already on its line: the conversation that exists reads first and the draft
 * arrives at the bottom of it, the way a new message would. Deterministic either
 * way — what matters is that it does not depend on which of the two the map
 * happened to be iterating.
 */
function attach(
  rows: readonly DiffRow[],
  threads: FileThreads | null,
  hideDone: boolean,
  composer: ThreadContext | null,
): readonly DiffRow[] {
  const byLine = threads?.byRightLine ?? NO_THREADS
  // Built here rather than where it is emitted so the anchor is narrowed once, and
  // so `draft === null` is the single answer to "is anybody writing on this file".
  const draft: ComposerRow | null =
    composer === null || composer.rightStart === null
      ? null
      : {
          kind: 'composer',
          key: composerKey(composer.rightStart.line),
          context: composer,
          line: composer.rightStart.line,
        }

  // The same array back, not a copy, for the file nobody has commented on and is
  // not writing on — which is most of them. A file with no threads pays nothing.
  if (byLine.size === 0 && draft === null) return rows
  // No hunks means no rows, and a thread has nothing to sit under; the panel
  // renders every one of them next to its notice instead. See `FileThreadList`.
  if (rows.length === 0) return rows

  const anchors = [...byLine.keys()].sort((a, b) => a - b)
  const out: DiffRow[] = []
  let at = 0
  // Cleared once the draft has been placed, which is what lets the thread cursor
  // stop deferring to it and carry on down the rest of the file.
  let pending = draft

  function emitBelow(end: number): void {
    for (;;) {
      const anchor = at < anchors.length ? anchors[at] : null

      // The thread first whenever the two are on the same line, so the draft
      // lands under the conversation it is being added to.
      if (anchor !== null && anchor < end && (pending === null || anchor <= pending.line)) {
        at++
        const all = byLine.get(anchor) ?? []
        const shown = hideDone ? all.filter((thread) => thread.resolution === 'open') : all
        // First thread's id, which is the oldest: `byRightLine` is chronological,
        // so a new reply or a second thread on the line appends and the key holds.
        if (shown.length > 0) {
          out.push({ kind: 'thread', key: `!${shown[0].id}`, threads: shown, line: anchor })
        }
        continue
      }

      if (pending !== null && pending.line < end) {
        out.push(pending)
        pending = null
        continue
      }

      return
    }
  }

  // Right-side line numbers only ever increase down the file, so one cursor over
  // the sorted anchors is enough — no lookup per row, and 5,000 rows cost 5,000
  // comparisons rather than 5,000 map probes.
  for (const item of rows) {
    out.push(item)
    if (item.kind === 'line') {
      if (item.right?.newLine != null) emitBelow(item.right.newLine + 1)
    } else if (item.kind === 'gap') {
      emitBelow(item.newStart + item.hiddenLines)
    }
  }

  // Anything left anchors past the last line the diff renders. The server is
  // meant to have put those in `unanchored`; if one slips through, the bottom of
  // the file is a worse place for it than its line and a better one than nowhere.
  emitBelow(Number.POSITIVE_INFINITY)

  return out
}
