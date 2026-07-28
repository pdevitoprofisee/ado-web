import { describe, expect, it } from 'vitest'

import { diffFile } from './diff'
import { buildRows, expandGap, setHideDone, setLayout, setThreads } from './diff-rows'
import type { FileThreads, Thread } from './comment-contract'
import type { DiffLine, DiffRow } from './diff-contract'

// A hundred numbered lines with two inserted near the top and one line rewritten
// in each of the lower thirds. Three hunks, so there are four gaps — leading,
// two interior, trailing — and the two-line insertion puts the old and new
// numbering permanently out of step, which is where off-by-two bugs live.
const BEFORE = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
const AFTER = (() => {
  const after = BEFORE.slice()
  after.splice(20, 0, 'inserted a', 'inserted b')
  after[52 - 1] = 'line 50 changed'
  after[82 - 1] = 'line 80 changed'
  return after
})()
const DIFF = diffFile(BEFORE, AFTER)

const gaps = (rows: readonly DiffRow[]) => rows.filter((row) => row.kind === 'gap')
const keys = (rows: readonly DiffRow[]) => rows.map((row) => row.key)

/** Every line a row shows, once each — a context row shows one line, not two. */
function shown(rows: readonly DiffRow[]): DiffLine[] {
  const out: DiffLine[] = []
  for (const row of rows) {
    if (row.kind !== 'line') continue
    if (row.left !== null && row.left === row.right) out.push(row.left)
    else {
      if (row.left !== null) out.push(row.left)
      if (row.right !== null) out.push(row.right)
    }
  }
  return out
}

const byNumber = (lines: readonly DiffLine[]) =>
  lines.slice().sort((a, b) => `${a.oldLine}/${a.newLine}`.localeCompare(`${b.oldLine}/${b.newLine}`))

describe('buildRows', () => {
  it('lays the file out as gap, hunk, lines, gap, ... in one flat array', () => {
    const { rows } = buildRows(DIFF, AFTER, 'unified')

    expect(rows.map((row) => row.kind).join(' ')).toMatch(
      /^gap hunk (line )+gap hunk (line )+gap hunk (line )+gap$/,
    )
    expect(rows.filter((row) => row.kind === 'hunk').map((row) => row.label)).toEqual([
      '@@ -18,6 +18,8 @@',
      '@@ -47,7 +49,7 @@',
      '@@ -77,7 +79,7 @@',
    ])
  })

  it('numbers each gap on both sides, which drift apart after the insertion', () => {
    const { rows } = buildRows(DIFF, AFTER, 'unified')

    expect(gaps(rows).map(({ oldStart, newStart, hiddenLines }) => ({ oldStart, newStart, hiddenLines }))).toEqual([
      { oldStart: 1, newStart: 1, hiddenLines: 17 },
      { oldStart: 24, newStart: 26, hiddenLines: 23 },
      { oldStart: 54, newStart: 56, hiddenLines: 23 },
      // 100 old lines, 102 new: the trailing gap runs to the end of both.
      { oldStart: 84, newStart: 86, hiddenLines: 17 },
    ])
  })

  it('gives every row a distinct key', () => {
    const { rows } = buildRows(DIFF, AFTER, 'unified')

    expect(new Set(keys(rows)).size).toBe(rows.length)
  })

  it('has no rows at all when there are no hunks', () => {
    // An unchanged file and a file the diff gave up on both produce no hunks,
    // and neither has a row to show — the caller writes that message, not us.
    expect(buildRows(diffFile(BEFORE, BEFORE), BEFORE, 'unified').rows).toEqual([])
    expect(buildRows({ hunks: [], added: 0, removed: 0, gaveUp: true }, BEFORE, 'split').rows).toEqual([])
  })
})

