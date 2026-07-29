// Work this app wants done, but not now and not in a render.
//
// Two callers want it and they want the same thing — the inbox filling in its
// below-the-fold rows, the PR page warming the top of its diff — so the scheduler
// is here rather than once in each. A second copy of this would be a second
// answer to "is `requestIdleCallback` there?", which is exactly the kind of
// question that gets answered differently in two files.

/**
 * Runs `work` when the browser is idle, and returns the way to call it off.
 *
 * `requestIdleCallback` is still missing in Safari and in jsdom, so it degrades
 * to a short timer rather than assuming it. The 2 s timeout on the real one is
 * the point: idle may never come on a busy tab, and work that happens eventually
 * beats work that never happens at all.
 */
export function onIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(work, { timeout: 2000 })

    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(work, 200)

  return () => clearTimeout(handle)
}
