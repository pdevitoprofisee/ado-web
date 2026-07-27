import { createServerFn } from '@tanstack/react-start'

import { NotConnectedError, adoClient } from './ado'
import { loadInbox } from './inbox'

import type { Inbox } from './inbox'
import type { RateLimit } from './ado-client'

export interface InboxResult {
  readonly inbox: Inbox | null
  /** `null` when the inbox loaded. Never carries a token — see `serviceDetail`. */
  readonly error: string | null
  readonly connected: boolean
  readonly rateLimit: RateLimit | null
}

/**
 * Errors are returned, not thrown, because the three failure modes are different
 * things to a person: no PAT yet is a setup step, a rejected PAT is a re-auth,
 * and a 500 from ADO is "try again". Only the first two are worth a distinct UI,
 * so the split here is `connected` plus a message we wrote ourselves.
 */
export const inboxQuery = createServerFn({ method: 'GET' })
  // `fresh` is what the Refresh button sends. A poll reuses the memoised
  // identity and teams; pressing Refresh means "I think this is wrong", and the
  // memo is one of the things that could be wrong.
  .validator((data: unknown) => ({ fresh: (data as { fresh?: unknown } | null)?.fresh === true }))
  .handler(async ({ data }): Promise<InboxResult> => {
    let client
    try {
      client = adoClient()
    } catch (error) {
      if (error instanceof NotConnectedError) {
        return { inbox: null, error: error.message, connected: false, rateLimit: null }
      }
      throw error
    }

    try {
      return {
        inbox: await loadInbox(client, data.fresh),
        error: null,
        connected: true,
        rateLimit: client.rateLimit(),
      }
    } catch (error) {
      return {
        inbox: null,
        error: error instanceof Error ? error.message : String(error),
        connected: true,
        rateLimit: client.rateLimit(),
      }
    }
  })
