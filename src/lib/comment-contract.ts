// The shape of a conversation, agreed once.
//
// Round 4 is built by four workstreams at the same time — the server layer that
// reads and writes threads, the row model that puts them in the diff, the Sonar
// client, and the Sonar panel — and this file plus `sonar-contract.ts` is the
// whole of what they share. Nothing here has behaviour. A type is cheap to agree
// on and expensive to discover you disagreed about.
//
// Every field is present because a live thread had it. The census behind this
// file is `docs/research/comments-sonar-inventory.md`: 56 threads and 59
// comments across four real pull requests. Where the census says a field was
// absent on some of them, the type says `null` or optional, and the absence is
// explained rather than defended against silently.

// ---------------------------------------------------------------------------
// Thread status.
// ---------------------------------------------------------------------------

/**
 * The seven states Azure DevOps documents, and no eighth.
 *
 * `unknown` is one of them — it is what ADO itself sends, not a parse failure —
 * and `status` is **absent entirely** on 32 of 56 sampled threads, so the field
 * is nullable everywhere it appears below. Every absence was a
 * `commentType: 'system'` thread: ADO's own activity trail has no status
 * because nothing about it is open or done.
 */
export type ThreadStatus =
  | 'unknown'
  | 'active'
  | 'fixed'
  | 'wontFix'
  | 'closed'
  | 'byDesign'
  | 'pending'

/**
 * The three a reviewer can set from this app, out of the seven readable above.
 *
 * Deliberately smaller than the API's range. `byDesign` and `closed` carry
 * meanings we would be guessing at on someone else's pull request, and
 * `unknown` is not a state anyone means to choose. Reading all seven and
 * writing three is the asymmetry the map asks for.
 */
export type SettableThreadStatus = 'fixed' | 'wontFix' | 'pending'

/**
 * Open or done — the only distinction the diff renders.
 *
 * `active` and `pending` are open: one is a live conversation, the other is a
 * question waiting on someone. Everything else is done and collapses to a stub
 * that keeps its line anchor. A thread with no status at all is done too, which
 * is right for the system threads that make up the majority of them.
 */
export type ThreadResolution = 'open' | 'done'

// ---------------------------------------------------------------------------
// People.
// ---------------------------------------------------------------------------

/**
 * Whoever wrote a comment.
 *
 * `id` is the GUID identity, and it is the field that decides whether a thread
 * is a person's or a robot's — see `SonarAuthorship` in `sonar-contract.ts`.
 * `imageUrl` points back at ADO, and T-030 measured that on a comment author it
 * is the `MemberAvatars/{descriptor}` form on **42 of 42** — the form that
 * answers 200 with no auth header at all, so the browser loads it unaided and no
 * proxy was needed. It is still only a *candidate*: the same field on a reviewer
 * and on a PR author is the redirecting `identityImage` form, so the renderer
 * checks the URL rather than the field. `avatar.tsx` owns that check.
 */
export interface CommentAuthor {
  readonly id: string
  readonly displayName: string
  readonly uniqueName: string | null
  readonly imageUrl: string | null
}

// ---------------------------------------------------------------------------
// Comments.
// ---------------------------------------------------------------------------

/** What ADO calls a comment; only two of the four kinds are a person talking. */
export type CommentType = 'text' | 'codeChange' | 'system' | 'unknown'

