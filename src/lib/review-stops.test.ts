import { describe, expect, it } from 'vitest'

import { fileAt, findingStops, openThreadStops, stepFrom } from './review-stops'

import type { FileThreads, Thread } from './comment-contract'
import type { SonarFinding } from './sonar-contract'

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

const onFile = (
  path: string,
  byRightLine: Record<number, readonly Thread[]>,
  unanchored: readonly Thread[] = [],
): FileThreads => ({
  path,
  byRightLine: new Map(Object.entries(byRightLine).map(([line, list]) => [Number(line), list])),
  unanchored,
})

const conversation = (...files: readonly FileThreads[]): ReadonlyMap<string, FileThreads> =>
  new Map(files.map((file) => [file.path, file]))

const finding = (over: Partial<SonarFinding> = {}): SonarFinding => ({
  key: 'AY-1',
  rule: 'javascript:S4036',
  message: 'Make sure the "PATH" variable only contains fixed, unwriteable directories.',
  path: '/src/log.ts',
  textRange: { startLine: 12, endLine: 12, startOffset: 2, endOffset: 30 },
  status: 'OPEN',
  impacts: [],
  cleanCodeAttributeCategory: null,
  effort: null,
  tags: [],
  url: 'https://sonarcloud.io/project/issues?id=Profisee_utilities&open=AY-1',
  ...over,
})

describe('openThreadStops', () => {
  it('walks the files in the order the page is drawing them', () => {
    // Not the map's order, which is ADO's: the list on screen is the tree's, and
    // stepping down it should follow the panels rather than a second ordering.
    const stops = openThreadStops(
      ['/src/a.ts', '/src/b.ts'],
      conversation(onFile('/src/b.ts', { 3: [thread(2)] }), onFile('/src/a.ts', { 9: [thread(1)] })),
    )

    expect(stops).toEqual([
      { id: '1', path: '/src/a.ts', line: 9 },
      { id: '2', path: '/src/b.ts', line: 3 },
    ])
  })

  it('sorts a file’s threads by line, not by the order ADO answered in', () => {
    const stops = openThreadStops(
      ['/src/a.ts'],
      conversation(onFile('/src/a.ts', { 40: [thread(1)], 7: [thread(2), thread(3)] })),
    )

    expect(stops.map((stop) => stop.line)).toEqual([7, 7, 40])
  })

  it('puts the unanchored threads first, where the panel puts them', () => {
    const stops = openThreadStops(
      ['/src/a.ts'],
      conversation(onFile('/src/a.ts', { 7: [thread(1)] }, [thread(2)])),
    )

    // No line, because there is no row for one: the stop is the file, and the
    // list above its diff is what the reader lands on.
    expect(stops).toEqual([
      { id: '2', path: '/src/a.ts', line: null },
      { id: '1', path: '/src/a.ts', line: 7 },
    ])
  })

  it('skips the resolved ones, which is the whole of what the key promises', () => {
    const stops = openThreadStops(
      ['/src/a.ts'],
      conversation(onFile('/src/a.ts', { 7: [thread(1, 'done')], 8: [thread(2)] })),
    )

    expect(stops.map((stop) => stop.id)).toEqual(['2'])
  })

  it('costs a file with no comments nothing at all', () => {
    expect(openThreadStops(['/src/a.ts'], new Map())).toEqual([])
  })
})

describe('findingStops', () => {
  it('drops a finding about a file this diff does not touch', () => {
    // The same test the panel makes before it offers a finding as a button. A
    // stop with nowhere to land looks like the key has stopped working.
    const stops = findingStops(
      [finding(), finding({ key: 'AY-2', path: '/src/untouched.ts' })],
      new Set(['/src/log.ts']),
    )

    expect(stops).toEqual([{ id: 'AY-1', path: '/src/log.ts', line: 12 }])
  })

  it('drops a finding about no file at all', () => {
    expect(findingStops([finding({ path: null })], new Set(['/src/log.ts']))).toEqual([])
  })

  it('anchors on the range’s start line, which a fixed issue still carries', () => {
    const stops = findingStops([finding({ textRange: null })], new Set(['/src/log.ts']))

    // `null` is the file itself, not line zero — a jump to the panel and no row.
    expect(stops).toEqual([{ id: 'AY-1', path: '/src/log.ts', line: null }])
  })

  it('keeps the order the panel prints them in', () => {
    const stops = findingStops(
      [finding({ key: 'AY-3' }), finding({ key: 'AY-1' })],
      new Set(['/src/log.ts']),
    )

    expect(stops.map((stop) => stop.id)).toEqual(['AY-3', 'AY-1'])
  })
})

describe('stepFrom', () => {
  const stops = [
    { id: 'a', path: '/src/a.ts', line: 1 },
    { id: 'b', path: '/src/b.ts', line: 2 },
    { id: 'c', path: '/src/c.ts', line: 3 },
  ]

  it('says there is nowhere to go rather than picking somewhere', () => {
    expect(stepFrom([], null, 1)).toBe(-1)
  })

  it('starts at the end the reader is heading towards', () => {
    expect(stepFrom(stops, null, 1)).toBe(0)
    expect(stepFrom(stops, null, -1)).toBe(2)
  })

  it('wraps at both ends', () => {
    expect(stepFrom(stops, 'c', 1)).toBe(0)
    expect(stepFrom(stops, 'a', -1)).toBe(2)
  })

  it('treats a stop that has gone as standing nowhere', () => {
    // Somebody else resolved the thread while this page was open. The first
    // remaining one is the honest answer; the stop that took its index is not.
    expect(stepFrom(stops, 'resolved-by-somebody-else', 1)).toBe(0)
  })
})

describe('fileAt', () => {
  it('is the last panel to have reached the fold', () => {
    // Two scrolled past, one at the top of the window, one still below it.
    expect(fileAt([-900, -400, 8, 600], 24)).toBe(2)
  })

  it('is nowhere when the reader is above the first panel', () => {
    expect(fileAt([120, 700], 24)).toBe(-1)
  })

  it('skips a path the list is not drawing rather than stopping at it', () => {
    expect(fileAt([-40, null, 8], 24)).toBe(2)
  })

  it('answers the last panel on a page scrolled to the bottom', () => {
    expect(fileAt([-2000, -900, -40], 24)).toBe(2)
  })
})
