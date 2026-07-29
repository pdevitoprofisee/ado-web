import { noteActivity } from './notifications'
import { readPrCache, writePrCache } from './pr-cache'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoClient } from './ado-client'

// Server-only. The per-PR half of the inbox: what a reviewer actually triages
// on, which the one cheap list call cannot carry.
//
// Four things were asked for and only three cost a call. `mergeStatus` is
// already on the list entry — measured, the single-PR detail call adds only
// `_links` and `artifactId` over it — so conflict state rides along on the plain
// row and this file never asks for it. What is left is genuinely 1+3N: threads
// (unresolved human comments, and the vote/push history), statuses (which
// commenters are bots), and policy evaluations (the checks).

/**
 * `policy/evaluations` is preview-only; the plain `7.1` earns a 400. That is the
 * fourth endpoint in this project whose version only a real credential reveals,
 * because ADO validates the token *before* the api-version — see ado-client.ts.
 */
const POLICY_VERSION = '7.1-preview.1'

/**
 * The measured thread vocabulary is `active`, `fixed`, `wontFix`, `closed`, and
 * absent (every system thread). Only the first two of those five mean someone
 * is still waiting on an answer; `pending` is documented but was not seen live,
 * and is included because guessing *toward* showing a comment is the safe error.
 */
const UNRESOLVED = new Set(['active', 'pending'])

/**
 * Exported for `notifications.ts`, which diffs two polls' worth of exactly this
 * payload and should not declare a second view of it. A type-only import, so the
 * module graph still has one edge and it points this way.
 */
export interface AdoComment {
  readonly id?: number
  readonly commentType?: string
  readonly content?: string
  readonly publishedDate?: string
  readonly author?: { readonly id?: string; readonly displayName?: string }
}

export interface AdoThread {
  readonly id?: number
  readonly status?: string
  readonly isDeleted?: boolean
  readonly publishedDate?: string
  readonly comments?: readonly AdoComment[]
  readonly properties?: Readonly<Record<string, { readonly $value?: unknown } | undefined>>
}

interface ThreadList {
  readonly value?: readonly AdoThread[]
}

interface StatusList {
  readonly value?: ReadonlyArray<{ readonly createdBy?: { readonly id?: string } }>
}

interface EvaluationList {
  readonly value?: ReadonlyArray<{
    readonly status?: string
    /**
     * Whether the policy is required, and whether it is switched on at all —
     * both live on the configuration rather than on the evaluation, and an
     * evaluation of a disabled policy is still returned.
     */
    readonly configuration?: {
      readonly isBlocking?: boolean
      readonly isEnabled?: boolean
    }
  }>
}

export interface Checks {
  readonly passed: number
  readonly failed: number
  readonly pending: number
}

/**
 * The states in which a policy is not standing in the way. `notApplicable` counts
 * as satisfied even though `readChecks` refuses to count it as a check that
 * passed — the two questions are different: it is not an accomplishment, but it
 * is not an obstacle either.
 */
const SATISFIED = new Set(['approved', 'notApplicable'])

/** The cached payload. A change to this shape must clear `pr_cache` in a migration. */
export interface Hydration {
  readonly checks: Checks
  readonly unresolved: number
  /** I approved, then someone pushed, and my vote is no longer standing. */
  readonly approvalReset: boolean
  /**
   * At least one required policy is not satisfied — the half of "can this merge"
   * that costs a call, and so the half worth caching. Same rule as
   * `Policy.blocking` on the detail page, deliberately: two rules for one
   * question drift, and the inbox would be the one that ends up lying.
   */
  readonly blocked: boolean
  /**
   * Nothing this app can see is stopping this from merging.
   *
   * Cached along with the rest, and **recomputed on every read** rather than
   * trusted, because two of its three inputs move without moving `commitId`:
   * publishing a draft and resolving a conflict both leave the source tip
   * exactly where it was. A trusted cached value would read "not ready" until
   * somebody pressed Refresh, which is the wrong number to be quietly wrong
   * about.
   *
   * A weaker claim than it sounds, and deliberately weaker than the detail
   * page's button: the inbox row cannot see `mergeStatus` at the level of
   * `queued` versus `succeeded`, only whether ADO called it conflicted. So this
   * means "worth opening to merge", and the page itself makes the final call.
   */
  readonly readyToMerge: boolean
}

/**
 * Success and failure are different shapes on purpose. Folding a failed fetch
 * into `unresolved: 0` would render as "nothing waiting on you", which is the
 * one thing this app must never say when it does not know.
 */
