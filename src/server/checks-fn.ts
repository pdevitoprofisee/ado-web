import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { AdoError } from './ado-client'
import { loadCheckDetail, loadChecksReport, retryBuild, retryStage } from './checks'
import { pullRequestRef } from './pull-request-fn'

import type { AdoClient, RateLimit } from './ado-client'
import type { CheckDetailTarget } from './checks'
import type { BuildRetryRequest, CheckDetail, ChecksReport, StageRetryRequest } from '../lib/checks-contract'

// The checks panel's entry points. Two reads and two writes, and the writes are
// the reason this file is careful.
//
// Everything interpolated into an Azure DevOps path is shape-checked rather than
// escaped, for `pull-request-fn.ts`' reason — a GUID cannot contain a traversal
// sequence and an encoded one still can. A build id is a path segment, a log id
// is a path segment, and a stage ref name is a path segment that arrives as free
// text. The stakes are not symmetrical either: a read with a wrong id costs a
// 404, and a write with a wrong id starts a build on somebody's branch.
//
// **Neither write below has been sent to Azure DevOps.** Both are written from
// Microsoft's reference plus what `pull-request.ts` already ships; T-040 has a
// human make the first real attempt against a throwaway pull request. The PAT is
// only known to hold `vso.build`, so a 403 from `vso.build_execute` is a likely
// first answer and is passed through verbatim rather than folded into one of ours.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/**
 * A pipeline stage's `identifier`, which is not a GUID and not a number.
 *
 * `__default` on 14 of 14 sampled builds, and YAML stage names are identifiers by
 * the schema's own rules — so the set of characters allowed here is the set
 * Azure Pipelines allows in `stage:`, and anything else is refused before it can
 * become a path.
 */
