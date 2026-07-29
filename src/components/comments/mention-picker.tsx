import { useEffect, useImperativeHandle, useMemo, useState } from 'react'

import { filterPeople, useDirectory } from '@/lib/identity-query'
import { cn } from '@/lib/utils'

import type { KeyboardEvent, Ref } from 'react'
import type { ReviewerCandidate } from '@/lib/identity-contract'

// The list of people that hangs under the composer while somebody types a name.
//
// Two decisions in here are worth stating, because both are departures from what
// the rest of the app does.
//
// **It is not built on `react-aria-components`' `ListBox`.** RAC's listbox takes
// DOM focus and moves it as you arrow through the options, and the whole point of
// this widget is that focus never leaves the textarea — the caret has to stay
// where it is, and the next keystroke has to go into the sentence being written.
// That is the ARIA "combobox with list autocomplete" arrangement: the text field
// keeps focus and points at the highlighted option through
// `aria-activedescendant`, which RAC implements internally for its own ComboBox
// and does not expose. So this is the pattern written out — `role="listbox"`,
// `role="option"`, `aria-selected` — which is a dozen lines and no fight.
//
// **The keyboard is answered here and not in the composer.** `keyDown` below is
// exposed imperatively so the composer can offer every key to the picker *first*
// and get back whether it was consumed. The ordering that buys is the whole
// feature: plain `Enter` has to select a person before the textarea inserts a
// newline, and `Escape` has to close this list before it reaches the composer's
// cancel, which throws away the draft. Both are one `return` in the composer
// rather than two flags kept in sync.

/** What the composer holds a handle to. */
export interface MentionPickerHandle {
  /**
   * Offers a key to the picker. `true` means it was consumed — the event has
   * already been prevented and the picker has acted — and the composer must not
   * look at it again.
   */
  keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean
}

const wrap = (index: number, length: number): number => (index + length) % length

export function MentionPicker({
  listId,
  query,
  onPick,
  onClose,
  onActiveId,
  ref,
}: {
  /** Shared with the textarea's `aria-controls`, and the stem of every option id. */
  listId: string
  /** What has been typed after the `@`. `''` is "show me people". */
  query: string
  onPick: (person: ReviewerCandidate) => void
  /** Escape, and only Escape. Choosing somebody closes it through `onPick`. */
  onClose: () => void
  /**
   * The id of the highlighted option, for the textarea's `aria-activedescendant`.
   * Reported upwards because the element that has to carry the attribute is the
   * one that has focus, which is not this one.
   */
  onActiveId: (id: string | null) => void
  ref?: Ref<MentionPickerHandle>
}) {
  // Mounted only while a mention is being typed, so this is where the directory
  // is actually asked for: open a composer and type nothing and the app makes no
  // identity calls at all.
  const directory = useDirectory()
  const [active, setActive] = useState(0)

  const people = useMemo(
    () => filterPeople(directory.data?.people ?? [], query),
    [directory.data, query],
  )

  // Clamped rather than reset on every render: the list shrinks as somebody keeps
  // typing, and an index left pointing past the end would select nobody.
  const index = people.length === 0 ? -1 : Math.min(active, people.length - 1)
  const activeId = index < 0 ? null : `${listId}-${index}`

  // A different query is a different list, so the highlight goes back to the best
  // match. Without this, typing one more character would leave the third row
  // highlighted in a list whose third row is now somebody else.
  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    onActiveId(activeId)

    // Cleared on unmount as well as on change: the attribute would otherwise be
    // left on the textarea pointing at an element that no longer exists.
    return () => onActiveId(null)
  }, [activeId, onActiveId])

  useImperativeHandle(
    ref,
    () => ({
      keyDown(event) {
        // First, and whether or not there is anybody in the list: a picker with a
        // "nobody matches" line in it is still something Escape should close, and
        // it must not be the composer's Escape that closes it.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()

          return true
        }
        // Nothing to navigate or choose. Returning false hands `Enter` back to
        // the textarea, where it is a newline like any other.
        if (index < 0) return false

        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive(wrap(index + 1, people.length))

          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive(wrap(index - 1, people.length))

          return true
        }
        // Tab selects, as it does in every autocomplete; it is also prevented, or
        // the choice would be followed by focus leaving the composer. Ctrl/Cmd +
        // Enter is *not* ours — that is submit, and it stays submit with the list
        // open.
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.metaKey && !event.ctrlKey)) {
          event.preventDefault()
          onPick(people[index])

          return true
        }

        return false
      },
    }),
    [index, people, onClose, onPick],
  )

  const notes: string[] = []
  if (directory.isPending) notes.push('Looking up who is in the organisation…')
  else if (directory.data?.error != null) notes.push(directory.data.error)
  else if (people.length === 0) {
    notes.push(query === '' ? 'Nobody to show.' : `Nobody matches “${query}”.`)
  }
  if (directory.data !== undefined) {
    // The two admissions `DirectoryResult` exists to make. Shown next to the list
    // rather than logged, because the person typing is the only one who can tell
    // that the colleague they were looking for is missing.
    if (!directory.data.complete && directory.data.error === null) {
      notes.push('Azure DevOps returned a full page of people, so this list may be short.')
    }
    const lost = directory.data.total - directory.data.people.length
    if (lost > 0) {
      notes.push(`${lost} of ${directory.data.total} people could not be looked up.`)
    }
  }

  return (
    // Under the whole composer rather than at the caret: anchoring to the caret
    // means measuring a textarea's text, and this box is two lines below where you
    // are typing either way. `shadow-popover` and the 1.5px pen are what every
    // other floating sheet in the app is drawn with.
    <div className="border-input bg-popover shadow-popover absolute top-full left-0 z-50 mt-1 w-full max-w-sm overflow-hidden rounded-md border-[1.5px]">
      <ul
        // Named, because a listbox with no name is a list of nothing to a screen
        // reader — and this one is never focused, so its name is the only thing
        // that says what the options are for.
        aria-label="People to mention"
        id={listId}
        role="listbox"
        className="max-h-56 overflow-y-auto py-1"
      >
        {people.map((person, at) => (
          <li
            key={person.identityId}
            aria-selected={at === index}
            id={`${listId}-${at}`}
            role="option"
            className={cn(
              'flex cursor-pointer items-baseline gap-2 px-2 py-1 text-sm',
              at === index && 'bg-accent text-ink',
            )}
            // Prevented, not handled: a mousedown on this row would blur the
            // textarea, and a blurred textarea closes the picker before the click
            // that was meant to choose somebody ever arrives.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(person)}
            onMouseEnter={() => setActive(at)}
          >
            <span className="truncate">{person.displayName}</span>
            {person.uniqueName === '' ? null : (
              <span className="text-muted-foreground ml-auto truncate text-xs">
                {person.uniqueName}
              </span>
            )}
          </li>
        ))}
      </ul>

      {notes.map((note) => (
        <p key={note} className="annotation text-muted-foreground border-border border-t px-2 py-1">
          {note}
        </p>
      ))}
    </div>
  )
}
