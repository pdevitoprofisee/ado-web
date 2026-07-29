import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { SonarNotConnectedError, loadSonarProjects, loadSonarReport, sonarClient } from './sonar'
import { pullRequestRef } from './pull-request-fn'

import type { AdoClient, RateLimit } from './ado-client'
import type { SonarClient } from './sonar'
import type { SonarProjectRef, SonarReport, SonarRule } from '../lib/sonar-contract'

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
