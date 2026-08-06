import type { DiffHunk, DiffLine, FileDiff } from './diff-contract'

// Two arrays of lines in, hunks out. Pure, synchronous, no I/O, no React.
//
// This is a port of git's xdiff rather than a diff of our own design, and that
// is a decision rather than an accident. The bar for this module is agreement
// with `git diff --unified=3` on real blobs out of this repository's history,
// and only one algorithm clears that bar: a patience or histogram diff will
// disagree with Myers about where a hunk begins even when both answers are
// correct. So the pieces below follow xdiff closely enough that the C reads
// next to them — the linear-space middle-snake of `xdl_split`, the
// divide-and-conquer of `xdl_recs_cmp`, the hunk sliding of
// `xdl_change_compact` including the indent heuristic git has had on by
// default since 2.14, and the hunk grouping of `xdl_get_hunk`.
//
// Two things xdiff does that this does not:
//
//   - the cost cutoffs inside `xdl_split` (`XDL_MAX_COST_MIN`, the snake
//     sampling), which abandon minimality once a single recursion box has cost
//     more than 256 edits. Realistic source files never reach that, and where
//     they would this refuses outright instead — see `MAX_DIFF_STEPS`.
//   - `-b`, and the ` @@ funcname` trailer on a header. `-w` is here — see
//     `DiffOptions.ignoreWhitespace` — and `-b` is not, because one flag
//     answers the re-indent this was wanted for and two is a menu.
//
// `diff.test.ts` measures how often the difference shows, against git itself,
// on this repository's own history.

/** git's `--unified=3`, and the number the row model collapses gaps against. */
export const DIFF_CONTEXT = 3

/**
 * Above this many characters a line is not marked intra-line. A minified
 * bundle on one line has no meaningful character ranges to point at, and the
 * token diff below is quadratic in the worst case — the 10 MB single line in
 * the tests is this guard doing its job.
 */
const MAX_INTRALINE_CHARS = 1000

/**
 * The ceiling on middle-snake work before the whole diff is abandoned.
 *
 * Myers is O(N·D): cheap when the files are similar, and quadratic when they
 * are not. The worst input this was measured on — 5,000 distinct lines shuffled
 * against a different shuffle of themselves, so D is near 2N and nothing is
 * discardable — costs 4.7e7 steps and 0.3 s. This ceiling is ten times that.
 * Hitting it takes about 2.5 s and needs roughly 20,000 shuffled lines; both
 * numbers are on the machine named in `diff.test.ts`.
 *
 * Crossing it sets `gaveUp` and returns no hunks, rather than falling back to a
 * cheaper algorithm, because a worse diff returned silently is the failure this
 * ticket exists to avoid.
 */
const MAX_DIFF_STEPS = 5e8

export interface DiffOptions {
  /** Unchanged lines kept either side of a change. `git diff -U<n>`. */
  readonly context?: number
  /**
   * `git diff -w`. Two lines are the same line when they are the same after
   * every whitespace character comes out of both.
   *
   * Only the interning key changes, which is where git applies it too: every
   * loop under `intern` goes on comparing integers, and the text that comes out
   * is still bytes that are in the file. See `emit` for which file.
   */
  readonly ignoreWhitespace?: boolean
}

const EMPTY: FileDiff = { hunks: [], added: 0, removed: 0, gaveUp: false }

/**
 * The hunks between two sides of one file, as `git diff` would cut them.
 *
 * Identical input returns `EMPTY` after a single equality pass — one walk is
 * the irreducible cost of knowing they are identical, and nothing after it
 * runs: no interning, no allocation, no search.
 */
export function diffFile(
  before: readonly string[],
  after: readonly string[],
  options: DiffOptions = {},
): FileDiff {
  if (identical(before, after)) return EMPTY

  const context = options.context ?? DIFF_CONTEXT
  const ignoreWhitespace = options.ignoreWhitespace === true
  const { a, b } = intern(before, after, ignoreWhitespace ? squeezed : asWritten)

  let changed: { chg1: Uint8Array; chg2: Uint8Array }
  try {
    changed = lineChanges(a, b)
  } catch (error) {
    if (error instanceof TooExpensive) return { hunks: [], added: 0, removed: 0, gaveUp: true }
    throw error
  }

  // Sliding runs on each side in turn, each using the other's runs to decide
  // whether a shift lines two changes up. Order matters and is git's.
  compact(before, a, changed.chg1, changed.chg2)
  compact(after, b, changed.chg2, changed.chg1)

  const changes = buildScript(changed.chg1, changed.chg2)
  const hunks = emit(before, after, changes, context, ignoreWhitespace)

  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === 'add') added++
      else if (line.op === 'delete') removed++
    }
  }

  return { hunks, added, removed, gaveUp: false }
}