export interface Comment {
  readonly id: number
  readonly parentCommentId: number | null
  readonly author: CommentAuthor
  /**
   * The markdown body — **`null` when the comment was deleted.**
   *
   * ADO soft-deletes: 7 of 59 sampled comments had `isDeleted: true` and no
   * `content` key at all. A deleted comment is a hole in the middle of a
   * conversation that still has replies under it, so it renders as a tombstone
   * rather than disappearing and orphaning them.
   */
  readonly content: string | null
  readonly publishedDate: string
  readonly lastUpdatedDate: string | null
  /** Absent from the API when the comment has never been edited; the two dates differ when it has. */
  readonly lastContentUpdatedDate: string | null
  readonly isDeleted: boolean
  readonly commentType: CommentType
  /**
   * Identities who liked this comment.
   *
   * Present on 59 of 59 sampled comments and **non-empty on none of them**, so
   * every rendering decision here is unexercised by real data. Read-only on
   * purpose: `POST .../likes` has never been authorised against a real
   * colleague's comment, and an unproven write is not worth a heart icon.
   */
  readonly likedBy: readonly CommentAuthor[]
  /**
   * Display names for the `@<GUID>` mentions in `content`, keyed by lower-cased
   * GUID.
   *
   * ADO puts the id in the body and the name nowhere, so a body rendered as it
   * arrives shows a reviewer a GUID. Resolved on the server, where the identity
   * call can be made and cached, and carried **on the comment** rather than on
   * the `ThreadList`: every renderer that has a comment already has the names,
   * where a list-level map would have to be threaded through `pr-detail` →
   * `FileDiffPanel` → `DiffView` → `ThreadCard` → `CommentView` → `Markdown` to
   * arrive at the one place that needs it.
   *
   * `content` itself is left exactly as ADO stored it. Rewriting the body would
   * put a display name into the edit composer, and saving that would post a
   * comment that had lost its mention.
   *
   * Empty when the body mentions nobody, and missing any id the lookup could not
   * answer for — an unresolved mention renders as ADO wrote it.
   */
  readonly mentions: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Where a thread points.
// ---------------------------------------------------------------------------

/**
 * A position in a file. ADO sends `offset` alongside `line`, and it is **not
 * always 1** — a thread can start mid-line — but the diff anchors by line, so
 * the column is carried and unused rather than dropped and missed later.
 */
export interface FilePosition {
  readonly line: number
  readonly offset: number
}

/**
 * The file and lines a thread hangs on, or `null` for a thread that hangs on
 * the pull request itself.
 *
 * **`threadContext` was `null` on 44 of 56 sampled threads.** Most of what
 * `threads` returns is not anchored anywhere: it is the activity trail plus
 * top-level discussion. Of the 12 that were anchored, **all 12 were right-side
 * only** — `leftFileStart`/`leftFileEnd` never appeared once — but the left
 * fields are typed because a comment on a deleted line is a thing ADO supports
 * and this sample simply did not contain one.
 *
 * `filePath` always arrived with a leading slash (`/src/foo.ts`). The changed
 * file list uses the same form, so they compare directly; nothing should
 * normalise one side only.
 */
export interface ThreadContext {
  readonly filePath: string
  readonly rightStart: FilePosition | null
  readonly rightEnd: FilePosition | null
  readonly leftStart: FilePosition | null
  readonly leftEnd: FilePosition | null
}

/**
 * Which two iterations the thread was written against.
 *
 * Present on all 12 anchored threads. This is what makes a line number mean
 * something: a comment on line 40 of iteration 2 is not a comment on line 40 of
 * iteration 5. `changeTrackingId` is ADO's own way of following a line across
 * iterations and it appeared on only 5 of 12, so it is a hint, not a mechanism.
 */
export interface IterationContext {
  readonly firstComparingIteration: number
  readonly secondComparingIteration: number
  readonly changeTrackingId: number | null
}

// ---------------------------------------------------------------------------
// Threads.
// ---------------------------------------------------------------------------

/**
 * One conversation.
 *
 * The `kind` field is this contract's own, not ADO's, and it is the load-bearing
 * simplification of the whole round: 32 of 56 threads are ADO's activity trail
 * (`'system'`), some are Sonar's robot (`'bot'`), and the rest are people
 * (`'human'`). Classify once, on the server, where the Sonar author identity is
 * known — the diff should never have to ask why a thread exists.
 */
export interface Thread {
  readonly id: number
  readonly status: ThreadStatus | null
  /** Derived from `status`, so the row model never re-implements the open/done rule. */
  readonly resolution: ThreadResolution
  readonly kind: ThreadKind
  readonly publishedDate: string
  readonly lastUpdatedDate: string | null
  readonly isDeleted: boolean
  readonly context: ThreadContext | null
  readonly iterationContext: IterationContext | null
  /** Chronological. Only 3 of 56 sampled threads had more than one. */
  readonly comments: readonly Comment[]
  /**
   * ADO's `properties`, flattened.
   *
   * The raw form is a `{"$type": "System.String", "$value": "…"}` wrapper on
   * every value, present on 56 of 56 threads. Unwrapped to strings here because
   * no consumer wants the wrapper, and typed as strings because
   * `SupportsMarkdown` arrives as a `System.Int32` and pretending otherwise
   * would mean two shapes. Read `CodeReviewThreadType` from here to learn what
   * a system thread is announcing.
   */
  readonly properties: Readonly<Record<string, string>>
}

/**
 * Who is talking.
 *
 * - `human` — a person. The conversation.
 * - `bot` — a robot, identified by author identity, currently only Sonar's.
 *   Kept out of the conversation because the findings panel says it better and
 *   ADO caps these at 50 per PR anyway (note 5).
 * - `system` — ADO narrating itself: votes, pushes, policy results. Never a
 *   conversation, and the majority of what the endpoint returns.
 */
export type ThreadKind = 'human' | 'bot' | 'system'

/** Every thread on a pull request, with the counts a "hide done" toggle needs. */
export interface ThreadList {
  readonly threads: readonly Thread[]
  /** Open human threads. What the tab badge should say. */
  readonly openCount: number
  readonly doneCount: number
  /** Excluded from `threads` entirely, and counted so the exclusion is visible rather than silent. */
  readonly systemCount: number
  readonly botCount: number
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

/**
 * A new thread anchored to a line, or to the pull request when `context` is null.
 *
 * `iterationContext` is not optional in practice even though ADO accepts its
 * absence: without it the comment lands against the latest iteration, which is
 * not necessarily the one the reviewer is looking at.
 */
export interface NewThread {
  readonly content: string
  readonly context: ThreadContext | null
  readonly iterationContext: IterationContext | null
  /** Threads a reviewer opens start `active`; nothing else makes sense. */
  readonly status: Extract<ThreadStatus, 'active'>
}

export interface NewReply {
  readonly threadId: number
  readonly parentCommentId: number
  readonly content: string
}

/**
 * A status change, on its own.
 *
 * Separate from replying on purpose, and this is a decision rather than a
 * shape: the map says replying to a done thread must not silently reactivate
 * it. Two operations means the UI has to ask for reactivation explicitly, and
 * cannot get there by accident.
 */
export interface StatusChange {
  readonly threadId: number
  readonly status: SettableThreadStatus | 'active'
}

export interface CommentEdit {
  readonly threadId: number
  readonly commentId: number
  readonly content: string
}

export interface CommentDelete {
  readonly threadId: number
  readonly commentId: number
}

// ---------------------------------------------------------------------------
// Threads in the diff.
// ---------------------------------------------------------------------------

/**
 * Threads on one file, indexed by the line they hang under.
 *
 * Keyed by right-side line number because every anchored thread in the sample
 * was right-side. A left-side thread has no key here and the row model must
 * fall back to the file's stub list rather than dropping it — losing a comment
 * is worse than showing it in the wrong place.
 */
export interface FileThreads {
  /** Leading-slash path, exactly as both ADO and the change list write it. */
  readonly path: string
  readonly byRightLine: ReadonlyMap<number, readonly Thread[]>
  /**
   * Threads on this file that no visible line could hold: left-side anchors,
   * and anchors past the end of the blob we fetched. Rendered above the diff so
   * they are somewhere rather than nowhere.
   */
  readonly unanchored: readonly Thread[]
}

/**
 * A thread, as a row in the virtualized diff.
 *
 * This is the one row kind whose height is not `ROW_HEIGHT`. `DiffRow` in
 * `diff-contract.ts` is deliberately fixed-height — the comment on `ROW_HEIGHT`
 * explains why measuring every row is what makes a long file stutter — so a
 * thread row is measured and every other row keeps its estimate. The virtualizer
 * supports exactly that: attach `measureElement` to these and nothing else.
 *
 * `key` follows `diff-rows.ts`'s rule that a row's identity never depends on its
 * position, so expanding a gap above a thread does not remount it.
 */
export interface ThreadRow {
  readonly kind: 'thread'
  /** `!<threadId>` — the sigils `@`, `~` and `/` are already taken by the other row kinds. */
  readonly key: string
  readonly threads: readonly Thread[]
  /** The right-side line these hang under, for the gutter and for scroll-to. */
  readonly line: number
}

/**
 * The height a thread row is assumed to be before it has been measured.
 *
 * A guess, and labelled as one. It decides how far the scrollbar lies for the
 * frame between a row entering the overscan window and its first measurement;
 * one comment of two lines plus a header is roughly this. Wrong in the safe
 * direction — too small means the correction shortens the document, which is
 * less visible than a jump the other way.
 */
export const THREAD_ROW_ESTIMATE = 120

/**
 * A draft, under the line it is going to be about. T-037, and the second and
 * last addition `DiffRow` takes.
 *
 * It is a **row** rather than local state beside the row model because the rows
 * are virtualized: a composer the virtualizer does not know about has nowhere to
 * be placed. And it lives on `RowModel` rather than in a `useState` next to it
 * because the rows are rebuilt from their inputs on every thirty-second poll —
 * anything not an input to that rebuild is erased by the next tick, draft and
 * all.
 *
 * `context` is carried whole rather than reduced to a line so that the one thing
 * that distinguishes this from the file-level composer — the anchor — is decided
 * once, by the caller that knows the file's path, and read back unchanged when
 * the thread is posted.
 */
export interface ComposerRow {
  readonly kind: 'composer'
  /** `+<line>` — `@`, `~`, `/` and `!` are taken by the other four row kinds. */
  readonly key: string
  /** Right-side and one-based, and never `null` on `rightStart`: see `setComposer`. */
  readonly context: ThreadContext
  /** The right-side line the draft hangs under, for its label and its gutter. */
  readonly line: number
}

/**
 * The height a composer row is assumed to be before it has been measured.
 *
 * Read off `Composer`'s own minimums rather than guessed at from a thread:
 * `min-h-20` of textarea, a toolbar and a footer of about 28px each, 3px of pen,
 * and the row's own `py-1`. Too small in the same safe direction
 * `THREAD_ROW_ESTIMATE` is, and only ever wrong for the one frame before the
 * textarea — which is `resize-y` and `field-sizing-content`, so it has no
 * predictable height at all — reports what it actually is.
 */
export const COMPOSER_ROW_ESTIMATE = 160
