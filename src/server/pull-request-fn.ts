import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { AdoError } from './ado-client'
import { loadChanges, loadPullRequest } from './pull-request'

import type { AdoClient, RateLimit } from './ado-client'
import type { ChangeSet, PullRequestDetail, PullRequestRef } from './pull-request'

// The route addresses a PR by three values out of a URL, which makes all three
// attacker-controlled in the only sense that matters here: every one of them is
// interpolated into an Azure DevOps *path*. So they are validated by shape
// rather than merely escaped, for the same reason `hydrate-fn.ts` spells out —
// a GUID cannot contain a traversal sequence, and an encoded one still can.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

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
      const pullRequest = await loadPullRequest(client, data)

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
