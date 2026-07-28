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
// to the row array. Rows are then a pure function of (diff, reveals, layout),
// which is what makes the two hard cases fall out instead of being handled:
// expanding the top and the bottom of one gap until the two reveals meet is
// just a union of adjacent ranges, and a row's key never depends on where the
// row sits, so nothing above the click is re-keyed.

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
}

export function buildRows(
  diff: FileDiff,
  lines: readonly string[],
  layout: DiffLayout,
): RowModel {
  return rebuild(diff, lines, layout, [])
}

/** The same diff and the same expansions, projected the other way. */
export function setLayout(model: RowModel, layout: DiffLayout): RowModel {
  if (layout === model.layout) return model
  return rebuild(model.diff, model.lines, layout, model.revealed)
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

  return rebuild(model.diff, model.lines, model.layout, union(model.revealed, span))
}

function rebuild(
  diff: FileDiff,
  lines: readonly string[],
  layout: DiffLayout,
  revealed: readonly Span[],
): RowModel {
  return { rows: project(flatten(diff, lines, revealed), layout), layout, diff, lines, revealed }
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
