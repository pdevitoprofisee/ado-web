import { createServerFn } from '@tanstack/react-start'

import { contentId, listViewed, setViewed, viewedKey } from './viewed'

// The file list's read/unread state. The one server function pair in this
// project that makes no Azure DevOps call at all — everything here is local
// SQLite — so there is no client to be connected to and no rate limit to report.
//
// Every field is still validated by shape rather than merely checked, for the
// reason `blob-fn.ts` and `hydrate-fn.ts` both spell out, and the reason holds
// even though nothing below is interpolated into a URL. It is not injection that
// bound parameters would have stopped anyway; it is that a repository id which
// is not a GUID, or a sha which is not forty hex digits, writes a row nothing
// will ever look up again. A mark that quietly fails to come back is worse than
// a rejected request, because the reviewer only finds out by re-reading a file
// they had already read.
//
// **The key format is `${objectId}:${path}`, lower-cased sha.** The file list
// has to build it to test a row against `keys`, and it cannot import
// `viewedKey` from `viewed.ts` to do it: that module reaches `db.ts` and a
// `node:sqlite` import in the client graph breaks the browser bundle. So the
// format is stated here as well as there, and `markViewed` returns the key it
// wrote so the common case — tick a box, update the set — needs no client-side
// construction at all.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
/** Uppercase 40-hex live, but ADO accepts either casing, and so does this. */
const SHA = /^[0-9a-f]{40}$/i

export interface ViewedListRequest {
  readonly repositoryId: string
  readonly id: number
}

export interface MarkViewedRequest extends ViewedListRequest {
  readonly path: string
  readonly objectId: string | null
  readonly originalObjectId: string | null
  readonly viewed: boolean
}

/**
 * `keys` is an array and not the `ReadonlySet` the store returns: a server
 * function's result is JSON, and a `Set` crosses that boundary as `{}`.
 */
export interface ViewedListResult {
  readonly keys: readonly string[]
}

export interface MarkViewedResult {
  /** The key the row was written or removed under, so the caller need not rebuild it. */
  readonly key: string
  readonly viewed: boolean
}

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

/** `null` is a real answer: an add has no before-sha and a delete has no after-sha. */
function sha(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${field} must be a 40-character hex object id.`)
  }

  return value
}

// The project id is absent on purpose, unlike `blob-fn.ts` where it is half the
// blob URL. Nothing here builds a URL, a repository id is a GUID and so unique
// on its own, and a second GUID in the key would only be one more value the file
// list has to get right for a mark to come back.
export function viewedListRequest(input: unknown): ViewedListRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
    throw new Error('id must be a pull request number.')
  }

  return { repositoryId: guid(raw.repositoryId, 'repositoryId'), id: raw.id as number }
}

export function markViewedRequest(input: unknown): MarkViewedRequest {
  const raw = (input ?? {}) as Record<string, unknown>
  const { repositoryId, id } = viewedListRequest(raw)

  // Not path-validated beyond this, for `blob-fn.ts`'s reason: it is a label
  // stored and handed back, never part of a URL.
  if (typeof raw.path !== 'string' || raw.path === '') {
    throw new Error('path must be a file path.')
  }
  if (typeof raw.viewed !== 'boolean') {
    throw new Error('viewed must be a boolean.')
  }

  return {
    repositoryId,
    id,
    path: raw.path,
    objectId: sha(raw.objectId, 'objectId'),
    originalObjectId: sha(raw.originalObjectId, 'originalObjectId'),
    viewed: raw.viewed,
  }
}

export const viewedQuery = createServerFn({ method: 'GET' })
  .validator(viewedListRequest)
  .handler(async ({ data }): Promise<ViewedListResult> => ({
    keys: [...listViewed(data.repositoryId, data.id)],
  }))

export const markViewed = createServerFn({ method: 'POST' })
  .validator(markViewedRequest)
  .handler(async ({ data }): Promise<MarkViewedResult> => {
    // Rejected at the edge rather than stored under a placeholder: a change
    // entry with a blob on neither side has no content for the mark to be about,
    // and inventing a key for it would put a row in the table that no file list
    // can ever match.
    const objectId = contentId(data)
    if (objectId === null) {
      throw new Error('objectId or originalObjectId is required.')
    }

    setViewed(
      { repositoryId: data.repositoryId, pullRequestId: data.id, path: data.path, objectId },
      data.viewed,
    )

    return { key: viewedKey(objectId, data.path), viewed: data.viewed }
  })
