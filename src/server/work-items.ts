import { WORK_ITEM_BATCH, WORK_ITEM_FIELDS, WORK_ITEM_SUGGESTIONS } from '../lib/work-item-contract'
import { prBase } from './pull-request'

import type { WorkItem, WorkItemSearchResult, WorkItemsResult } from '../lib/work-item-contract'
import type { AdoClient } from './ado-client'
import type { PullRequestRef } from './pull-request'

// Work items: reading the ones on a pull request, finding others, and linking one.
//
// **The read is two calls and cannot be one.** `pullRequests/{id}/workitems`
// answers refs — an id and an API url, no title — and `workItemRefs` is never on
// the pull request list payload (0 of 164 measured), so there is nowhere cheaper to
// get it from. 92 of 164 active pull requests have at least one, and the largest
// has 17. Both calls are cheap: 0.0049 and 0.0385 TSTU.
//
// **The link is a write on the work item, not on the pull request.** Azure DevOps
// has no endpoint that attaches a work item to a pull request. What exists is an
// `ArtifactLink` relation on the *work item*, added with a JSON Patch document —
// which is why `AdoClient.write` learned a per-call content type. Two consequences
// worth knowing before reading `linkWorkItem`: the scope is `vso.work_write`, which
// the stored token is not documented to hold, and `docs/map.md` lists work item
// editing as out of scope. So a 403 is a plausible first answer, and it is reported
// as a sentence rather than hidden — `requeueEvaluation`'s posture.
//
// **Unlinking is not here.** Removing a relation means removing it *by index*,
// which means reading the relations first and sending the item's `rev` along so a
// concurrent edit cannot shift the index under the write. That is a second feature
// with its own failure mode, and this one is worth having without it: a wrong link
// is removed in Azure DevOps, one click away through the row.

/** ADO's own name for a patch document, and the only content type `wit` accepts. */
const JSON_PATCH = 'application/json-patch+json'

/**
 * What one work item looks like on the wire.
 *
 * Every field is optional because `errorPolicy=omit` is always sent: the batch
 * answers 200 with the survivors, and a shape that assumed `fields` was there
 * would throw on the answer that was designed to be partial.
 */
interface AdoWorkItem {
  readonly id?: number
  readonly fields?: Record<string, unknown>
}

/** The refs call. `id` really is a string here — see `WorkItem.id`. */
interface AdoWorkItemRef {
  readonly id?: string
}

const text = (fields: Record<string, unknown>, name: string): string => {
  const value = fields[name]

  return typeof value === 'string' ? value : ''
}

/**
 * A ref's id as a number, or `null`.
 *
 * `Number('')` is 0 and `Number('12abc')` is NaN, so both are checked rather than
 * trusting the parse: an id of 0 is an id ADO answers 404 for, and one unusable id
 * in a batch used to cost every good id sent with it.
 */
