import { afterEach, describe, expect, it, vi } from 'vitest'

import { onIdle } from './idle'

// Two paths, and the second one is the one that runs in this test suite: jsdom
// implements no `requestIdleCallback`, so every idle-scheduled thing in this app
// is on the fallback whenever it is under test. Worth knowing which behaviour a
// component test is actually exercising.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('onIdle', () => {
  it('asks the browser for idle time when the browser has any to give', () => {
    const request = vi.fn(() => 7)
    const cancel = vi.fn()
    vi.stubGlobal('requestIdleCallback', request)
    vi.stubGlobal('cancelIdleCallback', cancel)
    const work = vi.fn()

    const off = onIdle(work)

    // The timeout, not just the callback: idle may never arrive on a busy tab.
    expect(request).toHaveBeenCalledWith(work, { timeout: 2000 })
    off()
    expect(cancel).toHaveBeenCalledWith(7)
  })

  it('degrades to a timer rather than assuming the callback exists', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const work = vi.fn()

    onIdle(work)

    expect(work).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('can be called off before the fallback timer fires', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const work = vi.fn()

    onIdle(work)()
    vi.advanceTimersByTime(1000)

    expect(work).not.toHaveBeenCalled()
  })
})
