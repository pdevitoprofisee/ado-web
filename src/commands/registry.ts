// Every keyboard shortcut in the app, declared once. The `?` sheet is rendered
// from this array, so a new binding costs one entry here and nothing else.
//
// Handlers deliberately live elsewhere. `j` means "next inbox row" on the inbox
// and "next diff row" in phase 3's file view; the key, the wording and the
// order the sheet prints them in are app-wide, the behaviour is not. Surfaces
// claim a key with `useCommand`.
//
// The keys later phases will want — `[`/`]` between files, `n`/`p` between
// unresolved threads, `r` reply, `e` edit — are not listed yet. They are one
// entry each, added alongside the surface that implements them, because a key
// whose meaning doesn't exist yet has no wording to print.

export type CommandGroup = 'Navigation' | 'View' | 'Help'

export interface Command {
  readonly id: string
  /** Compared against `KeyboardEvent.key`, so a character or a key name. */
  readonly key: string
  /** What the sheet prints, where the raw `key` reads badly. */
  readonly keyLabel?: string
  readonly label: string
  readonly group: CommandGroup
}

export const COMMANDS = [
  { id: 'nav.next', key: 'j', label: 'Next item', group: 'Navigation' },
  { id: 'nav.previous', key: 'k', label: 'Previous item', group: 'Navigation' },
  { id: 'nav.open', key: 'Enter', label: 'Open', group: 'Navigation' },
  {
    id: 'nav.back',
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    group: 'Navigation',
  },
  // A shell command, so it works on the diff as well as the inbox — the visible
  // control lives in the inbox header, and the diff is where you are when the
  // room gets dark.
  { id: 'view.theme', key: 't', label: 'Light or dark', group: 'View' },
  // `b` for bell. The panel is mounted by the shell rather than by a page, so
  // this reaches it from the diff as well — which is where you are when the
  // build you are waiting on breaks.
  { id: 'view.notifications', key: 'b', label: 'Notifications', group: 'View' },
  { id: 'help.shortcuts', key: '?', label: 'Keyboard shortcuts', group: 'Help' },
] as const satisfies ReadonlyArray<Command>

/** Only a declared id can be bound — a typo in `useCommand` is a type error. */
export type CommandId = (typeof COMMANDS)[number]['id']
