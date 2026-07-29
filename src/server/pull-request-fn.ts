import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { AdoError } from './ado-client'
import { readPrCache } from './pr-cache'
import {
  abandon,
  addReviewer,
  castVote,
  completePullRequest,
  isVote,
  loadChanges,
  loadPullRequest,
  reactivate,
  removeReviewer,
  requeueEvaluation,
  setTitle,
} from './pull-request'

import type { AdoClient, RateLimit } from './ado-client'
import type { Hydration } from './hydrate'
import type { ChangeSet, PullRequestDetail, PullRequestRef, Vote } from './pull-request'

// The route addresses a PR by three values out of a URL, which makes all three
// attacker-controlled in the only sense that matters here: every one of them is
// interpolated into an Azure DevOps *path*. So they are validated by shape
// rather than merely escaped, for the same reason `hydrate-fn.ts` spells out —
// a GUID cannot contain a traversal sequence, and an encoded one still can.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/i

/**
 * The three sections that are allowed to fail without taking the page with
 * them, flagged for the view so an empty array can be read correctly: `false`
 * means there is genuinely nothing there, `true` means we do not know.
 *
 * Reviewers and conflict state are deliberately absent. Reviewers ride on the
 * detail call, which is the page's hard dependency and cannot fail on its own;
 * whether the PR conflicts comes from that same call, and only the list of
 * conflicting *paths* is fetched separately — `PullRequestDetail.errors`
 * carries that one for anyone who wants it.
 */
export interface FailedSections {
  readonly policies: boolean
  readonly commits: boolean
  readonly files: boolean
}

const NOTHING_FAILED: FailedSections = { policies: false, commits: false, files: false }

/**
 * What the detail route renders from.
 *
 * Three failures, three answers, because they are three different things to the
 * person looking at the page: no PAT yet is a setup step, a PR that is not
 * there is a bad link or a repo you cannot see, and anything else is "Azure
 * DevOps said no, here is what it said". Folding the middle one into the last
 * would answer a mistyped id with a 404 nobody can read.
 */
export interface PullRequestDetailResult {
  readonly pullRequest: PullRequestDetail | null
  /** `null` when the PR loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly notFound: boolean
  /** Booleans over the messages in `pullRequest.errors`, for the view. */
  readonly failed: FailedSections
  readonly rateLimit: RateLimit | null
}

const failedSections = (detail: PullRequestDetail): FailedSections => ({
  policies: detail.errors.policies !== null,
  commits: detail.errors.commits !== null,
  files: detail.errors.files !== null,
})

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

export function pullRequestRef(input: unknown): PullRequestRef {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
    throw new Error('id must be a pull request number.')
  }

  return {
    projectId: guid(raw.projectId, 'projectId'),
    repositoryId: guid(raw.repositoryId, 'repositoryId'),
    id: raw.id as number,
  }
}

/** One update's changes: which iteration, and which earlier one to measure from. */
export interface IterationChangesRequest extends PullRequestRef {
  readonly iterationId: number
  readonly compareTo: number
}

export interface IterationChangesResult {
  readonly changes: ChangeSet | null
  readonly error: string | null
}

/**
 * The range check that stops a mislabelled diff.
 *
 * `$compareTo` out of range does not error — measured on !24766, a 39-iteration
 * pull request: `$compareTo=999` answered 200 with all 294 files, the complete
 * combined diff. Under a heading reading "Update 7" that is a wrong answer the
 * reviewer has no way to spot. So `compareTo` must name an iteration *before*
 * `iterationId`, zero being the merge base, and anything else is refused here
 * rather than sent.
 */
function iterationChangesRequest(input: unknown): IterationChangesRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.iterationId) || (raw.iterationId as number) < 1) {
    throw new Error('iterationId must be an iteration number.')
  }
  if (!Number.isSafeInteger(raw.compareTo) || (raw.compareTo as number) < 0) {
    throw new Error('compareTo must be an iteration number or zero.')
  }
  if ((raw.compareTo as number) >= (raw.iterationId as number)) {
    throw new Error('compareTo must name an earlier iteration.')
  }

  return { ...ref, iterationId: raw.iterationId as number, compareTo: raw.compareTo as number }
}

