import { describe, expect, it } from 'vitest'

import { findInDiff, findSentence, matchRanges } from './diff-find'

import type { FindTarget } from './diff-find'

const TARGETS: readonly FindTarget[] = [
  { path: '/src/log.ts', lines: ['const sink = open()', '', 'sink.write(line)'] },
  // Never scrolled to, so never fetched — the case the count has to own up to.
  { path: '/src/huge.ts', lines: null },
  { path: '/src/app.ts', lines: ['import { sink } from "./log"'] },
]

const paths = (targets: readonly FindTarget[], term: string) =>
  findInDiff(targets, term).hits.map((hit) => `${hit.path}:${hit.line}`)

describe('matchRanges', () => {
  it('finds nothing for an empty term', () => {
    expect(matchRanges('const sink', '')).toEqual([])
  })

  it('answers the range the match occupies', () => {
    expect(matchRanges('const sink', 'sink')).toEqual([[6, 10]])
  })

  it('finds every occurrence', () => {
    expect(matchRanges('sink to sink', 'sink')).toEqual([
      [0, 4],
      [8, 12],
    ])
  })

  it('does not overlap a match with the one before it', () => {
    // `aa` in `aaaa` is two, not three: the same answer `replaceAll` gives, and
    // the only one that can be drawn as a mark.
    expect(matchRanges('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('ignores case in either direction', () => {
    expect(matchRanges('Sink', 'sink')).toEqual([[0, 4]])
    expect(matchRanges('sink', 'SINK')).toEqual([[0, 4]])
  })

  it('falls back to an exact match when folding would move the offsets', () => {
    // `İ` lower-cases to two code units, so a folded haystack is a longer string
    // and every range after it would land on the wrong characters. Losing the
    // case-insensitive hit is the safe half of that trade.
    expect(matchRanges('İstanbul', 'istanbul')).toEqual([])
    expect(matchRanges('İstanbul', 'İstanbul')).toEqual([[0, 8]])
  })
})

describe('findInDiff', () => {
  it('finds nothing, and searches nothing, for an empty term', () => {
    // `''.includes('')` is true, so the guard is what stops a box that has just
    // been focused reporting every line in the pull request.
    expect(findInDiff(TARGETS, '')).toEqual({ hits: [], searched: 0, unsearched: 0 })
  })

  it('crosses files, in the order it was given them', () => {
    expect(paths(TARGETS, 'sink')).toEqual(['/src/log.ts:1', '/src/log.ts:3', '/src/app.ts:1'])
  })

  it('counts a line once however many times the term is on it', () => {
    const target = [{ path: '/a.ts', lines: ['sink sink sink'] }]

    expect(paths(target, 'sink')).toEqual(['/a.ts:1'])
  })

  it('numbers lines from one, the way the jump machinery addresses them', () => {
    expect(paths(TARGETS, 'write')).toEqual(['/src/log.ts:3'])
  })

  it('ignores case', () => {
    expect(paths(TARGETS, 'SINK')).toHaveLength(3)
  })

  it('counts a file it could not read rather than skipping it quietly', () => {
    const result = findInDiff(TARGETS, 'sink')

    expect(result.searched).toBe(2)
    expect(result.unsearched).toBe(1)
  })
})

describe('findSentence', () => {
  it('says both halves when something was out of reach', () => {
    expect(findSentence(findInDiff(TARGETS, 'sink'))).toBe(
      '3 matching lines · 1 of 3 files not searched',
    )
  })

  it('says how much was covered when all of it was', () => {
    const loaded = TARGETS.filter((target) => target.lines !== null)

    expect(findSentence(findInDiff(loaded, 'sink'))).toBe('3 matching lines · 2 files searched')
  })

  it('still names the blind spot when there are no matches at all', () => {
    // The whole point: "no matches" over a change set that was mostly unread is
    // the answer most likely to be believed and least likely to be true.
    expect(findSentence(findInDiff(TARGETS, 'nowhere'))).toBe(
      'No matching lines · 1 of 3 files not searched',
    )
  })

  it('counts one of each in the singular', () => {
    const one = [{ path: '/a.ts', lines: ['sink'] }]

    expect(findSentence(findInDiff(one, 'sink'))).toBe('1 matching line · 1 file searched')
  })
})
