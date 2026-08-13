import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useRoomyRows } from './row-density'

describe('useRoomyRows', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts condensed', () => {
    expect(renderHook(() => useRoomyRows()).result.current[0]).toBe(false)
  })

  it('remembers the choice for the next session', () => {
    const first = renderHook(() => useRoomyRows())
    act(() => first.result.current[1](true))
    expect(first.result.current[0]).toBe(true)

    expect(renderHook(() => useRoomyRows()).result.current[0]).toBe(true)
  })

  it('remembers being switched back off', () => {
    localStorage.setItem('ado-web.inbox.roomy', 'true')
    const { result } = renderHook(() => useRoomyRows())
    expect(result.current[0]).toBe(true)

    act(() => result.current[1](false))
    expect(renderHook(() => useRoomyRows()).result.current[0]).toBe(false)
  })

  // The grouping toggle beside this one keeps its own key, so a reader can be
  // grouped and condensed at once.
  it('does not read the grouping key', () => {
    localStorage.setItem('ado-web.inbox.grouped', 'true')
    expect(renderHook(() => useRoomyRows()).result.current[0]).toBe(false)
  })

  // A hardened profile *throws* on `localStorage`, and an arrangement is not
  // worth a blank page.
  it('still toggles when storage is unavailable', () => {
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })

    try {
      const { result } = renderHook(() => useRoomyRows())
      expect(result.current[0]).toBe(false)

      act(() => result.current[1](true))
      expect(result.current[0]).toBe(true)
    } finally {
      if (storage) Object.defineProperty(window, 'localStorage', storage)
    }
  })
})