describe('the two layouts', () => {
  it('show exactly the same lines', () => {
    // Not the same rows and not in the same order — side-by-side puts a delete
    // and its add on one row — but not one line more or fewer either way.
    const unified = buildRows(DIFF, AFTER, 'unified')
    const split = setLayout(unified, 'split')

    expect(byNumber(shown(split.rows))).toEqual(byNumber(shown(unified.rows)))
  })

  it('agree on context rows, headers and gaps, down to the key', () => {
    const unified = buildRows(DIFF, AFTER, 'unified')
    const split = setLayout(unified, 'split')
    const unchanging = (rows: readonly DiffRow[]) =>
      rows.filter((row) => row.kind !== 'line' || (row.left !== null && row.left === row.right))

    expect(unchanging(split.rows)).toEqual(unchanging(unified.rows))
  })

  it('put a change on two rows unified and one row side-by-side', () => {
    const unified = buildRows(DIFF, AFTER, 'unified')
    const split = setLayout(unified, 'split')
    const changed = (rows: readonly DiffRow[]) =>
      rows.filter((row) => row.kind === 'line' && row.left !== row.right)

    expect(changed(unified.rows).map((row) => row.key)).toEqual(['-/21', '-/22', '50/-', '-/52', '80/-', '-/82'])
    expect(changed(split.rows).map((row) => row.key)).toEqual(['-/21', '-/22', '50/52', '80/82'])
  })

  it('leave a blank opposite a delete with no add to pair with', () => {
    const before = ['a', 'b', 'c', 'one', 'two', 'three', 'x', 'y', 'z']
    const after = ['a', 'b', 'c', 'ONE', 'x', 'y', 'z']
    const { rows } = buildRows(diffFile(before, after), after, 'split')
    const changed = rows.filter((row) => row.kind === 'line' && row.left !== row.right)

    expect(
      changed.map((row) => (row.kind === 'line' ? [row.left?.text ?? null, row.right?.text ?? null] : null)),
    ).toEqual([
      ['one', 'ONE'],
      ['two', null],
      ['three', null],
    ])
  })

  it('keeps the expansions when the layout changes under them', () => {
    const unified = buildRows(DIFF, AFTER, 'unified')
    const expanded = expandGap(unified, '~24,26', 'top', 4)

    expect(setLayout(expanded, 'split').revealed).toEqual(expanded.revealed)
    // Nothing to rebuild when the layout is the one already in force.
    expect(setLayout(expanded, 'unified')).toBe(expanded)
  })
})

