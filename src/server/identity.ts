import {
  GRAPH_API_VERSION,
  IDENTITY_API_VERSION,
  IDENTITY_RESOLVE_BATCH,
} from '../lib/identity-contract'

import type { AdoClient } from './ado-client'
import type { ReviewerCandidate, SubjectKind } from '../lib/identity-contract'

// The org's people, once, so that naming one costs nothing.
//
// T-035 had two measured ways to answer "who can I mention", both from
// `docs/research/identity-inventory.md`, and this file is the second one:
//
//   (a) `POST graph/subjectquery` per keystroke on a 150 ms debounce, plus one
//       batched `identities` call to cross the descriptor→GUID gap. Always
//       current, but it is a **prefix** match — `Vincent` returns 0 results for
//       Jordan Vincent — and it is a `POST`, which `ado-client.ts`' `write()`
//       cannot address at all: `write()` hardcodes the core host and the graph
//       API only answers on `vssps`.
//
//   (b) this: one `GET graph/users` (344 users, 457 KB, **no continuation
//       token**) plus `344 / 50 = 7` batched `identities?subjectDescriptors=`
//       calls, held in the browser's query cache with a long `staleTime` and
//       filtered locally.
//
// (b) wins on the two things that matter here. Filtering a list in memory is a
// substring match, so a surname finds somebody — the one behaviour of
// `subjectquery` that would have surprised every user of this picker. And it
// sends no `POST`, which means the single write chokepoint in this app stays
// one-attempt-never-retried and unwidened.
//
// What it costs, honestly: the directory is a snapshot, so somebody who joined
// the org in the last half hour is not in the list until the query goes stale;
// and `graph/users` pages, so this can only see one page of it. Both are
// reported rather than hidden — see {@link Directory}.
//
// The 457 KB never reaches the browser. Only the six fields of
// {@link ReviewerCandidate} cross, which is roughly 150 bytes a person.

/**
 * When to stop believing this is the whole directory.
 *
 * `graph/users` returned **344** users with no `x-ms-continuationtoken` and no
 * token in the body, so one page held all of them. But the only signal that
 * there *is* another page is that header, and `AdoClient.get` hands back parsed
 * JSON — the transport exposes no headers, and widening it for this would be a
 * change to the file every read in the app goes through.
 *
 * So the honest signal available here is the count itself. Microsoft documents
 * the graph list APIs as paging at 500, and 344 is comfortably inside that; a
 * response that comes back at or past 500 is at the boundary and this module
 * cannot tell a full page from a complete directory. That answer is passed up as
 * `complete: false` and the picker says so, rather than offering a truncated
 * directory as if it were everybody.
 */
const DIRECTORY_PAGE_LIMIT = 500

/** A subject as `graph/users` returns it. No `id` — 0 of 344 had one. */
interface GraphSubject {
  readonly descriptor?: string
  readonly subjectKind?: string
  readonly displayName?: string
  /** A key on 344 of 344 and an address on 194. `''` is "absent", not "no mail". */
  readonly mailAddress?: string
  readonly origin?: string
  readonly _links?: { readonly avatar?: { readonly href?: string } | null } | null
}

/** One that can be offered: it has both a name to show and a descriptor to resolve. */
type NamedSubject = GraphSubject & { readonly descriptor: string; readonly displayName: string }

/**
 * An identity as `_apis/identities` returns it with `api-version=7.1` — the two
 * fields this needs and no more. It also carries `providerDisplayName`, which is
 * deliberately unused: the name shown comes from the subject that was searched,
 * so a crossing that fails cannot change what anybody is called.
 *
 * The api-version is not optional. Omitted, the call does not fail — it answers a
 * different, legacy, PascalCase body, and every field below reads `undefined`.
 */
interface AdoIdentity {
  readonly id?: string
  readonly subjectDescriptor?: string
  readonly isActive?: boolean
}

/**
 * Everyone this app can offer to mention, and what it knows it might have
 * missed.
 *
 * `total` is how many named subjects the directory listed; `people.length` is
 * how many of those got as far as having an identity id. They differ when a
 * batch of the crossing failed, and the difference is shown rather than
 * absorbed, because a picker quietly missing fifty colleagues looks exactly like
 * a picker whose search does not work.
 */
export interface Directory {
  readonly people: readonly ReviewerCandidate[]
  readonly total: number
  /** False when the response was big enough that there may be another page. */
  readonly complete: boolean
}

