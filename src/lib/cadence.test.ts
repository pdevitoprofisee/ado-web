import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CADENCE, IDLE_AFTER_MS, useCadence } from './cadence'

let visibility: DocumentVisibilityState = 'visible'

/** `document.visibilityState` is a getter with no setter; jsdom lets us replace it. */
function see(state: DocumentVisibilityState): void {
  visibility = state
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Fake timers move `Date.now` too, which is what the idle clock reads. */
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('useCadence', () => {
  it('polls at the tier while the window is visible and in use', () => {
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    expect(result.current).toBe(CADENCE.inbox)
  })

  it('stops entirely when the tab is hidden', () => {
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    see('hidden')

    // `false` rather than a long interval: `useQuery` reads this as "do not
    // poll", and there is nobody to show a stale number to.
    expect(result.current).toBe(false)
  })

  it('resumes the tier when the tab comes back', () => {
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    see('hidden')
    see('visible')

    expect(result.current).toBe(CADENCE.inbox)
  })

  it('drops to the idle tier when the window is visible but untouched', () => {
    // The case a `visibilitychange` listener alone misses: a window sitting
    // behind another window on a second monitor is 'visible' all night.
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    wait(IDLE_AFTER_MS + 60_000)

    expect(result.current).toBe(CADENCE.idle)
  })

  it('is not idle after a coffee-length gap', () => {
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    wait(IDLE_AFTER_MS - 60_000)

    expect(result.current).toBe(CADENCE.inbox)
  })

  it('comes back to the tier as soon as someone types', () => {
    const { result } = renderHook(() => useCadence(CADENCE.inbox))

    wait(IDLE_AFTER_MS + 60_000)
    expect(result.current).toBe(CADENCE.idle)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }))
    })

    expect(result.current).toBe(CADENCE.inbox)
  })

  it('leaves no timer or listener behind when the surface unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useCadence(CADENCE.inbox))

    unmount()

    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true })
    expect(vi.getTimerCount()).toBe(0)
  })
})