describe('expandGap', () => {
  const model = buildRows(DIFF, AFTER, 'unified')

  it('reveals lines off the top of the gap and moves its start down', () => {
    const expanded = expandGap(model, '~24,26', 'top', 3)
    const revealed = expanded.rows.slice(
      expanded.rows.findIndex((row) => row.key === '23/25') + 1,
      expanded.rows.findIndex((row) => row.kind === 'gap' && row.key === '~27,29'),
    )

    expect(revealed.map((row) => (row.kind === 'line' ? [row.left?.oldLine, row.right?.newLine, row.left?.text] : null))).toEqual([
      [24, 26, 'line 24'],
      [25, 27, 'line 25'],
      [26, 28, 'line 26'],
    ])
    expect(gaps(expanded.rows)[1]).toEqual({ kind: 'gap', key: '~27,29', hiddenLines: 20, oldStart: 27, newStart: 29 })
  })

  it('reveals lines off the bottom of the gap and leaves its start alone', () => {
    const expanded = expandGap(model, '~24,26', 'bottom', 3)

    expect(gaps(expanded.rows)[1]).toEqual({ kind: 'gap', key: '~24,26', hiddenLines: 20, oldStart: 24, newStart: 26 })
    // The three lines sit directly above the hunk they were hiding.
    const header = expanded.rows.findIndex((row) => row.key === '@47,49')
    expect(expanded.rows.slice(header - 3, header).map((row) => row.key)).toEqual(['44/46', '45/47', '46/48'])
  })

  it('takes the whole gap away when asked for all of it', () => {
    const expanded = expandGap(model, '~24,26', 'all')

    expect(gaps(expanded.rows).map((row) => row.key)).toEqual(['~1,1', '~54,56', '~84,86'])
    expect(shown(expanded.rows).filter((line) => line.newLine !== null && line.newLine >= 26 && line.newLine <= 48))
      .toHaveLength(23)
  })

  it('reveals no more than the gap holds', () => {
    const expanded = expandGap(model, '~1,1', 'top', 500)

    expect(gaps(expanded.rows).map((row) => row.key)).toEqual(['~24,26', '~54,56', '~84,86'])
    expect(expanded.revealed).toEqual([{ start: 1, end: 18 }])
  })

  it('does nothing at all when the key is not a gap', () => {
    expect(expandGap(model, '@47,49', 'all')).toBe(model)
    expect(expandGap(model, 'nonsense', 'top')).toBe(model)
    expect(expandGap(model, '~24,26', 'top', 0)).toBe(model)
  })

  it('closes the gap when two expansions of it meet in the middle', () => {
    // Top ten, then bottom five, leaves eight hidden between two revealed runs.
    // Revealing those eight makes the runs touch, and the gap has to vanish
    // rather than linger as a zero-line row.
    const top = expandGap(model, '~24,26', 'top', 10)
    const bottom = expandGap(top, '~34,36', 'bottom', 5)

    expect(gaps(bottom.rows)[1]).toEqual({ kind: 'gap', key: '~34,36', hiddenLines: 8, oldStart: 34, newStart: 36 })
    expect(bottom.revealed).toEqual([
      { start: 26, end: 36 },
      { start: 44, end: 49 },
    ])

    const met = expandGap(bottom, '~34,36', 'all')

    expect(gaps(met.rows).map((row) => row.key)).toEqual(['~1,1', '~54,56', '~84,86'])
    expect(met.revealed).toEqual([{ start: 26, end: 49 }])
    // One unbroken run of old lines 24 to 46 between the first two hunks.
    const between = met.rows.slice(
      met.rows.findIndex((row) => row.key === '23/25') + 1,
      met.rows.findIndex((row) => row.key === '@47,49'),
    )
    expect(between.map((row) => (row.kind === 'line' ? row.left?.oldLine : row.kind))).toEqual(
      Array.from({ length: 23 }, (_, i) => 24 + i),
    )
  })
})

describe('row identity across an expansion', () => {
  const model = buildRows(DIFF, AFTER, 'unified')

  it('leaves every key above the click at the very same index', () => {
    const at = model.rows.findIndex((row) => row.key === '~54,56')
    const expanded = expandGap(model, '~54,56', 'top', 6)

    expect(keys(expanded.rows).slice(0, at)).toEqual(keys(model.rows).slice(0, at))
    // And the same content behind those keys, so a virtualizer that remembers a
    // row by key finds nothing about it changed.
    expect(expanded.rows.slice(0, at)).toEqual(model.rows.slice(0, at))
  })

  it('leaves every key below the click unchanged too, only further down', () => {
    const expanded = expandGap(model, '~54,56', 'top', 6)
    const tail = model.rows.length - model.rows.findIndex((row) => row.key === '~54,56') - 1

    expect(keys(expanded.rows).slice(-tail)).toEqual(keys(model.rows).slice(-tail))
  })

  it('keeps every key it had, except the gap that was clicked', () => {
    for (const end of ['top', 'bottom', 'all'] as const) {
      const expanded = expandGap(model, '~24,26', end, 7)
      const kept = keys(model.rows).filter((key) => key !== '~24,26')

      expect(keys(expanded.rows)).toEqual(expect.arrayContaining(kept))
      expect(new Set(keys(expanded.rows)).size).toBe(expanded.rows.length)
    }
  })
})

// ---------------------------------------------------------------------------
// Threads (T-025).
// ---------------------------------------------------------------------------

const thread = (id: number, resolution: Thread['resolution'] = 'open'): Thread => ({
  id,
  status: resolution === 'open' ? 'active' : 'fixed',
  resolution,
  kind: 'human',
  publishedDate: '2026-07-01T00:00:00Z',
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments: [],
  properties: {},
})

