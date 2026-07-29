import { queryOptions, useQuery } from '@tanstack/react-query'

import { directoryQuery } from '@/server/identity-fn'

import type { ReviewerCandidate } from '@/lib/identity-contract'

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
    queryFn: () => directoryQuery(),
    staleTime: DIRECTORY_STALE_MS,
    gcTime: Infinity,
  })
}

export function useDirectory() {
  return useQuery(directoryOptions())
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
