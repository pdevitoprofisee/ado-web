import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { hydrate } from './hydrate'
import { resolveIdentity } from './inbox'

import type { AdoClient } from './ado-client'
import type { HydrationResult, HydrationTarget } from './hydrate'

// The client asks for rich data in batches, because it is the client that knows
// which rows are on screen. That makes every field below attacker-controlled in
// the only sense that matters here — three of them are interpolated into an
// Azure DevOps *path* — so they are validated by shape, not merely escaped.
// A GUID cannot contain a traversal sequence; an encoded one still could.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/i

/**
 * A ceiling on one request, not on the inbox: the client chunks, and this is
 * what stops a malformed caller from turning one round trip into 3N live calls
 * against an org we are already guessing at the rate limit for.
 */
const MAX_TARGETS = 25

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

function target(input: unknown): HydrationTarget {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
    throw new Error('id must be a pull request number.')
  }
  if (typeof raw.commitId !== 'string' || !SHA.test(raw.commitId)) {
    throw new Error('commitId must be a commit sha.')
  }
  if (!Number.isFinite(raw.myVote)) {
    throw new Error('myVote must be a number.')
  }

  return {
    id: raw.id as number,
    commitId: raw.commitId,
    projectId: guid(raw.projectId, 'projectId'),
    repositoryId: guid(raw.repositoryId, 'repositoryId'),
    myVote: raw.myVote as number,
  }
}

function connectedClient(): AdoClient | null {
  try {
    return adoClient()
  } catch (error) {
    if (error instanceof NotConnectedError) return null
    throw error
  }
}

export const hydrateQuery = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const targets = (data as { targets?: unknown } | null)?.targets

    if (!Array.isArray(targets)) throw new Error('targets must be an array.')
    if (targets.length > MAX_TARGETS) {
      throw new Error(`Too many pull requests in one request (max ${MAX_TARGETS}).`)
    }

    return {
      targets: targets.map(target),
      // Refresh, not a poll. The commit-keyed cache cannot see a comment posted
      // without a push, so this is the only way that count ever corrects.
      fresh: (data as { fresh?: unknown } | null)?.fresh === true,
    }
  })
  .handler(async ({ data }): Promise<readonly HydrationResult[]> => {
    // Silent on a missing credential rather than an error per row: the inbox
    // itself already renders the "not connected yet" prompt, and N copies of it
    // in the badge column would bury it.
    const client = connectedClient()
    if (client === null) return []

    /**
     * Resolved once per request, and only if something actually misses the
     * cache — otherwise a fully-cached inbox would still spend a call, and
     * "zero calls on an unchanged second visit" would be a near miss rather
     * than true. Shared between targets so the batch pays for it once.
     */
    let identity: Promise<string> | undefined
    const me = () => (identity ??= resolveIdentity(client).then((who) => who.id.toLowerCase()))

    return client.fanOut(data.targets, (one) => hydrate(client, one, me, undefined, data.fresh))
  })
