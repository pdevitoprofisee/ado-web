import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useHideDrafts } from './draft-visibility'

describe('useHideDrafts', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows drafts by default', () => {
    expect(renderHook(() => useHideDrafts()).result.current[0]).toBe(false)
  })

  it('remembers the choice for the next session', () => {
    const first = renderHook(() => useHideDrafts())
    act(() => first.result.current[1](true))
    expect(first.result.current[0]).toBe(true)

    expect(renderHook(() => useHideDrafts()).result.current[0]).toBe(true)
  })

  it('still toggles when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useHideDrafts())
    expect(result.current[0]).toBe(false)

    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
  })
})
