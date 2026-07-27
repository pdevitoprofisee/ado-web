import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { COMMANDS } from './registry'
import { ShortcutSheet } from './shortcut-sheet'
import { isTextEntry } from './text-entry'

import type { RefObject } from 'react'
import type { CommandId } from './registry'

// One keydown listener for the whole app. Surfaces don't add their own — they
// say which registry command they implement and get called when its key is
// pressed, so every shortcut is discoverable from ./registry.ts.

type HandlerRef = RefObject<() => void>
type Bind = (id: CommandId, handler: HandlerRef) => () => void

const BindContext = createContext<Bind | null>(null)

/**
 * Binds `handler` to a registry command for as long as the component is
 * mounted. The handler may close over anything and change identity freely.
 */
export function useCommand(id: CommandId, handler: () => void): void {
  const bind = useContext(BindContext)
  if (!bind) {
    throw new Error(`useCommand('${id}') used outside a CommandProvider`)
  }

  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })

  useEffect(() => bind(id, ref), [bind, id])
}

/** The two shortcuts that belong to the shell rather than to any surface. */
function ShellCommands({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  useCommand('help.shortcuts', onShowShortcuts)
  // `window.history`, not `router.history`: TanStack Router drives the browser
  // history and listens to popstate, so this lands in the router either way,
  // and the command layer stays usable (and testable) without a router.
  useCommand('nav.back', () => window.history.back())
  return null
}

export function CommandProvider({ children }: { children: React.ReactNode }) {
  // A ref, not state: binding a command must not re-render anything, because
  // phase 3's virtualized rows will bind and unbind as they scroll.
  const bindings = useRef(new Map<CommandId, Array<HandlerRef>>())
  const [isSheetOpen, setSheetOpen] = useState(false)

  const bind = useCallback<Bind>((id, handler) => {
    // A stack rather than a slot: two surfaces can own the same key across a
    // route transition, so the most recent binding wins and hands the key back
    // when it unmounts, instead of clobbering its predecessor for good.
    const stack = bindings.current.get(id) ?? []
    stack.push(handler)
    bindings.current.set(id, stack)

    return () => {
      const remaining =
        bindings.current.get(id)?.filter((entry) => entry !== handler) ?? []
      if (remaining.length === 0) bindings.current.delete(id)
      else bindings.current.set(id, remaining)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Bare keys only. Ctrl/Meta/Alt combinations belong to the browser and
      // the OS; Shift is allowed because `?` needs it.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.isComposing) return
      if (isTextEntry(event.target)) return

      const command = COMMANDS.find((entry) => entry.key === event.key)
      if (!command) return

      // While the sheet is up it owns the keyboard: `j` must not move a cursor
      // the user can't see, and its Escape is the dialog's, not `nav.back`'s.
      if (isSheetOpen) {
        if (command.id === 'help.shortcuts') setSheetOpen(false)
        return
      }

      const handler = bindings.current.get(command.id)?.at(-1)
      if (!handler) return

      event.preventDefault()
      handler.current()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSheetOpen])

  return (
    <BindContext value={bind}>
      <ShellCommands onShowShortcuts={() => setSheetOpen(true)} />
      {children}
      <ShortcutSheet
        isOpen={isSheetOpen}
        onOpenChange={setSheetOpen}
        // Read at open time. Nothing binds while the sheet has the keyboard,
        // so a snapshot cannot go stale underneath it.
        isBound={(id) => bindings.current.has(id)}
      />
    </BindContext>
  )
}
