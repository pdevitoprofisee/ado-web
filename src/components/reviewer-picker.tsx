import { UserAdd01Icon, UserMultipleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useMemo, useState } from 'react'
import { TextField } from 'react-aria-components'

import { Avatar } from './avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { filterPeople, useDirectory } from '@/lib/identity-query'
import { offerable, useInviteReviewer } from '@/lib/reviewers'
import { cn } from '@/lib/utils'

import type { KeyboardEvent } from 'react'
import type { ReviewerCandidate } from '@/lib/identity-contract'
import type { PullRequestRef, Reviewer } from '@/server/pull-request'

// Asking somebody to review, by typing part of their name.
//
// **The autocomplete is local.** Every keystroke matches against one cached
// snapshot of the org (`useDirectory`, 30-minute staleTime, one key shared with
// the @mention picker), so there is no debounce here, no minimum query length and
// nothing to cancel in flight — the three things T-034 was written asking for,
// all of them answered by T-035 having already chosen the whole-directory fetch.
// The reason that choice was made is the reason it is right here too: ADO's
// `subjectquery` matches a prefix of the *whole* display name, so searching it for
// `Vincent` finds Jordan Vincent zero times, and a reviewer field you cannot drive
// with a surname is a reviewer field people go back to ADO for.
//
// **The field is mounted, not rendered.** The directory costs eight calls and
// about 450 KB, and most visits to a pull request are a read. So the button below
// is the whole component until it is pressed, which is `MentionPicker`'s
// arrangement — there, typing an `@` is the mount — and is why `directoryOptions`
// deliberately has no `enabled`.
//
// **It only ever adds optional reviewers.** `isRequired` reaches the server
// function because the endpoint has the field, and this UI always sends `false`:
// a required reviewer is a merge gate, and putting a gate up is not something a
// fuzzy-match list should do on the same `Enter` that picks the name. Required
// reviewers on this org come from branch policy anyway — 127 of the 150 sampled
// required reviewers are the containers policy attached.

const wrap = (index: number, length: number): number => (index + length) % length

/**
 * The name, the address, and a face if there is one.
 *
 * The mail address is what disambiguates: this org has two `Naveen`s and the
 * display names differ by a surname most people do not know. Groups do not reach
 * this list at all — the directory is `graph/users` — but the glyph fallback is
 * here anyway so a service identity with no initials worth reading gets a mark
 * rather than a blank.
 */
function Candidate({ person }: { person: ReviewerCandidate }) {
  return (
    <>
      <Avatar
        href={person.avatarHref}
        name={person.displayName}
        className="size-5 shrink-0"
        fallback={
          person.kind === 'group' ? <HugeiconsIcon icon={UserMultipleIcon} size={12} /> : undefined
        }
      />
      <span className="truncate">{person.displayName}</span>
      {person.uniqueName === '' ? null : (
        <span className="text-muted-foreground ml-auto truncate text-xs">{person.uniqueName}</span>
      )}
    </>
  )
}

/**
 * The field itself: open, focused, and holding the only copy of the search.
 *
 * A component of its own so that the read lives behind the press — see the header.
 * It stays open after a successful add, because the answer to "who else has not
 * seen this" is usually more than one person, and closing would mean pressing the
 * button again and re-typing.
 */
