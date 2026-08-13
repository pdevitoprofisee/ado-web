import type { FileThreads } from './comment-contract'

// How much conversation sits on a file, as a number the tree and the panel
// header can both draw.
//
// Separate from `openThreadStops` in `review-stops.ts`, which walks the same map
// for a different answer: that one needs every thread in reading order, and this
// one needs two integers. Sorting a hundred line keys to arrive at "3" is work
// with nothing to show for it.

/** One file's threads, split by whether they still want an answer. */
export interface ThreadCount {
  /** `resolution === 'open'` — `active` and `pending` both count. */
  readonly open: number
  readonly done: number
}

/** A file nobody has commented on, and the answer while the read is in flight. */
export const NO_THREADS: ThreadCount = { open: 0, done: 0 }

/** Whether there is anything to draw at all. */
export function anyThreads(count: ThreadCount): boolean {
  return count.open + count.done > 0
}

/**
 * Count one file's threads, anchored and unanchored alike.
 *
 * `null` is both "no comments on this file" and "the conversation has not
 * arrived yet"; the caller cannot tell them apart and neither can this. Both
 * draw nothing, which is right in the first case and honest in the second.
 */
export function countThreads(threads: FileThreads | null): ThreadCount {
  if (threads === null) return NO_THREADS

  let open = 0
  let done = 0

  for (const thread of threads.unanchored) {
    if (thread.resolution === 'open') open += 1
    else done += 1
  }

  for (const line of threads.byRightLine.values()) {
    for (const thread of line) {
      if (thread.resolution === 'open') open += 1
      else done += 1
    }
  }

  return { open, done }
}

/** The counts of several files as one. What a shut directory says on its row. */
export function sumThreads(counts: readonly ThreadCount[]): ThreadCount {
  let open = 0
  let done = 0

  for (const count of counts) {
    open += count.open
    done += count.done
  }

  return { open, done }
}
