import { useState } from 'react'

import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

import type { KeyboardEvent } from 'react'

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
}) {
  const [text, setText] = useState(initial)
  const [pane, setPane] = useState<Pane>('write')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Whitespace is not content. `Markdown` renders nothing for it either, so a
  // submitted blank would be a comment with no body and no way to fix it.
  const empty = text.trim() === ''

  async function submit() {
    if (empty || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text)
      setText('')
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
    <div className="border-border/60 bg-background rounded-md border">
      <div className="border-border/60 flex items-center gap-1 border-b px-1.5 py-1">
        {(['write', 'preview'] as const).map((which) => (
          <Button
            key={which}
            variant="ghost"
            size="xs"
            onPress={() => setPane(which)}
            aria-pressed={pane === which}
            className={cn(pane === which && 'bg-muted text-foreground')}
          >
            {which === 'write' ? 'Write' : 'Preview'}
          </Button>
        ))}
      </div>

      {pane === 'write' ? (
        <textarea
          aria-label={label}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 field-sizing-content min-h-20 w-full resize-y border-0 bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-3"
        />
      ) : (
        <div className="min-h-20 px-2 py-1.5">
          {empty ? (
            <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      )}

      {error === null ? null : (
        // Above the buttons rather than replacing them: the text is still there
        // and pressing the same button again is the retry.
        <p role="alert" className="text-destructive border-border/60 border-t px-2 py-1.5 text-xs">
          {error}
        </p>
      )}

      <div className="border-border/60 flex items-center gap-2 border-t px-1.5 py-1">
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