export type HydrationResult =
  | { readonly id: number; readonly ok: true; readonly data: Hydration }
  | { readonly id: number; readonly ok: false; readonly error: string }

export interface HydrationTarget {
  readonly id: number
  /** `lastMergeSourceCommit.commitId` — the cache's validity token. */
  readonly commitId: string
  readonly projectId: string
  readonly repositoryId: string
  /** My current vote on this PR, from the list call's reviewers array. */
  readonly myVote: number
  /**
   * The two things the cheap list call already knows that decide readiness, sent
   * in rather than fetched: they cost nothing on the row, and asking for them
   * here would turn a cache hit back into a call.
   */
  readonly isDraft: boolean
  readonly conflicted: boolean
}

const key = (id: string | undefined): string | null => id?.toLowerCase() ?? null

const property = (thread: AdoThread, name: string): string | undefined => {
  const value = thread.properties?.[name]?.$value

  return value === undefined || value === null ? undefined : String(value)
}

/**
 * The identities on this PR that are machines, taken to be the ones that also
 * posted a *status*.
 *
 * The ticket only requires that Sonar threads not inflate the count, and the
 * obvious fix is to match the SonarCloud status author's id. Measured across 30
 * live PRs, that is the narrower version of a rule that is both shorter and
 * strictly better: the identities that comment as bots and the identities that
 * post statuses were the same two — Sonar ("QA Automation") and Azure Pipelines
 * Test Service — while all five humans posted no status at all. The general
 * rule caught the second bot, which the ticket did not know existed.
 *
 * Scoped to one PR, which errs in the safe direction: a bot that commented here
 * but posted no status here is counted as a human and inflates the number.
 * Swallowing a colleague's actual comment is the failure that matters.
 */
function botIds(statuses: StatusList): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const status of statuses.value ?? []) {
    const id = key(status.createdBy?.id)
    if (id !== null) ids.add(id)
  }

  return ids
}

export function countUnresolved(
  threads: readonly AdoThread[],
  bots: ReadonlySet<string>,
): number {
  let count = 0
  for (const thread of threads) {
    if (thread.isDeleted === true) continue
    if (!UNRESOLVED.has(thread.status ?? '')) continue

    const first = thread.comments?.[0]
    // Sonar posts as `text`, not `system`, so the comment type alone does not
    // separate the bots — it only removes ADO's own "X added Y as a reviewer".
    if (first === undefined || first.commentType === 'system') continue

    const author = key(first.author?.id)
    if (author !== null && bots.has(author)) continue

    count++
  }

  return count
}

/**
 * The Checks tab, which is the policy evaluations rather than the raw statuses
 * underneath them. `notApplicable` is not counted: a policy that does not apply
 * to this PR is not a check that passed.
 */
export function readChecks(evaluations: EvaluationList): Checks {
  let passed = 0
  let failed = 0
  let pending = 0

  for (const evaluation of evaluations.value ?? []) {
    switch (evaluation.status) {
      case 'approved':
        passed++
        break
      case 'rejected':
      case 'broken':
        failed++
        break
      case 'queued':
      case 'running':
        pending++
        break
    }
  }

  return { passed, failed, pending }
}

/**
 * Whether any required policy is still standing in the way.
 *
 * Not derivable from `readChecks`: a failing *optional* policy makes `failed`
 * non-zero without blocking anything, and a required policy sitting at `queued`
 * — the reviewer policy's "not yet met", per the live probe — blocks while
 * counting as pending. So the configuration has to be read, and `isEnabled`
 * with it, because ADO returns evaluations for policies that are switched off.
 *
 * An unrecognised status is not satisfied, which errs toward "blocked". Being
 * told to look again is a cheap mistake; being told a PR is ready when a policy
 * says otherwise is not.
 */
export function readBlocked(evaluations: EvaluationList): boolean {
  return (evaluations.value ?? []).some(
    (evaluation) =>
      evaluation.configuration?.isBlocking === true &&
      evaluation.configuration.isEnabled !== false &&
      !SATISFIED.has(evaluation.status ?? ''),
  )
}

/**
 * Whether a push knocked my approval down, which ADO records nowhere directly —
 * it just sets the vote back to 0, and a reviewer who does not notice thinks
 * they already signed off.
 *
 * It is reconstructed from the system threads: a `VoteUpdate` thread is authored
 * by the voter and carries `CodeReviewVoteResult`, and a `RefUpdate` thread is
 * stamped when the source branch moves. So: I voted yes, the branch moved after
 * that, and my vote is no longer positive. The last condition is what keeps this
 * from firing on every push to a PR I approved under a policy that does not
 * reset votes.
 */