/**
 * Which build to run again.
 *
 * The repository and the pull request number are not here, and that is not an
 * oversight: ADO addresses an evaluation by project and evaluation id, and adding
 * two ids the route would not use would mean validating values this write does
 * not depend on. What it does depend on is that `evaluationId` reaches a *path*,
 * so it is checked for being a GUID rather than escaped — the reason at the top
 * of this file, with a write's stakes on top of it: a read with a wrong id costs
 * a 404, a write with a wrong id starts somebody else's build.
 */
export interface RequeueRequest {
  readonly projectId: string
  readonly evaluationId: string
}

/**
 * Whether ADO took it.
 *
 * No `rateLimit`, unlike the reads: the caller re-reads the pull request
 * immediately afterwards and that answer carries the up-to-date count. Two
 * numbers arriving out of order for the same footer is worse than one.
 */
export interface RequeueResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Which pull request to squash, and the tip it was read at.
 *
 * `lastMergeSourceCommit` is not decoration and not a cache key: ADO compares it
 * to the source branch's actual tip and refuses the completion if they differ,
 * so it is what stops this merging a commit nobody in this session ever saw. It
 * comes off the page's own `PullRequestDetail`, and it is still checked here,
 * because it reaches an ADO request body and a shape check is cheap next to a
 * merge.
 */
export interface MergeRequest extends PullRequestRef {
  readonly lastMergeSourceCommit: string
}

/**
 * Whether ADO merged it.
 *
 * Same three fields as `RequeueResult` and for the same reason, but the failure
 * matters more here: ADO's refusals on this route are the interesting part —
 * a policy that is not satisfied, a branch that moved, a PAT without
 * `vso.code_write` — so the message is passed through for the view to show
 * verbatim rather than folded into one of ours.
 */
export interface MergeResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

export function mergeRequest(input: unknown): MergeRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (typeof raw.lastMergeSourceCommit !== 'string' || !SHA.test(raw.lastMergeSourceCommit)) {
    throw new Error('lastMergeSourceCommit must be a commit sha.')
  }

  return { ...ref, lastMergeSourceCommit: raw.lastMergeSourceCommit }
}

export function requeueRequest(input: unknown): RequeueRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    projectId: guid(raw.projectId, 'projectId'),
    evaluationId: guid(raw.evaluationId, 'evaluationId'),
  }
}

/** The new title, and which pull request is to carry it. */
export interface RenameRequest extends PullRequestRef {
  readonly title: string
}

/**
 * Whether Azure DevOps took the new title.
 *
 * The same three fields as `RequeueResult` and a separate type all the same: a
 * result is read at its call site, and `RequeueResult` there would have the
 * compiler agreeing that a rename reports whether a build was queued.
 * `threads-fn.ts` keeps its own `WriteResult` for the same reason.
 */
export interface RenameResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Trimmed, and empty refused.
 *
 * Trimmed here and not only in the field, because the *stored* title is what the
 * client compares against to decide a rename is a no-op — leave the spaces on and
 * `" x "` is a pull request that can be renamed to the same thing forever. Unlike
 * a comment (`threads-fn.ts`' `content`) there is nothing whitespace-sensitive
 * about a single line of display text, so there is no markdown to protect.
 *
 * **No length check.** ADO documents no limit for this field and we have not
 * measured one, so a refusal is ADO's to make and its message is the one the
 * field shows — inventing a ceiling here would refuse a title the service would
 * have accepted.
 */
function renamedTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('title must be a string.')

  const trimmed = value.trim()
  if (trimmed === '') throw new Error('title must not be empty.')

  return trimmed
}

export function renameRequest(input: unknown): RenameRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  return { ...ref, title: renamedTitle(raw.title) }
}

/**
 * Which pull request, and which of ADO's five votes.
 *
 * **Whose vote is deliberately not in here.** ADO puts the reviewer's id in the
 * path, so a `reviewerId` field on this request would be a field through which
 * one account casts another's approval — the exact thing the ticket names. It is
 * not validated-and-ignored either: `voteRequest` builds its answer out of a
 * `PullRequestRef` and a vote, so anything else the caller sends never reaches a
 * variable. `castVote` resolves the id from `_apis/connectionData`.
 */