/** `@@ -1,7 +1,9 @@`, in git's spelling: a count of 1 is implied, a count of 0 backs the start up one. */
export function formatHunkHeader(hunk: DiffHunk): string {
  return `@@ -${side(hunk.oldStart, hunk.oldCount)} +${side(hunk.newStart, hunk.newCount)} @@`
}

const side = (start: number, count: number): string =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`

function identical(before: readonly string[], after: readonly string[]): boolean {
  if (before === after) return true
  if (before.length !== after.length) return false
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// The search: xdiff's `xdl_recs_cmp` and `xdl_split`.
// ---------------------------------------------------------------------------

interface Interned {
  readonly a: Int32Array
  readonly b: Int32Array
  /** How many times each id occurs on each side. `xdl_classify_record`'s `len1`/`len2`. */
  readonly count1: Int32Array
  readonly count2: Int32Array
}

/** A line is itself: the key when no flag is asking for anything else. */
const asWritten = (line: string): string => line

/**
 * `-w`'s key: the line with every space taken out.
 *
 * The class is C's `isspace`, which is what xdiff's `XDL_ISSPACE` is, and not
 * JavaScript's `\s` — that also matches the Unicode separators. git compares
 * bytes and leaves a non-breaking space alone, so a line that gained one is a
 * line that changed, and `\s` would quietly call it context.
 */
const squeezed = (line: string): string => line.replace(/[ \t\n\v\f\r]+/g, '')

/**
 * Line text to a dense integer, so every inner loop compares numbers instead of
 * strings. `key` is what "the same line" means: two lines with the same key get
 * the same id and every stage below this one treats them as equal.
 */
function intern(
  first: readonly string[],
  second: readonly string[],
  key: (line: string) => string = asWritten,
): Interned {
  const ids = new Map<string, number>()
  const count1: number[] = []
  const count2: number[] = []

  const put = (lines: readonly string[], counts: number[]): Int32Array => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const line = key(lines[i] as string)
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
        count1.push(0)
        count2.push(0)
      }
      out[i] = id
      counts[id]++
    }
    return out
  }

  const a = put(first, count1)
  const b = put(second, count2)
  return { a, b, count1: Int32Array.from(count1), count2: Int32Array.from(count2) }
}

// ---------------------------------------------------------------------------
// Preparation: xdiff's `xdl_trim_ends` and `xdl_cleanup_records`.
//
// Before it searches, git throws lines away. A line with no counterpart at all
// on the other side cannot match anything, so dropping it is free. A line that
// occurs on the other side more often than about sqrt(n) times — a blank line,
// a lone `}` — is dropped too, when it sits inside a run of unmatchable lines.
// That second one is not free: it is why `git diff` sometimes shows a blank
// line as added when nobody touched it. It is also not optional here. Skipping
// it cost seven of eighty-one file pairs in the cross-check, every one of them
// a blank line git called changed and we called context.
// ---------------------------------------------------------------------------

/** A line occurring on the other side this often is a candidate for discarding. */
const MAX_EQLIMIT = 1024
/** How far `cleanMatch` looks either side before giving up on the question. */
const SIMSCAN_WINDOW = 100
/** The run has to be this much more unmatchable than multi-matched to discard. */
const KPDIS_RUN = 4

/** xdiff's shift-based integer square root, approximate on purpose and copied for its exact answers. */
function bogosqrt(n: number): number {
  let i = 1
  for (; n > 0; n >>= 2) i <<= 1
  return i
}

function lineChanges(a: Int32Array, b: Int32Array): { chg1: Uint8Array; chg2: Uint8Array } {
  const chg1 = new Uint8Array(a.length)
  const chg2 = new Uint8Array(b.length)

  // Common prefix and suffix are not searched and not classified.
  const shortest = Math.min(a.length, b.length)
  let start = 0
  while (start < shortest && a[start] === b[start]) start++
  let tail = 0
  while (tail < shortest - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const end1 = a.length - tail - 1
  const end2 = b.length - tail - 1

  const counts = countClasses(a, b)
  const keep1 = discardable(a, counts.inB, start, end1, bogosqrt(a.length), chg1)
  const keep2 = discardable(b, counts.inA, start, end2, bogosqrt(b.length), chg2)

  const reduced = myers(pick(a, keep1), pick(b, keep2))
  for (let i = 0; i < keep1.length; i++) if (reduced.chg1[i]) chg1[keep1[i] as number] = 1
  for (let i = 0; i < keep2.length; i++) if (reduced.chg2[i]) chg2[keep2[i] as number] = 1

  return { chg1, chg2 }
}

function countClasses(a: Int32Array, b: Int32Array): { inA: Int32Array; inB: Int32Array } {
  let classes = 0
  for (const id of a) if (id + 1 > classes) classes = id + 1
  for (const id of b) if (id + 1 > classes) classes = id + 1
  const inA = new Int32Array(classes)
  const inB = new Int32Array(classes)
  for (const id of a) inA[id]++
  for (const id of b) inB[id]++
  return { inA, inB }
}

/**
 * The indices of one side that the search will actually look at. Everything
 * else between `start` and `end` is marked changed on the way past, which is
 * sound for a line with no counterpart and a judgement call for the rest.
 */
function discardable(
  ids: Int32Array,
  onOther: Int32Array,
  start: number,
  end: number,
  limit: number,
  chg: Uint8Array,
): number[] {
  const mlim = Math.min(limit, MAX_EQLIMIT)

  // 0 no counterpart, 1 a few, 2 more than the limit.
  const dis = new Uint8Array(ids.length)
  for (let i = start; i <= end; i++) {
    const nm = onOther[ids[i] as number] as number
    dis[i] = nm === 0 ? 0 : nm >= mlim ? 2 : 1
  }

  const keep: number[] = []
  for (let i = start; i <= end; i++) {
    if (dis[i] === 1 || (dis[i] === 2 && !cleanMatch(dis, i, start, end))) keep.push(i)
    else chg[i] = 1
  }
  return keep
}

/**
 * Whether a line that matches too often should be discarded. Only when it sits
 * between runs that are mostly unmatchable: a common line surrounded by common
 * lines is holding a real alignment together, and a common line adrift in a
 * rewritten block is noise the search would waste its time on.
 */
function cleanMatch(dis: Uint8Array, i: number, start: number, end: number): boolean {
  if (i - start > SIMSCAN_WINDOW) start = i - SIMSCAN_WINDOW
  if (end - i > SIMSCAN_WINDOW) end = i + SIMSCAN_WINDOW

  let unmatchedBefore = 0
  let multiBefore = 1
  for (let r = 1; i - r >= start; r++) {
    if (!dis[i - r]) unmatchedBefore++
    else if (dis[i - r] === 2) multiBefore++
    else break
  }
  if (unmatchedBefore === 0) return false

  // Both runs count the line itself, so it is weighed twice in the ratio below.
  // That is what xdiff does — `rpdis0` and `rpdis1` are both seeded to 1 — and
  // the doubling is load-bearing: without it a lone blank line between two runs
  // of rewritten lines gets discarded and shows up as changed when it is not.
  let unmatchedAfter = 0
  let multiAfter = 1
  for (let r = 1; i + r <= end; r++) {
    if (!dis[i + r]) unmatchedAfter++
    else if (dis[i + r] === 2) multiAfter++
    else break
  }
  if (unmatchedAfter === 0) return false

  const unmatched = unmatchedBefore + unmatchedAfter
  const multi = multiBefore + multiAfter
  return multi * KPDIS_RUN < multi + unmatched
}

function pick(ids: Int32Array, keep: readonly number[]): Int32Array {
  const out = new Int32Array(keep.length)
  for (let i = 0; i < keep.length; i++) out[i] = ids[keep[i] as number] as number
  return out
}

class TooExpensive extends Error {}

/** xdiff's `XDL_LINE_MAX` sentinel for the backward path. */
const LINE_MAX = 0x7fffffff

interface Budget {
  steps: number
}

function myers(a: Int32Array, b: Int32Array): { chg1: Uint8Array; chg2: Uint8Array } {
  const chg1 = new Uint8Array(a.length)
  const chg2 = new Uint8Array(b.length)
  // One diagonal per k in [-(n2+1), n1+1], which is what `xdl_do_diff`
  // allocates; `off` recentres k=0 so the array index is never negative.
  const off = b.length + 1
  const kvdf = new Int32Array(a.length + b.length + 3)
  const kvdb = new Int32Array(a.length + b.length + 3)
  const budget: Budget = { steps: MAX_DIFF_STEPS }

  recurse(a, b, 0, a.length, 0, b.length, chg1, chg2, kvdf, kvdb, off, budget)

  return { chg1, chg2 }
}

function recurse(
  a: Int32Array,
  b: Int32Array,
  off1: number,
  lim1: number,
  off2: number,
  lim2: number,
  chg1: Uint8Array,
  chg2: Uint8Array,
  kvdf: Int32Array,
  kvdb: Int32Array,
  off: number,
  budget: Budget,
): void {
  // Shrink the box along both corner diagonals before searching it. This is
  // not only an optimisation: git does it at every level of the recursion, and
  // it is part of which minimal diff comes out.
  while (off1 < lim1 && off2 < lim2 && a[off1] === b[off2]) {
    off1++
    off2++
  }
  while (off1 < lim1 && off2 < lim2 && a[lim1 - 1] === b[lim2 - 1]) {
    lim1--
    lim2--
  }

  if (off1 === lim1) {
    for (let i = off2; i < lim2; i++) chg2[i] = 1
    return
  }
  if (off2 === lim2) {
    for (let i = off1; i < lim1; i++) chg1[i] = 1
    return
  }

  const [i1, i2] = split(a, b, off1, lim1, off2, lim2, kvdf, kvdb, off, budget)
  recurse(a, b, off1, i1, off2, i2, chg1, chg2, kvdf, kvdb, off, budget)
  recurse(a, b, i1, lim1, i2, lim2, chg1, chg2, kvdf, kvdb, off, budget)
}

/**
 * The middle snake: run the forward and backward D-paths one edit cost at a
 * time until they overlap, and return where. Linear in space, which is the
 * whole point — the 5,000-line pathological case would want a 25-million-cell
 * table otherwise.
 */
function split(
  a: Int32Array,
  b: Int32Array,
  off1: number,
  lim1: number,
  off2: number,
  lim2: number,
  kvdf: Int32Array,
  kvdb: Int32Array,
  off: number,
  budget: Budget,
): [number, number] {
  const dmin = off1 - lim2
  const dmax = lim1 - off2
  const fmid = off1 - off2
  const bmid = lim1 - lim2
  const odd = ((fmid - bmid) & 1) !== 0
  let fmin = fmid
  let fmax = fmid
  let bmin = bmid
  let bmax = bmid

  kvdf[off + fmid] = off1
  kvdb[off + bmid] = lim1

  for (;;) {
    // Widen the diagonal band by one on each side, sentinelling the diagonal
    // just outside it so the core loop needs no bounds test.
    if (fmin > dmin) kvdf[off + --fmin - 1] = -1
    else fmin++
    if (fmax < dmax) kvdf[off + ++fmax + 1] = -1
    else fmax--

    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvdf[off + d - 1] >= kvdf[off + d + 1] ? kvdf[off + d - 1] + 1 : kvdf[off + d + 1]
      let i2 = i1 - d
      const from = i1
      while (i1 < lim1 && i2 < lim2 && a[i1] === b[i2]) {
        i1++
        i2++
      }
      budget.steps -= i1 - from + 1
      kvdf[off + d] = i1
      if (odd && bmin <= d && d <= bmax && kvdb[off + d] <= i1) return [i1, i2]
    }

    if (bmin > dmin) kvdb[off + --bmin - 1] = LINE_MAX
    else bmin++
    if (bmax < dmax) kvdb[off + ++bmax + 1] = LINE_MAX
    else bmax--

    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvdb[off + d - 1] < kvdb[off + d + 1] ? kvdb[off + d - 1] : kvdb[off + d + 1] - 1
      let i2 = i1 - d
      const from = i1
      while (i1 > off1 && i2 > off2 && a[i1 - 1] === b[i2 - 1]) {
        i1--
        i2--
      }
      budget.steps -= from - i1 + 1
      kvdb[off + d] = i1
      if (!odd && fmin <= d && d <= fmax && i1 <= kvdf[off + d]) return [i1, i2]
    }

    if (budget.steps < 0) throw new TooExpensive()
  }
}

// ---------------------------------------------------------------------------
// Sliding: xdiff's `xdl_change_compact`.
//
// Myers picks one minimal edit script; usually several are minimal and they
// differ only in where a run of changed lines sits among identical
// neighbours. This is what makes a diff read as "a function was added" rather
// than "a closing brace and half of two functions were added". Without it the
// hunks are still correct and still disagree with git on roughly a third of
// real files.
// ---------------------------------------------------------------------------

/** How far xdiff will let the indent heuristic slide one group. */
const INDENT_HEURISTIC_MAX_SLIDING = 100

interface Group {
  start: number
  end: number
}

function groupInit(chg: Uint8Array): Group {
  const g: Group = { start: 0, end: 0 }
  while (g.end < chg.length && chg[g.end]) g.end++
  return g
}

function groupNext(chg: Uint8Array, g: Group): boolean {
  if (g.end === chg.length) return false
  g.start = g.end + 1
  for (g.end = g.start; g.end < chg.length && chg[g.end]; g.end++);
  return true
}

function groupPrevious(chg: Uint8Array, g: Group): boolean {
  if (g.start === 0) return false
  g.end = g.start - 1
  for (g.start = g.end; g.start > 0 && chg[g.start - 1]; g.start--);
  return true
}

/** Slide one line later, absorbing any group it bumps into. */
function slideDown(ids: Int32Array, chg: Uint8Array, g: Group): boolean {
  if (g.end >= chg.length || ids[g.start] !== ids[g.end]) return false
  chg[g.start++] = 0
  chg[g.end++] = 1
  while (g.end < chg.length && chg[g.end]) g.end++
  return true
}

/** Slide one line earlier, absorbing any group it bumps into. */
function slideUp(ids: Int32Array, chg: Uint8Array, g: Group): boolean {
  if (g.start === 0 || ids[g.start - 1] !== ids[g.end - 1]) return false
  chg[--g.start] = 1
  chg[--g.end] = 0
  while (g.start > 0 && chg[g.start - 1]) g.start--
  return true
}

function compact(lines: readonly string[], ids: Int32Array, chg: Uint8Array, other: Uint8Array): void {
  const indents = indentsOf(lines)
  const g = groupInit(chg)
  const go = groupInit(other)

  for (;;) {
    if (g.end !== g.start) {
      let size = 0
      let earliestEnd = 0
      let endMatchingOther = -1

      // Slide as far up as it goes, then as far down; absorbing a neighbour
      // changes the size, so repeat until it stops growing.
      do {
        size = g.end - g.start
        endMatchingOther = -1

        while (slideUp(ids, chg, g)) groupPrevious(other, go)
        earliestEnd = g.end
        if (go.end > go.start) endMatchingOther = g.end

        while (slideDown(ids, chg, g)) {
          groupNext(other, go)
          if (go.end > go.start) endMatchingOther = g.end
        }
      } while (size !== g.end - g.start)

      if (g.end === earliestEnd) {
        // Pinned. Nothing to choose between.
      } else if (endMatchingOther !== -1) {
        // Line up with the last group of changes on the other side that this
        // one can reach: one hunk of "these lines became those lines" beats a
        // delete and an add that the reader has to pair up by eye.
        while (go.end === go.start) {
          slideUp(ids, chg, g)
          groupPrevious(other, go)
        }
      } else {
        // A pure add or delete, free to sit anywhere in a run of identical
        // lines. Score every position it could take and pick the one that
        // splits the file where a human would: at a blank line, at the start
        // of a block rather than after its opening brace.
        let shift = Math.max(
          earliestEnd,
          g.end - size - 1,
          g.end - INDENT_HEURISTIC_MAX_SLIDING,
        )
        let bestShift = -1
        let bestIndent = 0
        let bestPenalty = 0

        for (; shift <= g.end; shift++) {
          const score: Score = { effectiveIndent: 0, penalty: 0 }
          scoreSplit(indents, shift, score)
          scoreSplit(indents, shift - size, score)
          if (bestShift === -1 || compareScores(score, bestIndent, bestPenalty) <= 0) {
            bestIndent = score.effectiveIndent
            bestPenalty = score.penalty
            bestShift = shift
          }
        }

        while (g.end > bestShift) {
          slideUp(ids, chg, g)
          groupPrevious(other, go)
        }
      }
    }

    if (!groupNext(chg, g)) break
    groupNext(other, go)
  }
}

// The weights below are xdiff's, unchanged and unexplained there too: they
// were fitted against real diffs, not derived. Copying them is the only way to
// land on the same split git lands on.
const MAX_INDENT = 200
const MAX_BLANKS = 20
const START_OF_FILE_PENALTY = 1
const END_OF_FILE_PENALTY = 21
const TOTAL_BLANK_WEIGHT = -30
const POST_BLANK_WEIGHT = 6
const RELATIVE_INDENT_PENALTY = -4
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10
const RELATIVE_OUTDENT_PENALTY = 24
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17
const RELATIVE_DEDENT_PENALTY = 23
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17
const INDENT_WEIGHT = 60

/**
 * Indentation in columns, tabs counting to the next multiple of eight, and -1
 * for a line that is blank or nothing but whitespace. Memoised because the
 * scoring asks for the same line up to `MAX_BLANKS` times per candidate split.
 */
interface Indents {
  readonly length: number
  at(i: number): number
}

const UNCOMPUTED = -2

function indentsOf(lines: readonly string[]): Indents {
  const cache = new Int32Array(lines.length).fill(UNCOMPUTED)
  return {
    length: lines.length,
    at(i) {
      const cached = cache[i]
      if (cached !== UNCOMPUTED) return cached
      const computed = indentOf(lines[i] as string)
      cache[i] = computed
      return computed
    },
  }
}

function indentOf(line: string): number {
  let indent = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === ' ') indent += 1
    else if (c === '\t') indent += 8 - (indent % 8)
    else if (c !== '\n' && c !== '\v' && c !== '\f' && c !== '\r') return indent
    if (indent >= MAX_INDENT) return MAX_INDENT
  }
  return -1
}

interface Score {
  effectiveIndent: number
  penalty: number
}

function scoreSplit(indents: Indents, at: number, score: Score): void {
  const endOfFile = at >= indents.length
  const indentHere = endOfFile ? -1 : indents.at(at)

  let preBlank = 0
  let preIndent = -1
  for (let i = at - 1; i >= 0; i--) {
    preIndent = indents.at(i)
    if (preIndent !== -1) break
    preBlank++
    if (preBlank === MAX_BLANKS) {
      preIndent = 0
      break
    }
  }

  let postBlank = 0
  let postIndent = -1
  for (let i = at + 1; i < indents.length; i++) {
    postIndent = indents.at(i)
    if (postIndent !== -1) break
    postBlank++
    if (postBlank === MAX_BLANKS) {
      postIndent = 0
      break
    }
  }

  if (preIndent === -1 && preBlank === 0) score.penalty += START_OF_FILE_PENALTY
  if (endOfFile) score.penalty += END_OF_FILE_PENALTY

  const blanksAfter = indentHere === -1 ? 1 + postBlank : 0
  const blanks = preBlank + blanksAfter
  score.penalty += TOTAL_BLANK_WEIGHT * blanks
  score.penalty += POST_BLANK_WEIGHT * blanksAfter

  const indent = indentHere !== -1 ? indentHere : postIndent
  score.effectiveIndent += indent

  if (indent === -1 || preIndent === -1 || indent === preIndent) return

  if (indent > preIndent) {
    score.penalty += blanks !== 0 ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY
  } else if (postIndent !== -1 && postIndent > indent) {
    // Indented less than what came before but more than what comes after is
    // most likely the head of a new block, not the tail of the old one.
    score.penalty += blanks !== 0 ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY
  } else {
    score.penalty += blanks !== 0 ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY
  }
}

/** Only the sign of the indent difference counts, weighted against the penalty. */
function compareScores(score: Score, indent: number, penalty: number): number {
  const cmp = (score.effectiveIndent > indent ? 1 : 0) - (score.effectiveIndent < indent ? 1 : 0)
  return INDENT_WEIGHT * cmp + (score.penalty - penalty)
}

// ---------------------------------------------------------------------------
// Emission: xdiff's `xdl_build_script`, `xdl_get_hunk` and `xdl_emit_diff`.
// ---------------------------------------------------------------------------

interface Change {
  i1: number
  chg1: number
  i2: number
  chg2: number
}

/**
 * The two changed-line bitmaps into paired runs. They stay in step because the
 * unchanged lines are the same lines in the same order on both sides — that is
 * what the diff established.
 */
function buildScript(chg1: Uint8Array, chg2: Uint8Array): Change[] {
  const changes: Change[] = []
  let i1 = 0
  let i2 = 0

  while (i1 < chg1.length || i2 < chg2.length) {
    if ((i1 < chg1.length && chg1[i1]) || (i2 < chg2.length && chg2[i2])) {
      const s1 = i1
      const s2 = i2
      while (i1 < chg1.length && chg1[i1]) i1++
      while (i2 < chg2.length && chg2[i2]) i2++
      changes.push({ i1: s1, chg1: i1 - s1, i2: s2, chg2: i2 - s2 })
    } else {
      i1++
      i2++
    }
  }

  return changes
}

/** A mutable `DiffLine` — `edits` is filled in after the hunk is built. */
interface Line {
  op: DiffLine['op']
  text: string
  oldLine: number | null
  newLine: number | null
  edits: [number, number][]
}

function emit(
  before: readonly string[],
  after: readonly string[],
  changes: readonly Change[],
  context: number,
  ignoreWhitespace: boolean,
): DiffHunk[] {
  // Two changes closer together than twice the context would print overlapping
  // context, so they become one hunk instead. Exactly `2 * context` apart is
  // the boundary case where the two hunks would abut without overlapping, and
  // git merges that one too.
  const maxCommon = 2 * context
  const hunks: DiffHunk[] = []

  for (let first = 0; first < changes.length; ) {
    let last = first
    while (last + 1 < changes.length) {
      const prev = changes[last] as Change
      const next = changes[last + 1] as Change
      if (next.i1 - (prev.i1 + prev.chg1) > maxCommon) break
      last++
    }

    const head = changes[first] as Change
    const tail = changes[last] as Change
    const s1 = Math.max(head.i1 - context, 0)
    const s2 = Math.max(head.i2 - context, 0)
    const e1 = Math.min(tail.i1 + tail.chg1 + context, before.length)
    const e2 = Math.min(tail.i2 + tail.chg2 + context, after.length)

    const lines: Line[] = []
    let p1 = s1
    let p2 = s2

    // Context is drawn from `after`, not from `before`. With no flag the two
    // hold the same bytes on a context line and the choice is invisible; under
    // `-w` they differ on exactly the lines the flag turned into context, and
    // git prints the after side there — measured against `git diff -w`, not
    // reasoned out. It is also the side `buildRows` reads when it expands a
    // collapsed gap, so a revealed line and a printed one say the same thing.
    for (let c = first; c <= last; c++) {
      const change = changes[c] as Change
      for (; p1 < change.i1; p1++, p2++) {
        lines.push({ op: 'context', text: after[p2] as string, oldLine: p1 + 1, newLine: p2 + 1, edits: [] })
      }
      for (let i = 0; i < change.chg1; i++) {
        const at = change.i1 + i
        lines.push({ op: 'delete', text: before[at] as string, oldLine: at + 1, newLine: null, edits: [] })
      }
      for (let i = 0; i < change.chg2; i++) {
        const at = change.i2 + i
        lines.push({ op: 'add', text: after[at] as string, oldLine: null, newLine: at + 1, edits: [] })
      }
      p1 = change.i1 + change.chg1
      p2 = change.i2 + change.chg2
    }

    for (; p1 < e1; p1++, p2++) {
      lines.push({ op: 'context', text: after[p2] as string, oldLine: p1 + 1, newLine: p2 + 1, edits: [] })
    }

    markIntraLine(lines, ignoreWhitespace)

    hunks.push({ oldStart: s1 + 1, oldCount: e1 - s1, newStart: s2 + 1, newCount: e2 - s2, lines })
    first = last + 1
  }

  return hunks
}

// ---------------------------------------------------------------------------
// Intra-line marking.
//
// Nothing here comes from git — `git diff` has no character ranges in its
// default output. The pairing rule is positional and is deliberately the same
// rule the split layout uses to put a delete beside an add, so the marks in
// the two halves of a side-by-side row always refer to each other.
// ---------------------------------------------------------------------------

function markIntraLine(lines: readonly Line[], ignoreWhitespace: boolean): void {
  for (let i = 0; i < lines.length; ) {
    if ((lines[i] as Line).op !== 'delete') {
      i++
      continue
    }
    const deleteStart = i
    while (i < lines.length && (lines[i] as Line).op === 'delete') i++
    const addStart = i
    while (i < lines.length && (lines[i] as Line).op === 'add') i++

    const pairs = Math.min(addStart - deleteStart, i - addStart)
    for (let p = 0; p < pairs; p++) {
      markPair(lines[deleteStart + p] as Line, lines[addStart + p] as Line, ignoreWhitespace)
    }
  }
}

function markPair(removed: Line, added: Line, ignoreWhitespace: boolean): void {
  if (removed.text.length > MAX_INTRALINE_CHARS || added.text.length > MAX_INTRALINE_CHARS) return

  const left = tokenize(removed.text)
  const right = tokenize(added.text)
  const tokens = intern(left.texts, right.texts)
  const { chg1, chg2 } = myers(tokens.a, tokens.b)

  // Under `-w` the marks stop pointing at whitespace. This pair is a real
  // change or it would not be here, but a re-indented line still has a changed
  // indent token, and highlighting it is the flag handing back the thing the
  // reader turned it on to stop seeing. Only the marking is dropped; the bytes
  // are drawn as they are.
  if (ignoreWhitespace) {
    unmarkWhitespace(left.texts, chg1)
    unmarkWhitespace(right.texts, chg2)
  }

  // Two lines whose only common ground is whitespace have nothing to point at,
  // and neither does a pair with no common tokens at all: marking every
  // character is the same as marking none, and says less.
  if (!sharesSubstance(left.texts, chg1) || !sharesSubstance(right.texts, chg2)) return

  removed.edits = ranges(left, chg1)
  added.edits = ranges(right, chg2)
}

interface Tokens {
  readonly texts: string[]
  readonly starts: number[]
}

/** Words, runs of whitespace, and single punctuation characters. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

function tokenize(text: string): Tokens {
  const texts: string[] = []
  const starts: number[] = []
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    texts.push(m[0])
    starts.push(m.index)
  }
  return { texts, starts }
}

/** Clears the change bit on tokens the flag says are not there. */
function unmarkWhitespace(texts: readonly string[], chg: Uint8Array): void {
  for (let i = 0; i < texts.length; i++) {
    // `squeezed` and not `trim`, so one definition of whitespace decides both
    // what counts as a changed line and what counts as a changed word.
    if (chg[i] && squeezed(texts[i] as string) === '') chg[i] = 0
  }
}

function sharesSubstance(texts: readonly string[], chg: Uint8Array): boolean {
  for (let i = 0; i < texts.length; i++) {
    if (!chg[i] && (texts[i] as string).trim() !== '') return true
  }
  return false
}

function ranges(tokens: Tokens, chg: Uint8Array): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < tokens.texts.length; i++) {
    if (!chg[i]) continue
    const start = tokens.starts[i] as number
    let end = start + (tokens.texts[i] as string).length
    while (i + 1 < tokens.texts.length && chg[i + 1]) {
      i++
      end = (tokens.starts[i] as number) + (tokens.texts[i] as string).length
    }
    out.push([start, end])
  }
  return out
}
