import type { HighlightToken } from '@/lib/diff-contract'

// One line of diff text, coloured by Shiki and marked where it differs from the
// line opposite. Two independent segmentations of the same string meet here —
// the highlighter cuts it by grammar, the diff cuts it by what changed — and
// they do not line up. Rendering them as nested elements would put a span
// inside a span for every token inside every edit; this merges the two sets of
// boundaries first and emits one flat run per resulting piece.

/** A run of text that renders as one element: one colour, one edit state. */
export interface Segment {
  readonly text: string
  /** `null` before highlighting arrives, and for a language we do not bundle. */
  readonly color: string | null
  /** Shiki's `FontStyle` bit flags: 1 italic, 2 bold, 4 underline. */
  readonly fontStyle: number
  readonly edited: boolean
}

const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4

/**
 * Cut `text` at every boundary either input cares about, so each piece has a
 * single colour and a single edit state.
 *
 * `tokens` is `null` until the worker answers — which is most of the time a
 * line is on screen for the first time, and the reason the whole pipeline is
 * allowed to render before highlighting exists.
 */
export function segment(
  text: string,
  tokens: readonly HighlightToken[] | null = null,
  edits: readonly (readonly [start: number, end: number])[] = [],
): readonly Segment[] {
  if (text === '') return []

  // Tokens that do not add up to this line were produced for a different
  // string — a stale result for a line that has since changed, which is
  // reachable because highlighting is async and the diff is not. Colouring by
  // offset would paint the wrong characters, so drop the colour and keep the
  // text. Losing colour is a worse-looking line; keeping it is a wrong one.
  const usable =
    tokens !== null && tokens.reduce((total, token) => total + token.text.length, 0) === text.length
      ? tokens
      : null

  const bounds = new Set<number>([0, text.length])
  if (usable !== null) {
    let at = 0
    for (const token of usable) {
      at += token.text.length
      bounds.add(at)
    }
  }
  for (const [start, end] of edits) {
    // A range past the end of the line is a bug upstream, not a reason to
    // render nothing. Clamp it and carry on.
    if (start >= end) continue
    bounds.add(Math.max(0, Math.min(start, text.length)))
    bounds.add(Math.max(0, Math.min(end, text.length)))
  }

  const cuts = [...bounds].sort((left, right) => left - right)
  const segments: Segment[] = []
  // Walked alongside the cuts rather than searched per cut: a minified line is
  // thousands of tokens, and a scan per piece would make it quadratic.
  let index = 0
  let tokenEnd = usable === null ? text.length : (usable[0]?.text.length ?? text.length)

  for (let cut = 0; cut < cuts.length - 1; cut += 1) {
    const from = cuts[cut]
    const to = cuts[cut + 1]
    while (usable !== null && from >= tokenEnd && index < usable.length - 1) {
      index += 1
      tokenEnd += usable[index].text.length
    }
    const token = usable === null ? undefined : usable[index]

    segments.push({
      text: text.slice(from, to),
      color: token?.color ?? null,
      fontStyle: token?.fontStyle ?? 0,
      edited: edits.some(([start, end]) => start <= from && to <= end),
    })
  }

  return segments
}

function style(part: Segment) {
  return {
    color: part.color ?? undefined,
    fontStyle: (part.fontStyle & ITALIC) !== 0 ? 'italic' : undefined,
    fontWeight: (part.fontStyle & BOLD) !== 0 ? 'bold' : undefined,
    textDecoration: (part.fontStyle & UNDERLINE) !== 0 ? 'underline' : undefined,
  } as const
}

export function LineText({
  text,
  tokens = null,
  edits = [],
}: {
  text: string
  tokens?: readonly HighlightToken[] | null
  edits?: readonly (readonly [start: number, end: number])[]
}) {
  const parts = segment(text, tokens, edits)

  // Nothing to say about this text, so say it with no element at all — a bare
  // text node. This is the common case: an unhighlighted context line, of which
  // a large diff is mostly made. GitHub measured collapsing eight elements per
  // line to two as ~50% of the memory and 78% of the INP; a plain string is one
  // step further down that same road.
  if (
    parts.length === 0 ||
    (parts.length === 1 && parts[0].color === null && parts[0].fontStyle === 0 && !parts[0].edited)
  ) {
    return text
  }

  return parts.map((part, at) => (
    <span
      // Index is identity here and nowhere else: this list is a leaf, rebuilt
      // whole whenever the line or its tokens change, and never reordered.
      key={at}
      className={part.edited ? 'bg-diff-word rounded-[2px]' : undefined}
      style={style(part)}
    >
      {part.text}
    </span>
  ))
}