export interface VoteRequest extends PullRequestRef {
  readonly vote: Vote
}

/**
 * Whether ADO recorded the vote.
 *
 * Its own type beside `RequeueResult`'s three identical fields, for the reason
 * `RenameResult` gives: a result is read at its call site, and one shared shape
 * would have the compiler agreeing that a vote reports whether a build was
 * queued. `error` carries the refusal `castVote` made *before* sending as well as
 * anything ADO said, because from the header's side those are one outcome — the
 * vote is not set, and here is the sentence saying why.
 */
export interface VoteResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * The five integers, and only those.
 *
 * `isVote` lives in `pull-request.ts` so it is covered by that file's tests, and
 * it is a whitelist rather than a range check because the scale is not arithmetic:
 * `-7` is not "slightly rejected", it is a value ADO would store and nothing in
 * this app could read back.
 */
export function voteRequest(input: unknown): VoteRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (!isVote(raw.vote)) {
    throw new Error('vote must be one of 10, 5, 0, -5 or -10.')
  }

  return { ...ref, vote: raw.vote }
}

/**
 * Which pull request, and whose row on it.
 *
 * The mirror image of `VoteRequest`, and the contrast between the two is the point
 * of both: a vote must not carry a reviewer id, and a reviewer write is *nothing
 * but* one. What this one must not carry is a **vote** — the endpoint underneath
 * takes both, so a `vote` here would be the same hole from the other side. It is
 * not validated-and-ignored: `reviewerRequest` builds its answer out of a
 * `PullRequestRef`, an id and a flag, so a `vote` a caller sends reaches no
 * variable.
 *
 * `isRequired` is on the add and meaningless on the remove, which is why it is
 * optional here and defaulted rather than split into two types: one shape, two
 * writes, and the removal simply does not read it.
 */
export interface ReviewerRequest extends PullRequestRef {
  readonly reviewerId: string
  readonly isRequired: boolean
}

export function reviewerRequest(input: unknown): ReviewerRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  // The same shape check the other three ids get, for the reason at the top of
  // this file: it is going into an Azure DevOps path. `addReviewer` checks it
  // again — see its header.
  if (typeof raw.reviewerId !== 'string' || !GUID.test(raw.reviewerId)) {
    throw new Error('reviewerId must be an identity GUID.')
  }

  return { ...ref, reviewerId: raw.reviewerId, isRequired: raw.isRequired === true }
}

/**
 * Whether ADO put somebody on the pull request, or took them off.
 *
 * One type for both, where `AbandonResult` and `ReactivateResult` are two — and
 * the reason those are two does not apply here. Those are each other's inverse on
 * the *same* object, so a shared type would let the compiler agree that closing a
 * pull request reported reopening it. These two name different people: the row
 * being written is in the request, the call sites are two separate controls, and
 * there is no sentence either one could return that the other would render wrongly.
 */
export interface ReviewerWriteResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Whether ADO abandoned it, and whether it put it back.
 *
 * Two types for two writes with the same three fields, `RenameResult`'s reason
 * again — and with more to it here than usual, because these two are each other's
 * inverse. A single `LifecycleResult` returned by both is a type in which the
 * compiler cannot tell "we closed it" from "we reopened it", which is the one
 * distinction a reader of either call site is there to make.
 */
export interface AbandonResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

export interface ReactivateResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * "Did a push wipe my approval" — read out of the inbox's cache, not out of ADO.
 *
 * The fact needs the pull request's system threads, `hydrate.ts` already reads
 * them every poll, and `pr_cache` is keyed on `(pr_id, commit_id)` where the
 * commit is the source tip. So this costs one synchronous SQLite lookup and no
 * network call at all, and the key does the freshness check for us: once anybody
 * pushes, the row no longer matches and this answers `null` — *we do not know* —
 * rather than handing the header a verdict about a commit that has been replaced.
 *
 * `null` in three more cases, all of them the same honest answer: ADO did not say
 * which commit the branch is on, the inbox has never hydrated this pull request,
 * or reading the database failed. The header says nothing on `null`, which the
 * ticket asks for outright — a stale approval on screen after a force-push is
 * worse than silence.
 *
 * Not gated on the viewer's current vote here. `approvalWasReset` already
 * short-circuits on `myVote > 0`, but that was computed against the vote as it
 * stood when the inbox last looked; the header holds a fresher one and gates on
 * it there, so re-approving clears the notice without waiting for a poll.
 */
