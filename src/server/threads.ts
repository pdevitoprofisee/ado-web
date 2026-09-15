import { mentionedIds, mentionsIn } from '../lib/people'

import type { AdoClient } from './ado-client'
import type { PullRequestRef } from './pull-request'
import type {
  Comment,
  CommentAuthor,
  CommentType,
  FileThreads,
  IterationContext,
  SettableThreadStatus,
  Thread,
  ThreadContext,
  ThreadKind,
  ThreadList,
  ThreadResolution,
  ThreadStatus,
  VoteEvent,
} from '../lib/comment-contract'

// One pull request's conversation, read and written.
//
// **No value may be imported here from anything server-only, and that has to
// stay true.** `fileThreads` below is called by the diff's row model, which runs
// in the browser: one value import from `./ado-client` would drag
// `connection-test.ts` and `@napi-rs/keyring` — a native addon — into the client
// bundle. Everything that needs such a value (the viewer's identity,
// `createServerFn`) lives in `threads-fn.ts` for that reason and no other.
// `viewed.ts` / `viewed-key.ts` is the same split after the same problem. The one
// value import is `../lib/people`, which imports nothing at all and which
// `markdown.tsx` already ships to the browser; everything else is `import type`.
//
// What T-022 measured against the live org, so nothing below re-derives it:
//
//   - **`threads` ignores every parameter.** `$top=1`, `$skip=1`,
//     `$expand=none`, `iteration=1&baseIteration=0`, `7.2-preview.1` and no
//     `api-version` at all each returned the same 9 threads on !24794. So this
//     is one call with no parameters and no paging loop, and a "page size" here
//     would be a knob wired to nothing.
//   - Plain `api-version=7.1` is correct for `threads` and for `statuses`. Only
//     `connectionData` and `policy/evaluations` are preview-only.
//   - `properties` values are `{"$type","$value"}` wrappers on 56 of 56
//     threads, and `SupportsMarkdown` arrives as a `System.Int32` — hence the
//     unwrap to strings that `comment-contract.ts` specifies.
//   - 32 of 56 threads are ADO's activity trail and carry **no `status` key**.
//     A missing status is not "active"; it is a thread that was never a
//     question.
//   - `GET .../threads/{id}` answers with a single thread **not wrapped in
//     `value`**, which is what makes the own-author check below one cheap call.

/** `context.genre` on the status the Sonar pipeline posts. Verbatim, all 8 PRs that had one. */
const SONAR_GENRE = 'SonarCloud'

/** The three states a reviewer can set, plus reopening. Nothing else is writable. */
const SETTABLE: ReadonlySet<string> = new Set<SettableThreadStatus | 'active'>([
  'fixed',
  'wontFix',
  'pending',
  'active',
])

/** ADO's seven, read as themselves. An eighth would be a service change, not a parse failure. */
const KNOWN_STATUS: ReadonlySet<string> = new Set<ThreadStatus>([
  'unknown',
  'active',
  'fixed',
  'wontFix',
  'closed',
  'byDesign',
  'pending',
])

/** The map's rule, in one place: a live conversation, or a question waiting on someone. */
const OPEN: ReadonlySet<string> = new Set<ThreadStatus>(['active', 'pending'])

const KNOWN_COMMENT_TYPE: ReadonlySet<string> = new Set<CommentType>([
  'text',
  'codeChange',
  'system',
  'unknown',
])

const NO_BOTS: ReadonlySet<string> = new Set<string>()

/**
 * No mentions resolved, which is what a parse with nothing looked up gets.
 *
 * The default for `toThreadList` — `fileThreads`' callers and the tests parse
 * without a client — and what the writes below pass: a POST or a PATCH echoes back
 * the text that was just submitted, and there is nobody to resolve it against
 * without a second call for a body the poll is about to re-read anyway.
 */
const NO_NAMES: ReadonlyMap<string, string> = new Map<string, string>()

/**
 * How many mentioned GUIDs go into one `identityIds` query string. The same 100
 * `inbox.ts` chunks descriptors at — a limit nobody has hit, chunked anyway
 * rather than discovered as a 400 on the one PR with a long thread.
 */
const IDENTITY_CHUNK = 100

