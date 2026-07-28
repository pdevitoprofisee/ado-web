import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

import { COMMANDS } from './registry'

import type { Command, CommandGroup, CommandId } from './registry'

// Generated from the registry, never hand-written — that is the whole point of
// the ticket. Nothing in this file names a key or a shortcut.

/** Groups in the order the registry first mentions them; `Map` keeps insertion order. */
function byGroup(
  commands: ReadonlyArray<Command>,
): Array<[CommandGroup, Array<Command>]> {
  const groups = new Map<CommandGroup, Array<Command>>()
  for (const command of commands) {
    const existing = groups.get(command.group)
    if (existing) existing.push(command)
    else groups.set(command.group, [command])
  }
  return [...groups]
}

export function ShortcutSheet({
  isOpen,
  onOpenChange,
  isBound,
}: {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** Whether any mounted surface is currently listening for the command. */
  isBound: (id: CommandId) => boolean
}) {
  return (
    // Width is all this adds: `Dialog` already draws the largest sketch
    // corners, the pen outline, the brightest sheet and the graphite cast, and
    // a reference sheet is exactly the surface that vocabulary was written for.
    // Wider than the default `sm:max-w-sm` because every row here is a pair —
    // wording on the left, key on the right — and they should not meet.
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Dimmed keys have nothing listening on this screen.
        </DialogDescription>
      </DialogHeader>

      {/* A drawn rule between what this sheet is and the reference itself. 6px
          tall; the dialog's own gap is what gives it the room. */}
      <hr className="sketch-rule" />

      <div className="flex flex-col gap-4">
        {byGroup(COMMANDS).map(([group, commands]) => (
          <section key={group} className="flex flex-col gap-0.5">
            <h3 className="annotation">{group}</h3>
            <dl className="flex flex-col">
              {commands.map((command) => {
                const bound = isBound(command.id as CommandId)
                return (
                  <div
                    key={command.id}
                    data-slot="shortcut"
                    data-bound={bound}
                    className={cn(
                      'flex items-center justify-between gap-4 py-0.5',
                      !bound && 'opacity-45',
                    )}
                  >
                    {/* The key is the thing being looked up, so it keeps the
                        strong ink the drawn `Kbd` gives it; the wording beside
                        it is the caption. */}
                    <dt className="text-ink-500">{command.label}</dt>
                    <dd>
                      <Kbd>{command.keyLabel ?? command.key}</Kbd>
                    </dd>
                  </div>
                )
              })}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