function approvalReset(detail: PullRequestDetail): boolean | null {
  const commitId = detail.lastMergeSourceCommit
  if (commitId === null) return null

  try {
    return readPrCache<Hydration>(detail.id, commitId)?.approvalReset ?? null
  } catch {
    return null
  }
}

/** The error rather than `null`, so the message it already carries is the one shown. */
function connectedClient(): AdoClient | NotConnectedError {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return error
    throw error
  }
}

export const pullRequestQuery = createServerFn({ method: 'GET' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<PullRequestDetailResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return {
        pullRequest: null,
        error: client.message,
        connected: false,
        notFound: false,
        failed: NOTHING_FAILED,
        rateLimit: null,
      }
    }

    try {
      const detail = await loadPullRequest(client, data)
      const pullRequest = { ...detail, approvalReset: approvalReset(detail) }

      return {
        pullRequest,
        error: null,
        connected: true,
        notFound: false,
        failed: failedSections(pullRequest),
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        pullRequest: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        // Only the detail call can 404 the page: the three optional sections
        // return their failures rather than throwing, so a 404 reaching here
        // means the pull request itself is not there.
        notFound: error instanceof AdoError && error.status === 404,
        // Nothing loaded, so nothing partially failed — `error` is the answer.
        failed: NOTHING_FAILED,
        rateLimit: client.rateLimit(),
      }
    }
  })

/**
 * One update's changed files, fetched on demand.
 *
 * Separate from `pullRequestQuery` rather than a parameter on it: the combined
 * list arrives with the page and is what it leads with, and switching to an
 * update should not re-fetch the policies, the commits and the reviewers to
 * answer a question about files. It also means each update gets its own cache
 * entry, so flipping back to one already looked at is free.
 */
export const iterationChangesQuery = createServerFn({ method: 'GET' })
  .validator(iterationChangesRequest)
  .handler(async ({ data }): Promise<IterationChangesResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) return { changes: null, error: client.message }

    const { iterationId, compareTo, ...ref } = data

    try {
      return { changes: await loadChanges(client, ref, iterationId, compareTo), error: null }
    } catch (error) {
      return { changes: null, error: error instanceof Error ? error.message : String(error) }
    }
  })

/**
 * Run a build policy again.
 *
 * This page's only write, and the only one outside the conversation. It is here
 * rather than in a file of its own because the checklist it acts on is read by
 * `pullRequestQuery` above — a requeue is not a feature, it is the one verb the
 * policy rows have.
 *
 * `ok: false` rather than a throw for `threads-fn.ts`'s reason: a write refused
 * before it was sent and a write ADO rejected are both failures the row has to
 * report, and the caller should not have to infer that from which field is null.
 * Which builds are offered a requeue at all is `requeueTarget`'s decision, not
 * this function's — it will requeue whatever it is handed, because the id came
 * off a row the server drew.
 */
