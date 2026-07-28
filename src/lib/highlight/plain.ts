import type { HighlightedLines } from '@/lib/diff-contract'
import type { Theme } from '@/lib/theme'

// The unhighlighted answer, in its own module because the main thread needs it
// and must not pull Shiki in to get it. Everything else under `highlight/`
// reaches `shiki/core` eventually; this file reaches nothing — both imports are
// types.

/**
 * Each theme's resolved foreground. Hard-coded rather than read off the loaded
 * theme so that plain text costs no theme fetch — a `.psd` in the diff should
 * download no grammar and no theme at all.
 *
 * `tokenise.test.ts` asserts both equal what Shiki resolves, so neither can
 * drift: repointing a theme in `bundle.ts` without changing these fails there.
 * The eight digits on the dark one are Shiki's, not a typo — `vitesse-dark`'s
 * foreground carries an `ee` alpha byte, which is legal in CSS and goes straight
 * into `style={{ color }}` the way every other token's colour does.
 */
export const PLAIN_COLOR: Record<Theme, string> = {
  light: '#393a34',
  dark: '#dbd7caee',
}

/** One token per line, unstyled. What an unbundled language renders as. */
export function plainLines(lines: readonly string[], theme: Theme): HighlightedLines {
  const color = PLAIN_COLOR[theme]

  return lines.map((text) => [{ text, color }])
}
