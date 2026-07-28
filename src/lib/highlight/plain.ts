import type { HighlightedLines } from '@/lib/diff-contract'

// The unhighlighted answer, in its own module because the main thread needs it
// and must not pull Shiki in to get it. Everything else under `highlight/`
// reaches `shiki/core` eventually; this file reaches nothing.

/**
 * `github-dark`'s resolved foreground. Hard-coded rather than read off the
 * loaded theme so that plain text costs no theme fetch — a `.psd` in the diff
 * should download no grammar and no theme at all.
 *
 * `bundle.test.ts` asserts this equals what Shiki resolves, so it cannot drift.
 */
export const PLAIN_COLOR = '#e1e4e8'

/** One token per line, unstyled. What an unbundled language renders as. */
export function plainLines(lines: readonly string[]): HighlightedLines {
  return lines.map((text) => [{ text, color: PLAIN_COLOR }])
}
