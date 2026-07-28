import { resolveIdentity } from './inbox'

import type { AdoClient } from './ado-client'

// Server-only. One pull request, assembled into the shape the detail page reads.
//
// This file is the **contract** between three things built in parallel: the
// fetch/derivation below, the presentational components in
// `src/components/pr-detail.tsx`, and the route that wires them. The exported
// types are the agreement — change a shape here and both sides move with it.
//
// What the live probe settled, so nothing below re-derives it:
//
//   - Every endpoint here takes plain `api-version=7.1`. Only `policy/
//     evaluations` needs `7.1-preview.1`, which `hydrate.ts` already knew. That
//     is the first time in this project a new endpoint family cost nothing to
//     version, and it was still worth checking: four of the previous five
//     needed a preview suffix that only a real credential reveals.
//   - **The single-PR call earns its place on `description` alone.** Measured,
//     it adds only `_links` and `artifactId` in keys over what the list already
//     returned — but the list truncates `description` at 400 characters and the
//     detail call returned 1710. Everything else on this page could have come
//     from the inbox row.
//   - **`mergeFailureMessage` does not exist.** Not null — absent, on 15 of 15
//     conflicted active PRs, along with `mergeFailureType` and
//     `lastMergeCommit`. Conflicts live on their own endpoint and are a *list
//     of paths*, which is the more useful thing anyway: "what conflicts" beats
//     "there are conflicts".

/** The one endpoint in this file that is preview-only. */
const POLICY_VERSION = '7.1-preview.1'

/**
 * One call, deliberately generous, and explicit because it has to be: **omit
 * `$top` and the changes endpoint silently answers with 100**. It does not
 * clamp — `$top=100000` is accepted, and the largest PR measured (1096 files)
 * came back whole in one 288 KB response — so paging buys nothing here that a
 * headroom this size does not already cover, and `truncated` covers the rest.
 */
const FILE_LIMIT = 5000

export interface Person {
  readonly id: string
  readonly displayName: string
}

/** One file the merge cannot reconcile on its own. */
export interface Conflict {
  /** Matches `changeEntries[].item.path` exactly, so the two lists line up. */
  readonly path: string
  /** Live values: `editEdit` (36), `deleteEdit` (4), `editDelete` (1). */
  readonly type: string
  /** Already resolved in ADO's own conflict editor, and merely still listed. */
  readonly resolved: boolean
}

/**
 * Conflict state, which the map asks to be "stated loudly".
 *
 * `status` is ADO's own vocabulary, kept verbatim rather than folded into a
 * boolean, because "we have not tried to merge yet" and "we tried and it
 * failed" are different things to tell someone. Only `succeeded` and
 * `conflicts` were ever seen across 21133 PRs, and the field is **absent
 * entirely** on abandoned ones — so an empty `status` means ADO did not say,
 * which is neutral and must not be dressed up as a conflict.
 *
 * `conflicts` replaces what the contract first guessed was here. There is no
 * `mergeFailureMessage`: measured, the key is absent on every conflicted PR.
 * The list of paths is the better answer regardless — a reviewer wants to know
 * *what* conflicts, not that something does.
 */
export interface MergeState {
  readonly status: string
  readonly conflicted: boolean
  /** Empty unless `conflicted`; the endpoint is only asked then. */
  readonly conflicts: readonly Conflict[]
}

/**
 * Votes: `10` approved · `5` approved with suggestions · `0` none ·
 * `-5` waiting for author · `-10` rejected.
 */
export interface Reviewer {
  readonly id: string
  readonly displayName: string
  readonly vote: number
  /** A team or group rather than a person — how team assignment reaches you. */
  readonly isContainer: boolean
  readonly isRequired: boolean
  /**
   * Present on a *person* who voted on behalf of a container: the containers
   * their vote was recorded against. This is the only way to attribute a team's
   * vote to whoever actually cast it. Measured, it hangs off 117 of 197 people
   * and 0 of 160 containers — the opposite of the intuitive reading.
   *
   * The `vote` nested inside each entry is **always 0** (verified on all 117)
   * and is therefore not carried: a container's real vote is its own top-level
   * row, and reading the nested one would report every team as undecided.
   */
  readonly votedFor: readonly Person[]
}

/** ADO's evaluation vocabulary. `queued` covers "not yet satisfied", not just builds. */
export type PolicyStatus =
  | 'approved'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'broken'
  | 'notApplicable'
  | 'unknown'