/**
 * Mentioned GUID → display name, per client, for the life of the process.
 *
 * The conversation is polled about every 30 seconds, and the names in it do not
 * change; asking `identities` again on every poll would triple this tab's call
 * budget to re-learn the same three names. Keyed on the client so a different
 * credential never reads a name resolved under someone else's, and weak so a
 * retired client takes its cache with it.
 *
 * An id that resolved to nothing is remembered as `''` — asked and unanswered —
 * so a mention of a deleted identity costs one call rather than one per poll. A
 * *failed* call caches nothing, because a 503 is not an answer.
 */
const NAME_CACHE = new WeakMap<AdoClient, Map<string, string>>()

interface AdoIdentity {
  readonly id?: string
  readonly displayName?: string
  readonly uniqueName?: string
  readonly imageUrl?: string
}

/** `{"$type": "System.String", "$value": "…"}` on every property of every thread. */
interface AdoPropertyValue {
  readonly $type?: string
  readonly $value?: unknown
}

interface AdoComment {
  readonly id?: number
  /** `0` on a thread's first comment — ADO's "no parent", not a comment id. */
  readonly parentCommentId?: number
  readonly author?: AdoIdentity
  /** **Absent, not null, on a deleted comment.** 52 of 59 had it. */
  readonly content?: string
  readonly publishedDate?: string
  readonly lastUpdatedDate?: string
  readonly lastContentUpdatedDate?: string
  /** Absent on the 52 live comments; `true` on the 7 deleted ones. */
  readonly isDeleted?: boolean
  readonly commentType?: string
  /** Present on 59 of 59 and empty on all 59; `setCommentLike` is what fills it. */
  readonly usersLiked?: readonly AdoIdentity[]
}

interface AdoPosition {
  readonly line?: number
  /** Not always 1 — a thread can start mid-line. Carried, never used to anchor. */
  readonly offset?: number
}

interface AdoThreadContext {
  readonly filePath?: string
  readonly rightFileStart?: AdoPosition | null
  readonly rightFileEnd?: AdoPosition | null
  /** Never once seen live (0 of 12), and a comment on a deleted line is real. */
  readonly leftFileStart?: AdoPosition | null
  readonly leftFileEnd?: AdoPosition | null
}

/**
 * `changeTrackingId` sits **beside** `iterationContext`, not inside it — the
 * contract's `IterationContext` flattens the two, so this is the one place that
 * knows they arrived on different levels.
 */
interface AdoPullRequestThreadContext {
  readonly iterationContext?: {
    readonly firstComparingIteration?: number
    readonly secondComparingIteration?: number
  } | null
  readonly changeTrackingId?: number
}

export interface AdoThread {
  readonly id?: number
  /** Absent on 32 of 56. See the header. */
  readonly status?: string
  readonly publishedDate?: string
  readonly lastUpdatedDate?: string
  readonly isDeleted?: boolean
  readonly comments?: readonly AdoComment[]
  readonly threadContext?: AdoThreadContext | null
  readonly pullRequestThreadContext?: AdoPullRequestThreadContext | null
  readonly properties?: Record<string, AdoPropertyValue | string | number | null> | null
}

interface AdoStatus {
  readonly context?: { readonly genre?: string; readonly name?: string } | null
  readonly createdBy?: AdoIdentity
}

/** Where every call about one pull request's threads hangs off. */
const threadsBase = (ref: PullRequestRef): string =>
  `${ref.projectId}/_apis/git/repositories/${ref.repositoryId}/pullRequests/${ref.id}/threads`

const author = (raw: AdoIdentity | undefined): CommentAuthor => ({
  id: raw?.id ?? '',
  displayName: raw?.displayName ?? 'unknown',
  uniqueName: raw?.uniqueName ?? null,
  imageUrl: raw?.imageUrl ?? null,
})

const commentType = (raw: string | undefined): CommentType =>
  KNOWN_COMMENT_TYPE.has(raw ?? '') ? (raw as CommentType) : 'unknown'

/**
 * `unknown` is ADO's own eighth-shaped answer and is kept; a *missing* status is
 * `null`, which is a different fact about a different kind of thread. Folding
 * the two together would report 32 activity-trail entries as unknown-status
 * conversations.
 */
const threadStatus = (raw: string | undefined): ThreadStatus | null => {
  if (raw === undefined) return null

  return KNOWN_STATUS.has(raw) ? (raw as ThreadStatus) : 'unknown'
}

/** Derived once here so the row model never re-implements the open/done rule. */
export const resolutionOf = (status: ThreadStatus | null): ThreadResolution =>
  status !== null && OPEN.has(status) ? 'open' : 'done'

