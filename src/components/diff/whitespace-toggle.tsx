import { cn } from '@/lib/utils'

// Its own file for the reason `LayoutToggle` is: three pages hold this control
// now — a pull request, a branch, and a commit — and "the same toggle" has to
// mean the same component. A copy is three places to remember that a pressed
// option is a teal wash and not `bg-muted`, and the third one to be forgotten.

/**
 * `git diff -w`, for every file on the page at once.
 *
 * One control rather than one per file, like the layout: the reason to turn it
 * on is that a formatter went through the change, and that is true of the change
 * and not of the file in front of you.
 *
 * Flipping it re-diffs. It cannot reproject an open file the way `setLayout`
 * does, because the hunks themselves come out different — but the two blobs are
 * already in hand and content-addressed, so nothing is fetched again.
 */
export function WhitespaceToggle({
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
}: {
  ignoreWhitespace: boolean
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={ignoreWhitespace}
      onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
      // `LayoutToggle`'s pressed styling, because the two sit on the same line
      // and answer the same kind of question, so a chosen one should look chosen
      // the same way.
      className={cn(
        'rounded-sm px-1.5 py-0.5',
        ignoreWhitespace ? 'text-ink bg-accent' : 'hover:text-foreground',
      )}
    >
      Ignore whitespace
    </button>
  )
}
