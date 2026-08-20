import { Alert02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import type { ReactNode } from 'react'

// The two sentences every section on the pull request page needs.
//
// One copy, at last. These eight lines were written in `pr-detail.tsx`, copied
// into `sonar/panel.tsx` with a note saying to lift them the first time a third
// section wanted them, and copied again into `checks/panel.tsx` with a note saying
// the third copy was a deliberate debt and to lift all three when a fourth came
// along. The work items section is the fourth.

/** "There are none" and "we could not find out" are different facts. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
}

export function Failed({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 px-2 py-1.5 text-sm">
      <HugeiconsIcon icon={Alert02Icon} size={14} className="shrink-0" aria-hidden />
      {children}
    </p>
  )
}