export const isSettableStatus = (status: unknown): status is SettableThreadStatus | 'active' =>
  typeof status === 'string' && SETTABLE.has(status)

/**
 * The wrapper off, the value to a string.
 *
 * A string on purpose, not `unknown`: `SupportsMarkdown` is a `System.Int32` and
 * every other observed property is a `System.String`, so a faithful type would
 * be two shapes for a bag of values whose only consumer is
 * `CodeReviewThreadType`. A bare (unwrapped) value is accepted too — nothing
 * live sent one, and a hard cast that throws on the first one would be a worse
 * trade than reading it as written.
 */
function unwrapProperties(
  raw: Record<string, AdoPropertyValue | string | number | null> | null | undefined,
): Readonly<Record<string, string>> {
  const properties: Record<string, string> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === null || value === undefined) continue
    const unwrapped = typeof value === 'object' ? value.$value : value
    if (unwrapped === null || unwrapped === undefined) continue
    properties[key] = String(unwrapped)
  }

  return properties
}

const position = (raw: AdoPosition | null | undefined) =>
  raw === null || raw === undefined || typeof raw.line !== 'number'
    ? null
    : { line: raw.line, offset: raw.offset ?? 1 }

/**
 * `null` for the 44 of 56 threads that hang on the pull request itself rather
 * than on a file — and also for an anchor with no `filePath`, which would be a
 * position in nothing.
 */
function threadContext(raw: AdoThreadContext | null | undefined): ThreadContext | null {
  if (raw === null || raw === undefined || typeof raw.filePath !== 'string') return null

  return {
    filePath: raw.filePath,
    rightStart: position(raw.rightFileStart),
    rightEnd: position(raw.rightFileEnd),
    leftStart: position(raw.leftFileStart),
    leftEnd: position(raw.leftFileEnd),
  }
}

function iterationContext(
  raw: AdoPullRequestThreadContext | null | undefined,
): IterationContext | null {
  const iteration = raw?.iterationContext
  if (raw === null || raw === undefined || iteration === null || iteration === undefined) {
    return null
  }

  return {
    firstComparingIteration: iteration.firstComparingIteration ?? 0,
    secondComparingIteration: iteration.secondComparingIteration ?? 0,
    // Beside `iterationContext` on the wire, and on only 5 of 12 anchored
    // threads: a hint for following a line across iterations, not a mechanism.
    changeTrackingId: raw.changeTrackingId ?? null,
  }
}

function toComment(raw: AdoComment, names: ReadonlyMap<string, string> = NO_NAMES): Comment {
  return {
    id: raw.id ?? 0,
    // `0` is ADO's "top of the thread", not comment number zero. Mapped to null
    // so that "is this a reply" is a question about the data rather than about
    // an ADO sentinel.
    parentCommentId:
      typeof raw.parentCommentId === 'number' && raw.parentCommentId > 0
        ? raw.parentCommentId
        : null,
    author: author(raw.author),
    // The key is absent on a deleted comment, so this is the tombstone signal as
    // much as `isDeleted` is. 3 of 56 threads have replies, and one of those
    // replies hangs under a deleted parent — dropping it would orphan a live
    // comment.
    content: typeof raw.content === 'string' ? raw.content : null,
    publishedDate: raw.publishedDate ?? '',
    lastUpdatedDate: raw.lastUpdatedDate ?? null,
    lastContentUpdatedDate: raw.lastContentUpdatedDate ?? null,
    isDeleted: raw.isDeleted === true,
    commentType: commentType(raw.commentType),
    likedBy: (raw.usersLiked ?? []).map(author),
    // Narrowed to this body's own mentions rather than handed the whole lookup:
    // the comment carries what the comment needs, and an empty object is the
    // renderer's signal to skip the mention pass entirely.
    mentions: mentionsIn(typeof raw.content === 'string' ? raw.content : null, names),
  }
}

/**
 * Who is talking, decided here and never asked again.
 *
 * System first, and by two signals that agreed on all 56 sampled threads: a
 * first comment of `commentType: 'system'`, and a `CodeReviewThreadType`
 * property. Either is enough, because they are the same 32 threads and a
 * one-signal test would be a guess about which one ADO drops first.
 *
 * `bot` is then author identity against the Sonar status's author, and the
 * caveat in `SonarAuthorship` travels with it: live, that identity is a
 * general-purpose "QA Automation" account. If a person posts as it, their
 * comment is misfiled as a robot's. It is the best available signal — Sonar's
 * threads carry no marker property, only
 * `Microsoft.TeamFoundation.Discussion.UniqueID` — and not a reliable one.
 */
