import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { pullRequestRef } from './pull-request-fn'
import { linkWorkItem, loadWorkItems, searchWorkItems } from './work-items'

import type { AdoClient } from './ado-client'
import type { PullRequestRef } from './pull-request'
import type { WorkItem, WorkItemSearchRequest } from '../lib/work-item-contract'

// The work items section's entry points: two reads and one write.
//
// The write is the reason this file is careful. Everything interpolated into an
// Azure DevOps path is shape-checked rather than escaped, for `pull-request-fn.ts`'
// reason — a work item id is a path segment, and a wrong one on a read costs a 404
// while a wrong one on a write links somebody else's ticket to this pull request.
//
// **The link has not been sent to Azure DevOps.** Written from Microsoft's
// reference, like both writes in `checks-fn.ts`; the standing rule is no write
// against a colleague's pull request, so the first real attempt is a person using
// it on their own. The stored token is only known to hold read scopes plus
// `vso.code_write` and `vso.build_execute`, so a 403 for a missing `vso.work_write`
// is a likely first answer and is passed through verbatim rather than folded into
// one of ours.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

/**
 * The error rather than `null`, so the message it already carries is the one shown.
 * Duplicated from `pull-request-fn.ts` and `checks-fn.ts` for the reason stated
 * there: it is five lines, and a shared helper invites the next module to import a
 * whole route's worth of types to reach it.
 */
function connectedClient(): AdoClient | NotConnectedError {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return error
    throw error
  }
}

/** What the Work items section renders from. */
export interface WorkItemsQueryResult {
  readonly items: readonly WorkItem[]
  /** How many the pull request claims, which can be more than arrived. */
  readonly total: number
  readonly error: string | null
  readonly connected: boolean
}

/** What the picker's list renders from. */
export interface WorkItemSearchQueryResult {
  readonly items: readonly WorkItem[]
  readonly error: string | null
  readonly connected: boolean
}

/**
 * Whether ADO took the link.
 *
 * Its own type despite matching the retry results field for field, for
 * `StageRetryResult`'s reason: a result is read at its call site, and one shared
 * type would have the compiler agreeing that linking a work item reports whether a
 * build was requeued.
 */
export interface WorkItemLinkResult {
  readonly ok: boolean
  readonly error: string | null
  readonly connected: boolean
}

/** Which work item to link, and to which pull request. */
export interface WorkItemLinkRequest extends PullRequestRef {
  readonly workItemId: number
}

export function workItemSearchRequest(input: unknown): WorkItemSearchRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (typeof raw.query !== 'string') throw new Error('query must be text.')

  return { projectId: guid(raw.projectId, 'projectId'), query: raw.query }
}

export function workItemLinkRequest(input: unknown): WorkItemLinkRequest {
  const ref = pullRequestRef(input)
  const raw = (input ?? {}) as Record<string, unknown>

  // The same check `linkWorkItem` makes again, and for the same reason the reviewer
  // id gets two: this one becomes a path segment on a `PATCH`.
  if (!Number.isSafeInteger(raw.workItemId) || (raw.workItemId as number) <= 0) {
    throw new Error('workItemId must be a work item number.')
  }

  return { ...ref, workItemId: raw.workItemId as number }
}

/**
 * The work items on one pull request. Two calls: refs, then titles.
 *
 * Its own query rather than a section of `pullRequestQuery`, `checksReportQuery`'s
 * arrangement: the page should not wait on the work item API to draw a title, and
 * the picker below the section wants to invalidate this read alone after a link.
 */
export const workItemsQuery = createServerFn({ method: 'GET' })
  .validator(pullRequestRef)
  .handler(async ({ data }): Promise<WorkItemsQueryResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { items: [], total: 0, error: client.message, connected: false }
    }

    try {
      const loaded = await loadWorkItems(client, data)

      return { ...loaded, connected: true }
    } catch (error) {
      return { items: [], total: 0, error: message(error), connected: true }
    }
  })

/**
 * Work items to offer, for what has been typed so far.
 *
 * `GET` even though WIQL underneath is a `POST`: this changes nothing, and calling
 * it a read is what lets the client cache it per query the way the picker needs.
 */
export const workItemSearchQuery = createServerFn({ method: 'GET' })
  .validator(workItemSearchRequest)
  .handler(async ({ data }): Promise<WorkItemSearchQueryResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { items: [], error: client.message, connected: false }
    }

    try {
      const found = await searchWorkItems(client, data.projectId, data.query)

      return { ...found, connected: true }
    } catch (error) {
      return { items: [], error: message(error), connected: true }
    }
  })

/** Attaches an existing work item to this pull request. See the file header. */
export const attachWorkItem = createServerFn({ method: 'POST' })
  .validator(workItemLinkRequest)
  .handler(async ({ data }): Promise<WorkItemLinkResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { ok: false, error: client.message, connected: false }
    }

    const { workItemId, ...ref } = data
    try {
      await linkWorkItem(client, ref, workItemId)

      return { ok: true, error: null, connected: true }
    } catch (error) {
      return { ok: false, error: message(error), connected: true }
    }
  })
