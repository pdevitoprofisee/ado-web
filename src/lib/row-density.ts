import { useCallback, useState } from 'react'

// How much room a pull request row gets, and whether that choice survives a
// reload.
//
// The two arrangements answer two different days. One line fits about 24 rows on
// a 900px sheet, which is the density a triage pass down `j`/`k` wants; two lines
// fit about 15 but stop truncating the title, which is what you want when you are
// reading rather than counting. Neither is right for both, so the reader picks.

/** Where the choice is kept. Nothing else reads this key. */
const STORAGE_KEY = 'ado-web.inbox.roomy'

/**
 * The row density toggle, remembered.
 *
 * `useGroupByRepository`'s shape and its reasoning, including the defensive
 * reads: `localStorage` *throws* on access in a hardened browser profile, and an
 * arrangement is not worth a blank page.
 *
 * One line is the default, because it is what the table was before this existed
 * and because it is the arrangement that fits more of your inbox on screen.
 */
export function useRoomyRows(): readonly [boolean, (next: boolean) => void] {
  const [roomy, setRoomy] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const choose = useCallback((next: boolean) => {
    setRoomy(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // A session that cannot persist still gets to rearrange its own inbox.
    }
  }, [])

  return [roomy, choose]
}