function threadKind(
  raw: AdoThread,
  properties: Readonly<Record<string, string>>,
  bots: ReadonlySet<string>,
): ThreadKind {
  const first = raw.comments?.[0]

  if (first?.commentType === 'system' || properties.CodeReviewThreadType !== undefined) {
    return 'system'
  }
  // Never seen live (56 of 56 had at least one comment). A thread with nothing
  // in it is nobody talking, and calling it human would put an empty card in
  // the conversation.
  if (first === undefined) return 'system'

  const id = first.author?.id

  return typeof id === 'string' && bots.has(id) ? 'bot' : 'human'
}

function toThread(
  raw: AdoThread,
  bots: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): Thread {
  const properties = unwrapProperties(raw.properties)
  const status = threadStatus(raw.status)

  return {
    id: raw.id ?? 0,
    status,
    resolution: resolutionOf(status),
    kind: threadKind(raw, properties, bots),
    publishedDate: raw.publishedDate ?? '',
    lastUpdatedDate: raw.lastUpdatedDate ?? null,
    isDeleted: raw.isDeleted === true,
    context: threadContext(raw.threadContext),
    iterationContext: iterationContext(raw.pullRequestThreadContext),
    comments: (raw.comments ?? []).map((comment) => toComment(comment, names)),
    properties,
  }
}

/**
 * When somebody voted, out of a system thread that says they did.
 *
 * The one dated record of a vote there is: `reviewers[].vote` is a standing
 * number with nothing to say about when it was cast. `hydrate.ts` reads the same
 * two properties off the raw payload for the inbox's approval-reset mark; this
 * reads them off the mapped thread, where the `$value` wrappers are already gone.
 *
 * A vote of `0` is not kept. It is the *absence* of a vote — ADO writes one when
 * a push resets an approval — and treating it as a review would date a review
 * that was taken away.
 */
function voteEvent(thread: Thread): VoteEvent | null {
  if (thread.properties.CodeReviewThreadType !== 'VoteUpdate') return null
  if (thread.isDeleted) return null

  const voterId = thread.comments[0]?.author.id ?? ''
  const vote = Number(thread.properties.CodeReviewVoteResult)
  if (voterId === '' || thread.publishedDate === '' || !Number.isFinite(vote) || vote === 0) {
    return null
  }

  return { voterId, at: thread.publishedDate, vote }
}

/**
 * The conversation, with the two kinds it left out counted rather than dropped
 * silently.
 *
 * A pull request whose 32 system threads vanish has to be able to say "32
 * system", because "no comments" and "no comments a person wrote" are different
 * answers and only one of them is ever surprising.
 *
 * The vote trail is the one thing carried *out* of those system threads rather
 * than counted with them, because it is the only dated record of who reviewed
 * and when — see `VoteEvent`.
 */
export function toThreadList(
  raw: readonly AdoThread[],
  bots: ReadonlySet<string> = NO_BOTS,
  names: ReadonlyMap<string, string> = NO_NAMES,
): ThreadList {
  const threads: Thread[] = []
  const votes: VoteEvent[] = []
  let systemCount = 0
  let botCount = 0
  let openCount = 0
  let doneCount = 0

  for (const entry of raw) {
    const thread = toThread(entry, bots, names)

    if (thread.kind === 'system') {
      systemCount += 1
      const vote = voteEvent(thread)
      if (vote !== null) votes.push(vote)
      continue
    }
    if (thread.kind === 'bot') {
      botCount += 1
      continue
    }

    threads.push(thread)
    if (thread.resolution === 'open') openCount += 1
    else doneCount += 1
  }

  return { threads, openCount, doneCount, systemCount, botCount, votes }
}

/**
 * The conversation grouped by file, keyed by the right-side line it hangs under.
 *
 * Pure, and called from the browser — see the header. Two things land in
 * `unanchored` rather than nowhere: a left-side anchor, which no right-side key
 * can hold (0 of 12 live, but ADO supports commenting on a deleted line), and an
 * anchor whose `line` ADO did not send. **Anchors past the end of the blob are
 * not filtered here** and cannot be: this function has the threads, not the
 * file, so the row model drops those into the same list once it knows how long
 * the file is.
 */