const fileThreads = (
  byRightLine: Record<number, readonly Thread[]>,
  unanchored: readonly Thread[] = [],
): FileThreads => ({
  path: '/src/app.ts',
  byRightLine: new Map(Object.entries(byRightLine).map(([line, list]) => [Number(line), list])),
  unanchored,
})

/** The row a thread row sits directly under, by key. */
function under(rows: readonly DiffRow[], key: string): string | undefined {
  const at = rows.findIndex((row) => row.key === key)
  return at < 1 ? undefined : rows[at - 1].key
}

describe('thread rows', () => {
  // Line 20 of the new file is a context line inside the first hunk, so it is
  // rendered in both layouts and under the same key in each.
  const threads = fileThreads({ 20: [thread(7)] })

  it('sits under its right-side line, in unified and in split alike', () => {
    // Same row, both layouts: a conversation about a line is one conversation,
    // not two halves of one, so there is nothing here for the projection to do.
    for (const layout of ['unified', 'split'] as const) {
      const { rows } = buildRows(DIFF, AFTER, layout, threads)

      expect(under(rows, '!7')).toBe('20/20')
      expect(rows.filter((row) => row.kind === 'thread')).toEqual([
        { kind: 'thread', key: '!7', threads: [thread(7)], line: 20 },
      ])
    }
  })

  it('groups every thread on one line into one row to measure', () => {
    // Two people on one line is one row, keyed on the older thread — the id that
    // does not change when the second one arrives.
    const { rows } = buildRows(DIFF, AFTER, 'unified', fileThreads({ 20: [thread(7), thread(9)] }))
    const rendered = rows.filter((row) => row.kind === 'thread')

    expect(rendered).toHaveLength(1)
    expect(rendered[0].key).toBe('!7')
    expect(rendered[0].kind === 'thread' && rendered[0].threads.map((one) => one.id)).toEqual([7, 9])
  })

  it('leaves the rows of a file with no threads exactly as they were', () => {
    // Most files in a pull request have no comments, and none of them should
    // come out of this looking any different from round 3.
    const plain = buildRows(DIFF, AFTER, 'unified')

    expect(buildRows(DIFF, AFTER, 'unified', fileThreads({})).rows).toEqual(plain.rows)
    expect(buildRows(DIFF, AFTER, 'unified', null).rows).toEqual(plain.rows)
    // And nothing is rebuilt at all when the threads did not change.
    expect(setThreads(plain, null)).toBe(plain)
  })

  it('has nowhere to put one when the file has no rows', () => {
    // No hunks means no rows and nothing for a thread to hang under. The panel
    // renders all of them next to its notice instead.
    const unchanged = buildRows(diffFile(BEFORE, BEFORE), BEFORE, 'unified', threads)

    expect(unchanged.rows).toEqual([])
  })
})

