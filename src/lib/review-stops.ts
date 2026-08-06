import type { FileThreads } from './comment-contract'
import type { SonarFinding } from './sonar-contract'

// Everywhere the keyboard can send a reviewer inside one pull request, worked out
// from the same data the page is already drawing.
//
// Separate from the keys themselves because the ordering is the whole of the
// behaviour and none of it needs a DOM: "the next unresolved thread" is a fact
// about a thread map and a file order, and it should be readable as one.
//
// **A stop carries an id rather than an index.** The conversation is polled every
// thirty seconds and hands down a fresh array each time, so an index remembered
// across a tick can point at a different thread than the one the reader was
// standing on — see `useConversation`. Ids come from ADO and survive the poll.

/** Somewhere to be sent: a file, and a line in it when there is one. */
export interface Stop {
  /** Stable across a poll, and unique within one list of stops. */
  readonly id: string
  readonly path: string
  /** A right-side line number, as `ChangedFileDiff.jumpTo` takes it, or `null` for the file itself. */
  readonly line: number | null
}

/**
 * Every unresolved thread in the diff, in the order the diff is read in.
 *
 * `paths` is the file order the page is showing — the tree's order, not ADO's —
 * so stepping follows the list on screen rather than a second ordering nobody can
 * see. A file with no comments contributes nothing and costs a map lookup.
 *
 * Unanchored threads come before the lines of their own file because that is
 * where the panel puts them: `FileThreadList` renders above the diff. They have
 * no line, so a stop on one is a stop on the file.
 *
 * Resolution and not status: `active` and `pending` are both open, and
 * `ThreadResolution` is the field that already says so.
 */
export function openThreadStops(
  paths: readonly string[],
  threads: ReadonlyMap<string, FileThreads>,
): readonly Stop[] {
  const stops: Stop[] = []

  for (const path of paths) {
    const onFile = threads.get(path)
    if (onFile === undefined) continue

    for (const thread of onFile.unanchored) {
      if (thread.resolution === 'open') stops.push({ id: `${thread.id}`, path, line: null })
    }

    for (const line of [...onFile.byRightLine.keys()].sort((a, b) => a - b)) {
      for (const thread of onFile.byRightLine.get(line) ?? []) {
        if (thread.resolution === 'open') stops.push({ id: `${thread.id}`, path, line })
      }
    }
  }

  return stops
}

/**
 * The findings a reader can actually be sent to, in the panel's own order.
 *
 * Same test the panel makes before it offers a finding as a button: a path, and a
 * path that is in this change set. A finding about a file the iteration does not
 * touch has nowhere to land, and stepping onto it would look like the key had
 * stopped working.
 *
 * Grouped order is kept — rule by rule, count descending — so the key walks the
 * list in the order the details tab prints it.
 */
export function findingStops(
  findings: readonly SonarFinding[],
  paths: ReadonlySet<string>,
): readonly Stop[] {
  const stops: Stop[] = []

  for (const finding of findings) {
    if (finding.path === null || !paths.has(finding.path)) continue
    stops.push({
      id: finding.key,
      path: finding.path,
      // `startLine` and not `line`, which a fixed issue drops — see `SonarTextRange`.
      line: finding.textRange?.startLine ?? null,
    })
  }

  return stops
}

/**
 * Where `delta` lands from the stop the reader is standing on, wrapping.
 *
 * `-1` when there is nowhere to go, which the caller says out loud rather than
 * swallowing — a key that does nothing is indistinguishable from a broken one.
 *
 * An `id` that is no longer in the list is the same as standing nowhere: the
 * thread was resolved by somebody else while this page was open, and the honest
 * answer is the first stop, not the one that happens to have taken its index.
 * `FindBar` steps the same way for the same reason.
 */
export function stepFrom(
  stops: readonly Stop[],
  id: string | null,
  delta: number,
): number {
  if (stops.length === 0) return -1

  const at = stops.findIndex((stop) => stop.id === id)
  if (at === -1) return delta > 0 ? 0 : stops.length - 1

  return (at + delta + stops.length) % stops.length
}

/**
 * Which file the window is on, given each panel's distance from the top of it.
 *
 * The last panel to have reached the fold, because a panel scrolled past has a
 * negative top and the one being read is the last such: everything below it is
 * still down the page. `-1` when the reader is above the first panel, which is
 * where the page opens.
 *
 * `null` is a path with no panel — a file the list is not drawing — and it is
 * skipped rather than treated as far away, so it cannot end a run of panels the
 * reader has already passed.
 */
export function fileAt(tops: readonly (number | null)[], fold: number): number {
  let at = -1

  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index]
    if (top !== null && top <= fold) at = index
  }

  return at
}
