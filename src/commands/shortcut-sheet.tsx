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
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Dimmed keys have nothing listening on this screen.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {byGroup(COMMANDS).map(([group, commands]) => (
          <section key={group} className="flex flex-col gap-0.5">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {group}
            </h3>
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
                    <dt>{command.label}</dt>
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
