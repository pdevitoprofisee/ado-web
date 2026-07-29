import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { CADENCE, useCadence } from './cadence'
import { pullRequestKey } from './requeue'
import { checkDetailQuery, checksReportQuery, retryBuildRun } from '@/server/checks-fn'
import { requeuePolicy } from '@/server/pull-request-fn'

import type {
  BuildRun,
  CheckDetail,
  CheckFailure,
  CheckSummary,
  ChecksErrors,
  ChecksReport,
} from './checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// The checks panel's client half: one read for the list, one read per opened row,
// and two of the three ways to run something again.
//
// **Two queries and not one**, for the reason `CheckDetail` gives: the list is
// 1 + N cheap calls and the detail is five or six calls and up to 200 KB, so a
// panel that fetched both would spend a quarter of a megabyte to draw five rows
// nobody has clicked. The split is the same one `blob-query.ts` makes for file
// contents.
//
// **Polling stops when the build does.** A finished build's timeline, logs and
// test results can never change — the server holds them for an hour on exactly
// that reasoning — so the only thing worth re-asking is a build that is still
// going. `useCadence` already stops in a hidden tab; this stops in a finished
// one.

/** The pull request's checks list. Flat tuple, like every other key in the app. */
export const checksKey = (ref: PullRequestRef) =>
  ['checks', ref.projectId, ref.repositoryId, ref.id] as const

/**
 * One build's detail, keyed by the build and not by the pull request.
 *
 * A build belongs to a project, not to a review — the same build can be the
 * answer to two pull requests' policies after a retarget — and the server's cache
 * is keyed the same way. Nothing in this key names the PR.
 */
export const checkDetailKey = (projectId: string, buildId: number) =>
  ['check-detail', projectId, buildId] as const

const NO_CHECKS: readonly CheckSummary[] = []
const NO_FAILURES: readonly CheckFailure[] = []
const NO_ERRORS: ChecksErrors = { checks: null, builds: null, timeline: null, tests: null }
const NO_RUNS: ReadonlyMap<number, BuildRun> = new Map()

/**
 * Statuses that will not change on their own.
 *
 * `queued` is not one of them: it is ADO's word for "this policy is not yet
 * satisfied", which on a build policy means a build is coming or running. `broken`
 * is settled — a policy configuration that cannot evaluate stays broken until
 * somebody edits it.
 */
const SETTLED: ReadonlySet<string> = new Set(['approved', 'rejected', 'broken', 'notApplicable'])

/**
 * Whether anything in the report is still moving.
 *
 * Both halves are asked, because they can disagree: a policy can say `queued`
 * before it has a build id at all (measured on 35 of 150 evaluations), and a build
 * can still be `inProgress` under a policy whose status has not caught up. Either
 * one is a reason to look again; neither is a reason to poll for the rest of the
 * afternoon.
 */
export function isRunning(report: ChecksReport | null): boolean {
  if (report === null) return false

  return (
    report.checks.some((check) => !SETTLED.has(check.status)) ||
    report.builds.some((build) => build.status !== 'completed')
  )
}

export interface Checks {
  readonly checks: readonly CheckSummary[]
  /** By `BuildLink.buildId`. Built here because a `Map` does not cross a server-function boundary. */
  readonly builds: ReadonlyMap<number, BuildRun>
  /** Which sections could not be read. `null` is the good case — see `ChecksErrors`. */
  readonly errors: ChecksErrors
  /** Checks whose build would not load, named one by one. */
  readonly failed: readonly CheckFailure[]
  readonly pending: boolean
  /** The whole read having failed, as opposed to one section of it. */
  readonly error: string | null
  readonly connected: boolean
}

/** The checks list for one pull request: one ADO call plus one per distinct build. */
export function useChecks(ref: PullRequestRef): Checks {
  const cadence = useCadence(CADENCE.pullRequest)

  const query = useQuery({
    queryKey: checksKey(ref),
    queryFn: () => checksReportQuery({ data: ref }),
    // Only while something is actually in progress. A pull request whose builds
    // have all finished is a page with no news on it, and the tab is very often
    // left open on exactly that. The function form because the decision is made
    // from the answer, which the options object cannot otherwise see.
    refetchInterval: (self) => (isRunning(self.state.data?.report ?? null) ? cadence : false),
    staleTime: CADENCE.pullRequest,
  })

  const report = query.data?.report ?? null

  const builds = useMemo(
    () =>
      report === null || report.builds.length === 0
        ? NO_RUNS
        : new Map(report.builds.map((build) => [build.id, build])),
    [report],
  )

  return {
    checks: report?.checks ?? NO_CHECKS,
    builds,
    errors: report?.errors ?? NO_ERRORS,
    failed: report?.failed ?? NO_FAILURES,
    pending: query.isPending,
    // Two ways to fail and one sentence for both, as `useConversation` does: the
    // server function catching an ADO error, and the call never arriving.
    error: query.data?.error ?? query.error?.message ?? null,
    connected: query.data?.connected ?? true,
  }
}

