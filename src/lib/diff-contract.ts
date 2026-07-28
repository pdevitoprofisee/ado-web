// The types phase 3 is built around, in one place because four otherwise
// independent pieces meet here: the blob layer that fetches (T-016), the diff
// that computes (T-017), the row model that flattens (T-018), and the view that
// renders (T-020). No logic lives in this file — only the shape they agree on.
//
// Every judgement encoded below came from a live measurement in T-015; where it
// did not, the comment says so.

/**
 * One side of one file.
 *
 * Not `string | null`. A missing side means four genuinely different things to a
 * reader — this file is new, this file is gone, this file is a JPEG, this file
 * is a 40 MB bundle — and collapsing them into an absent string makes the view
 * guess. Each is rendered as itself.
 */
export type BlobSide =
  | {
      readonly kind: 'text'
      /**
       * Split on `\n`, with `\r` retained at line ends when the file used CRLF —
       * the diff compares lines, and a file that mixes endings has a real change
       * on those lines that stripping would hide.
       */
      readonly lines: readonly string[]
      readonly bytes: number
      /** The file's last line has no terminator. `git diff` says so; so do we. */
      readonly noFinalNewline: boolean
    }
  /**
   * Decided from the bytes: a NUL inside the first few KB. Not from the
   * extension, and not from `Content-Type` — T-015 measured that ADO answers
   * `application/octet-stream` for every `$format`, including `text`, so the
   * header carries no signal at all.
   */
  | { readonly kind: 'binary'; readonly bytes: number }
  /**
   * Refused for its size. `bytes` is what was counted.
   *
   * **Corrected in T-016.** This said "refused before the body was read, on
   * `Content-Length`", and that is not achievable here: ADO declares a length
   * only below ~256 KiB and goes `Transfer-Encoding: chunked` above it, with no
   * overlap between the two ranges across 705 live blobs. Every blob big enough
   * to refuse is exactly the one that arrives with no declared size, so the
   * length check has an empty live domain and the count on bytes-in-hand is
   * what actually refuses. Refusing unread would mean aborting the stream from
   * inside `ado-client.ts`.
   */
  | { readonly kind: 'too-large'; readonly bytes: number }
  /** No such side: the before of an add, the after of a delete. */
  | { readonly kind: 'absent' }
  /** ADO refused this specific blob. The rest of the file list is still good. */
  | { readonly kind: 'failed'; readonly message: string }

/** Both sides of one changed file, as the server hands them over. */
export interface FileBlobs {
  /**
   * Where the file is now. One path, not two, so an `edit, rename` cannot say
   * here what it used to be called — the old name is on
   * `ChangedFile.originalPath` and the view reads it from there. Kept as one
   * field deliberately: this type exists to carry bytes, and the file list is
   * already the thing that knows about names.
   */
  readonly path: string
  readonly before: BlobSide
  readonly after: BlobSide
  /**
   * `objectId === originalObjectId`, which live means a **pure rename**: the
   * bytes did not move, only the name did. Zero blobs are fetched, both sides
   * are `absent`, and the view has to say "renamed, unchanged" rather than
   * showing an empty diff that looks like a bug.
   */
  readonly renamedOnly: boolean
}

export type DiffOp = 'context' | 'add' | 'delete'

/**
 * Line numbers are 1-based and nullable on the side that does not have the
 * line, which is the same convention `git diff` prints and the same one the
 * gutter renders.
 */
export interface DiffLine {
  readonly op: DiffOp
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
  /**
   * Character ranges within `text` that differ from the line opposite, so a
   * one-character edit does not read as a whole line replaced. Empty when the
   * line has no counterpart or the change is not worth marking.
   */
  readonly edits: readonly (readonly [start: number, end: number])[]
}

export interface DiffHunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly DiffLine[]
}

export interface FileDiff {
  readonly hunks: readonly DiffHunk[]
  readonly added: number
  readonly removed: number
  /**
   * The diff was abandoned and `hunks` is empty — a file too pathological to
   * diff in reasonable time. A stated surrender, never a silent one.
   */
  readonly gaveUp: boolean
}

/**
 * What the virtualizer measures and renders. A flat, indexable list, because a
 * virtualizer cannot ask a tree how tall it is.
 *
 * `key` is stable across an expansion. Expanding a gap in the middle of a file
 * must not remount every row above the click, and index is not identity.
 */
export type DiffRow =
  | { readonly kind: 'hunk'; readonly key: string; readonly label: string }
  /**
   * Both sides of one rendered line. In unified mode exactly one of `left` and
   * `right` is set on a change and both hold the same line on context; in
   * side-by-side a delete pairs with the add opposite it, and the missing half
   * is `null` — a blank, not a gap.
   */
  | {
      readonly kind: 'line'
      readonly key: string
      readonly left: DiffLine | null
      readonly right: DiffLine | null
    }
  /** A collapsed run of unchanged lines, and what clicking it would reveal. */
  | {
      readonly kind: 'gap'
      readonly key: string
      readonly hiddenLines: number
      readonly oldStart: number
      readonly newStart: number
    }

export type DiffLayout = 'unified' | 'split'

/** One token of highlighted text. Shiki's `ThemedToken`, narrowed to what renders. */
export interface HighlightToken {
  readonly text: string
  readonly color: string
  /** Shiki's `FontStyle` bit flags: 1 italic, 2 bold, 4 underline. */
  readonly fontStyle?: number
}

/**
 * A file's tokens, outer dimension already lines — `codeToTokensBase` returns
 * `ThemedToken[][]` whose first dimension *is* the lines, so no re-splitting.
 */
export type HighlightedLines = readonly (readonly HighlightToken[])[]

export interface Highlighter {
  /**
   * Batched per file, never per line. `path` chooses the grammar; a language
   * that is not bundled resolves to plain text rather than rejecting.
   *
   * Async and non-blocking on purpose: the diff renders before this arrives.
   */
  highlight(path: string, lines: readonly string[]): Promise<HighlightedLines>
  dispose(): void
}
