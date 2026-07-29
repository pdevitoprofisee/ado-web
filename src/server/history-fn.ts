import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { loadHistory } from './history'

import type { History } from './history'
import type { RateLimit } from './ado-client'

export interface HistoryResult {
  readonly history: History | null
  /** `null` when the page loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * The same three failure modes as the inbox, returned rather than thrown for the
 * same reason: no PAT yet is a setup step, a rejected PAT is a re-auth, and a 500
 * from ADO is "try again". Kept a deliberate mirror of `inbox-fn.ts` so the two
 * pages degrade identically — a history page that failed in its own private way
 * would be one more thing to learn.
 */
export const historyQuery = createServerFn({ method: 'GET' })
  // `fresh` is Refresh. It reaches the identity memo as well as the list calls,
  // because "I think this is wrong" includes the GUID everything here filters on.
  .validator((data: unknown) => ({ fresh: (data as { fresh?: unknown } | null)?.fresh === true }))
  .handler(async ({ data }): Promise<HistoryResult> => {
    let client
    try {
      client = adoClient()
    } catch (error) {
      if (error instanceof NotConnectedError) {
        return { history: null, error: error.message, connected: false, rateLimit: null }
      }
      throw error
    }

    try {
      return {
        history: await loadHistory(client, data.fresh),
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        history: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  })
