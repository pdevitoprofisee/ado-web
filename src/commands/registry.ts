// Every keyboard shortcut in the app, declared once. The `?` sheet is rendered
// from this array, so a new binding costs one entry here and nothing else.
//
// Handlers deliberately live elsewhere. `j` means "next inbox row" on the inbox
// and "next diff row" in phase 3's file view; the key, the wording and the
// order the sheet prints them in are app-wide, the behaviour is not. Surfaces
// claim a key with `useCommand`.
//
// `r` reply and `e` edit are still not listed, and not because nobody has got to
// them: nothing that reaches Azure DevOps has a key. A vote is the same `PUT` as
// adding a reviewer, so a mistyped one puts a colleague's name on a pull request,
// and a comment posted by a slip is a comment everybody watching the thread has
// already been mailed. The review keys below either move the window or write a
// local SQLite row.

export type CommandGroup = 'Navigation' | 'Review' | 'View' | 'Help'

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
  // `/` and not `Ctrl+F`, which this layer cannot have: it ignores every key
  // pressed with Ctrl, Meta or Alt, on purpose, because those belong to the
  // browser. Taking the browser's own find away would also be a promise this
  // cannot keep — a diff has files whose bytes were never fetched.
  { id: 'find.diff', key: '/', label: 'Find in the diff', group: 'Navigation' },
  // Reading one pull request without the mouse. The brackets are one family on
  // purpose — bare between the files, shifted between Sonar's findings — because
  // both are "send me somewhere else in this change set", and `n`/`p` stay for
  // the thing a reviewer steps through most.
  { id: 'review.nextFile', key: ']', label: 'Next file', group: 'Review' },
  { id: 'review.previousFile', key: '[', label: 'Previous file', group: 'Review' },
  { id: 'review.nextThread', key: 'n', label: 'Next unresolved thread', group: 'Review' },
  {
    id: 'review.previousThread',
    key: 'p',
    label: 'Previous unresolved thread',
    group: 'Review',
  },
  // The one key here that records anything, and it records it locally: a viewed
  // mark is a row in this app's own SQLite and never leaves the machine.
  { id: 'review.viewed', key: 'v', label: 'Mark this file read or unread', group: 'Review' },
  { id: 'review.nextFinding', key: '}', label: 'Next Sonar finding', group: 'Review' },
  { id: 'review.previousFinding', key: '{', label: 'Previous Sonar finding', group: 'Review' },
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
