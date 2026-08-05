import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { loadRepositories } from './repositories'

import type { Repositories } from './repositories'
import type { RateLimit } from './ado-client'

export interface OrgRepositoriesResult {
  readonly repositories: Repositories | null
  /** `null` when the page loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * The same three failure modes as the inbox and the history, returned rather than
 * thrown: no PAT yet is a setup step, a rejected PAT is a re-auth, and a 500 from
 * ADO is "try again". A deliberate mirror of `history-fn.ts`, so a fourth page
 * does not degrade in a fourth private way.
 *
 * **`orgRepositoriesQuery`, not `repositoriesQuery`** — `local-git-fn.ts` already
 * exports that name for the repositories on this disk, and the two lists are
 * different things that a shared name would eventually get confused.
 *
 * No validator, because there is nothing to pass. There is no `fresh` flag here:
 * `loadRepositories` memoises nothing, so a refetch is already a fresh call.
 */
export const orgRepositoriesQuery = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OrgRepositoriesResult> => {
    let client
    try {
      client = adoClient()
    } catch (error) {
      if (error instanceof NotConnectedError) {
        return { repositories: null, error: error.message, connected: false, rateLimit: null }
      }
      throw error
    }

    try {
      return {
        repositories: await loadRepositories(client),
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        repositories: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  },
)