const STAGE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const notFoundError = (error: unknown): boolean =>
  error instanceof AdoError && error.status === 404

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive number.`)
  }

  return value as number
}

/**
 * The error rather than `null`, so the message it already carries is the one
 * shown. Duplicated from `pull-request-fn.ts` and `sonar-fn.ts` for the reason
 * stated there: it is five lines, and a shared `connected*` helper invites the
 * next module to import a whole route's worth of types to reach it.
 */
function connectedClient(): AdoClient | NotConnectedError {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return error
    throw error
  }
}

/**
 * What the checks panel renders from.
 *
 * No `notFound`, unlike the detail: `loadChecksReport` answers a section that
 * would not load with a message inside `report.errors`, so a pull request whose
 * evaluations 404 still returns a report — an empty one, with the reason
 * attached to the part that failed. `report: null` means the call itself did not
 * happen.
 */
export interface ChecksReportResult {
  readonly report: ChecksReport | null
  /** `null` when the report loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * What one opened row renders from.
 *
 * `notFound` is here and not on the report because the build read is the one
 * call in this file allowed to fail outright, and its 404 is a real answer worth
 * distinguishing: ADO says `BuildNotFoundException` for a build that has been
 * deleted by retention, which is a different thing to tell a reviewer than
 * "Azure DevOps answered 404".
 */
export interface CheckDetailResult {
  readonly detail: CheckDetail | null
  readonly error: string | null
  readonly connected: boolean
  readonly notFound: boolean
  readonly rateLimit: RateLimit | null
}

/** Whether ADO took the build retry. */
export interface BuildRetryResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Whether ADO took the stage retry.
 *
 * The same three fields as `BuildRetryResult` and a separate type all the same,
 * for `RenameResult`'s reason: a result is read at its call site, and one type
 * for both would have the compiler agreeing that retrying a stage reports
 * whether a whole build was requeued.
 */
export interface StageRetryResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Which build's detail to load.
 *
 * The pull request is not in here on purpose: ADO addresses a build by project
 * and build id, and carrying the repository and PR number would mean validating
 * two values this read does not use. Same reasoning as `RequeueRequest` in
 * `pull-request-fn.ts`.
 */
export function checkDetailRequest(input: unknown): CheckDetailTarget {
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    projectId: guid(raw.projectId, 'projectId'),
    buildId: positive(raw.buildId, 'buildId'),
  }
}

export function buildRetryRequest(input: unknown): BuildRetryRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  return {
    projectId: guid(raw.projectId, 'projectId'),
    buildId: positive(raw.buildId, 'buildId'),
  }
}

export function stageRetryRequest(input: unknown): StageRetryRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (typeof raw.stageRefName !== 'string' || !STAGE.test(raw.stageRefName)) {
    throw new Error('stageRefName must be a stage identifier.')
  }
  if (typeof raw.forceRetryAllJobs !== 'boolean') {
    throw new Error('forceRetryAllJobs must be true or false.')
  }

  return {
    projectId: guid(raw.projectId, 'projectId'),
    buildId: positive(raw.buildId, 'buildId'),
    stageRefName: raw.stageRefName,
    forceRetryAllJobs: raw.forceRetryAllJobs,
  }
}

/**
 * The checks list for one pull request: 1 + N calls, N being the number of
 * distinct builds behind its build policies.
 *
 * Separate from `pullRequestQuery` — which reads the same evaluations for its
 * Policies checklist — because this one also reads a build per policy, and the
 * page should not wait on the build API to draw a title. The two agree because
 * they ask the same endpoint the same question; they arrive apart because one is
 * cheaper than the other.
 */
export const checksReportQuery = createServerFn({ method: 'GET' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<ChecksReportResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { report: null, error: client.message, connected: false, rateLimit: null }
    }

    try {
      return {
        report: await loadChecksReport(client, data),
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        report: null,
        error: message(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  })

/**
 * One check's detail: the timeline, the failing step's log, and the failed tests.
 *
 * Five to six calls and up to ~200 KB, which is why it is a separate function
 * and not a wider report — see `CheckDetail`. A finished build's answer is held
 * in process for an hour; a build that is still running is re-read every time,
 * because that is the only honest thing to do with a timeline that is still
 * being written.
 */
export const checkDetailQuery = createServerFn({ method: 'GET' })
  .validator(checkDetailRequest)
  .handler(async ({ data }): Promise<CheckDetailResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return {
        detail: null,
        error: client.message,
        connected: false,
        notFound: false,
        rateLimit: null,
      }
    }

    try {
      return {
        detail: await loadCheckDetail(client, data),
        error: null,
        connected: true,
        notFound: false,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        detail: null,
        error: message(error),
        connected: true,
        notFound: notFoundError(error),
        rateLimit: client.rateLimit(),
      }
    }
  })

/**
 * "Run that whole build again."
 *
 * `POST` because it changes something, `retry=true` because that is how ADO
 * spells it, and no `rateLimit` in the answer for `RequeueResult`'s reason: the
 * caller re-reads immediately and two counts arriving out of order for one
 * footer is worse than one.
 *
 * **Unsent.** See the header, and `BuildRetryRequest` in the contract for the
 * three separate things a first live attempt has to establish.
 */
export const retryBuildRun = createServerFn({ method: 'POST' })
  .validator(buildRetryRequest)
  .handler(async ({ data }): Promise<BuildRetryResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    try {
      await retryBuild(client, data)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return { ok: false, error: message(error), connected: true }
    }
  })

/**
 * "Run that one stage again."
 *
 * Reachable, tested, and disabled in the panel — every pipeline in this
 * organisation declares exactly one stage, `__default`, so there is nothing here
 * for it to address. It exists because the ticket asks for the granularity and
 * because the next org this app is pointed at may well have stages; it is not
 * enabled because a button whose only possible argument is `__default` retries
 * the whole build while claiming otherwise.
 *
 * **Unsent**, and ADO answers it with no body, so `ok` means "the service did
 * not refuse" and nothing more.
 */
export const retryBuildStage = createServerFn({ method: 'POST' })
  .validator(stageRetryRequest)
  .handler(async ({ data }): Promise<StageRetryResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    try {
      await retryStage(client, data)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return { ok: false, error: message(error), connected: true }
    }
  })
