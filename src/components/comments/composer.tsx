import { useEffect, useId, useRef, useState } from 'react'

import { MentionPicker } from '@/components/comments/mention-picker'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { insertMention, mentionQuery } from '@/lib/mention-draft'
import { cn } from '@/lib/utils'

import type { ChangeEvent, KeyboardEvent } from 'react'
import type { MentionPickerHandle } from '@/components/comments/mention-picker'
import type { ReviewerCandidate } from '@/lib/identity-contract'
import type { MentionQuery } from '@/lib/mention-draft'

// T-026. Where a reply, an edit and a new thread all get written — one component,
// three call sites, because they differ in what happens to the text and in
// nothing about typing it.
//
// The preview goes through the same `Markdown` the description renders through,
// which is the point rather than a convenience: `remark-breaks` is on, so a stack
// of one-line notes stays a stack of one-line notes exactly as it will in ADO,
// and `rehype-raw` is *not* installed, so `<b>` shows as three characters here
// and three characters there. A preview rendered any other way is a preview that
// lies about the comment.
//
// **The text survives a failed submit.** `onSubmit` is awaited and a rejection is
// caught here, so the textarea still holds what was in it and the reason sits
// underneath. Losing a paragraph to a 503 is the worst outcome this component
// has available.
//
// T-035 added the `@mention` half. Three things about it live here and nowhere
// else, because they are all about the textarea rather than about the list:
//
// **The keys go to the picker first.** `onKeyDown` offers every key to
// `MentionPickerHandle.keyDown` and returns if it was taken. That ordering is the
// feature: plain `Enter` chooses a person before the textarea inserts a newline,
// and `Escape` closes the list before it reaches `onCancel`, which throws the
// draft away. Ctrl/Cmd + Enter is never taken, so submit still submits with the
// list open.
//
// **The role stays `textbox`.** ARIA 1.2 would put `role="combobox"` on the field,
// and that is wrong for this one: every reply box in the app is this component,
// the list exists only while a name is being typed, and a textarea announcing
// itself as a combobox for the other 99% of its life is worse than a textbox that
// grows `aria-activedescendant` for a moment. `aria-autocomplete`,
// `aria-haspopup` and `aria-activedescendant` are all supported on `textbox`.
//
// **Escape is remembered by offset.** Dismissing the picker must not touch the
// text, so the `@` somebody escaped out of is still there and still matches —
// which would reopen the list on the next keystroke. `dismissed` holds that `@`'s
// offset, so the list stays shut for *that* mention and opens for the next one.

/** What a keyboard hint says, and it is the platform's word for the key. */
const SUBMIT_HINT = '⌘/Ctrl + Enter'

type Pane = 'write' | 'preview'