export function fileThreads(threads: readonly Thread[]): ReadonlyMap<string, FileThreads> {
  const files = new Map<string, { byRightLine: Map<number, Thread[]>; unanchored: Thread[] }>()

  for (const thread of threads) {
    const path = thread.context?.filePath
    if (path === undefined) continue

    let file = files.get(path)
    if (file === undefined) {
      file = { byRightLine: new Map(), unanchored: [] }
      files.set(path, file)
    }

    // `rightStart`, not `rightEnd`: 5 of 12 anchors were multi-line, and a
    // thread belongs under the line the reviewer selected first.
    const line = thread.context?.rightStart?.line
    if (line === undefined || line < 1) {
      file.unanchored.push(thread)
      continue
    }

    const at = file.byRightLine.get(line)
    if (at === undefined) file.byRightLine.set(line, [thread])
    else at.push(thread)
  }

  return new Map(
    [...files].map(([path, file]) => [
      path,
      { path, byRightLine: file.byRightLine, unanchored: file.unanchored },
    ]),
  )
}

/**
 * Which identities post as robots on this pull request.
 *
 * A set and not the single `SonarAuthorship` the contract names, for two
 * measured reasons: a multi-project repository posts one Sonar status per
 * project (6 of them on !24804), and nothing promises they share an author. All
 * eight sampled PRs' statuses did — `27ec814b…` throughout — so the set has one
 * member in practice and the code does not depend on that.
 */
async function sonarAuthors(client: AdoClient, ref: PullRequestRef): Promise<ReadonlySet<string>> {
  const base = threadsBase(ref).replace(/\/threads$/, '')
  const result = await client.get<{ value?: readonly AdoStatus[] }>(`${base}/statuses`)
  const bots = new Set<string>()

  for (const status of result.value ?? []) {
    if (status.context?.genre !== SONAR_GENRE) continue
    const id = status.createdBy?.id
    if (typeof id === 'string' && id !== '') bots.add(id)
  }

  return bots
}

/**
 * Display names for every `@<GUID>` these bodies mention.
 *
 * `_apis/identities?identityIds=…` on the **`vssps`** host, which is the lookup
 * `inbox.ts` already proved: `graph/subjectlookup` takes descriptors, not GUIDs,
 * and a mention carries a GUID. Cached per client, so the common case — a poll of
 * a conversation whose mentions were resolved a minute ago — asks for nothing.
 *
 * **Costs nothing when nobody is tagged.** Only bodies containing the pattern put
 * an id in `wanted`, and an empty `wanted` returns before any call — which is
 * most pull requests, and which is why the call budget below still reads "two".
 *
 * Fails quietly, for `sonarAuthors`' reason: the price of losing this is that a
 * mention renders as the GUID ADO wrote, which is exactly what it did before. The
 * price of throwing would be a comments tab that goes blank because an identity
 * endpoint hiccupped.
 */
async function mentionNames(
  client: AdoClient,
  raw: readonly AdoThread[],
): Promise<ReadonlyMap<string, string>> {
  let known = NAME_CACHE.get(client)
  if (known === undefined) {
    known = new Map<string, string>()
    NAME_CACHE.set(client, known)
  }

  const wanted = new Set<string>()
  for (const thread of raw) {
    for (const comment of thread.comments ?? []) {
      for (const id of mentionedIds(comment.content ?? null)) {
        if (!known.has(id)) wanted.add(id)
      }
    }
  }
  if (wanted.size === 0) return known

  const ids = [...wanted]
  const chunks: string[][] = []
  for (let at = 0; at < ids.length; at += IDENTITY_CHUNK) {
    chunks.push(ids.slice(at, at + IDENTITY_CHUNK))
  }

  try {
    const pages = await client.fanOut(chunks, (chunk) =>
      client.get<{ value?: readonly AdoIdentity[] }>(
        '_apis/identities',
        { identityIds: chunk.join(',') },
        'vssps',
      ),
    )

    for (const page of pages) {
      for (const identity of page.value ?? []) {
        const id = identity.id
        if (typeof id !== 'string' || identity.displayName === undefined) continue
        known.set(id.toLowerCase(), identity.displayName)
      }
    }
    // Asked and not answered — a mention of an identity this org no longer
    // resolves. Remembered as a blank so the next poll does not ask again.
    for (const id of wanted) if (!known.has(id)) known.set(id, '')
  } catch {
    // Left uncached on purpose: a failed call is not an answer, and the next
    // poll should get to try again.
  }

  return known
}

