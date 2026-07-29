import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Dialog as DialogPrimitive, Modal as ModalPrimitive } from 'react-aria-components'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Cancel01Icon,
  Notification03Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from '@hugeicons/core-free-icons'

import { Button } from '@/components/ui/button'
import { DialogOverlay, DialogTitle } from '@/components/ui/dialog'
import { age } from '@/components/pr-list'
import { useCommand } from '@/commands/command-provider'
import { cn } from '@/lib/utils'
import { toggleMuted, unlockAudio, useMuted } from '@/lib/notify'
import { useMarkAllRead, useMarkRead, useNotifications } from './use-notifications'

import type { Notification, NotificationKind } from '@/server/notifications'

// The bell, the badge, and the panel behind them.
//
// **Built on `react-aria-components` directly rather than on `Dialog`.** The
// decision is geometry, not preference: `dialog.tsx`'s `Dialog` is a centred
// `sm:max-w-sm` card that zooms in, and a slide-over is a full-height sheet
// hinged on the right edge — every one of that component's positioning classes
// would have to be overridden, which is a fork with extra steps. What *is*
// reused is `DialogOverlay`, because the dim, the blur and the click-outside
// behaviour of a modal surface should be identical wherever it appears, and
// `DialogTitle`, because the heading has to carry react-aria's `slot="title"`
// for the dialog to be named.
//
// The panel is a modal on purpose. A notification list you can click through
// while it stays open sounds friendlier, but it is a list of links out of
// itself: every row navigates, and the first thing a row does on the way out is
// dismiss the thing it was in.

/** One tone per event, on the pens the rest of the app already uses for them. */
const KINDS: Record<NotificationKind, { readonly label: string; readonly tone: string }> = {
  build: { label: 'build', tone: 'prof-badge--red' },
  vote: { label: 'vote', tone: 'prof-badge--teal' },
  comment: { label: 'comment', tone: 'prof-badge--navy' },
  commits: { label: 'commits', tone: 'prof-badge--amber' },
}

/**
 * Takes Escape for as long as the panel is up.
 *
 * A separate component because `useCommand` binds for the lifetime of the one
 * that calls it, and the command provider keeps a *stack* per key — so mounting
 * this inside the open panel takes Escape off the shell (where it means "go
 * back") and hands it straight back on close. react-aria closes on Escape by
 * itself; this is here so the shell's `window.history.back()` cannot also fire
 * and navigate away from the page you were reading.
 */
function CloseOnEscape({ onClose }: { onClose: () => void }) {
  useCommand('nav.back', onClose)

  return null
}

function NotificationRow({
  item,
  onOpen,
  onToggleRead,
}: {
  item: Notification
  onOpen: () => void
  onToggleRead: () => void
}) {
  const kind = KINDS[item.kind]

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <Link
        to="/pr/$projectId/$repositoryId/$prId"
        params={{
          projectId: item.projectId,
          repositoryId: item.repositoryId,
          prId: String(item.prId),
        }}
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-2">
          <span className={cn('prof-badge tracking-label shrink-0 px-1.5 py-0.5 text-2xs leading-none uppercase', kind.tone)}>
            {kind.label}
          </span>
          {/* Unread is carried by weight rather than by a dot: the row already
              has a coloured pill on it, and two marks competing on one line is
              how a list stops reading as a list. */}
          <span
            className={cn(
              'truncate text-sm',
              item.read ? 'text-muted-foreground' : 'font-medium text-foreground',
            )}
          >
            {item.title}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.detail}</span>
      </Link>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="annotation">{age(new Date(item.createdAt).toISOString())}</span>
        <Button variant="ghost" size="xs" onPress={onToggleRead}>
          {item.read ? 'Mark unread' : 'Mark read'}
        </Button>
      </span>
    </li>
  )
}