export function Composer({
  label,
  onSubmit,
  onCancel,
  initial = '',
  submitLabel = 'Comment',
  placeholder = 'Leave a comment',
  autoFocus = false,
  onDraftChange,
}: {
  /** Names the textarea; there is more than one composer on a page. */
  label: string
  /**
   * Resolves and the composer clears; rejects and it keeps every character.
   * The message on the rejection is what the reviewer is shown.
   */
  onSubmit: (content: string) => Promise<void>
  /** Absent means there is nothing to abandon — a reply box that is always open. */
  onCancel?: () => void
  /** The text an edit starts with. Empty for a reply or a new thread. */
  initial?: string
  submitLabel?: string
  placeholder?: string
  autoFocus?: boolean
  /**
   * Told each character, so a caller can keep the draft when this unmounts.
   *
   * Only one caller needs it: the composer in the diff is a virtualized row, so it
   * is unmounted both when it is closed and — with nobody deciding anything — when
   * it scrolls out of the overscan window. Every other call site outlives its own
   * draft and passes nothing. The text stays owned here either way; this reports
   * it, and `initial` is how it comes back.
   */
  onDraftChange?: (content: string) => void
}) {
  const [text, setText] = useState(initial)
  const [pane, setPane] = useState<Pane>('write')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const box = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<MentionPickerHandle | null>(null)
  /** Shared by the textarea's `aria-controls` and every option's id. */
  const listId = useId()

  /** The `@…` under the caret, or `null`. Not "is the picker open" — see `open`. */
  const [mention, setMention] = useState<MentionQuery | null>(null)
  /** The offset of an `@` that Escape closed. */
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Where the caret has to be put back after an insertion. */
  const [caretTo, setCaretTo] = useState<number | null>(null)
  /**
   * Names for the people mentioned from this composer, keyed as `Markdown` wants
   * them (lower-cased GUID), so the preview reads `@Jordan Vincent` rather than
   * the GUID that is actually in the text. Only what was picked here: resolving a
   * mention that arrived in `initial` is the read side's job, and it already has a
   * lookup for it.
   */
  const [names, setNames] = useState<Record<string, string>>({})

  // Whitespace is not content. `Markdown` renders nothing for it either, so a
  // submitted blank would be a comment with no body and no way to fix it.
  const empty = text.trim() === ''

  // The list is shown for a mention that has not been escaped out of, and only
  // while there is a textarea to type into.
  const open = pane === 'write' && mention !== null && mention.at !== dismissed

  // Every write to `text` goes through here, so a caller keeping the draft is never
  // told a stale version of it — including the clear after a successful post.
  function change(next: string) {
    setText(next)
    onDraftChange?.(next)
  }

  /** Re-asks whether a mention is being typed, at whatever the caret is now. */
  function place(next: string, caret: number) {
    const found = mentionQuery(next, caret)
    // Kept by value, not by identity: this runs on every key *up* as well as on
    // every change, and a new object saying the same thing would re-render the
    // whole composer — which in the diff is a virtualized row — twice a keystroke.
    setMention((was) =>
      was?.at === found?.at && was?.query === found?.query ? was : found,
    )
    // Forgotten once the mention it belonged to is gone, or an `@` typed later at
    // the same offset would come up already dismissed.
    if (found === null) setDismissed(null)
  }

  function edit(event: ChangeEvent<HTMLTextAreaElement>) {
    change(event.target.value)
    place(event.target.value, event.target.selectionStart)
  }

  /**
   * The caret can move without the text changing — an arrow key, Home, a click —
   * and a picker that only looked at `onChange` would go on offering people for an
   * `@` the caret has left, then insert a name into the middle of a word.
   */
  function sync(event: { currentTarget: HTMLTextAreaElement }) {
    place(event.currentTarget.value, event.currentTarget.selectionStart)
  }

  function pick(person: ReviewerCandidate) {
    const node = box.current
    if (mention === null || node === null) return

    const next = insertMention(text, mention.at, node.selectionStart, person.identityId)
    change(next.text)
    setMention(null)
    setDismissed(null)
    setNames((was) => ({ ...was, [person.identityId.toLowerCase()]: person.displayName }))
    setCaretTo(next.caret)
  }

  // React writes the new value and the browser puts the caret at the end of it, so
  // an insertion in the middle of a sentence would leave you typing at the bottom
  // of the box. Put back after the render that changed the value, not during it.
  useEffect(() => {
    const node = box.current
    if (caretTo === null || node === null) return
    node.focus()
    node.setSelectionRange(caretTo, caretTo)
    setCaretTo(null)
  }, [caretTo])

  async function submit() {
    if (empty || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text)
      change('')
      setPane('write')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Azure DevOps did not take that comment.')
    } finally {
      setBusy(false)
    }
  }

  // Bound to the textarea rather than through `useCommand`, and this is a
  // deliberate exception to "shortcuts live in the registry". The app's one
  // keydown listener returns early on `isTextEntry(event.target)` and on any
  // Ctrl/Meta combination — the two rules that stop `j` moving the cursor while
  // someone writes a sentence — so neither of these keys can reach it. Routing
  // them through would mean weakening both for every surface in the app.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Offered to the picker before anything else looks at it. `true` means it has
    // been prevented and acted on, and the rest of this function must not run —
    // Enter chose somebody, or Escape closed a list rather than a draft.
    if (picker.current?.keyDown(event) === true) return

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'Escape' && onCancel !== undefined) {
      // Stopped here as well as prevented: `nav.back` is bound to Escape at the
      // shell, and abandoning a draft must not also go back a page.
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    // Drawn as the app's other text fields are, because that is what this is: a
    // textarea with chrome. `bg-popover` is Prof's input sheet (`--paper-3`, the
    // brightest paper) and `border-input` is its stroke, so a composer sitting on
    // a `bg-card` thread reads as somewhere to type rather than as another panel.
    // `rounded-lg`, not `input.tsx`'s `rounded-sm`, because it is panel-sized —
    // and not bare `rounded`, which is the one step of the scale still mapped to a
    // machine corner. The 1.5px pen matches every other bordered surface; `/60` on
    // the line was tuned against a dark app and is nothing against warm paper.
    // `relative` for the mention picker, which hangs off the bottom of this box:
    // anchoring it to the caret would mean measuring a textarea's text, and the
    // list ends up two lines under the caret either way.
    <div className="relative rounded-lg border-[1.5px] border-input bg-popover">
      {/* 1px borders, not `.sketch-rule`, for all three boundaries in here. A
          drawn rule costs 6px and there are up to three of them in a box about
          140px tall — that is 18px of texture inside a thing whose whole job is
          to get out of the way while someone writes a sentence. */}
      <div className="border-border flex items-center gap-1 border-b px-1.5 py-1">
        {(['write', 'preview'] as const).map((which) => (
          <Button
            key={which}
            variant="ghost"
            size="xs"
            onPress={() => setPane(which)}
            aria-pressed={pane === which}
            // The teal wash for the chosen pane, as `LayoutToggle` and
            // `HideDoneToggle` use it. `bg-muted` said "sunken" about the control
            // you are currently on, which is the wrong direction — and on this
            // sheet it is the wrong colour twice over, because `--muted` is
            // `--paper-1` and the box under it is `--paper-3`.
            className={cn(pane === which && 'bg-accent text-ink')}
          >
            {which === 'write' ? 'Write' : 'Preview'}
          </Button>
        ))}
      </div>

      {pane === 'write' ? (
        <textarea
          ref={box}
          aria-label={label}
          // A `textbox` that sometimes has a list attached, rather than a
          // `combobox`; the reasoning is at the top of the file. `aria-controls`
          // and `aria-expanded` are only there while the list is, so a plain reply
          // box has nothing extra on it at all.
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open ? true : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId ?? undefined}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={4}
          onChange={edit}
          onKeyDown={onKeyDown}
          onKeyUp={sync}
          onClick={sync}
          // A list left hanging under a field nobody is typing in. The mouse path
          // does not come through here: the picker prevents its own `mousedown`,
          // so choosing somebody never blurs this.
          onBlur={() => setMention(null)}
          // No `ring-*` and no `focus-visible:border-*`: styles.css draws focus
          // once, globally, as a teal box-shadow with a paper gap inside it, and a
          // second ring on top of it would be two rings. `rounded-sm` is here for
          // that shadow alone — the field is transparent, so the radius shows up
          // nowhere else, and without it the one drawn corner in this box would be
          // a hard rectangle appearing the moment you focus the thing.
          className="placeholder:text-muted-foreground field-sizing-content min-h-20 w-full resize-y rounded-sm border-0 bg-transparent px-2 py-1.5 text-sm outline-none"
        />
      ) : (
        <div className="min-h-20 px-2 py-1.5">
          {empty ? (
            <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
          ) : (
            <Markdown mentions={names}>{text}</Markdown>
          )}
        </div>
      )}

      {open && mention !== null ? (
        <MentionPicker
          ref={picker}
          listId={listId}
          query={mention.query}
          onPick={pick}
          onClose={() => setDismissed(mention.at)}
          // The state setter itself, not an arrow: the picker reports the active
          // option from an effect, and a new function every render would re-run it
          // every render.
          onActiveId={setActiveId}
        />
      ) : null}

      {error === null ? null : (
        // Above the buttons rather than replacing them: the text is still there
        // and pressing the same button again is the retry.
        // The pen and nothing else. A `bg-pen-red-tint` wash under it was the
        // obvious Prof move and it is the wrong one here: `--pen-red` measures
        // 5.01:1 on this box's white sheet and 4.08:1 on its own tint, so adding
        // the wash would take the one sentence in this component that has to be
        // read from clearing AA to failing it. The wash earns its place on `Alert`,
        // which is a whole surface you are meant to notice; this is a line of type
        // eight pixels under the button that caused it.
        <p role="alert" className="text-destructive border-border border-t px-2 py-1.5 text-xs">
          {error}
        </p>
      )}

      <div className="border-border flex items-center gap-2 border-t px-1.5 py-1">
        <Button size="xs" onPress={() => void submit()} isDisabled={empty || busy}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        {onCancel === undefined ? null : (
          <Button variant="ghost" size="xs" onPress={onCancel} isDisabled={busy}>
            Cancel
          </Button>
        )}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
          <Kbd>{SUBMIT_HINT}</Kbd>
          to save
        </span>
      </div>
    </div>
  )
}