export function approvalWasReset(
  threads: readonly AdoThread[],
  me: string,
  myVote: number,
): boolean {
  if (myVote > 0) return false

  let approvedAt: number | null = null
  let pushedAt: number | null = null

  for (const thread of threads) {
    const at = Date.parse(thread.publishedDate ?? '')
    if (Number.isNaN(at)) continue

    switch (property(thread, 'CodeReviewThreadType')) {
      case 'VoteUpdate':
        if (
          key(thread.comments?.[0]?.author?.id) === me &&
          Number(property(thread, 'CodeReviewVoteResult')) > 0
        ) {
          approvedAt = Math.max(approvedAt ?? 0, at)
        }
        break
      case 'RefUpdate':
        pushedAt = Math.max(pushedAt ?? 0, at)
        break
    }
  }

  return approvedAt !== null && pushedAt !== null && pushedAt > approvedAt
}

/**
 * The three facts behind the inbox's ready mark, in one place so the cached path
 * and the fetched path cannot disagree. A draft cannot complete at all, a
 * conflicted branch has nothing to complete into, and a required policy that is
 * not satisfied is ADO's own refusal.
 */
const ready = (
  hydration: Pick<Hydration, 'blocked'>,
  target: Pick<HydrationTarget, 'isDraft' | 'conflicted'>,
): boolean => !hydration.blocked && !target.isDraft && !target.conflicted

/**
 * One PR's worth of rich data, cache first.
 *
 * The cache is read through `readPrCache`, which compares the commit inside the
 * read — so a PR nobody has pushed to costs zero calls here, and a PR that moved
 * cannot serve a stale row even if this function forgot to check.
 *
 * `fresh` is the one way past it, and it exists because the commit key has a
 * blind spot T-007 surfaced deliberately: a thread opened or resolved *without*
 * a push does not change `commitId`, so the count stays stale for the life of
 * the page. That is the wrong number someone presses Refresh about (T-008).
 */
export async function hydrate(
  client: AdoClient,
  target: HydrationTarget,
  me: () => Promise<string>,
  db?: DatabaseSync,
  fresh = false,
): Promise<HydrationResult> {
  const cached = fresh ? undefined : readPrCache<Hydration>(target.id, target.commitId, db)
  if (cached !== undefined) {
    // The cached row's `readyToMerge` is overwritten rather than served: see the
    // field's own note — the draft flag and the conflict flag both change without
    // the commit changing, so the only trustworthy value is the one computed from
    // the target in hand.
    return { id: target.id, ok: true, data: { ...cached, readyToMerge: ready(cached, target) } }
  }

  const base = `${target.projectId}/_apis/git/repositories/${target.repositoryId}/pullRequests/${target.id}`

  try {
    const [threads, statuses, evaluations, identity] = await Promise.all([
      client.get<ThreadList>(`${base}/threads`),
      client.get<StatusList>(`${base}/statuses`),
      client.get<EvaluationList>(`${target.projectId}/_apis/policy/evaluations`, {
        artifactId: `vstfs:///CodeReview/CodeReviewId/${target.projectId}/${target.id}`,
        'api-version': POLICY_VERSION,
      }),
      me(),
    ])

    const all = threads.value ?? []
    const bots = botIds(statuses)
    const blocked = readBlocked(evaluations)
    const data: Hydration = {
      checks: readChecks(evaluations),
      unresolved: countUnresolved(all, bots),
      approvalReset: approvalWasReset(all, identity, target.myVote),
      blocked,
      readyToMerge: ready({ blocked }, target),
    }
    writePrCache(target.id, target.commitId, data, db)

    // Three of the four things T-039 announces are in the responses above, and
    // this is the only place they are ever fetched — so detection is a diff taken
    // where the poll already happens, not a second loop. It runs on the fetched
    // path only, which is precisely the point of the cache: a PR nobody has
    // pushed to costs no call, and nothing about it can have changed.
    try {
      noteActivity({
        prId: target.id,
        commitId: target.commitId,
        // From `me()`, i.e. the credential — never from the request.
        viewerId: identity,
        threads: all,
        bots,
        failed: data.checks.failed,
      }, Date.now(), db)
    } catch {
      // A notification that could not be written must not cost this row its
      // badges. The panel missing an entry is a smaller failure than an inbox
      // that renders a PR as unknown, and the next fetched hydration will diff
      // against the same watermark and try again.
    }

    return { id: target.id, ok: true, data }
  } catch (error) {
    // Returned, not thrown: one PR whose calls failed must cost that PR its
    // badges, not cost the whole inbox its rows.
    return {
      id: target.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