/**
 * The whole conversation: two calls, one of which is allowed to fail quietly.
 *
 * `statuses` exists only to name the robot. 6 of 14 sampled pull requests had no
 * Sonar status at all, and on those there are simply no bot threads — so a
 * missing status is a normal answer and a *failed* statuses call must not cost
 * the conversation either. The price of losing it is that Sonar's threads read
 * as a person's, which is visible and recoverable; the price of throwing would
 * be a comments tab that goes blank because a status endpoint hiccupped.
 */
export async function loadThreads(client: AdoClient, ref: PullRequestRef): Promise<ThreadList> {
  const [raw, bots] = await fanOutTuple<[{ value?: readonly AdoThread[] }, ReadonlySet<string>]>(
    client,
    [
      // No parameters: T-022 proved every one of them changes nothing here.
      () => client.get<{ value?: readonly AdoThread[] }>(threadsBase(ref)),
      () => sonarAuthors(client, ref).catch(() => NO_BOTS),
    ],
  )

  const threads = raw.value ?? []

  // Third and sequential, because which identities to ask about is written in the
  // bodies the first call returns — there is nothing to fan out with. Zero calls
  // on a conversation that tags nobody, and zero again on every poll after the
  // first; see `mentionNames`.
  return toThreadList(threads, bots, await mentionNames(client, threads))
}

/**
 * Only the robot's threads — the half `loadThreads` throws away.
 *
 * `toThreadList` drops `kind === 'bot'` on purpose: the conversation tab shows
 * people, and the findings panel says what Sonar said better than 50 capped
 * comments do. Resolving a finding is the one act that needs them back, because
 * the thread it closes is one of these.
 *
 * **`sonarAuthors` is allowed to throw here**, unlike in `loadThreads`. There, a
 * failed statuses call costs a label and the conversation still renders. Here it
 * is the entire test for whether a thread is Sonar's, and without it every thread
 * reads as a person's — so the honest answer is a failure, not an empty list that
 * means "Sonar opened no thread for this".
 */
