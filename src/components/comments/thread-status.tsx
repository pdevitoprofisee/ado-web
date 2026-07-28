import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { SettableThreadStatus, Thread, ThreadStatus } from '@/lib/comment-contract'
import type { ThreadActions } from './thread-actions'

// What a thread's status is, and the four ways to change it.
//
// Buttons rather than a select, because there is no menu primitive in
// `components/ui` and adding one for four options is more machinery than the
// options are worth. They are also the four the API accepts as a *write*: ADO
// reports seven statuses (`closed` and `byDesign` both turned up live) but only
// `fixed`, `wontFix`, `pending` and `active` can be set, which is why
// `SettableThreadStatus` exists and why "closed" is a label here and not a button.

/** How a status reads to a person, since the wire words are camelCase. */
const LABEL: Record<ThreadStatus, string> = {
  unknown: 'No status',
  active: 'Active',
  fixed: 'Resolved',
  wontFix: "Won't fix",
  closed: 'Closed',
  byDesign: 'By design',
  pending: 'Pending',
}

/**
 * The three settable resolutions, in the order they are reached for.
 *
 * `active` is not here: it is the *reopen*, and it belongs next to a done thread
 * rather than in a row of ways to close one.
 */
const RESOLVE: readonly { readonly status: SettableThreadStatus; readonly label: string }[] = [
  { status: 'fixed', label: 'Resolve' },
  { status: 'wontFix', label: "Won't fix" },
  { status: 'pending', label: 'Pending' },
]

/**
 * The word for a thread's status, for the stub and the card header.
 *
 * `null` is the common case, not the edge: `status` was absent on 32 of 56
 * sampled threads and every one of those was a system thread. It reads the same
 * as ADO's own `unknown` because there is nothing else honest to say.
 */
export function statusLabel(status: ThreadStatus | null): string {
  return status === null ? LABEL.unknown : LABEL[status]
}

export function ThreadStatusControl({
  thread,
  actions,
  className,
}: {
  thread: Thread
  actions?: ThreadActions
  className?: string
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<SettableThreadStatus | 'active' | null>(null)
  const onStatusChange = actions?.onStatusChange

  // A system thread's status is ADO's to set — a vote or a policy wrote it, and
  // `PATCH`ing it back does not undo the thing it records.
  if (onStatusChange === undefined || thread.kind === 'system') {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        {statusLabel(thread.status)}
      </span>
    )
  }

  // Aliased past the guard above: a narrowing does not follow an outer `const`
  // into a closure, and the alternative is a `!` that outlives the reason for it.
  const send = onStatusChange

  function change(status: SettableThreadStatus | 'active') {
    setFailure(null)
    setBusy(status)
    send({ threadId: thread.id, status })
      .catch((cause: unknown) => {
        setFailure(
          cause instanceof Error ? cause.message : 'Azure DevOps did not change that status.',
        )
      })
      .finally(() => setBusy(null))
  }

  // `resolution`, not `status`: the contract folds seven statuses into open/done
  // for exactly this decision, and 32 of 56 sampled threads had no `status` at
  // all — reading `status === 'active'` here would call most of them done.
  const done = thread.resolution === 'done'

  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {done ? (
        <>
          <span className="text-muted-foreground text-xs">{statusLabel(thread.status)}</span>
          <Button
            variant="ghost"
            size="xs"
            onPress={() => change('active')}
            isDisabled={busy !== null}
          >
            {busy === 'active' ? 'Reopening…' : 'Reopen'}
          </Button>
        </>
      ) : (
        RESOLVE.map(({ status, label }) => (
          <Button
            key={status}
            variant={status === 'fixed' ? 'outline' : 'ghost'}
            size="xs"
            onPress={() => change(status)}
            isDisabled={busy !== null}
          >
            {busy === status ? 'Saving…' : label}
          </Button>
        ))
      )}
      {failure === null ? null : (
        <span role="alert" className="text-destructive text-xs">
          {failure}
        </span>
      )}
    </span>
  )
}