export const requeuePolicy = createServerFn({ method: 'POST' })
  .validator(requeueRequest)
  .handler(async ({ data }): Promise<RequeueResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    try {
      await requeueEvaluation(client, data)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Rename a pull request.
 *
 * `ok: false` rather than a throw, as the requeue above — and here the message
 * matters more, because this is the write whose refusal we cannot predict.
 * **Nothing in here checks whether renaming is allowed.** Who may edit a pull
 * request's title is ADO's own permission model, which this project has no
 * credential to probe and no business guessing at, and re-deriving the PR's
 * status would be an extra read to answer a question the write itself answers.
 * So the attempt goes out and ADO's sentence — a 403's detail included, see
 * `AdoError` — is what the field shows.
 */
export const renamePullRequest = createServerFn({ method: 'POST' })
  .validator(renameRequest)
  .handler(async ({ data }): Promise<RenameResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { title, ...ref } = data

    try {
      await setTitle(client, ref, title)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Squash-merge the pull request.
 *
 * The one write in this app that changes a branch, so two things about it are
 * deliberate. It sends no bypass of any kind — `completePullRequest` says why —
 * and it decides nothing: whether merging is even possible is judged where the
 * page's own state is, in `mergeBlocker`, and re-judged by ADO, which owns the
 * answer. Duplicating that judgement here would mean two rules that can drift,
 * and the one that would win is the weaker.
 *
 * `ok: false` rather than a throw, like `requeuePolicy`: "not connected" and
 * "ADO refused" are both things the confirmation dialog has to say out loud, and
 * ADO's refusal is usually the only place the actual reason is written down.
 */
export const squashMerge = createServerFn({ method: 'POST' })
  .validator(mergeRequest)
  .handler(async ({ data }): Promise<MergeResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { lastMergeSourceCommit, ...ref } = data

    try {
      await completePullRequest(client, ref, lastMergeSourceCommit)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Set **my** vote on the pull request.
 *
 * The name is the contract: there is no other vote this can set. The reviewer id
 * ADO wants in the path is resolved from the token inside `castVote` and is not a
 * field of `VoteRequest`, so a caller who names somebody else is a caller who has
 * sent a key nothing reads.
 *
 * A refused vote comes back as `ok: false` with `castVote`'s sentence, alongside
 * "not connected" and anything ADO said — `requeuePolicy`'s reason. The header
 * shows the sentence and leaves the vote where ADO still has it, which is the same
 * rule `EditableTitle` follows for a rename ADO would not take.
 */
export const setMyVote = createServerFn({ method: 'POST' })
  .validator(voteRequest)
  .handler(async ({ data }): Promise<VoteResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { vote, ...ref } = data

    try {
      const refusal = await castVote(client, ref, vote)

      return { ok: refusal === null, error: refusal, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Abandon the pull request.
 *
 * Nothing here decides whether abandoning is allowed, for `renamePullRequest`'s
 * reason — ADO owns that answer and this app has no credential to probe it with.
 * What *is* decided, and decided on the page rather than here, is whether to offer
 * the button at all: the header offers it on an active pull request the viewer
 * opened, and ADO refuses the rest with a sentence the dialog shows.
 *
 * The confirmation in front of it is the component's, not this function's. A
 * server function that could only be called after a dialog would be a server
 * function that trusts a dialog.
 */
export const abandonPullRequest = createServerFn({ method: 'POST' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<AbandonResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    try {
      await abandon(client, data)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/** Put an abandoned pull request back. `abandonPullRequest`'s inverse, and its twin. */
export const reactivatePullRequest = createServerFn({ method: 'POST' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<ReactivateResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    try {
      await reactivate(client, data)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Ask somebody to review this pull request.
 *
 * Two writes over one endpoint, and this is the half that does not vote — see
 * `addReviewer`, which is where the body is decided and where the reason it
 * carries no `vote` is written down.
 *
 * Nothing here decides who may be added, `abandonPullRequest`'s reason: ADO owns
 * that answer and this app has no credential to probe it with. What the page
 * decides is who is worth *offering*, which is the directory minus the people
 * already on the pull request.
 */
export const inviteReviewer = createServerFn({ method: 'POST' })
  .validator(reviewerRequest)
  .handler(async ({ data }): Promise<ReviewerWriteResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { reviewerId, isRequired, ...ref } = data

    try {
      await addReviewer(client, ref, reviewerId, isRequired)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })

/**
 * Take somebody off it again.
 *
 * The one write in this app that deletes anything, and the destructive thing about
 * it is a vote rather than a person — `removeReviewer` says what goes with them,
 * and the page is what declines to offer it where that would matter.
 */
export const withdrawReviewer = createServerFn({ method: 'POST' })
  .validator(reviewerRequest)
  .handler(async ({ data }): Promise<ReviewerWriteResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { reviewerId, ...ref } = data

    try {
      await removeReviewer(client, ref, reviewerId)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
      }
    }
  })