/**
 * One line of the checklist: what is actually standing between this PR and a
 * merge.
 *
 * `name` is `configuration.type.displayName` — except that it is **not unique**.
 * The live probe found two "Minimum number of reviewers" policies on one PR,
 * differing only in scope, so the id is carried and the name is qualified where
 * the settings offer something to qualify it with (a build policy's
 * `displayName`, for instance). A checklist with two identical rows and
 * different verdicts is a checklist nobody can act on.
 */
export interface Policy {
  /** `configuration.id`, because `name` collides. */
  readonly id: string
  readonly name: string
  readonly status: PolicyStatus
  /**
   * Blocking *and not yet satisfied* — i.e. this row is a reason the PR cannot
   * complete right now. A passing required policy is required, not blocking.
   */
  readonly blocking: boolean
  /** The specific thing: a build number, an approval count, a required reviewer. */
  readonly detail: string | null
  /** A build result, when the policy has one to point at. */
  readonly url: string | null
}

export interface Commit {
  readonly id: string
  /** First line of the message, derived here. */
  readonly subject: string
  /**
   * ADO's `commentTruncated`, renamed because its own name misleads. Measured
   * against the standalone commit resource, which returns the whole message: on
   * 4 of 4 truncated commits the `comment` we were handed was **exactly the
   * complete first line**, a prefix of the full text, and what was dropped was
   * the body after the blank line. It fired on 9 of 21 commits at message
   * lengths of 33–86 characters, so it is not a length limit either.
   *
   * So it does not mean `subject` is clipped — `subject` is whole. It means
   * there is more commit message than this page is showing. Called `truncated`,
   * it produced a UI that marked nearly half of all commits as cut off.
   */
  readonly bodyOmitted: boolean
  readonly author: string
  readonly at: string
  readonly url: string
}

/**
 * `changeType` is a `[Flags]` enum and arrives as a comma-separated string
 * (`"edit, rename"`), so it is parsed to a set rather than compared as a word.
 * Live: `edit` 2578, `add` 588, `delete` 77, `edit, rename` 40, `rename` 5.
 */
export interface ChangedFile {
  /**
   * Where the file is *now* — except on a delete, where there is no now and this
   * is where it was. Not simply `item.path`: on a delete ADO sends `item.path`
   * as literal `null` and puts the real path on the entry (see
   * `AdoChangeEntry`).
   */
  readonly path: string
  readonly changeType: readonly string[]
  /**
   * Where the file was, when that differs from `path` — so, a rename's old name.
   * `null` on an edit, an add, and a delete, because ADO sends the entry-level
   * path only on a delete and a rename and a delete has already spent it on
   * `path`.
   */
  readonly originalPath: string | null
  /** Blob sha *after* the change — works directly as a blob id (map: the diff pipeline). */
  readonly objectId: string | null
  /**
   * Blob sha *before*. Absent on an add, and **equal to `objectId` on a pure
   * rename**, which is the one case where a sha comparison says "unchanged" and
   * is right about the bytes while being wrong about the file.
   */
  readonly originalObjectId: string | null
}

/**
 * One push onto the source branch — what ADO calls an iteration and labels
 * "Update N" in its own UI. The unit `$compareTo` speaks, and the reason the
 * per-update view is keyed on these rather than on commits: a single push can
 * carry five commits, and asking for one commit's changes means a second
 * endpoint that has nothing sensible to say about a merge commit.
 *
 * Measured: 120 pull requests across the org, 58 with one iteration, median 2,
 * p90 5, p99 15, max 39.
 */
export interface Iteration {
  readonly id: number
  /**
   * First line of the tip commit's message. ADO calls this the iteration's
   * `description` and sends the *whole* message, body and all, so it is cut here
   * the same way a commit's is.
   */
  readonly subject: string
  readonly author: string
  readonly createdAt: string
  /**
   * `push` | `forcePush` | `create` | `rebase` | `retarget` | `resolveConflicts`
   * | `unknown`. Every one of the 44 iterations measured said `push`, so the rest
   * are documented rather than observed — which is why this is a string the view
   * prints and not a union it switches on.
   */
  readonly reason: string
}