function ReviewerField({
  prRef,
  reviewers,
  onClose,
}: {
  prRef: PullRequestRef
  /** Who is already on the pull request, so they are not offered again. */
  reviewers: readonly Reviewer[]
  onClose: () => void
}) {
  const directory = useDirectory()
  const invite = useInviteReviewer(prRef)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const listId = 'reviewer-suggestions'

  // Filtered *after* the ones already on the pull request are dropped, not
  // before: the eight slots are worth eight people who can actually be added, and
  // taking the already-present out of a list that was already cut to eight would
  // show five.
  const people = useMemo(
    () => filterPeople(offerable(directory.data?.people ?? [], reviewers), query),
    [directory.data, reviewers, query],
  )

  // Clamped rather than reset, and the highlight goes home on a new query — both
  // `MentionPicker`'s reasons, and the same two lines.
  const index = people.length === 0 ? -1 : Math.min(active, people.length - 1)
  const activeId = index < 0 ? null : `${listId}-${index}`

  useEffect(() => {
    setActive(0)
  }, [query])

  // Named from the directory rather than remembered on the side: `invite.pending`
  // is the id being written, and the list it came from is right here.
  const asking =
    invite.pending === null
      ? null
      : (directory.data?.people.find((person) => person.identityId === invite.pending) ?? null)

  function pick(person: ReviewerCandidate) {
    invite.run(person, false)
    // Cleared on the way out rather than on the way back, so the field is ready
    // for the next name while ADO is still thinking about this one. The row
    // appears when the re-read says it is there — nothing is drawn optimistically.
    setQuery('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // Stopped as well as prevented, `TitleField`'s reason: Escape at the shell
      // is `nav.back`, and closing this field must not also leave the page.
      event.preventDefault()
      event.stopPropagation()
      onClose()

      return
    }
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(wrap(index + 1, people.length))

      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(wrap(index - 1, people.length))

      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(people[index])
    }
  }

  const notes: string[] = []
  if (directory.isPending) notes.push('Looking up who is in the organisation…')
  else if (directory.data?.error != null) notes.push(directory.data.error)
  else if (people.length === 0) {
    notes.push(
      query === '' ? 'Everybody in the list is already on this.' : `Nobody matches “${query}”.`,
    )
  }
  if (directory.data !== undefined) {
    // The two admissions `DirectoryResult` exists to make, shown for
    // `MentionPicker`'s reason: the person typing is the only one who can tell
    // that the colleague they wanted is missing from the list.
    if (!directory.data.complete && directory.data.error === null) {
      notes.push('Azure DevOps returned a full page of people, so this list may be short.')
    }
    const lost = directory.data.total - directory.data.people.length
    if (lost > 0) notes.push(`${lost} of ${directory.data.total} people could not be looked up.`)
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {/* `relative`, because the list is positioned against this and not against
          the section: a suggestion list that overlaps the Description below it is
          the point — the section must not grow by 200px as you type. */}
      <div className="relative flex items-center gap-2">
        <TextField
          aria-label="Ask somebody to review"
          value={query}
          onChange={setQuery}
          className="min-w-0 max-w-sm flex-1"
        >
          {/* The ARIA combobox written out, as in `MentionPicker` and for the
              opposite reason: there, focus had to stay in a textarea RAC's
              ComboBox would have taken it from; here the input is ours and the
              list under it is ours, so `role="combobox"` is simply the truth
              about a field whose only purpose is to choose one of them. */}
          <Input
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId ?? undefined}
            placeholder="Name or email"
            onKeyDown={onKeyDown}
          />
        </TextField>
        <Button variant="ghost" size="xs" onPress={onClose}>
          Done
        </Button>

        <div className="border-input bg-popover shadow-popover absolute top-full left-0 z-50 mt-1 w-full max-w-sm overflow-hidden rounded-md border-[1.5px]">
          <ul
            aria-label="People who could review this"
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
                  'flex cursor-pointer items-center gap-2 px-2 py-1 text-sm',
                  at === index && 'bg-accent text-ink',
                )}
                // Prevented rather than handled: a mousedown here blurs the
                // field, and the click that was meant to choose somebody would
                // arrive after the blur had moved the page on.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(person)}
                onMouseEnter={() => setActive(at)}
              >
                <Candidate person={person} />
              </li>
            ))}
          </ul>

          {notes.map((note) => (
            <p
              key={note}
              className="annotation text-muted-foreground border-border border-t px-2 py-1"
            >
              {note}
            </p>
          ))}
        </div>
      </div>

      {asking === null ? null : (
        <p className="text-muted-foreground text-xs">Asking {asking.displayName}…</p>
      )}
      {invite.error === null ? null : (
        // Dismissable, unlike the vote control's: this field stays open across
        // several adds, so a refusal from two people ago must not still be sitting
        // under it. `role="alert"` because nothing else on the page moves when a
        // write is refused.
        <p role="alert" className="text-destructive flex items-baseline gap-2 text-xs">
          <span>Azure DevOps did not add them: {invite.error}</span>
          <button type="button" className="hover:text-primary underline" onClick={invite.dismiss}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  )
}

/**
 * The one control the Reviewers section adds, and the read it is hiding.
 *
 * Offered only on an active pull request — see the call site. Adding a reviewer to
 * something already merged or abandoned is a write ADO may well take and nobody
 * will act on, which is `lifecycleAction`'s reasoning applied one section down.
 */
export function ReviewerPicker({
  prRef,
  reviewers,
}: {
  prRef: PullRequestRef
  reviewers: readonly Reviewer[]
}) {
  const [asking, setAsking] = useState(false)

  if (asking) {
    return <ReviewerField prRef={prRef} reviewers={reviewers} onClose={() => setAsking(false)} />
  }

  return (
    <div className="mt-1.5">
      <Button variant="outline" size="xs" onPress={() => setAsking(true)}>
        <HugeiconsIcon icon={UserAdd01Icon} size={12} aria-hidden />
        Ask somebody to review
      </Button>
    </div>
  )
}
