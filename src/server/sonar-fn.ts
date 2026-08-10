import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import {
  SonarNotConnectedError,
  applyTransition,
  loadSonarProjects,
  loadSonarReport,
  sonarClient,
  sonarThreadFor,
} from './sonar'
import { SONAR_TRANSITIONS } from '../lib/sonar-contract'
import { loadBotThreads, setThreadStatus } from './threads'
import { pullRequestRef } from './pull-request-fn'

import type { AdoClient, RateLimit } from './ado-client'
import type { SonarClient } from './sonar'
import type { PullRequestRef } from './pull-request'
import type {
  SonarProjectRef,
  SonarReport,
  SonarResolveRequest,
  SonarResolveResult,
  SonarRule,
  SonarTransition,
} from '../lib/sonar-contract'

// The findings panel's one entry point. The route hands over the same three
// URL values `pullRequestQuery` validates, so `pullRequestRef` is reused rather
// than re-derived — the shape check is about what gets interpolated into an
// Azure DevOps path, and that is the same path here.

/**
 * A pull request with no Sonar status: not an error, not a failure, just nothing
 * to render. Distinct from `report: null`, which means we tried and could not.
 */
const EMPTY_REPORT: SonarReport = {
  projects: [],
  groups: [],
  gate: null,
  failed: [],
  truncated: [],
}

/**
 * What the findings panel renders from.
 *
 * `report: null` with an `error` is the only failed state; a report that arrived
 * with `failed` entries is a *success* that lost some projects, and the panel
 * shows both halves. `report` present with no `projects` means the pull request
 * has no Sonar analysis — the panel renders nothing at all, rather than an empty
 * findings list that reads as "Sonar found no problems".
 *
 * `rules` rides along because it comes from the same round trip the group names
 * come from. Fetching rule detail when somebody expands a rule would be a second
 * call for data we already had.
 */
export interface SonarReportResult {
  readonly report: SonarReport | null
  readonly rules: readonly SonarRule[]
  /** `null` when the report loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  /**
   * False when a credential is missing — **either** the ADO PAT or the Sonar
   * token, because to the person looking at the page both are the same unfinished
   * setup step and `error` names which one.
   */
  readonly connected: boolean
  /** From the one ADO call this makes. Sonar sends no rate-limit information at all. */
  readonly rateLimit: RateLimit | null
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The error rather than `null`, so the message it already carries is the one
 * shown. Duplicated from `pull-request-fn.ts` rather than shared: it is four
 * lines, and a `connected*` helper exported across fn modules invites the next
 * one to import a whole route's worth of types to get at it.
 */
function connectedAdo(): AdoClient | NotConnectedError {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return error
    throw error
  }
}

/** Same shape, the other credential. */
function connectedSonar(): SonarClient | SonarNotConnectedError {
  try {
    return sonarClient()
  } catch (error) {
    if (error instanceof SonarNotConnectedError) return error
    throw error
  }
}

/**
 * Sonar's findings for one pull request.
 *
 * Separate from `pullRequestQuery` for the same reason the iteration changes are:
 * this is three-to-five calls to a second service, one of which is deprecated
 * and any of which can be rate-limited for minutes, and none of that belongs in
 * front of the page's own detail call. The panel loads on its own and fails on
 * its own.
 *
 * The ADO statuses come first and decide everything: no Sonar status means no
 * Sonar call, so a repository that does not use Sonar never touches the token
 * and never shows a panel.
 */