/** A set of changed files, however it was asked for. */
export interface ChangeSet {
  readonly files: readonly ChangedFile[]
  /** More files exist than were fetched. Rendered, never silently dropped. */
  readonly truncated: boolean
}

export interface FileList extends ChangeSet {
  /** The iteration these files belong to — the latest one. */
  readonly iterationId: number | null
  /**
   * Every update, oldest first, so the view can offer one of them without a
   * second round trip. Free: the changes endpoint is iteration-scoped, so this
   * list had to be fetched to know which iteration to ask about.
   */
  readonly iterations: readonly Iteration[]
}

/**
 * Which of the three optional sections could not be fetched, and why.
 *
 * A section that failed is not a section that is empty, and the page has to be
 * able to say which: "no policies on this PR" and "we could not read the
 * policies" look identical once a failure has been folded into an empty array,
 * and only one of them means the checklist can be trusted. `null` is the good
 * case. The header and the conflict state are absent from this list on purpose
 * — they come from the detail call, which is the page's one hard dependency.
 */
export interface SectionErrors {
  readonly policies: string | null
  readonly commits: string | null
  readonly files: string | null
  /** The conflicting *paths*. Whether the PR conflicts at all is not in here. */
  readonly conflicts: string | null
}

export interface PullRequestDetail {
  readonly id: number
  readonly title: string
  /** Full text. The inbox's copy is truncated at 400 characters; this is not. */
  readonly description: string
  readonly author: Person
  readonly createdAt: string
  readonly isDraft: boolean
  /** `active` | `completed` | `abandoned`. */
  readonly status: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly merge: MergeState
  readonly reviewers: readonly Reviewer[]
  readonly policies: readonly Policy[]
  readonly commits: readonly Commit[]
  readonly files: FileList
  readonly project: string
  readonly repository: string
  /** The dev.azure.com permalink — this app replaces it, it does not hide it. */
  readonly url: string
  /** Who is looking, so the UI can mark their own row. `null` if unresolved. */
  readonly viewerId: string | null
  /** Per-section fetch failures. All `null` on a page that loaded whole. */
  readonly errors: SectionErrors
}

/** Addresses one PR. GUIDs because they are interpolated into an ADO path. */
export interface PullRequestRef {
  readonly projectId: string
  readonly repositoryId: string
  readonly id: number
}

interface AdoIdentity {
  readonly id?: string
  readonly displayName?: string
}

interface AdoReviewer extends AdoIdentity {
  readonly vote?: number
  readonly isContainer?: boolean
  readonly isRequired?: boolean
  readonly votedFor?: readonly AdoIdentity[]
}

interface AdoDetail {
  readonly pullRequestId?: number
  readonly title?: string
  readonly description?: string
  readonly createdBy?: AdoIdentity
  readonly creationDate?: string
  readonly isDraft?: boolean
  readonly status?: string
  readonly sourceRefName?: string
  readonly targetRefName?: string
  /** Absent on every abandoned PR measured, so `undefined` is a real answer. */
  readonly mergeStatus?: string
  readonly reviewers?: readonly AdoReviewer[]
  readonly repository?: {
    readonly name?: string
    readonly project?: { readonly name?: string }
  }
}

interface AdoPolicySettings {
  /** A build policy names its definition here; most other types send nothing. */
  readonly displayName?: string
  readonly buildDefinitionId?: number
  readonly minimumApproverCount?: number
  readonly creatorVoteCounts?: boolean
  readonly requiredReviewerIds?: readonly string[]
  readonly scope?: ReadonlyArray<{ readonly refName?: string | null }>
}

interface AdoPolicyContext {
  readonly buildId?: number
  readonly buildDefinitionName?: string
  /** A build passed, but on an older commit. Phase 5 wants it; we keep it. */
  readonly buildIsNotCurrent?: boolean
}

interface AdoEvaluation {
  readonly status?: string
  readonly context?: AdoPolicyContext | null
  readonly configuration?: {
    readonly id?: number | string
    readonly isBlocking?: boolean
    readonly isEnabled?: boolean
    readonly type?: { readonly displayName?: string }
    readonly settings?: AdoPolicySettings
  }
}

interface AdoCommit {
  readonly commitId?: string
  readonly comment?: string
  readonly commentTruncated?: boolean
  readonly author?: { readonly name?: string; readonly date?: string }
}

