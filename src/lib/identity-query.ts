import { queryOptions, useQuery } from '@tanstack/react-query'

import { directoryQuery } from '@/server/identity-fn'

import type { FetchStatus } from '@tanstack/react-query'
import type { ReviewerCandidate } from '@/lib/identity-contract'
import type { DirectoryResult } from '@/server/identity-fn'

// The org's directory, asked for once and matched locally — the client half of
// the decision recorded in `src/server/identity.ts`.
//
// The point of this file is the same as `blob-query.ts`': two features want the
// same list, and a second key would mean paying eight calls twice and calling it
// a cache. The `@mention` picker reads it here; T-034's reviewer autocomplete is
// meant to read it here too, with `filterPeople` doing the matching for both.

/**
 * How long the snapshot is believed for: half an hour.
 *
 * This is a directory, not a pull request. People join an org on the scale of
 * days, and the cost of being half an hour behind is that somebody who started
 * this morning has to be mentioned by GUID or after a refresh — against eight
 * calls every time a composer is opened if this were short.
 *
 * `gcTime: Infinity` because the pair is what makes it one fetch per session:
 * every composer on the page mounts and unmounts as threads open, scroll and
 * close, and an entry collected the moment the last one closed would be fetched
 * again by the next one inside the same minute.
 */
const DIRECTORY_STALE_MS = 30 * 60_000

/** How many people a picker shows at once. */
export const MENTION_SUGGESTIONS = 8

/**
 * The shared query. One key, no parameters — there is one directory.
 *
 * `enabled` is deliberately not set: whether the directory is worth fetching yet
 * is the caller's business. The mention picker's answer is "only once somebody
 * has typed an `@`", which it expresses by not mounting the component that reads
 * this at all.
 */
export function directoryOptions() {
  return queryOptions({
    queryKey: ['identity-directory'],
    queryFn: async () => {
      const directory = await directoryQuery()
      if (directory.error === null) saveDirectory(directory)

      return directory
    },
    staleTime: DIRECTORY_STALE_MS,
    gcTime: Infinity,
    // The fetch takes seconds, so a reload starts from the last good copy and
    // refetches behind it once that copy is older than the staleTime.
    initialData: () => savedDirectory()?.directory,
    initialDataUpdatedAt: () => savedDirectory()?.savedAt,
  })
}

const STORAGE_KEY = 'identity-directory'

interface SavedDirectory {
  readonly savedAt: number
  readonly directory: DirectoryResult
}

// `localStorage` throws in a hardened profile and is absent during prerender.
function savedDirectory(): SavedDirectory | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)

    return raw === null ? undefined : (JSON.parse(raw) as SavedDirectory)
  } catch {
    return undefined
  }
}

function saveDirectory(directory: DirectoryResult): void {
  try {
    const saved: SavedDirectory = { savedAt: Date.now(), directory }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // A session that cannot persist still gets the in-memory cache.
  }
}

export function useDirectory() {
  return useQuery(directoryOptions())
}

/** Only what `directoryNote` reads, so it stays a function over four fields. */
interface DirectoryState {
  readonly fetchStatus: FetchStatus
  readonly status: 'pending' | 'error' | 'success'
  readonly error: Error | null
  readonly data: DirectoryResult | undefined
}

/**
 * What to say about the read itself, or `null` when the directory arrived.
 *
 * Shared by both pickers because both got the same two states wrong. A *paused*
 * query is `pending` forever — React Query's default `networkMode` holds it there
 * for as long as the browser claims to be offline — so a picker that only asks
 * `isPending` says "looking up…" until the tab is reloaded and never says why. An
 * *errored* query is the same trap one step on: `data` is undefined then, so the
 * next branch down reads the failure as an empty directory and says everybody is
 * already on the pull request.
 */
export function directoryNote(directory: DirectoryState): string | null {
  if (directory.fetchStatus === 'paused') {
    return 'This browser says it is offline, so nobody can be looked up.'
  }
  if (directory.status === 'pending') return 'Looking up who is in the organisation…'
  if (directory.status === 'error') {
    // An empty message as well as a missing one: `Error('')` reads as a blank
    // sentence under the field, which is worse than admitting there is no reason.
    const reason = directory.error?.message ?? ''

    return `The list of people could not be read. ${reason === '' ? 'No reason was given.' : reason}`
  }

  return directory.data?.error ?? null
}

/**
 * Where a candidate matched, best first. Lower sorts earlier.
 *
 * The order exists because a substring match on 344 people finds too many: typing
 * `jo` should offer `Jordan` before `Marjorie` and before somebody whose mail
 * address merely contains `jo`. Names first, then addresses; prefixes before the
 * middle of a word.
 */
function rank(person: ReviewerCandidate, needle: string): number {
  const name = person.displayName.toLowerCase()
  const mail = person.uniqueName.toLowerCase()

  if (name.startsWith(needle)) return 0
  // The surname case, which is the whole reason this is a local list:
  // `subjectquery` matches a prefix of the *whole* display name, so searching
  // Azure DevOps for `Vincent` finds Jordan Vincent 0 times.
  if (name.split(/[\s,.'-]+/).some((word) => word.startsWith(needle))) return 1
  if (mail.startsWith(needle)) return 2
  if (name.includes(needle)) return 3
  if (mail.includes(needle)) return 4

  return -1
}

/**
 * The people worth offering for what has been typed so far.
 *
 * An empty query is not an empty answer — it is the top of the alphabet, because
 * typing `@` on its own is a request to be shown who is there. `people` arrives
 * sorted by display name (`loadDirectory`), and `sort` is stable in every engine
 * this runs in, so the order inside a rank stays alphabetical.
 */
export function filterPeople(
  people: readonly ReviewerCandidate[],
  query: string,
  limit: number = MENTION_SUGGESTIONS,
): readonly ReviewerCandidate[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return people.slice(0, limit)

  return people
    .map((person) => ({ person, at: rank(person, needle) }))
    .filter((scored) => scored.at >= 0)
    .sort((left, right) => left.at - right.at)
    .slice(0, limit)
    .map((scored) => scored.person)
}
