import { describe, expect, it } from 'vitest'

import { diffFile } from './diff'
import { buildRows, expandGap, setLayout } from './diff-rows'
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