/**
 * The placement is a trap: `originalPath` sits on the *entry* while
 * `originalObjectId` sits on the *item*, so the two halves of a rename are not
 * next to each other.
 *
 * An earlier revision of this comment said the entry-level path could wait for
 * phase 3. That was wrong, and it shipped a crash: on a **delete**, `item.path`
 * is literal `null` and `originalPath` is the only path in the payload. See
 * T-015.
 *
 * `path` is therefore `string | null`, not `string | undefined` — the
 * difference is the whole bug.
 */
interface AdoChangeEntry {
  readonly changeType?: string
  /** Present only on a delete and a rename. Absent — not null — otherwise. */
  readonly originalPath?: string
  readonly item?: {
    readonly path?: string | null
    readonly objectId?: string
    readonly originalObjectId?: string
    readonly isFolder?: boolean
  }
}

interface AdoIteration {
  readonly id?: number
  /** The tip commit's *entire* message, despite the name. */
  readonly description?: string
  readonly author?: AdoIdentity
  readonly createdDate?: string
  readonly reason?: string
}

interface AdoConflict {
  readonly conflictPath?: string
  readonly conflictType?: string
  /** `unresolved` | `partiallyResolved` | `resolved`, when ADO sends it at all. */
  readonly resolutionStatus?: string
}

const branch = (ref: string | undefined): string => ref?.replace(/^refs\/heads\//, '') ?? ''

const person = (identity: AdoIdentity | undefined): Person => ({
  id: identity?.id ?? '',
  displayName: identity?.displayName ?? 'unknown',
})

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * `changeType` is a `[Flags]` enum on the wire: `"edit, rename"` is one entry,
 * not two, and `changeType === 'edit'` stops matching the moment a file is both
 * edited and moved. Splitting is the only reading that survives a rename.
 */
export function changeFlags(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((flag) => flag.trim())
    .filter((flag) => flag !== '')
}

/**
 * The first line, and nothing else — no ellipsis, no marker. Whether a body
 * followed is carried beside it as `bodyOmitted`, because a punctuation mark is
 * not a signal: a commit subject can legitimately end in one, and the UI would
 * have to guess.
 */
export const commitSubject = (comment: string | undefined): string =>
  (comment ?? '').split('\n')[0].trim()

/** Statuses that mean this row is not standing in the way of a merge. */
const SATISFIED: ReadonlySet<string> = new Set(['approved', 'notApplicable'])

const KNOWN_STATUS: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'queued',
  'running',
  'broken',
  'notApplicable',
])

/**
 * An unrecognised status becomes `unknown` rather than being passed through, so
 * the UI never has to render a word nobody wrote a case for — and `unknown`
 * counts as unsatisfied below, which errs toward showing a row as blocking.
 */
const policyStatus = (raw: string | undefined): PolicyStatus =>
  KNOWN_STATUS.has(raw ?? '') ? (raw as PolicyStatus) : 'unknown'

/**
 * `type.displayName` collides — two "Minimum number of reviewers" policies sat
 * on the sampled PR, differing only in scope. The id keeps the rows distinct
 * for React; this keeps them distinct for the person reading them, using
 * whatever the settings offer: a build policy names its definition, and the
 * rest are told apart by the branch they are scoped to.
 */
function policyName(type: string, settings: AdoPolicySettings): string {
  const named = settings.displayName?.trim()
  const scoped = (settings.scope ?? [])
    .map((scope) => branch(scope.refName ?? undefined))
    .find((name) => name !== '')
  const qualifier = named !== undefined && named !== '' ? named : scoped

  return qualifier === undefined ? type : `${type} — ${qualifier}`
}

/**
 * The specific thing the row is about, keyed off the shape of `settings` rather
 * than off `displayName`: the name is display text and collides, the settings
 * are data and do not.
 */
function policyDetail(
  settings: AdoPolicySettings,
  context: AdoPolicyContext | null | undefined,
): string | null {
  if (settings.buildDefinitionId !== undefined) {
    return [
      context?.buildDefinitionName ?? settings.displayName ?? `definition ${settings.buildDefinitionId}`,
      context?.buildId === undefined ? null : `build ${context.buildId}`,
      // The difference between "the build passed" and "a build passed, earlier".
      context?.buildIsNotCurrent === true ? 'ran on an earlier commit' : null,
    ]
      .filter((part) => part !== null)
      .join(' · ')
  }
  // Before the approver count, not after: a "Required reviewers" policy carries
  // **both** keys — measured, 10 of 10 — and the count is the less specific of
  // the two. Ordered the other way, every required-reviewer row on the live org
  // read "1 approval, author counts", which is the checklist answering a
  // question nobody asked.
  if (settings.requiredReviewerIds !== undefined) {
    return plural(settings.requiredReviewerIds.length, 'required reviewer')
  }
  if (typeof settings.minimumApproverCount === 'number') {
    const counts = settings.creatorVoteCounts === true ? ', author counts' : ''

    return `${plural(settings.minimumApproverCount, 'approval')}${counts}`
  }

  return null
}

