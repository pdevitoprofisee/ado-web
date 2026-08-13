import { describe, expect, it } from 'vitest'

import { NO_THREADS, anyThreads, countThreads, sumThreads } from './thread-counts'

import type { FileThreads, Thread, ThreadResolution } from './comment-contract'

const thread = (id: number, resolution: ThreadResolution): Thread => ({
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

const on = (byRightLine: [number, Thread[]][], unanchored: Thread[] = []): FileThreads => ({
  path: '/src/log.ts',
  byRightLine: new Map(byRightLine),
  unanchored,
})

describe('countThreads', () => {
  it('counts both buckets, split by whether the thread is still open', () => {
    const count = countThreads(
      on(
        [
          [4, [thread(1, 'open'), thread(2, 'done')]],
          [12, [thread(3, 'done')]],
        ],
        [thread(4, 'open')],
      ),
    )

    expect(count).toEqual({ open: 2, done: 2 })
  })

  it('reads a file with no threads and a conversation that has not arrived the same way', () => {
    // The caller cannot tell them apart, and neither can this. Both draw nothing.
    expect(countThreads(null)).toEqual(NO_THREADS)
    expect(countThreads(on([]))).toEqual(NO_THREADS)
  })
})

describe('anyThreads', () => {
  it('is true for a resolved conversation, which is still a conversation', () => {
    expect(anyThreads({ open: 0, done: 1 })).toBe(true)
    expect(anyThreads(NO_THREADS)).toBe(false)
  })
})

describe('sumThreads', () => {
  it('adds a shut directory’s files up into one pair', () => {
    expect(sumThreads([{ open: 1, done: 0 }, NO_THREADS, { open: 2, done: 3 }])).toEqual({
      open: 3,
      done: 3,
    })
  })

  it('sums nothing to nothing', () => {
    expect(sumThreads([])).toEqual(NO_THREADS)
  })
})