export const sonarReportQuery = createServerFn({ method: 'GET' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<SonarReportResult> => {
    const ado = connectedAdo()
    if (ado instanceof NotConnectedError) {
      return { report: null, rules: [], error: ado.message, connected: false, rateLimit: null }
    }

    let projects: readonly SonarProjectRef[]
    try {
      projects = await loadSonarProjects(ado, data)
    } catch (error) {
      return {
        report: null,
        rules: [],
        error: message(error),
        connected: true,
        rateLimit: ado.rateLimit(),
      }
    }

    if (projects.length === 0) {
      return {
        report: EMPTY_REPORT,
        rules: [],
        error: null,
        connected: true,
        rateLimit: ado.rateLimit(),
      }
    }

    // Only now is the token read at all — and only here, on the server. Nothing
    // below puts it, or anything derived from it, into the returned value.
    const client = connectedSonar()
    if (client instanceof SonarNotConnectedError) {
      return {
        report: null,
        rules: [],
        error: client.message,
        connected: false,
        rateLimit: ado.rateLimit(),
      }
    }

    try {
      const { report, rules } = await loadSonarReport(client, projects)

      return { report, rules, error: null, connected: true, rateLimit: ado.rateLimit() }
    } catch (error) {
      // `loadSonarReport` puts a project's failure in `report.failed`, so
      // reaching here means something outside a single project broke.
      return {
        report: null,
        rules: [],
        error: message(error),
        connected: true,
        rateLimit: ado.rateLimit(),
      }
    }
  })

// ---------------------------------------------------------------------------
// Triaging a finding.
// ---------------------------------------------------------------------------

/** What the thread step does for each transition. Read once, from the contract. */
const THREAD_STATUS = new Map(SONAR_TRANSITIONS.map((one) => [one.transition, one.thread]))

/**
 * The one write, validated the way every other write here is.
 *
 * `transition` is checked against the four this app offers rather than the twelve
 * `do_transition` accepts, and the difference matters: `close` and the security
 * hotspot transitions are real API values that no button sends, and a validator
 * that waves them through turns a missing button into an open endpoint.
 *
 * `issueKey` is checked for shape only. It is not interpolated into a path — it
 * travels as a form parameter — so length and character class are all there is to
 * test, and Sonar answers 404 for a well-shaped key that is not one of its own.
 */
export function resolveRequest(input: unknown): PullRequestRef & SonarResolveRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  if (typeof raw.issueKey !== 'string' || !/^[\w-]{1,64}$/.test(raw.issueKey)) {
    throw new Error('issueKey must be a SonarCloud issue key.')
  }
  if (typeof raw.transition !== 'string' || !THREAD_STATUS.has(raw.transition as SonarTransition)) {
    const offered = [...THREAD_STATUS.keys()].join(', ')
    throw new Error(`transition must be one of ${offered}.`)
  }
  if (raw.comment !== undefined && typeof raw.comment !== 'string') {
    throw new Error('comment must be text.')
  }

  return {
    ...ref,
    issueKey: raw.issueKey,
    transition: raw.transition as SonarTransition,
    comment: raw.comment,
  }
}

/**
 * Triage one finding in SonarCloud, then close the comment ADO shows for it.
 *
 * **Two services, two answers, and neither is inferred from the other.** Sonar is
 * asked first because it owns both the issue state and the quality gate; a thread
 * closed over a finding Sonar still calls open is contradicted by the gate on the
 * same screen. If the transition fails, nothing is written to ADO at all.
 *
 * Once Sonar has agreed, **the thread step cannot fail the operation**. The debt
 * decision is recorded, the gate will move on the next analysis, and an ADO PATCH
 * that failed afterwards is one unfinished write — reported as
 * `thread: 'failed'` beside a `transitioned: true` rather than folded into a
 * single "it did not work", which would send a reviewer to do the whole thing
 * again in the Sonar UI.
 *
 * `thread: 'none'` is the *ordinary* outcome, not a fault. ADO caps Sonar's
 * comments at 50 per pull request, so most findings have no thread — and
 * `confirm` deliberately leaves the one it has open, because confirming an issue
 * is agreeing it is real.
 */
export const resolveSonarFinding = createServerFn({ method: 'POST' })
  .validator(resolveRequest)
  .handler(async ({ data }): Promise<SonarResolveResult> => {
    const { issueKey, transition, comment, ...ref } = data

    const client = connectedSonar()
    if (client instanceof SonarNotConnectedError) {
      return {
        transitioned: false,
        status: null,
        thread: 'none',
        error: client.message,
        threadError: null,
      }
    }

    let status: SonarResolveResult['status']
    try {
      status = await applyTransition(client, issueKey, transition, comment)
    } catch (error) {
      return {
        transitioned: false,
        status: null,
        thread: 'none',
        error: message(error),
        threadError: null,
      }
    }

    const wanted = THREAD_STATUS.get(transition) ?? null
    // Sonar has already agreed by here, so every path below reports
    // `transitioned: true` — including the ones that never reach ADO.
    if (wanted === null) {
      return { transitioned: true, status, thread: 'none', error: null, threadError: null }
    }

    const ado = connectedAdo()
    if (ado instanceof NotConnectedError) {
      return {
        transitioned: true,
        status,
        thread: 'failed',
        error: null,
        threadError: ado.message,
      }
    }

    try {
      const thread = sonarThreadFor(await loadBotThreads(ado, ref), issueKey)
      if (thread === null) {
        return { transitioned: true, status, thread: 'none', error: null, threadError: null }
      }

      await setThreadStatus(ado, ref, { threadId: thread.id, status: wanted })

      return { transitioned: true, status, thread: 'updated', error: null, threadError: null }
    } catch (error) {
      return { transitioned: true, status, thread: 'failed', error: null, threadError: message(error) }
    }
  })
