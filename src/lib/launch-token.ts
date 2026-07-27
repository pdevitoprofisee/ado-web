// The client half of the per-launch token. Isomorphic on purpose: the header
// name and the bootstrap path are a wire contract with src/server/request-guard.ts,
// and a second copy of either is a rename that fails silently as a 403.

export const LAUNCH_TOKEN_HEADER = 'x-ado-web-launch-token'

/**
 * Answered by the request guard before the router is consulted, so it needs no
 * route file. The leading `__` keeps it out of the way of anything the file
 * router will ever generate.
 */
export const LAUNCH_TOKEN_PATH = '/__launch-token'

let inflight: Promise<string> | undefined

/**
 * SSR is off and the shell is prerendered at build time, so there is nowhere to
 * inline a per-launch value — anything in that HTML is baked in once, shipped
 * identically to every launch, and sits on disk. The token has to be fetched at
 * runtime, which means exactly one request that cannot itself carry a token.
 * What protects that request instead is written down in the guard.
 *
 * Memoised per document, and only on success: a bootstrap that failed once must
 * not poison every server-function call for the life of the tab.
 */
export function launchToken(): Promise<string> {
  inflight ??= fetch(LAUNCH_TOKEN_PATH, { headers: { accept: 'text/plain' } })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`launch token bootstrap failed with ${response.status}`)
      }
      return response.text()
    })
    .catch((error: unknown) => {
      inflight = undefined
      throw error
    })

  return inflight
}