const usable = (subject: GraphSubject): subject is NamedSubject =>
  typeof subject.descriptor === 'string' &&
  subject.descriptor !== '' &&
  typeof subject.displayName === 'string' &&
  subject.displayName !== ''

const kindOf = (raw: string | undefined): SubjectKind => (raw === 'group' ? 'group' : 'user')

function batches(users: readonly NamedSubject[]): NamedSubject[][] {
  const chunks: NamedSubject[][] = []
  for (let at = 0; at < users.length; at += IDENTITY_RESOLVE_BATCH) {
    chunks.push(users.slice(at, at + IDENTITY_RESOLVE_BATCH))
  }

  return chunks
}

/**
 * One batch across the gap: descriptors in, `descriptor → id` out.
 *
 * **Keyed by the descriptor ADO echoes back, never by position.** The temptation
 * is to zip the answers onto the batch by index — the docs say they come back in
 * the order they were sent — and the failure mode of being wrong about that is
 * the worst one available in this feature: every person after the first
 * unresolved descriptor would be paired with somebody else's GUID, and the
 * composer would insert a mention of the wrong colleague with the right name
 * shown next to it. A descriptor that comes back unmatched is dropped instead,
 * which costs one person from the list and cannot mistake anybody for anybody.
 *
 * Fails to an empty map rather than throwing: 50 people missing from the picker
 * is recoverable and visible (`total` still counts them), where one 404 taking
 * the whole directory down is not. And the batch size is the whole reason to
 * care — 70 descriptors answers **404**, indistinguishable from a wrong path.
 */
async function crossing(
  client: AdoClient,
  batch: readonly NamedSubject[],
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>()

  try {
    const page = await client.get<{ value?: readonly (AdoIdentity | null)[] }>(
      '_apis/identities',
      {
        subjectDescriptors: batch.map((user) => user.descriptor).join(','),
        queryMembership: 'None',
        'api-version': IDENTITY_API_VERSION,
      },
      'vssps',
    )

    for (const identity of page.value ?? []) {
      // `null` in place of an identity is a *successful* response containing
      // nothing for that descriptor. It is also what the whole array is when the
      // legacy `descriptors=` parameter is used by mistake.
      if (identity === null || identity === undefined) continue
      if (identity.isActive === false) continue
      const { id, subjectDescriptor } = identity
      if (typeof id !== 'string' || id === '') continue
      if (typeof subjectDescriptor !== 'string' || subjectDescriptor === '') continue
      found.set(subjectDescriptor, id)
    }
  } catch {
    // Left empty on purpose. See above.
  }

  return found
}

const candidate = (user: NamedSubject, identityId: string): ReviewerCandidate => ({
  identityId,
  descriptor: user.descriptor,
  kind: kindOf(user.subjectKind),
  displayName: user.displayName,
  // `''` on the 151 `vsts`-origin service accounts, and the contract says to read
  // the empty string as absent rather than trusting the key.
  uniqueName: user.mailAddress ?? '',
  // Already credential-free — the `MemberAvatars/{descriptor}` form answers 200
  // with no auth header — so this can go straight into an `<img src>`.
  avatarHref: user._links?.avatar?.href ?? '',
})

/**
 * The directory, in one call plus one batched call per fifty people.
 *
 * Sorted by display name here rather than in the picker, so that the list a bare
 * `@` shows is alphabetical without the browser sorting 344 names on every
 * keystroke — and so both consumers of this (the mention picker, and T-034's
 * reviewer autocomplete) get the same order without agreeing on one.
 */
export async function loadDirectory(client: AdoClient): Promise<Directory> {
  const page = await client.get<{ value?: readonly GraphSubject[] }>(
    '_apis/graph/users',
    // Preview-only, permanently: plain `7.1` answers 400 on every `graph/*` path.
    { 'api-version': GRAPH_API_VERSION },
    'vssps',
  )

  const returned = page.value ?? []
  const users = returned.filter(usable)
  const chunks = batches(users)
  const resolved = await client.fanOut(chunks, (batch) => crossing(client, batch))

  const people: ReviewerCandidate[] = []
  chunks.forEach((batch, index) => {
    const found = resolved[index]
    for (const user of batch) {
      const identityId = found.get(user.descriptor)
      if (identityId === undefined) continue
      people.push(candidate(user, identityId))
    }
  })

  people.sort((left, right) => left.displayName.localeCompare(right.displayName))

  return {
    people,
    total: users.length,
    complete: returned.length < DIRECTORY_PAGE_LIMIT,
  }
}
