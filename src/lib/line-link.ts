import { useEffect, useState } from 'react'

import { scrollToFile } from './file-anchor'

// A link to one line of one file, in this application's own URL. What a reviewer
// sends to somebody who is not running this application's copy of the page.
//
// A fragment and not a search param. Three routes show a diff — the pull
// request, the branch compare, a commit — and a param would have to be declared
// on all three `validateSearch`es to survive the router, which is three places
// to forget. A fragment belongs to no route and the router never touches it.
//
// This does not contradict `file-anchor.ts`, which refuses to put its id in an
// `href="#…"`. That refusal is about the app writing a hash into its own URL as
// you read, which would fill the back button with scroll positions nobody chose
// to keep. Nothing here navigates: the string is built for the clipboard, and
// read back only on the one load where a fresh tab was opened on somebody's
// link.
//
// `path` and `line` are ADO's own two names, so a reader who has seen one of its
// URLs is not being taught a second vocabulary for the same two facts.

/** A file, and a right-side line in it. What a permalink addresses. */
export interface LineTarget {
  readonly path: string
  readonly line: number
}

/**
 * A link to `line` of `path` on the page `href` is already showing.
 *
 * Everything but the fragment is kept, which is what makes this right on the
 * branch compare: its `?target=` is which two commits are being read, and a link
 * that dropped it would open a different diff at the same line number.
 */
export function linePermalink(href: string, path: string, line: number): string {
  const url = new URL(href)
  url.hash = new URLSearchParams({ path, line: String(line) }).toString()

  return url.toString()
}

/**
 * The line a URL is asking for, or `null` when it is not asking for one.
 *
 * Everything malformed answers `null` rather than throwing. This is the one
 * input a stranger typed — pasted, forwarded, truncated by a chat client — and a
 * link that lost half its fragment should open the page it names.
 */
export function readLineTarget(hash: string = window.location.hash): LineTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const path = params.get('path')
  const line = Number(params.get('line'))

  if (path === null || path === '') return null
  if (!Number.isSafeInteger(line) || line < 1) return null

  return { path, line }
}

/**
 * The permalink this page was opened on, held until the page can answer it.
 *
 * `ready` is the caller's "the panels exist now" — the file list has arrived and
 * rendered. Scrolling before that finds no element and spends the one chance
 * there was to arrive.
 *
 * Forgotten the moment it has been acted on, for the reason the Sonar jump in
 * `pr-detail.tsx` clears its own: a target still in hand would haul the reader
 * back to the line every time the file list changed underneath them. The line
 * outlives this — the panel took a copy on the same commit and is waiting on its
 * own bytes to act on it.
 */
export function useLineTarget(ready: boolean): LineTarget | null {
  const [target, setTarget] = useState<LineTarget | null>(readLineTarget)

  useEffect(() => {
    if (target === null || !ready) return

    scrollToFile(target.path)
    setTarget(null)
  }, [target, ready])

  return target
}
