// A person, as Azure DevOps hands them over and as this app has to draw them.
//
// Two problems, one module, because they are the same problem twice: ADO gives
// you an identity that a reader would not recognise, and something has to turn
// it back into a person. A `displayName` with no usable image becomes a
// monogram; an `@<GUID>` buried in a comment body becomes a name.
//
// **Nothing here imports anything, and that is load-bearing.** `threads.ts`
// value-imports this file, and every other import in that file is `import type`
// so the diff's row model can call `fileThreads` in the browser without dragging
// `@napi-rs/keyring` into the client bundle. A module with no imports cannot
// break that rule — which is what makes it safe for the server to do the GUID
// scan and the browser to do the split with one shared pattern rather than two
// copies of a regex that would drift apart.

/**
 * Two letters for the blob.
 *
 * `\p{L}` rather than `\w`: these are ADO display names, and "Ángel Ruiz" has to
 * come out "AR" while `[Products]\Contributors` must not come out "[P" — which
 * is why a container never reaches here and gets the group glyph instead.
 * First and last name, not first two, so "Paul James DeVito" is still "PD".
 */
export function initials(displayName: string): string {
  const words = displayName.match(/\p{L}+/gu)
  if (words === null || words.length === 0) return '?'

  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (words[0][0] + last).toUpperCase()
}

/**
 * How ADO writes a mention: `@<GUID>`, angle brackets and all.
 *
 * That is the literal text of the comment. The display name is nowhere in the
 * body — ADO's own web UI resolves it at render time — so a body rendered as it
 * arrives reads `cc @<FBFD3DD4-4D56-641D-9005-AE776A2D856C>`, which is the thing
 * this exists to stop.
 *
 * Case-insensitive, and every id below comes out lower case, because ADO is not
 * consistent about GUID casing between endpoints: the mention arrives upper case
 * and `_apis/identities` answers lower. Comparing them as written silently fails
 * to resolve every mention in the app.
 */
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const MENTION = new RegExp(`@<(${GUID})>`, 'gi')

/**
 * The bracketed half of a mention, on its own.
 *
 * Built from the same `GUID` as `MENTION` rather than written out twice, because
 * the reason this second pattern exists is subtle enough without the two drifting:
 * `<FBFD3DD4-4D56-641D-9005-AE776A2D856C>` is a **syntactically valid HTML tag**
 * — a letter followed by letters, digits and hyphens is all CommonMark asks of a
 * tag name — so a markdown parser takes that half of the mention out of the prose
 * and hands it back as raw HTML, leaving a lone `@` behind in the text before it.
 * A GUID starting with a digit is not a legal tag name and stays put, which is
 * why half the mentions in one comment can survive and half cannot.
 */
const TAG = new RegExp(`^<(${GUID})>$`, 'i')

/** Somebody tagged, and the exact characters they were tagged with. */
export interface Mention {
  readonly id: string
  /** What the body said. Rendered as-is when the id resolves to no name. */
  readonly raw: string
}

/** A run of ordinary text, or a mention. */
export type MentionPiece = string | Mention

/**
 * A body cut into text and mentions, in order.
 *
 * The `raw` on each mention is why this returns pieces rather than a replaced
 * string: an unresolved id has to render exactly as it was written, and a
 * caller that had already thrown the original text away could not do that.
 */
export function splitMentions(text: string): readonly MentionPiece[] {
  const pieces: MentionPiece[] = []
  let at = 0

  for (const match of text.matchAll(MENTION)) {
    const start = match.index ?? 0
    if (start > at) pieces.push(text.slice(at, start))
    pieces.push({ id: match[1].toLowerCase(), raw: match[0] })
    at = start + match[0].length
  }
  if (at < text.length) pieces.push(text.slice(at))

  return pieces
}

/**
 * The id, if this string is exactly the `<GUID>` half of a mention.
 *
 * For the renderer, which meets that half as its own node once a parser has been
 * over the body. Anchored, so an HTML tag that merely contains a GUID is not a
 * mention.
 */
export function mentionTag(value: string): string | null {
  const match = TAG.exec(value)
  return match === null ? null : match[1].toLowerCase()
}

/** Every identity this text mentions, lower case, each one once. */
export function mentionedIds(text: string | null): readonly string[] {
  if (text === null) return []

  const ids = new Set<string>()
  for (const match of text.matchAll(MENTION)) ids.add(match[1].toLowerCase())

  return [...ids]
}

/**
 * The names for the mentions in *this* text and no others.
 *
 * Narrowed per comment rather than handing every comment the whole lookup table,
 * so what a comment carries is what a comment needs. An id the lookup answered
 * nothing for is left out entirely — the renderer's cue to print the GUID as ADO
 * wrote it instead of a chip with a blank in it.
 */
export function mentionsIn(
  text: string | null,
  names: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const found: Record<string, string> = {}

  for (const id of mentionedIds(text)) {
    const name = names.get(id)
    if (name !== undefined && name !== '') found[id] = name
  }

  return found
}