export function toPolicies(
  evaluations: readonly AdoEvaluation[],
  org: string,
  projectId: string,
): Policy[] {
  return evaluations.map((evaluation, index) => {
    const configuration = evaluation.configuration
    const settings = configuration?.settings ?? {}
    const status = policyStatus(evaluation.status)
    const buildId = evaluation.context?.buildId

    return {
      id: String(configuration?.id ?? index),
      name: policyName(configuration?.type?.displayName ?? 'Policy', settings),
      status,
      blocking:
        configuration?.isBlocking === true &&
        configuration.isEnabled !== false &&
        !SATISFIED.has(status),
      detail: policyDetail(settings, evaluation.context),
      url:
        buildId === undefined
          ? null
          : `https://dev.azure.com/${encodeURIComponent(org)}/${projectId}/_build/results?buildId=${buildId}`,
    }
  })
}

/**
 * A section that failed and a section that is empty are different answers, so
 * each optional section is run for its value *or* its message and never for a
 * throw. Only the detail call is allowed to take the page down with it.
 */
interface Section<T> {
  readonly data: T
  readonly error: string | null
}

async function section<T>(load: () => Promise<T>, empty: T): Promise<Section<T>> {
  try {
    return { data: await load(), error: null }
  } catch (error) {
    return { data: empty, error: error instanceof Error ? error.message : String(error) }
  }
}

const NO_POLICIES: readonly Policy[] = []
const NO_COMMITS: readonly Commit[] = []
const NO_CONFLICTS: readonly Conflict[] = []
const NO_FILES: FileList = { files: [], iterationId: null, iterations: [], truncated: false }

/** Where every call about one pull request hangs off. Two callers, hence a name. */
const prBase = (ref: PullRequestRef): string =>
  `${ref.projectId}/_apis/git/repositories/${ref.repositoryId}/pullRequests/${ref.id}`
const UNFETCHED: Section<readonly Conflict[]> = { data: NO_CONFLICTS, error: null }

/**
 * `client.fanOut` is homogeneous in its item type and this page's calls are
 * not, so the thunks go in as one array and come back as a tuple in the same
 * order. `Promise.all` would have typed itself and would also have gone around
 * the concurrency cap and the throttle gate, which is the entire reason the
 * client owns fan-out rather than each feature doing its own.
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

/**
 * The viewer's id, remembered for the life of the client.
 *
 * The page's five calls are already spoken for and this would be a sixth. The
 * inbox memoises the same answer behind a TTL because *team membership* can
 * change under it; an account's own id cannot, so there is nothing here for a
 * TTL to protect against and the second PR you open costs five again. Keyed on
 * the client, so a re-entered PAT or a switched org gets a new one (`ado.ts`).
 */
const viewers = new WeakMap<AdoClient, Promise<string>>()

function resolveViewer(client: AdoClient): Promise<string | null> {
  let who = viewers.get(client)

  if (who === undefined) {
    who = resolveIdentity(client).then((identity) => identity.id)
    // A cached rejection would be permanent, and this fails on a network blip
    // far more often than it does on a bad token.
    who.catch(() => {
      if (viewers.get(client) === who) viewers.delete(client)
    })
    viewers.set(client, who)
  }

  // Best effort on purpose: not knowing who is looking costs the "that's you"
  // marker, not the page.
  return who.catch(() => null)
}

async function loadPolicies(client: AdoClient, ref: PullRequestRef): Promise<readonly Policy[]> {
  const evaluations = await client.get<{ value?: readonly AdoEvaluation[] }>(
    `${ref.projectId}/_apis/policy/evaluations`,
    {
      artifactId: `vstfs:///CodeReview/CodeReviewId/${ref.projectId}/${ref.id}`,
      'api-version': POLICY_VERSION,
    },
  )

  return toPolicies(evaluations.value ?? [], client.org, ref.projectId)
}

