import { Tag01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useState } from 'react'
import { TextField } from 'react-aria-components'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAttachWorkItem, useWorkItemSearch } from '@/lib/work-items'

import type { KeyboardEvent } from 'react'
import type { WorkItem } from '@/lib/work-item-contract'
import type { PullRequestRef } from '@/server/pull-request'

// Attaching an existing work item, by typing part of its title or its number.
//
// **The autocomplete is remote**, which is the one way this differs from
// `ReviewerPicker` — and the reason for every extra line in here. There is no
// snapshot to match against: work items are hundreds of thousands of rows that
// change all day, so each keystroke is a WIQL query plus a batch read. Hence the
// debounce (in `useWorkItemSearch`), hence the previous matches staying on screen
// while the next answer is in flight, and hence a search that can fail — a list
// fed by a local array has no error state and this one has three.
//
// **The field is mounted, not rendered**, `ReviewerPicker`'s arrangement and its
// reason one step stronger: the button below is the whole component until pressed,
// so a pull request nobody attaches anything to costs no calls at all.
//
// **Nothing here creates a work item.** Attaching one that exists is the whole
// feature. Creating one is a form, a work item type, a required-fields rule per
// project and a second scope, and none of that belongs behind a search field.

const wrap = (index: number, length: number): number => (index + length) % length

/**
 * The number, the title, and what kind of thing it is.
 *
 * The number leads because it is what somebody who already knows the ticket
 * recognises, and it is the only field guaranteed to be there — a work item with
 * no title is normal enough that `item()` does not invent one.
 */
function Candidate({ item }: { item: WorkItem }) {
  return (
    <>
      <span className="text-muted-foreground shrink-0 font-mono text-2xs">{item.id}</span>
      <span className="truncate">{item.title === '' ? 'Untitled' : item.title}</span>
      <span className="annotation text-muted-foreground ml-auto shrink-0">
        {[item.type, item.state].filter((word) => word !== '').join(' · ')}
      </span>
    </>
  )
}

/** What to say about the search itself, or `null` when matches arrived. */
function searchNote(
  search: ReturnType<typeof useWorkItemSearch>,
  query: string,
  offered: number,
): string | null {
  // A paused query is `pending` for as long as the browser claims to be offline,
  // so asking `isPending` alone would say "looking…" until the tab is reloaded —
  // `directoryNote`'s trap, and the same two branches to avoid it.
  if (search.fetchStatus === 'paused') {
    return 'This browser says it is offline, so nothing can be looked up.'
  }
  if (search.status === 'pending') return 'Looking for work items…'
  if (search.status === 'error') {
    const reason = search.error?.message ?? ''

    return `Work items could not be searched. ${reason === '' ? 'No reason was given.' : reason}`
  }
  if (search.data?.error !== null && search.data?.error !== undefined) {
    return `Work items could not be searched. ${search.data.error}`
  }
  if (offered > 0) return null

  return query.trim() === ''
    ? 'Nothing recent is assigned to you. Type a number or part of a title.'
    : `Nothing matches “${query}”.`
}

/**
 * The field itself: open, focused, and holding the only copy of the search.
 *
 * A component of its own so that the reads live behind the press — see the header.
 * It stays open after a successful attach: a pull request that closes one ticket
 * often closes two, and closing the field would mean pressing the button again.
 */
