import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { loadDirectory } from './identity'

import type { AdoClient, RateLimit } from './ado-client'
import type { ReviewerCandidate } from '../lib/identity-contract'

// The one entry point for "who is in this org". Two consumers: the `@mention`
// picker in the comment composer (T-035) and T-034's reviewer autocomplete, which
// wants the same list for the same reason and must not fetch it a second time —
// see `src/lib/identity-query.ts`, which owns the cache key they share.
//
// No validator, because there is nothing to validate: this takes no input, so
// nothing from the browser is interpolated into an Azure DevOps path. That is
// also the only reason a directory-wide read is safe to expose at all.

/**
 * The directory as the browser gets it.
 *
 * Flat, readonly, `error` carried rather than thrown, `connected` separate from
 * `error` so a missing PAT is a setup step and not a failure — the shape every
 * other read in `src/server/*-fn.ts` returns.
 *
 * `complete` and `total` are the two honest admissions this list has to make.
 * `complete: false` means Azure DevOps returned enough users that there may be
 * another page this app cannot ask for; `total` above `people.length` means some
 * of the people it listed could not be resolved to an identity id and therefore
 * cannot be mentioned. Both are rendered as a note under the picker, because a
 * silently short directory is indistinguishable from a search that does not work.
 */
export interface DirectoryResult {
  readonly people: readonly ReviewerCandidate[]
  readonly total: number
  readonly complete: boolean
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The five lines every fn module has its own copy of. Duplicated on purpose:
 * shared, it would be one import that drags a route's worth of types behind it.
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
 * Everybody who can be named in a comment.
 *
 * Eight calls, all `GET`, all on `vssps`, and all of them read-only: one page of
 * `graph/users` and one `identities` call per fifty people. Held on the client
 * with a long `staleTime` (`identity-query.ts`), so this runs at most once for as
 * long as somebody keeps the tab open — and not at all until they type an `@`.
 */
export const directoryQuery = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DirectoryResult> => {
    const client = connectedClient()
    if (client instanceof NotConnectedError) {
      return {
        people: [],
        total: 0,
        complete: false,
        error: client.message,
        connected: false,
        rateLimit: null,
      }
    }

    try {
      const directory = await loadDirectory(client)

      return {
        ...directory,
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      // The message from `AdoError`, which carries a status and a URL and never a
      // credential. Nothing derived from the PAT is in this object.
      return {
        people: [],
        total: 0,
        complete: false,
        error: message(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  },
)
