import { cn } from '@/lib/utils'

import type { DiffLayout } from '@/lib/diff-contract'

// Its own file because two pages hold this control now — a pull request and a
// branch on this disk — and "the same toggle" has to mean the same component,
// not a second one styled to match. A copy would be two places to remember that
// the pressed option is a teal wash and not `bg-muted`, and the second one to be
// forgotten.

/**
 * Unified or side-by-side, for every file at once.
 *
 * One control for the whole page rather than one per file: the choice is about
 * how you read, not about the file in front of you, and `setLayout` reprojects
 * an already-expanded file rather than starting it over, so flipping it mid-read
 * costs nothing and loses nothing.
 */
export function LayoutToggle({
  layout,
  onLayoutChange,
}: {
  layout: DiffLayout
  onLayoutChange: (layout: DiffLayout) => void
}) {
  return (
    <div role="group" aria-label="Diff layout" className="flex items-baseline gap-2">
      {(['unified', 'split'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={layout === option}
          onClick={() => onLayoutChange(option)}
          // `rounded-sm` and not bare `rounded`: only the named steps are mapped
          // onto the sketch radii, so `rounded` is the one class in the scale
          // that still draws a machine corner.
          //
          // The pressed option is filled in with the teal wash rather than
          // outlined, because an outline that appears and disappears moves the
          // two words either side of it. `bg-muted` said "sunken" on a control
          // that is chosen, which is the wrong direction.
          className={cn(
            'rounded-sm px-1.5 py-0.5',
            layout === option ? 'text-ink bg-accent' : 'hover:text-foreground',
          )}
        >
          {option === 'unified' ? 'Unified' : 'Side by side'}
        </button>
      ))}
    </div>
  )
}