export function Notifications() {
  const [isOpen, setOpen] = useState(false)
  const query = useNotifications()
  const markRead = useMarkRead()
  const markAllRead = useMarkAllRead()
  const muted = useMuted()

  const items = query.data?.items ?? []
  const unread = query.data?.unread ?? 0

  useCommand('view.notifications', () => setOpen((open) => !open))

  // The audio context is created on the first gesture of the session and not
  // before — see `notify.ts`. Listening here rather than on the bell because the
  // gesture that unlocks it should be *any* gesture: a notification arriving two
  // minutes into a reading session must be audible without anyone having clicked
  // the bell first.
  useEffect(() => {
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })

    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  return (
    <>
      {/* Bottom left, because the other three corners are taken: the inbox owns
          its top-right controls, the devtools own bottom-right, and a page's own
          heading owns top-left. */}
      <Button
        variant="outline"
        size="icon"
        onPress={() => setOpen(true)}
        aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
        className="fixed bottom-3 left-3 z-40 shadow-popover"
      >
        <HugeiconsIcon icon={Notification03Icon} size={16} aria-hidden />
        {unread > 0 && (
          <span className="prof-badge prof-badge--red absolute -top-2 -right-2 px-1.5 py-0.5 text-2xs leading-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>

      <DialogOverlay isDismissable isOpen={isOpen} onOpenChange={setOpen}>
        <ModalPrimitive
          data-slot="notifications-panel"
          // Only the two left corners are drawn — the sheet is hinged on the
          // right edge of the window, so its right corners are off-screen. They
          // have to be *corner* longhands: `rounded-l-*` takes one value per
          // corner and a sketch radius has two, and the whole declaration is
          // dropped. `dialog.tsx`'s footer carries the same note.
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l-[1.5px] border-ink bg-popover text-popover-foreground shadow-popover duration-100 outline-none [border-bottom-left-radius:1.5rem_1rem] [border-top-left-radius:1.5rem_1.1rem] data-entering:animate-in data-entering:slide-in-from-right data-exiting:animate-out data-exiting:slide-out-to-right"
        >
          <DialogPrimitive
            data-slot="notifications-dialog"
            aria-label="Notifications"
            className="flex min-h-0 flex-1 flex-col outline-none"
          >
            <CloseOnEscape onClose={() => setOpen(false)} />

            <div className="flex items-center gap-2 px-3 py-3">
              <DialogTitle className="flex-1">Notifications</DialogTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={muted}
                aria-label="Mute notification sounds"
                onPress={toggleMuted}
                className={cn(muted && 'bg-accent text-ink')}
              >
                <HugeiconsIcon icon={muted ? VolumeOffIcon : VolumeHighIcon} size={14} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close notifications"
                onPress={() => setOpen(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
              </Button>
            </div>

            <div className="sketch-rule" />

            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {items.map((item) => (
                <NotificationRow
                  key={item.key}
                  item={item}
                  onOpen={() => {
                    // Opening a notification is reading it. Fired before the
                    // navigation lands so the badge is already right when the
                    // panel comes back.
                    if (!item.read) markRead.mutate({ keys: [item.key], read: true })
                    setOpen(false)
                  }}
                  onToggleRead={() => markRead.mutate({ keys: [item.key], read: !item.read })}
                />
              ))}
            </ul>

            {items.length === 0 && (
              <p className="flex-1 px-3 py-6 text-sm text-muted-foreground">
                Nothing new yet.
              </p>
            )}

            <div className="sketch-rule" />

            <div className="flex items-center gap-2 px-3 py-2">
              {/* The scope, said out loud, because it is the one thing about this
                  feature that would otherwise be discovered as a bug: nothing
                  polls while the app is closed, so nothing is detected then
                  either. The first look after a restart is a baseline. */}
              <p className="annotation flex-1">Noticed while this app is open</p>
              <Button
                variant="outline"
                size="xs"
                isDisabled={unread === 0}
                onPress={() => markAllRead.mutate()}
              >
                Mark all read
              </Button>
            </div>
          </DialogPrimitive>
        </ModalPrimitive>
      </DialogOverlay>
    </>
  )
}
