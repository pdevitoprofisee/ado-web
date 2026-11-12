import { useCallback, useState } from 'react'

/** Where the choice is kept. Nothing else reads this key. */
const STORAGE_KEY = 'ado-web.inbox.hideDrafts'

/**
 * Whether the inbox leaves draft pull requests out, remembered.
 *
 * `useRoomyRows`'s shape, including the defensive reads: `localStorage` throws
 * on access in a hardened browser profile.
 *
 * Off by default, so that a new session shows every open pull request.
 */
export function useHideDrafts(): readonly [boolean, (next: boolean) => void] {
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const choose = useCallback((next: boolean) => {
    setHidden(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // A session that cannot persist still gets to hide its own drafts.
    }
  }, [])

  return [hidden, choose]
}