export interface CheckDetailState {
  readonly detail: CheckDetail | null
  readonly pending: boolean
  readonly error: string | null
  readonly connected: boolean
  /** The build is gone — retention deletes them, and that is not the same as a broken call. */
  readonly notFound: boolean
}

/**
 * The detail behind one build: the timeline, the failing step's log, the failures.
 *
 * `live` comes from the row that opened this — the report already knows whether
 * the build has finished, and passing it down means the panel has one answer to
 * "is this still going" rather than two that can disagree. Once the detail's own
 * read says `completed`, the poll stops regardless: a finished build is finished
 * whatever the list still says.
 */
export function useCheckDetail(
  projectId: string,
  buildId: number,
  live: boolean,
): CheckDetailState {
  const cadence = useCadence(CADENCE.pullRequest)

  const query = useQuery({
    queryKey: checkDetailKey(projectId, buildId),
    queryFn: () => checkDetailQuery({ data: { projectId, buildId } }),
    refetchInterval: (self) =>
      live && self.state.data?.detail?.build.status !== 'completed' ? cadence : false,
    // An hour once it is done, matching `LOG_CACHE_MS` on the server: reopening a
    // row you closed a minute ago should not re-fetch 191 KB of stack traces.
    staleTime: live ? CADENCE.pullRequest : CADENCE.history,
  })

  return {
    detail: query.data?.detail ?? null,
    pending: query.isPending,
    error: query.data?.error ?? query.error?.message ?? null,
    connected: query.data?.connected ?? true,
    notFound: query.data?.notFound ?? false,
  }
}

/** One re-run control's state: the verb, whether it is in flight, and what ADO said. */
export interface Rerun {
  readonly ask: () => void
  readonly pending: boolean
  /** What Azure DevOps said about the last attempt, or `null`. */
  readonly error: string | null
}

/**
 * Ask ADO to evaluate a build policy again — the granularity that already works.
 *
 * The server function is `pull-request-fn.ts`' `requeuePolicy`, reused rather than
 * reimplemented: it is the same act the policy checklist performs, and two
 * implementations of one write is two things to get wrong. `useRequeue` itself
 * could not be reused — it takes a `Policy`, this takes a `CheckSummary`, and it
 * invalidates only the pull request.
 *
 * Both keys are invalidated because both surfaces draw this evaluation: the
 * checklist in the details tab and the row that was just pressed.
 */
export function useRequeueCheck(ref: PullRequestRef, check: CheckSummary): Rerun {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      if (check.requeueId === null) throw new Error('That check has no evaluation to requeue.')

      const result = await requeuePolicy({
        data: { projectId: ref.projectId, evaluationId: check.requeueId },
      })
      // The server function answers a refusal rather than throwing one; react-query
      // only calls something a failure if it rejects. This is where the two meet.
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    // `onSettled` and awaited, for `useRequeue`'s reason: a write that timed out on
    // the way back may well have been applied, and the re-read is the only thing
    // that knows.
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: checksKey(ref) }),
        client.invalidateQueries({ queryKey: pullRequestKey(ref) }),
      ])
    },
  })

  return {
    ask: () => mutation.mutate(),
    pending: mutation.isPending,
    error: mutation.error?.message ?? null,
  }
}

/**
 * Retry a whole build — `PATCH build/builds/{id}?retry=true`.
 *
 * **This has never been sent to Azure DevOps.** See `BuildRetryRequest`: the body
 * is a guess, the scope (`vso.build_execute`) may not be held by the stored PAT,
 * and it is unknown whether a retry mints a new build id. A 403 is a realistic
 * first answer, which is why the message ADO gives is shown verbatim against the
 * button instead of being folded into one of ours.
 *
 * The detail key is invalidated as well as the list, because a retry changes the
 * very thing the open row is showing — and the server drops its cached timeline
 * for the same build on the way out.
 */
export function useRetryBuild(ref: PullRequestRef, projectId: string, buildId: number): Rerun {
  const client = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await retryBuildRun({ data: { projectId, buildId } })
      if (!result.ok) throw new Error(result.error ?? 'Azure DevOps did not say why.')
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: checksKey(ref) }),
        client.invalidateQueries({ queryKey: checkDetailKey(projectId, buildId) }),
      ])
    },
  })

  return {
    ask: () => mutation.mutate(),
    pending: mutation.isPending,
    error: mutation.error?.message ?? null,
  }
}