async function loadCommits(
  client: AdoClient,
  ref: PullRequestRef,
  base: string,
): Promise<readonly Commit[]> {
  const result = await client.get<{ value?: readonly AdoCommit[] }>(`${base}/commits`)

  return (result.value ?? [])
    .filter((commit): commit is AdoCommit & { commitId: string } => typeof commit.commitId === 'string')
    .map((commit) => ({
      id: commit.commitId,
      subject: commitSubject(commit.comment),
      bodyOmitted: commit.commentTruncated === true,
      author: commit.author?.name ?? 'unknown',
      at: commit.author?.date ?? '',
      // ADO's own `url` on a commit is the REST resource, which is not
      // somewhere to send a reader. The web route takes the same ids.
      url: `https://dev.azure.com/${encodeURIComponent(client.org)}/${ref.projectId}/_git/${ref.repositoryId}/commit/${commit.commitId}`,
    }))
}

/**
 * The changed files, which cost two calls because the changes endpoint is
 * iteration-scoped and there is no way to ask for "the latest" by name.
 *
 * Not paged, on measurement rather than on hope. Three independent enumerations
 * of the same 1096-file PR — one `$top=2000` call, a blind `$skip` walk in
 * pages of 25, and a service-directed walk — returned identical path sets, so
 * the PR list's *short-page-is-not-the-last-page* trap (note 6) does not reach
 * here: nothing filters entries inside a PR you can already read. What does
 * bite is `nextTop`, which is `min($top, remaining)` and looks exactly like a
 * page size; feeding it back walks the tail one file at a time. It is ignored,
 * as is `nextSkip`.
 */
function toChangeSet(entries: readonly AdoChangeEntry[]): ChangeSet {
  const files: ChangedFile[] = []

  for (const entry of entries) {
    // `?? null` and not `??`-into-the-guard: `item.path` is null on a delete,
    // so falling through to `originalPath` is the normal path for one change
    // kind in five, not a defensive flourish.
    const now = entry.item?.path ?? null
    const path = now ?? entry.originalPath ?? null
    // Never seen live (0 of 3288), but a folder entry has no blob to diff and
    // would render as a file that changed by nothing.
    if (path === null || entry.item?.isFolder === true) continue

    files.push({
      path,
      changeType: changeFlags(entry.changeType),
      // Only a rename has somewhere else to have been: a delete's old path is
      // already `path`, and an edit or an add never sends one.
      originalPath: now !== null && entry.originalPath !== undefined ? entry.originalPath : null,
      objectId: entry.item?.objectId ?? null,
      originalObjectId: entry.item?.originalObjectId ?? null,
    })
  }

  return { files, truncated: entries.length >= FILE_LIMIT }
}

/**
 * The changes on one iteration, against whichever earlier one you name.
 *
 * `compareTo` is ADO's `$compareTo` and it is not optional here on purpose.
 * Omitting the parameter means zero, zero means the merge base, and the merge
 * base is the whole-PR diff — so a caller that meant "what update 7 changed" and
 * forgot the argument gets 294 files back and no error. Making it explicit turns
 * that into a type error instead. Range-checking it is `pull-request-fn.ts`'s
 * job, for the same reason: **`$compareTo=999` on a 39-iteration PR answers with
 * the full combined diff**, measured, so an out-of-range value fails open into a
 * wrong answer wearing an update's label.
 */
export async function loadChanges(
  client: AdoClient,
  ref: PullRequestRef,
  iterationId: number,
  compareTo: number,
): Promise<ChangeSet> {
  const result = await client.get<{ changeEntries?: readonly AdoChangeEntry[] }>(
    `${prBase(ref)}/iterations/${iterationId}/changes`,
    { $top: FILE_LIMIT, $compareTo: compareTo },
  )

  return toChangeSet(result.changeEntries ?? [])
}