function refId(ref: AdoWorkItemRef): number | null {
  const parsed = Number(ref.id)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function batches(ids: readonly number[]): number[][] {
  const chunks: number[][] = []
  for (let at = 0; at < ids.length; at += WORK_ITEM_BATCH) {
    chunks.push(ids.slice(at, at + WORK_ITEM_BATCH))
  }

  return chunks
}

function item(org: string, raw: AdoWorkItem): WorkItem | null {
  const fields = raw.fields
  if (raw.id === undefined || fields === undefined) return null

  const project = text(fields, 'System.TeamProject')
  const base = `https://dev.azure.com/${encodeURIComponent(org)}`

  return {
    id: raw.id,
    // An untitled work item is not one this app invents a name for. The row shows
    // the id as well, which is what a reader recognises anyway.
    title: text(fields, 'System.Title'),
    state: text(fields, 'System.State'),
    type: text(fields, 'System.WorkItemType'),
    url:
      project === ''
        ? `${base}/_workitems/edit/${raw.id}`
        : `${base}/${encodeURIComponent(project)}/_workitems/edit/${raw.id}`,
  }
}

/**
 * Titles for ids, in the order the ids were given.
 *
 * Chunked at 200 because 210 answered HTTP 500 with the limit in the message, and
 * `errorPolicy=omit` on every request because one id the credential cannot see
 * otherwise costs the whole batch a 404. Deleted work items are normal, so that
 * flag is not a precaution — it is the working configuration.
 *
 * Matched back by the id ADO echoes, never by position: `loadDirectory` explains
 * why at length, and the failure here is the same one — one dropped id would pair
 * every later row with somebody else's title.
 */
export async function fetchWorkItems(
  client: AdoClient,
  ids: readonly number[],
): Promise<readonly WorkItem[]> {
  if (ids.length === 0) return []

  const chunks = batches(ids)
  const pages = await client.fanOut(chunks, (chunk) =>
    client.get<{ value?: readonly AdoWorkItem[] }>('_apis/wit/workitems', {
      ids: chunk.join(','),
      fields: WORK_ITEM_FIELDS.join(','),
      errorPolicy: 'omit',
    }),
  )

  const found = new Map<number, WorkItem>()
  for (const page of pages) {
    for (const raw of page.value ?? []) {
      const mapped = item(client.org, raw)
      if (mapped !== null) found.set(mapped.id, mapped)
    }
  }

  return ids.map((id) => found.get(id)).filter((one): one is WorkItem => one !== undefined)
}

/**
 * The work items on one pull request.
 *
 * `total` counts the refs and `items` counts the titles, so a work item that was
 * deleted or lives where the credential cannot look becomes a gap the section can
 * say out loud instead of a row that silently is not there.
 */
export async function loadWorkItems(
  client: AdoClient,
  ref: PullRequestRef,
): Promise<WorkItemsResult> {
  const refs = await client.get<{ value?: readonly AdoWorkItemRef[] }>(`${prBase(ref)}/workitems`)
  const ids = (refs.value ?? []).map(refId).filter((id): id is number => id !== null)

  return { items: await fetchWorkItems(client, ids), total: ids.length, error: null }
}

/** A WIQL string literal. Doubling the quote is the only escape WIQL has. */
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * Ids from one WIQL query, newest change first, at most `WORK_ITEM_SUGGESTIONS`.
 *
 * A POST that changes nothing, sent through `write` because `write` is the only
 * path with a body. It inherits the write path's one attempt and no retry, which is
 * stricter than a read needs and costs a search that met a throttle one empty
 * answer. It also lands in the write ledger when the ledger is on — noise, and
 * accurate noise: it is an outgoing POST.
 *
 * Project-scoped so `@project` resolves, with `[System.TeamProject] = @project` on
 * top of that: the route scopes permission, not the query.
 */
async function wiql(client: AdoClient, projectId: string, where: string): Promise<number[]> {
  const query =
    'SELECT [System.Id] FROM WorkItems ' +
    `WHERE [System.TeamProject] = @project AND ${where} ` +
    'ORDER BY [System.ChangedDate] DESC'

  const answer = await client.write<{ workItems?: readonly { id?: number }[] }>(
    'POST',
    `${projectId}/_apis/wit/wiql`,
    { query },
    { $top: WORK_ITEM_SUGGESTIONS },
  )

  const ids: number[] = []
  for (const one of answer?.workItems ?? []) {
    if (Number.isInteger(one.id) && (one.id as number) > 0) ids.push(one.id as number)
  }

  return ids
}

/**
 * The work items to offer when nothing has been typed: mine, most recently changed.
 *
 * Not the same thing as "the ones I last looked at". Azure DevOps has an endpoint
 * for that — `_apis/work/accountmyworkrecentactivity` — and it is preview-only and
 * unproven here, against two calls this file already makes. The cost of the choice
 * is that a work item nobody assigned to you is not offered until you type.
 */
export async function recentWorkItems(
  client: AdoClient,
  projectId: string,
): Promise<WorkItemSearchResult> {
  const ids = await wiql(client, projectId, '[System.AssignedTo] = @Me')

  return { items: await fetchWorkItems(client, ids), error: null }
}

/** Long enough for any real title fragment, short enough not to build a silly query. */
const MAX_QUERY = 200

/**
 * Work items matching what has been typed.
 *
 * **A number is tried as an id first.** Typing `162828` is how somebody who already
 * has the ticket number attaches it, and one batch call answers that exactly. When
 * no such work item comes back, the same number goes on to the title search,
 * because `1628` is also a thing titles contain — so the cheap answer is tried
 * first and the general one is not lost.
 */
export async function searchWorkItems(
  client: AdoClient,
  projectId: string,
  query: string,
): Promise<WorkItemSearchResult> {
  const needle = query.trim().slice(0, MAX_QUERY)
  if (needle === '') return recentWorkItems(client, projectId)

  if (/^\d+$/.test(needle)) {
    const exact = await fetchWorkItems(client, [Number(needle)])
    if (exact.length > 0) return { items: exact, error: null }
  }

  const ids = await wiql(client, projectId, `[System.Title] CONTAINS ${literal(needle)}`)

  return { items: await fetchWorkItems(client, ids), error: null }
}

/**
 * The artifact link that means "this work item is on that pull request".
 *
 * `vstfs:///Git/PullRequestId/{project}%2F{repository}%2F{id}`, with both GUIDs and
 * the slashes percent-encoded *inside* the value. The encoding is part of the
 * identifier rather than part of sending it: ADO parses the three parts out of this
 * one string, and a literal slash there names a different artifact.
 */
export const pullRequestArtifact = (ref: PullRequestRef): string =>
  `vstfs:///Git/PullRequestId/${ref.projectId}%2F${ref.repositoryId}%2F${ref.id}`

/**
 * Links an existing work item to this pull request.
 *
 * **Unproven against Azure DevOps.** Written from the documented shape, like
 * `addReviewer` and `requeueEvaluation` before it, and for the same reason: the
 * standing rule is no write against a colleague's pull request, so the first real
 * answer comes from somebody using this on their own. The likely refusal is a 403
 * for a missing `vso.work_write` scope, and a refusal renders as a sentence.
 *
 * Adding to `/relations/-` needs no index and no `rev` test — the patch appends, so
 * there is nothing a concurrent edit can shift underneath it.
 */
export async function linkWorkItem(
  client: AdoClient,
  ref: PullRequestRef,
  workItemId: number,
): Promise<void> {
  if (!Number.isInteger(workItemId) || workItemId <= 0) {
    throw new Error(`${workItemId} is not a work item id.`)
  }

  await client.write(
    'PATCH',
    `${ref.projectId}/_apis/wit/workitems/${workItemId}`,
    [
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: pullRequestArtifact(ref),
          attributes: { name: 'Pull Request' },
        },
      },
    ],
    {},
    { contentType: JSON_PATCH },
  )
}
