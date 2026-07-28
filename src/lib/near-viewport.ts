import { useEffect, useRef, useState } from 'react'

import type { RefObject } from 'react'

// Whether an element has come near enough to the viewport to be worth paying
// for. One thing, one reason: the diff panels are open from the start now, and
// a 294-file pull request cannot fetch 588 blobs to honour that.
//
// The margin is what makes it feel like nothing is being deferred at all — the
// fetch starts about a screen before the file arrives, so by the time it is
// under the cursor the bytes usually already are.

/** A screen's worth of warning at a comfortable window height. Not measured; adjust by feel. */
const MARGIN = '800px'

export function useNearViewport<T extends HTMLElement>(
  margin: string = MARGIN,
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const element = ref.current

    // No observer, no answer — and `false` is the safe half of that, not `true`.
    // A caller that cannot tell whether the element is on screen still has the
    // header click as its other trigger, whereas guessing `true` would make
    // every file in a jsdom fixture fetch itself.
    if (element === null || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return

        // One way. What this gates is a fetch, and there is no un-fetching, so
        // scrolling a file back off screen must not put it back to unread —
        // and it means the observer's work is over the moment it answers once.
        setNear(true)
        observer.disconnect()
      },
      { rootMargin: margin },
    )

    observer.observe(element)

    return () => observer.disconnect()
  }, [margin])

  return [ref, near]
}
