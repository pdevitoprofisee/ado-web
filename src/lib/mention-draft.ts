// Where an `@mention` starts in a half-typed sentence, and what putting one in
// does to the text around it.
//
// Split out of the composer because it is the half that has nothing to do with
// React: given a string and a caret, either the person is typing a mention or
// they are not, and that question has a right answer that can be tested without
// a DOM. Imports nothing, for the same reason `people.ts` imports nothing — the
// composer runs in the browser and this is arithmetic on a string.
//
// `people.ts` owns reading a mention back out of a body; this owns putting one
// in. The two share no regex because they are not the same pattern: reading
// looks for `@<GUID>` in text somebody already wrote, and this looks for an `@`
// followed by whatever a person has managed to type so far.

/**
 * How many characters after the `@` still count as a query.
 *
 * A cap rather than nothing, because the trigger is found by scanning back from
 * the caret: without one, an `@` in the first line of a long comment would keep
 * matching for the rest of the paragraph. 40 is longer than any display name in
 * the directory and shorter than a sentence.
 */
const MAX_QUERY = 40

/**
 * What ends a query. Whitespace obviously; `@` because two of them is not one
 * name; `<` and `>` because that is what a *finished* mention is made of, so a
 * caret sitting just after `@<` is not the start of a new search.
 */
const ENDS_QUERY = /[\s<>@]/

/** What may sit immediately before the `@`. Anything else is `foo@bar`. */
const BEFORE_TRIGGER = /[\s(['"]/

/** An opening or closing fence, indented by up to the three spaces CommonMark allows. */
const FENCE = /^ {0,3}(?:```|~~~)/

/** A mention being typed: the `@` and what has been typed after it. */
export interface MentionQuery {
  /** Index of the `@` itself, which is where an insertion starts. */
  readonly at: number
  /** Everything between the `@` and the caret. `''` the instant `@` is typed. */
  readonly query: string
}

/**
 * Whether the `@` at `at` is inside a fenced code block.
 *
 * Counted rather than parsed: an odd number of fence lines above it means the
 * last one opened a block nothing has closed yet. Only *whole lines* above the
 * `@` are counted, so a fence on the same line cannot open a block around a
 * mention on it.
 *
 * Inline code — a single pair of backticks — is deliberately not checked. One
 * unmatched backtick in ordinary prose is common, and suppressing the picker
 * there would be a feature that silently stops working for reasons nobody can
 * see. A fence is unambiguous; a lone backtick is not.
 */
function insideFence(text: string, at: number): boolean {
  const lines = text.slice(0, at).split('\n')
  let open = false

  for (const line of lines.slice(0, -1)) {
    if (FENCE.test(line)) open = !open
  }

  return open
}

/**
 * The mention being typed at `caret`, or `null` if there isn't one.
 *
 * Four ways to be `null`, and all four are the picker staying shut rather than
 * an error: there is no `@` behind the caret, the `@` is mid-word (`foo@bar` is
 * an address, not a mention), something between the `@` and the caret ended the
 * query, or the whole thing is inside a code fence.
 *
 * An empty `query` is a *match*, not a miss. Typing `@` on its own is a request
 * to be shown people — the directory is already in hand, so there is nothing to
 * spend on answering it.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, caret))
  const at = before.lastIndexOf('@')
  if (at < 0 || before.length - at > MAX_QUERY + 1) return null

  const query = before.slice(at + 1)
  if (ENDS_QUERY.test(query)) return null

  // Start of the body counts as a boundary; so does the start of a line, which
  // is the same test because `\n` is whitespace.
  if (at > 0 && !BEFORE_TRIGGER.test(text[at - 1])) return null
  if (insideFence(text, at)) return null

  return { at, query }
}

/** A body with a mention put in, and where the caret goes afterwards. */
export interface MentionInsert {
  readonly text: string
  readonly caret: number
}

/**
 * Replaces the `@…` being typed with the mention ADO stores.
 *
 * Upper case, because that is what ADO writes — 5 of 5 mentions found live — and
 * `identity-contract.ts`' {@link MENTION_TEMPLATE} is the form. Nothing else in
 * the body moves: the text before the `@` and the text from the caret onwards
 * are spliced back on either side unchanged, and the returned caret is the
 * character after the closing `>`.
 *
 * No trailing space. The next thing typed is usually one, and adding it here
 * would mean an insertion that quietly changed a character the person did not
 * type — which is the one thing a composer must never do to a draft.
 */
export function insertMention(
  text: string,
  at: number,
  caret: number,
  identityId: string,
): MentionInsert {
  const mention = `@<${identityId.toUpperCase()}>`

  return {
    text: text.slice(0, at) + mention + text.slice(Math.max(at, caret)),
    caret: at + mention.length,
  }
}