async function loadFiles(client: AdoClient, ref: PullRequestRef, base: string): Promise<FileList> {
  const result = await client.get<{ value?: readonly AdoIteration[] }>(`${base}/iterations`)
  const iterations = (result.value ?? [])
    .filter((iteration): iteration is AdoIteration & { id: number } =>
      typeof iteration.id === 'number',
    )
    .map((iteration) => ({
      id: iteration.id,
      subject: commitSubject(iteration.description),
      author: iteration.author?.displayName ?? 'unknown',
      createdAt: iteration.createdDate ?? '',
      reason: iteration.reason ?? 'unknown',
    }))

  // No iterations is an answer, not a failure — and asking for `/iterations/0/
  // changes` would be a 404 dressed up as one.
  if (iterations.length === 0) return NO_FILES

  const iterationId = Math.max(...iterations.map((iteration) => iteration.id))

  // `$compareTo: 0` and not the absent parameter, though they are the same call:
  // measured identical on !24766 (64 entries either way), and writing the zero
  // says out loud that this is the merge-base comparison — the combined diff of
  // the whole pull request, which is what the page leads with.
  const changes = await loadChanges(client, ref, iterationId, 0)

  return { ...changes, iterationId, iterations }
}

/**
 * The conflicting paths, asked for only when the PR says it has some. On a
 * clean PR this endpoint answers 200 with `count: 0`, so the guard is not about
 * avoiding an error — it is about keeping the common page at five calls.
 */
async function loadConflicts(client: AdoClient, base: string): Promise<readonly Conflict[]> {
  const result = await client.get<{ value?: readonly AdoConflict[] }>(`${base}/conflicts`)

  return (result.value ?? [])
    .filter((conflict): conflict is AdoConflict & { conflictPath: string } =>
      typeof conflict.conflictPath === 'string',
    )
    .map((conflict) => ({
      path: conflict.conflictPath,
      type: conflict.conflictType ?? 'unknown',
      resolved: conflict.resolutionStatus === 'resolved',
    }))
}

/**
 * Five calls: the PR, its policy evaluations, its commits, its iterations and
 * the changes on the latest of them. Four of those are independent and go out
 * together; the changes wait only because they need an iteration id.
 *
 * A conflicted PR is a sixth, and it cannot be anything else: which endpoint to
 * call is the answer the first call gives you.
 */
export async function loadPullRequest(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<PullRequestDetail> {
  const base = prBase(ref)

  const [pr, viewerId, policies, commits, files] = await fanOutTuple(client, [
    () => client.get<AdoDetail>(base),
    () => resolveViewer(client),
    () => section(() => loadPolicies(client, ref), NO_POLICIES),
    () => section(() => loadCommits(client, ref, base), NO_COMMITS),
    () => section(() => loadFiles(client, ref, base), NO_FILES),
  ])

  if (typeof pr.pullRequestId !== 'number') {
    throw new Error(`Azure DevOps answered without a pull request for !${ref.id}.`)
  }

  const conflicted = pr.mergeStatus === 'conflicts'
  const conflicts = conflicted
    ? await section(() => loadConflicts(client, base), NO_CONFLICTS)
    : UNFETCHED
  const project = pr.repository?.project?.name ?? ''
  const repository = pr.repository?.name ?? ''

  return {
    id: pr.pullRequestId,
    title: pr.title ?? '(untitled)',
    description: pr.description ?? '',
    author: person(pr.createdBy),
    createdAt: pr.creationDate ?? '',
    isDraft: pr.isDraft === true,
    status: pr.status ?? 'active',
    sourceBranch: branch(pr.sourceRefName),
    targetBranch: branch(pr.targetRefName),
    merge: {
      // Empty rather than a stand-in: `notSet` is a documented value that never
      // once occurred live, and inventing it here would be reporting an ADO
      // answer we did not get.
      status: pr.mergeStatus ?? '',
      conflicted,
      conflicts: conflicts.data,
    },
    reviewers: (pr.reviewers ?? []).map((reviewer) => ({
      id: reviewer.id ?? '',
      displayName: reviewer.displayName ?? 'unknown',
      vote: reviewer.vote ?? 0,
      isContainer: reviewer.isContainer === true,
      isRequired: reviewer.isRequired === true,
      votedFor: (reviewer.votedFor ?? []).map(person),
    })),
    policies: policies.data,
    commits: commits.data,
    files: files.data,
    project,
    repository,
    url: `https://dev.azure.com/${encodeURIComponent(client.org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${pr.pullRequestId}`,
    viewerId,
    errors: {
      policies: policies.error,
      commits: commits.error,
      files: files.error,
      conflicts: conflicts.error,
    },
  }
}

export { POLICY_VERSION }