function WorkItemField({
  prRef,
  attached,
  onClose,
}: {
  prRef: PullRequestRef
  /** What is already on the pull request, so it is not offered twice. */
  attached: ReadonlySet<number>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const search = useWorkItemSearch(prRef.projectId, query)
  const attach = useAttachWorkItem(prRef)

  const listId = 'work-item-suggestions'

  // Filtered rather than asked for: WIQL cannot be told to leave out the eight ids
  // already on the pull request without putting them in the query text, and a
  // query that grows with the section is a query that stops being cacheable.
  const items = (search.data?.items ?? []).filter((item) => !attached.has(item.id))

  const index = items.length === 0 ? -1 : Math.min(active, items.length - 1)
  const activeId = index < 0 ? null : `${listId}-${index}`

  useEffect(() => {
    setActive(0)
  }, [query])

  function pick(item: WorkItem) {
    attach.run(item.id)
    // Cleared on the way out, not on the way back: the field is ready for the next
    // number while ADO is still thinking about this one, and the row appears when
    // the re-read says it is there.
    setQuery('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // Stopped as well as prevented: Escape at the shell is `nav.back`, and
      // closing this field must not also leave the page.
      event.preventDefault()
      event.stopPropagation()
      onClose()

      return
    }
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(wrap(index + 1, items.length))

      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(wrap(index - 1, items.length))

      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(items[index])
    }
  }

  const note = searchNote(search, query, items.length)

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {/* `relative`, so the list is positioned against this and not against the
          section: the suggestions are meant to overlap what is below them rather
          than push the page down 200px as you type. */}
      <div className="relative flex items-center gap-2">
        <TextField
          aria-label="Attach a work item"
          value={query}
          onChange={setQuery}
          className="min-w-0 max-w-sm flex-1"
        >
          {/* The ARIA combobox written out rather than RAC's `ComboBox`,
              `ReviewerPicker`'s reason: the input is ours and the list under it is
              ours, so the roles are simply the truth about them. */}
          <Input
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId ?? undefined}
            placeholder="Number or title"
            onKeyDown={onKeyDown}
          />
        </TextField>
        <Button variant="ghost" size="xs" onPress={onClose}>
          Done
        </Button>

        <div className="border-input bg-popover shadow-popover absolute top-full left-0 z-50 mt-1 w-full max-w-sm overflow-hidden rounded-md border-[1.5px]">
          <ul
            aria-label="Work items that could be attached"
            id={listId}
            role="listbox"
            className="max-h-56 overflow-y-auto py-1"
          >
            {items.map((item, at) => (
              <li
                key={item.id}
                aria-selected={at === index}
                id={`${listId}-${at}`}
                role="option"
                className={cn(
                  'flex cursor-pointer items-baseline gap-2 px-2 py-1 text-sm',
                  at === index && 'bg-accent text-ink',
                )}
                // Prevented rather than handled: a mousedown here blurs the field,
                // and the click meant to choose a ticket would arrive after the
                // blur had moved the page on.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActive(at)}
              >
                <Candidate item={item} />
              </li>
            ))}
          </ul>

          {note === null ? null : (
            <p className="annotation text-muted-foreground border-border border-t px-2 py-1">
              {note}
            </p>
          )}
        </div>
      </div>

      {attach.pending === null ? null : (
        <p className="text-muted-foreground text-xs">Attaching {attach.pending}…</p>
      )}
      {attach.error === null ? null : (
        // Dismissable, `ReviewerPicker`'s reason: this field stays open across
        // several attaches, so a refusal from two tickets ago must not still be
        // sitting under it.
        <p role="alert" className="text-destructive flex items-baseline gap-2 text-xs">
          <span>Azure DevOps did not attach it: {attach.error}</span>
          <button type="button" className="hover:text-primary underline" onClick={attach.dismiss}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  )
}

/**
 * The one control the Work items section adds, and the reads it is hiding.
 *
 * Offered only on an active pull request — see the call site. Attaching a ticket to
 * something already merged or abandoned is a link nobody will act on, which is
 * `ReviewerPicker`'s reasoning one section down.
 */
export function WorkItemPicker({
  prRef,
  attached,
}: {
  prRef: PullRequestRef
  attached: ReadonlySet<number>
}) {
  const [asking, setAsking] = useState(false)

  if (asking) {
    return <WorkItemField prRef={prRef} attached={attached} onClose={() => setAsking(false)} />
  }

  return (
    <div className="mt-1.5">
      <Button variant="outline" size="xs" onPress={() => setAsking(true)}>
        <HugeiconsIcon icon={Tag01Icon} size={12} aria-hidden />
        Attach a work item
      </Button>
    </div>
  )
}