describe('a thread the diff cannot place on a visible line', () => {
  it('hangs under the gap that is hiding its line', () => {
    // New line 5 is inside the leading gap. Somewhere beats nowhere: a comment
    // behind a collapsed run of context is still a comment on this file.
    const { rows } = buildRows(DIFF, AFTER, 'unified', fileThreads({ 5: [thread(7)] }))

    expect(under(rows, '!7')).toBe('~1,1')
  })

  it('moves onto its real line when that gap is opened, without being remounted', () => {
    // The key is the thread's id and nothing about position, so the virtualizer
    // sees the same row move rather than one row unmount and another appear.
    const model = buildRows(DIFF, AFTER, 'unified', fileThreads({ 5: [thread(7)] }))
    const opened = expandGap(model, '~1,1', 'all')

    expect(under(model.rows, '!7')).toBe('~1,1')
    expect(under(opened.rows, '!7')).toBe('5/5')
    expect(opened.rows.filter((row) => row.kind === 'thread').map((row) => row.key)).toEqual(['!7'])
  })

  it('keeps its key when a gap above it is expanded', () => {
    // The invariant round 3 established, now with a thread in it: expanding a gap
    // anywhere above must not re-key anything, or every row below the click
    // remounts for a click that changed nothing about them.
    const model = buildRows(DIFF, AFTER, 'unified', fileThreads({ 20: [thread(7)] }))
    const expanded = expandGap(model, '~1,1', 'top', 6)

    expect(under(expanded.rows, '!7')).toBe('20/20')
    expect(keys(expanded.rows)).toEqual(expect.arrayContaining(keys(model.rows).filter((key) => key !== '~1,1')))
  })

  it('lands at the bottom rather than nowhere when its line is past the diff', () => {
    // The server is meant to have put this in `unanchored`. If one slips through,
    // the end of the file is a worse place for it than its line and a far better
    // one than gone.
    const { rows } = buildRows(DIFF, AFTER, 'unified', fileThreads({ 9_000: [thread(7)] }))

    expect(rows[rows.length - 1]).toEqual({ kind: 'thread', key: '!7', threads: [thread(7)], line: 9_000 })
  })

  it('leaves `unanchored` out of the rows entirely', () => {
    // A left-side anchor has no right-side line to sit under, so it is not a row
    // at all — `FileThreadList` renders it above the diff. Not lost, just not here.
    const { rows } = buildRows(DIFF, AFTER, 'unified', fileThreads({}, [thread(7)]))

    expect(rows.filter((row) => row.kind === 'thread')).toEqual([])
    expect(rows).toEqual(buildRows(DIFF, AFTER, 'unified').rows)
  })
})

describe('hide done', () => {
  const threads = fileThreads({ 20: [thread(7)], 24: [thread(9, 'done')] })

  it('takes the done thread out of the model, not out of the styling', () => {
    // An input to the row model rather than a class on a rendered row: a hidden
    // thread that still occupies a row is a row the virtualizer still measures,
    // and a measured row is the expensive kind.
    const shown = buildRows(DIFF, AFTER, 'unified', threads)
    const hidden = buildRows(DIFF, AFTER, 'unified', threads, true)

    expect(shown.rows.filter((row) => row.kind === 'thread').map((row) => row.key)).toEqual(['!7', '!9'])
    expect(hidden.rows.filter((row) => row.kind === 'thread').map((row) => row.key)).toEqual(['!7'])
    expect(hidden.rows).toHaveLength(shown.rows.length - 1)
  })

  it('drops the row when every thread on the line is done', () => {
    const hidden = buildRows(DIFF, AFTER, 'unified', fileThreads({ 20: [thread(9, 'done')] }), true)

    expect(hidden.rows).toEqual(buildRows(DIFF, AFTER, 'unified').rows)
  })

  it('toggles without disturbing the expansions or the layout', () => {
    const model = expandGap(buildRows(DIFF, AFTER, 'split', threads), '~54,56', 'top', 4)
    const hidden = setHideDone(model, true)

    expect(hidden.revealed).toEqual(model.revealed)
    expect(hidden.layout).toBe('split')
    // Nothing to rebuild when the flag is the one already in force.
    expect(setHideDone(hidden, true)).toBe(hidden)
  })
})

describe('setThreads', () => {
  it('keeps the expansions when threads arrive after the bytes', () => {
    // Threads come from a poll: they land after the diff and again every thirty
    // seconds. A reply must not close a gap somebody opened to read the code the
    // reply is about.
    const model = expandGap(buildRows(DIFF, AFTER, 'unified'), '~24,26', 'top', 5)
    const withThreads = setThreads(model, fileThreads({ 20: [thread(7)] }))

    expect(withThreads.revealed).toEqual(model.revealed)
    expect(under(withThreads.rows, '!7')).toBe('20/20')
    // And the same thread row survives the next poll unchanged.
    expect(setThreads(withThreads, withThreads.threads)).toBe(withThreads)
  })
})
