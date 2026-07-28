import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { loadFileBlobs } from './blob'

import type { AdoClient, RateLimit } from './ado-client'
import type { BlobRepo, BlobRequest } from './blob'
import type { FileBlobs } from '../lib/diff-contract'

// Both sides of one file, for the diff view.
//
// Everything here is interpolated into an Azure DevOps *path*, so — as
// `pull-request-fn.ts` and `hydrate-fn.ts` both spell out — it is validated by
// shape rather than merely escaped. A GUID cannot contain a traversal sequence
// and neither can 40 hex digits; an encoded one still can.
//
// **The two shas come in with the request, and that is a deliberate departure
// from T-016's wording** ("takes a PR ref and a file path"). Resolving a path to
// its two shas server-side means the iterations call plus the changes call on
// every file opened, and it means re-implementing `loadFiles` — the parsing that
// already cost this project a shipped crash over `item.path` being `null` on a
// delete. The caller has the `ChangedFile` in hand from the file list it is
// rendering; sending it back is one source of truth and two fewer calls. The
// shas are validated as hard as the GUIDs are, and a PAT holder could read any
// blob in the org through the browser anyway, so this widens nothing.
//
// The pull request id is carried and not used: a blob is repository-scoped and
// does not appear in the URL. It stays because it is what the route addresses
// this call by, and validating a third GUID is free.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
/** Uppercase 40-hex live, but ADO accepts either casing, and so does this. */
const SHA = /^[0-9a-f]{40}$/i

export interface FileBlobsRequest {
  readonly projectId: string
  readonly repositoryId: string
  readonly id: number
  readonly path: string
  readonly objectId: string | null
  readonly originalObjectId: string | null
}

/**
 * What the diff view renders from.
 *
 * `blobs` is null only when the call could not be made at all. A blob that ADO
 * refused is not an error here — it is a `failed` side inside a perfectly good
 * `FileBlobs`, which is the whole point of `BlobSide` having five shapes.
 */
export interface FileBlobsResult {
  readonly blobs: FileBlobs | null
  /** `null` when the file loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
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

export function fileBlobsRequest(input: unknown): FileBlobsRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
    throw new Error('id must be a pull request number.')
  }
  // Not path-validated beyond this: it is a label carried through to the view,
  // never part of a URL. The shas address the content.
  if (typeof raw.path !== 'string' || raw.path === '') {
    throw new Error('path must be a file path.')
  }

  return {
    projectId: guid(raw.projectId, 'projectId'),
    repositoryId: guid(raw.repositoryId, 'repositoryId'),
    id: raw.id as number,
    path: raw.path,
    objectId: sha(raw.objectId, 'objectId'),
    originalObjectId: sha(raw.originalObjectId, 'originalObjectId'),
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

export const fileBlobsQuery = createServerFn({ method: 'GET' })
  .validator(fileBlobsRequest)
  .handler(async ({ data }): Promise<FileBlobsResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return { blobs: null, error: client.message, connected: false, rateLimit: null }
    }

    const repo: BlobRepo = { projectId: data.projectId, repositoryId: data.repositoryId }
    const file: BlobRequest = {
      path: data.path,
      objectId: data.objectId,
      originalObjectId: data.originalObjectId,
    }

    try {
      return {
        blobs: await loadFileBlobs(client, repo, file),
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      // `loadFileBlobs` turns a refused blob into a `failed` side rather than a
      // throw, so reaching here is the cache or the process, not Azure DevOps.
      return {
        blobs: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  })
