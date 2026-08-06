import { useMemo, useRef, useState } from 'react'

import { useCommand } from '@/commands/command-provider'
import { fileAnchor } from '@/lib/file-anchor'
import { fileAt, findingStops, openThreadStops, stepFrom } from '@/lib/review-stops'

import type { RefObject } from 'react'
import type { Stop } from '@/lib/review-stops'
import type { FileThreads } from '@/lib/comment-contract'
import type { SonarFinding } from '@/lib/sonar-contract'
import type { ChangedFile } from '@/server/pull-request'

// The review view's keyboard: seven keys, no writes, one live region.
//
// Nothing here reaches Azure DevOps. Moving is moving, and the viewed mark is a
// row in this app's own SQLite — see `viewed-fn.ts`, which is the one server
// function pair in the project that makes no ADO call at all. Voting, replying
// and resolving are deliberately mouse-only: a vote and an invitation are the
// same `PUT`, so a slip on the wrong key would make somebody a reviewer.
//
// It renders one paragraph. Every move it makes is a scroll somebody watching the
// screen can see and somebody listening to it cannot, and the count in the
// sentence is the part that is not on screen at all.

/**
 * How close to the top of the window a panel has to be to count as the one being
 * read.
 *
 * Not zero. The panels carry `scroll-mt-2`, so a jump parks one eight pixels
 * down, and a fold at zero would decide the reader was still on the file above —
 * making the next `]` land back where it started.
 */
const FOLD = 24

/** A panel's distance from the top of the window, or `null` if it is not drawn. */
function topOf(path: string): number | null {
  const panel = document.getElementById(fileAnchor(path))
  return panel === null ? null : panel.getBoundingClientRect().top
}

/** A stop in words, for the sentence the region reads out. */
function where(stop: Stop): string {
  return stop.line === null ? stop.path : `${stop.path} line ${stop.line}`
}

export function ReviewKeys({
  files,
  isRead,
  onViewedChange,
  threads,
  findings,
  onGo,
}: {
  /** The change set in the order the list is drawing it. Stepping follows this. */
  files: readonly ChangedFile[]
  isRead: (file: ChangedFile) => boolean
  onViewedChange: (file: ChangedFile, viewed: boolean) => void
  threads: ReadonlyMap<string, FileThreads>
  /** Sonar's findings, flattened in the panel's order. Filtered to this diff here. */
  findings: readonly SonarFinding[]
  /** Send the reader here — the page's own jump, the one the find box uses. */
  onGo: (to: { path: string; line: number | null }) => void
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files])

  const threadStops = useMemo(() => openThreadStops(paths, threads), [paths, threads])
  const findingStopList = useMemo(
    () => findingStops(findings, new Set(paths)),
    [findings, paths],
  )

  // Refs and not state: which thread you are standing on changes nothing on the
  // screen, and the conversation poll re-renders this component every thirty
  // seconds without disturbing them.
  const onThread = useRef<string | null>(null)
  const onFinding = useRef<string | null>(null)

  const [said, say] = useState('')

  function stepFile(delta: number) {
    if (files.length === 0) return

    const at = fileAt(paths.map(topOf), FOLD)
    // Clamped rather than wrapped, unlike the two lists below: a change set is
    // read top to bottom, and `]` on the last file quietly restarting at the first
    // is how a reviewer comes to think they have been through all of them.
    const to = Math.min(Math.max(at + delta, 0), files.length - 1)

    onGo({ path: paths[to], line: null })
    say(`File ${to + 1} of ${files.length}, ${paths[to]}.`)
  }

  function stepStop(
    stops: readonly Stop[],
    standing: RefObject<string | null>,
    delta: number,
    what: string,
    none: string,
  ) {
    const to = stepFrom(stops, standing.current, delta)
    if (to === -1) {
      say(none)
      return
    }

    standing.current = stops[to].id
    onGo(stops[to])
    say(`${what} ${to + 1} of ${stops.length}, ${where(stops[to])}.`)
  }

  useCommand('review.nextFile', () => stepFile(1))
  useCommand('review.previousFile', () => stepFile(-1))

  useCommand('review.nextThread', () =>
    stepStop(threadStops, onThread, 1, 'Unresolved thread', 'No unresolved threads in this diff.'),
  )
  useCommand('review.previousThread', () =>
    stepStop(threadStops, onThread, -1, 'Unresolved thread', 'No unresolved threads in this diff.'),
  )

  useCommand('review.nextFinding', () =>
    stepStop(findingStopList, onFinding, 1, 'Sonar finding', 'No Sonar findings in these files.'),
  )
  useCommand('review.previousFinding', () =>
    stepStop(findingStopList, onFinding, -1, 'Sonar finding', 'No Sonar findings in these files.'),
  )

  useCommand('review.viewed', () => {
    if (files.length === 0) return

    // The file the window is on, or the first one when the reader is still above
    // them all — which is where the page opens, and where `v` should mean "this
    // one" rather than nothing.
    const file = files[Math.max(fileAt(paths.map(topOf), FOLD), 0)]
    const next = !isRead(file)

    onViewedChange(file, next)
    say(`${file.path} marked ${next ? 'read' : 'unread'}.`)
  })

  // Screen readers only: the tick, the count above the list and the page moving
  // under you are all already on the screen. Mounted empty rather than
  // conditionally, so the region exists before it has anything to say — a region
  // inserted along with its text is one several screen readers never announce.
  return (
    <p role="status" className="sr-only">
      {said}
    </p>
  )
}
