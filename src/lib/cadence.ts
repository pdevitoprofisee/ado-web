import { useEffect, useState } from 'react'

// How often a surface re-asks Azure DevOps, in one place so the numbers are a
// policy rather than a scattering of magic numbers in `useQuery` calls.
//
// The tiers are the ticket's. The two rules around them exist because "left open
// overnight" has two different shapes and only one of them is a hidden tab: a
// browser window sitting behind another window on a second monitor reports
// `visibilityState: 'visible'` all night. Polling only on visibility would keep
// that window asking every two minutes until morning.

export const CADENCE = {
  /**
   * An open pull request — the diff you are reading right now, where a new push
   * or a new comment changes what you are looking at.
   *
   * Declared, and nothing subscribes to it yet: round 1 has no open-PR surface.
   * Same shape as T-009's registry holding `[`/`]` before phase 3 exists.
   */
  pullRequest: 30_000,
  /** The inbox. New review requests are not a thirty-second concern. */
  inbox: 120_000,
  /**
   * My completed and abandoned pull requests — the one surface with no news in
   * it, because a finished pull request does not become more finished.
   *
   * Nothing polls at this tier and it is deliberately not passed to
   * `useCadence`: it is a `staleTime` only, so returning to the page inside the
   * hour re-renders the list already in the cache and the two ADO calls it costs
   * are paid once.
   */
  history: 60 * 60_000,
  /**
   * Visible, but nobody has touched the machine in a while. Slow rather than
   * stopped: the window is on screen, so a wrong number on it is still a wrong
   * number someone can read.
   */
  idle: 15 * 60_000,
} as const

/** Long enough that a walk to get coffee is not "idle", short enough to catch a night. */
export const IDLE_AFTER_MS = 5 * 60_000

/** Cheap, passive, and enough to notice a person: no mousemove, no scroll storm. */
const ACTIVITY = ['pointerdown', 'keydown', 'focus', 'visibilitychange'] as const

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

/**
 * The refetch interval for a tier, or `false` to stop — which is what
 * `useQuery`'s `refetchInterval` wants.
 *
 * A hidden tab polls **not at all** rather than slowly. There is nobody to show
 * a stale number to, and the query refetches on focus anyway, so the data is
 * fresh by the time it is looked at. That is the whole answer to "an inbox left
 * open overnight": the common case costs zero.
 */
export function useCadence(base: number, now: () => number = Date.now): number | false {
  const [interval, setInterval] = useState<number | false>(base)

  useEffect(() => {
    let last = now()

    const decide = () => {
      setInterval(hidden() ? false : now() - last >= IDLE_AFTER_MS ? CADENCE.idle : base)
    }

    const touch = () => {
      last = now()
      decide()
    }

    for (const event of ACTIVITY) {
      // `focus` does not bubble, so it is captured rather than listened for on
      // window — otherwise clicking into a field would not register as activity.
      document.addEventListener(event, touch, { capture: true, passive: true })
    }

    // A tick rather than a timeout per event: the question is only ever "how
    // long has it been", and re-arming a timer on every keystroke is worse.
    const tick = globalThis.setInterval(decide, 60_000)
    decide()

    return () => {
      for (const event of ACTIVITY) {
        document.removeEventListener(event, touch, { capture: true })
      }
      globalThis.clearInterval(tick)
    }
  }, [base, now])

  return interval
}
