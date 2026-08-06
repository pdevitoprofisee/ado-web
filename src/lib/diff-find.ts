// Finding a string across a diff, and counting what could not be looked at.
//
// `Ctrl+F` searches the document, and the document holds about 56 rows of each
// open file — the virtualizer's window. So the browser answers "not found" for
// the other three thousand lines of the file you are looking at, confidently and
// wrongly. This searches the *bytes* instead, which the query cache is already
// holding for every file a panel has fetched.
//
// **The bytes are the whole limit, and it is a large one.** A panel fetches when
// it comes near the viewport, so a 294-file pull request you have just opened has
// six files in hand and 288 it has never asked for. Fetching them to search would
// be 576 blob calls for a keystroke. So the search covers what is loaded and
// `findSentence` says out loud how much that is not — a count nobody can check is
// worse than no count, and "3 matches" over a change set that was 95% unread is
// exactly that.

/** One file to look in: its path, and its text if we have it. */
export interface FindTarget {
  readonly path: string
  /**
   * The file as it now stands — the after side, split into lines — or `null`
   * when its bytes have never been fetched.
   *
   * The after side and not both, because a hit has to be somewhere the reader
   * can be *sent*: `jumpToLine` and `rowIndexForLine` both address a row by its
   * right-hand line number, and a removed line has none. Removed lines are still
   * marked where they happen to be on screen — `LineText` marks whatever text it
   * is given — they are just not stops, and `SEARCHES` says so.
   */
  readonly lines: readonly string[] | null
}

/** A line worth stepping to, addressed the way the jump machinery addresses one. */
export interface FindHit {
  readonly path: string
  /** A right-side line number, 1-based, as `ChangedFileDiff.jumpTo` takes it. */
  readonly line: number
}

export interface FindResult {
  /** In file order, then line order — the order the diff is read in. */
  readonly hits: readonly FindHit[]
  /** How many files had text to look through. */
  readonly searched: number
  /** How many did not, which is the number `findSentence` refuses to hide. */
  readonly unsearched: number
}

/**
 * What the search covers, in words, for the label the box carries.
 *
 * The same job `pr-search.ts`' `SEARCHES` does: one string, read by the control,
 * so the page cannot describe behaviour the functions below do not implement.
 */
export const SEARCHES =
  'the current text of every file whose bytes are loaded — not removed lines, and not a file you have not scrolled to yet'

/**
 * Where `term` sits inside `text`, case-insensitively, as character ranges.
 *
 * Ranges rather than a boolean because this feeds `segment`, which cuts a line at
 * every boundary anybody cares about; a match is the third such boundary set,
 * beside the highlighter's tokens and the diff's intra-line edits.
 *
 * Non-overlapping, so `aa` in `aaaa` is two matches and not three — the same
 * answer `String.replaceAll` and every editor gives.
 */
export function matchRanges(
  text: string,
  term: string,
): readonly (readonly [start: number, end: number])[] {
  if (term === '') return []

  // Lower-casing is per-character in almost every alphabet and is not in a few:
  // `İ` lower-cases to two code units, which would shift every offset after it
  // and paint the mark over the wrong characters. When the length moves, fold the
  // comparison back to exact. A missed case-insensitive hit is a worse search; a
  // mark on the wrong characters is a wrong one.
  const folded = text.toLowerCase()
  const lowered = term.toLowerCase()
  const aligned = folded.length === text.length && lowered.length === term.length
  const haystack = aligned ? folded : text
  const needle = aligned ? lowered : term

  const ranges: (readonly [number, number])[] = []
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    ranges.push([at, at + needle.length])
  }

  return ranges
}

/**
 * Every line of every loaded file that contains `term`, and how many files were
 * left out.
 *
 * **A hit is a line, not an occurrence.** Three matches on one line are one stop,
 * because a stop is a `scrollToIndex` and the row is the smallest thing that can
 * be scrolled to. Counting occurrences and stepping through lines would print a
 * total the Next button could never reach.
 *
 * An empty term finds nothing and searches nothing, rather than matching every
 * line — `''.includes('')` is true, and a box that has just been focused should
 * not report five thousand hits.
 */
export function findInDiff(targets: readonly FindTarget[], term: string): FindResult {
  if (term === '') return { hits: [], searched: 0, unsearched: 0 }

  const needle = term.toLowerCase()
  const hits: FindHit[] = []
  let searched = 0

  for (const target of targets) {
    if (target.lines === null) continue
    searched += 1

    for (let at = 0; at < target.lines.length; at += 1) {
      if (target.lines[at].toLowerCase().includes(needle)) {
        hits.push({ path: target.path, line: at + 1 })
      }
    }
  }

  return { hits, searched, unsearched: targets.length - searched }
}

/**
 * The count and the blind spot in one sentence, because they are one fact.
 *
 * The two halves are never shown apart. "12 matching lines" is a number a reader
 * will act on — they will stop looking — and it is only true of the files that
 * were read. Printing the second half beside it is the whole of this ticket's
 * honesty criterion.
 */
export function findSentence(result: FindResult): string {
  const found =
    result.hits.length === 0
      ? 'No matching lines'
      : `${result.hits.length} matching ${result.hits.length === 1 ? 'line' : 'lines'}`

  const total = result.searched + result.unsearched
  const rest =
    result.unsearched === 0
      ? `${total} ${total === 1 ? 'file' : 'files'} searched`
      : `${result.unsearched} of ${total} files not searched`

  return `${found} · ${rest}`
}