export async function loadBotThreads(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<readonly Thread[]> {
  const [raw, bots] = await fanOutTuple<[{ value?: readonly AdoThread[] }, ReadonlySet<string>]>(
    client,
    [
      () => client.get<{ value?: readonly AdoThread[] }>(threadsBase(ref)),
      () => sonarAuthors(client, ref),
    ],
  )

  return (raw.value ?? [])
    .map((entry) => toThread(entry, bots, NO_NAMES))
    .filter((thread) => thread.kind === 'bot')
}

/**
 * One comment, for the server-side own-author check.
 *
 * `GET .../threads/{id}` returns the thread **unwrapped** — measured, T-022 §3 —
 * and it is one call rather than the whole list, which is what makes checking
 * authorship before every edit cheap enough to be unconditional. `null` when
 * either the thread or the comment is not there, so the caller can tell "not
 * yours" from "not there".
 */
async function loadComment(
  client: AdoClient,
  ref: PullRequestRef,
  threadId: number,
  commentId: number,
): Promise<Comment | null> {
  const raw = await client.get<AdoThread>(`${threadsBase(ref)}/${threadId}`)
  const comment = (raw.comments ?? []).find((entry) => entry.id === commentId)

  return comment === undefined ? null : toComment(comment)
}

/**
 * ADO is not consistent about GUID casing between endpoints and this is an
 * identity comparison, which is `inbox.ts`'s note verbatim. Here the failure mode
 * is the opposite of an empty inbox: a casing mismatch would refuse to let
 * someone edit their own comment, which reads as a bug in the button.
 */
const sameIdentity = (a: string, b: string): boolean =>
  a !== '' && b !== '' && a.toLowerCase() === b.toLowerCase()

/**
 * The own-author check: `null` to proceed, a sentence to refuse with.
 *
 * The viewer's id is a parameter rather than something this function resolves,
 * for the header's reason — resolving it needs a value import — and the caller in
 * `threads-fn.ts` gets it from the token, never from the request. A
 * client-supplied `viewerId` is not a check, it is a field the caller fills in.
 *
 * The author is read back from ADO rather than trusted from whatever the panel
 * had on screen, so a stale render cannot smuggle an edit past it. ADO would
 * refuse a foreign edit itself; the point of refusing here is that the reviewer
 * gets a sentence about ownership instead of a 401, and the write is never sent.
 */
export async function guardOwnComment(
  client: AdoClient,
  ref: PullRequestRef,
  target: { readonly threadId: number; readonly commentId: number },
  viewerId: string,
): Promise<string | null> {
  const comment = await loadComment(client, ref, target.threadId, target.commentId)

  if (comment === null) return 'That comment is no longer on the thread.'
  if (!sameIdentity(comment.author.id, viewerId)) {
    return 'Only a comment’s author can edit or delete it.'
  }

  return null
}

/**
 * A reply, on the thread's own comment collection.
 *
 * `parentCommentId` is required by the caller and not defaulted, because a reply
 * with no parent is a second root comment on the same thread — ADO accepts it,
 * and the conversation renders wrong from then on.
 *
 * **This request has never been sent.** Every write below is built from ADO's
 * documented shape and from the read payloads T-022 measured; none of them was
 * probed, because probing a write means writing on a colleague's pull request.
 */
export async function postReply(
  client: AdoClient,
  ref: PullRequestRef,
  reply: { readonly threadId: number; readonly parentCommentId: number; readonly content: string },
): Promise<Comment | null> {
  const raw = await client.write<AdoComment>(
    'POST',
    `${threadsBase(ref)}/${reply.threadId}/comments`,
    {
      content: reply.content,
      parentCommentId: reply.parentCommentId,
      commentType: 'text',
    },
  )

  return raw === null ? null : toComment(raw)
}

/**
 * A thread's status, on its own request.
 *
 * Separate from replying because the map is explicit that replying to a done
 * thread must not silently reactivate it — and separate *here*, not only in the
 * UI, so there is no shape in which the two can travel together. Reopening is
 * `active`, and it is a deliberate act with its own button.
 *
 * Unproven against ADO. See `postReply`.
 */
export async function setThreadStatus(
  client: AdoClient,
  ref: PullRequestRef,
  change: { readonly threadId: number; readonly status: SettableThreadStatus | 'active' },
  bots: ReadonlySet<string> = NO_BOTS,
): Promise<Thread | null> {
  const raw = await client.write<AdoThread>('PATCH', `${threadsBase(ref)}/${change.threadId}`, {
    status: change.status,
  })

  return raw === null ? null : toThread(raw, bots, NO_NAMES)
}

/**
 * The inverse of `threadContext`, and the only place the wire's four position
 * keys are written rather than read.
 *
 * A file-level thread is `{ filePath }` with no positions at all — that is ADO's
 * own way of commenting on a file rather than on a line, not a degenerate anchor.
 * `rightFileEnd` falls back to `rightFileStart` because ADO anchors nothing when
 * given a start with no end, and a one-line selection is the common case.
 */
function toAdoThreadContext(context: ThreadContext): AdoThreadContext {
  return {
    filePath: context.filePath,
    rightFileStart: context.rightStart ?? undefined,
    rightFileEnd: context.rightEnd ?? context.rightStart ?? undefined,
    leftFileStart: context.leftStart ?? undefined,
    leftFileEnd: context.leftEnd ?? context.leftStart ?? undefined,
  }
}

/**
 * The inverse of `iterationContext`, including the nesting the contract gets
 * wrong: `changeTrackingId` is a **sibling** of `iterationContext` on the wire,
 * not a field inside it. `threads.ts` is the one file that knows that, in both
 * directions.
 */
function toAdoPullRequestThreadContext(
  iteration: IterationContext,
): AdoPullRequestThreadContext {
  return {
    changeTrackingId: iteration.changeTrackingId ?? undefined,
    iterationContext: {
      firstComparingIteration: iteration.firstComparingIteration,
      secondComparingIteration: iteration.secondComparingIteration,
    },
  }
}

/**
 * A new thread — on a line, on a file, or on the pull request itself.
 *
 * The fifth write, and the one T-024 did not enumerate: it lists reply, status,
 * edit and delete, while T-026 requires the composer to open a thread as well as
 * answer one. Without this the app can only ever join conversations other people
 * started, which is not a review client.
 *
 * `status: 'active'` is the contract's, not a choice made here — a thread nobody
 * has answered yet is open by definition. `iterationContext` is passed through
 * rather than defaulted, because ADO's default is "the latest iteration" and the
 * reviewer may well be reading update 3 of 7; the caller that knows which view is
 * on screen is the one that says.
 *
 * Unproven against ADO. See `postReply`.
 */
export async function createThread(
  client: AdoClient,
  ref: PullRequestRef,
  thread: {
    readonly content: string
    readonly context: ThreadContext | null
    readonly iterationContext: IterationContext | null
  },
  bots: ReadonlySet<string> = NO_BOTS,
): Promise<Thread | null> {
  const raw = await client.write<AdoThread>('POST', threadsBase(ref), {
    // A thread is created with its first comment inside it; there is no
    // create-then-comment pair, and a thread with no comments would be a row
    // with nothing in it.
    comments: [{ parentCommentId: 0, content: thread.content, commentType: 'text' }],
    status: 'active',
    threadContext: thread.context === null ? undefined : toAdoThreadContext(thread.context),
    pullRequestThreadContext:
      thread.iterationContext === null
        ? undefined
        : toAdoPullRequestThreadContext(thread.iterationContext),
  })

  return raw === null ? null : toThread(raw, bots, NO_NAMES)
}

/**
 * An edit, which is a PATCH of `content` and nothing else.
 *
 * Only `content` goes in the body on purpose: a PATCH that also carried
 * `commentType` or `parentCommentId` would be re-asserting fields the caller
 * read a moment ago, and one of them being stale is how an edit moves a comment.
 *
 * Whether the comment is the viewer's own is checked before this is called —
 * `threads-fn.ts` — because that check needs an identity and this file must stay
 * free of value imports.
 *
 * Unproven against ADO. See `postReply`.
 */
export async function editComment(
  client: AdoClient,
  ref: PullRequestRef,
  edit: { readonly threadId: number; readonly commentId: number; readonly content: string },
): Promise<Comment | null> {
  const raw = await client.write<AdoComment>(
    'PATCH',
    `${threadsBase(ref)}/${edit.threadId}/comments/${edit.commentId}`,
    { content: edit.content },
  )

  return raw === null ? null : toComment(raw)
}

/**
 * A delete, which ADO implements as a soft delete: the comment stays in the
 * thread with `isDeleted: true` and **no `content` key**, which is exactly the
 * tombstone the reader already handles. Answers 204, hence `write`'s `null`.
 *
 * Unproven against ADO. See `postReply`.
 */
export async function deleteComment(
  client: AdoClient,
  ref: PullRequestRef,
  target: { readonly threadId: number; readonly commentId: number },
): Promise<void> {
  await client.write(
    'DELETE',
    `${threadsBase(ref)}/${target.threadId}/comments/${target.commentId}`,
  )
}

/**
 * A like on somebody's comment, put on or taken off.
 *
 * The route was measured by T-022 and reads: `GET .../comments/{c}/likes`
 * answers 200 authenticated, 401 anonymously, and 404 for an invented sibling
 * path — so the controller is there. The two writes are ADO's documented `POST`
 * and `DELETE` on that same path, both with no body. Nothing is parsed back
 * either way, and the panel re-reads the thread for the new `usersLiked`.
 *
 * `POST` and not `PUT`, which answers 405: the likes controller does not declare
 * that verb. A like is Microsoft's `Create`, not an upsert.
 *
 * No own-author guard, unlike edit and delete: a like is for other people's
 * comments, and ADO takes the liker from the token rather than from the body.
 *
 * Unproven against ADO. See `postReply`.
 */
export async function setCommentLike(
  client: AdoClient,
  ref: PullRequestRef,
  change: { readonly threadId: number; readonly commentId: number; readonly liked: boolean },
): Promise<void> {
  await client.write(
    change.liked ? 'POST' : 'DELETE',
    `${threadsBase(ref)}/${change.threadId}/comments/${change.commentId}/likes`,
  )
}

/**
 * The same tuple wrapper `pull-request.ts` explains: two calls of two different
 * types, one concurrency cap. `Promise.all` would type itself and would also go
 * around the throttle gate, which is the reason the client owns fan-out.
 */
async function fanOutTuple<T extends readonly unknown[]>(
  client: AdoClient,
  tasks: { readonly [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  const done = await client.fanOut(
    tasks as unknown as ReadonlyArray<() => Promise<unknown>>,
    (run) => run(),
  )

  return done as unknown as T
}
