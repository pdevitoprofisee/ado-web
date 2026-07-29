// The shape of a person: how to search for one, how to name one in a comment,
// how to add one as a reviewer, and how to show their face. Types only — this
// file imports nothing, and must not import from `src/server/*` or pull in a
// client, so that the server, the reviewer autocomplete and the @mention
// composer can agree on a shape before any of them exists.
//
// Evidence: `docs/research/identity-inventory.md`. 182 Azure DevOps calls
// against the live `Profisee` org, every one a `GET` except
// `POST _apis/graph/subjectquery` and `POST _apis/graph/subjectlookup`, which
// are searches that use `POST` only because the query travels in a body.
// Nothing under `pullRequests/` was written to, so every write shape below is
// marked documented-not-measured and nothing else in the file depends on it.
//
// The house rule from `sonar-contract.ts` holds: every field was measured, and
// every field whose shape was a surprise carries the number that surprised us.

// ---------------------------------------------------------------------------
// Hosts and versions. Getting either wrong is a 404 or a 400, not a warning.
// ---------------------------------------------------------------------------

/**
 * The host every graph and identity call must go to.
 *
 * Not the host the rest of the app uses. `POST _apis/graph/subjectquery` and
 * `GET _apis/graph/users` on `dev.azure.com` both answer **404** with "The
 * controller for path '/_apis/graph/subjectquery' was not found or does not
 * implement IController" — which reads like a wrong path and is actually a wrong
 * host. On `vssps.dev.azure.com` the same requests answer 200.
 *
 * **The one exception is avatars:** `_apis/GraphProfile/MemberAvatars/{descriptor}`
 * lives on `dev.azure.com`, not on `vssps` — see {@link AvatarRef}.
 *
 * `ado-client.ts` already knows both hosts, but its `write()` hardcodes the core
 * one, and the single authorised `POST` in this whole area is on `vssps`.
 * Whatever issues `subjectquery` has to be able to name its host.
 */
export type IdentityHost = 'vssps'

/**
 * The `api-version` a `graph/*` call needs.
 *
 * Preview-only, permanently. `api-version=7.1` answers 400 "The requested
 * version "7.1" of the resource is under preview. The -preview flag must be
 * supplied in the api-version for such requests" — so the app's global
 * `API_VERSION` cannot be reused here. Omitting it is also a 400.
 * `7.1-preview.1`, `7.2-preview.1`, `7.0-preview.1` and `6.0-preview.1` all
 * answer 200 with identical bodies; `9.9` answers 400 naming 7.2 as the latest.
 */
export const GRAPH_API_VERSION = '7.1-preview.1'

/**
 * The `api-version` an `_apis/identities` call needs — and it is not optional.
 *
 * Omitting it does not fail. It silently returns a different, legacy,
 * PascalCase body: `Id`, `ProviderDisplayName`, and a `Descriptor` that is an
 * object of `{IdentityType, Identifier}` rather than a string. With `7.1` the
 * body is the camelCase shape in {@link ResolvedIdentity}. A client written
 * against one and served the other reads `undefined` everywhere.
 */
export const IDENTITY_API_VERSION = '7.1'

// ---------------------------------------------------------------------------
// The two names for one person. This is the whole difficulty of this area.
// ---------------------------------------------------------------------------

/**
 * A graph subject descriptor: `<origin>.<base64url payload>`.
 *
 * What the graph API speaks. Observed prefixes: `aad.` (a directory user),
 * `vssgp.` (an ADO group — 17 of 30 sampled reviewers), `s2s.` (a service
 * identity), `vsid.`. This is the *only* identifier `subjectquery` hands back:
 * a subject carries **no `id` key at all** (0 of 344 directory users had one).
 *
 * **Do not decode it.** The `aad.` payload base64-decodes to something
 * GUID-shaped, and it is tempting to skip a network call. Across 300 directory
 * users the decoded payload equalled the identity id **0** times. It differed
 * only at character 14 — the UUID version nibble, `7` in the descriptor and `6`
 * in the id — **135** times, and for the other **165** it was not a GUID at all
 * but strings like `<guid>:AgentPoolAdmin:<guid>` and `<guid>:3:S-1-5-21-…`.
 * So the shortcut is right 45% of the time and silently wrong the rest.
 */
export type SubjectDescriptor = string

/**
 * An ADO identity id: a GUID.
 *
 * What everything *except* the graph API speaks — `reviewers/{id}`,
 * `createdBy.id`, `author.id`, and the GUID inside a mention. Crossing from a
 * {@link SubjectDescriptor} to this is the step that costs a network call; see
 * {@link IDENTITY_RESOLVE_BATCH}.
 *
 * **Casing is not stable across endpoints.** `_apis/identities` answers lower
 * case; a mention stores the same GUID upper case. Compare them as written and
 * every mention silently fails to resolve — the bug `people.ts` already guards
 * against by matching case-insensitively.
 */
export type IdentityId = string

/**
 * The AAD object id. Present on nearly every subject, and not a substitute for
 * {@link IdentityId}.
 *
 * Sometimes the same GUID, sometimes a different one, with nothing on the
 * subject to say which: of 299 directory users carrying an `originId`, it
 * equalled the identity id **127** times and differed the other **172**. Both
 * users inspected by hand differed — `Jordan Vincent` is
 * `originId 5c7f1240-567e-…` against `id fbfd3dd4-4d56-…`.
 *
 * That is the worst possible failure mode: use it as an id and it works for
 * roughly two people in five. It is in the contract only so nobody reaches for
 * it as a cheap way across the gap.
 */
export type AadOriginId = string

// ---------------------------------------------------------------------------
// Searching for a person.
// ---------------------------------------------------------------------------

/**
 * What `subjectquery` will search for.
 *
 * Must be an **array**, and must be non-empty. `subjectKind: 'User'` as a bare
 * string answers 400 "Value cannot be null. Parameter name: subjectQuery";
 * omitting the key answers 400 naming `SubjectKind`; `[]` answers 400 "The
 * collection must contain at least one element". An unrecognised value is not an
 * error — `['Nonsense']` and `['Scope']` both answer 200 with zero results.
 *
 * Capitalised going in, lower-cased coming out: the request takes `'User'` and
 * every returned subject says `subjectKind: 'user'`.
 */
export type SubjectKindQuery = 'User' | 'Group'

/** `subjectKind` as it comes back, which is not how it goes in. */
export type SubjectKind = 'user' | 'group'

/**
 * The body of the one authorised `POST` in this area.
 *
 * `POST {vssps}/{org}/_apis/graph/subjectquery?api-version=7.1-preview.1`. It
 * mutates nothing; the query travels in a body because it can be long.
 */
export interface SubjectQuery {
  readonly query: string
  readonly subjectKind: readonly SubjectKindQuery[]
}

/**
 * A person or group as `subjectquery` returns them — the raw candidate, before
 * the gap has been crossed.
 *
 * Note what is **not** here: an `id`. This type cannot add a reviewer and cannot
 * write a mention. It has to be paired with a {@link ResolvedIdentity} first,
 * which is what {@link ReviewerCandidate} is.
 */
export interface SearchableSubject {
  readonly descriptor: SubjectDescriptor
  readonly subjectKind: SubjectKind
  readonly displayName: string
  /**
   * Present as a key on 344 of 344 directory users but carrying an address on
   * only **194** — the rest are `''`, mostly the 151 users whose `origin` is
   * `vsts` rather than `aad` (service accounts and legacy identities). Treat
   * `''` as absent rather than trusting the key.
   */
  readonly mailAddress: string
  readonly originId: AadOriginId | null
  /**
   * `aad`×193 · `vsts`×151 across the directory. Worth keeping, because it
   * predicts whether `mailAddress` will be usable.
   */
  readonly origin: string
  /**
   * The avatar URL ADO has already assembled, lifted from `_links.avatar.href`
   * (the `_links` object also carries `self`, `memberships`, `membershipState`
   * and `storageKey`). This is the credential-free form — see {@link AvatarRef}.
   */
  readonly avatarHref: string
}

/**
 * How the query is matched. Measured, because it decides what the autocomplete
 * can honestly promise.
 *
 * **A prefix match, not a substring search** — a prefix of the display name or a
 * prefix of the mail address, case-insensitively:
 *
 * - `Jordan` → 2 · `jordan` → 2 · `JORDAN` → 2 · `Jorda` → 2
 * - `Jordan Vincent` (the whole display name) → 1
 * - `jordan.vincent` → 1 · `jordan.vincent@profisee.com` → 1
 * - **`Vincent` (the surname) → 0** · `orda` → 0 · `JordanVincent` → 0 ·
 *   `profisee.com` → 0
 *
 * So a user who types a colleague's surname gets nothing back, and the UI has to
 * say "start typing a first name" rather than let an empty list read as "no such
 * person". This is the one behaviour of this endpoint that will surprise
 * everybody who uses it.
 */
export const SUBJECT_QUERY_MATCHES = 'display-name prefix or mail-address prefix' as const

/**
 * The shortest query the endpoint accepts: one character.
 *
 * `''` answers 400 "The string must have at least one character"; omitting
 * `query` answers 400. One character is legal and useful — `J` returned 29
 * users, `Jo` 10, `Jor` 2 — so {@link SUBJECT_QUERY_DEBOUNCE_MS} exists to spare
 * the network, not to satisfy the API.
 */
export const SUBJECT_QUERY_MIN_LENGTH = 1

/**
 * The most subjects one `subjectquery` will ever return.
 *
 * A **hard, silent cap**. `query: 'a'` answers `count: 100` with 100 values;
 * adding `$top=500` answers `count: 100` again; the response carries only
 * `count` and `value`, and **no** `x-ms-continuationtoken`. There is no way to
 * page past it and no way to tell a truncated answer from a complete one.
 *
 * For the UI that means a 1- or 2-character query is not "the first 100 of
 * many", it is "100 of an unknown number", and the picker has to say so rather
 * than imply the list is exhaustive.
 */
export const SUBJECT_QUERY_RESULT_CAP = 100

/**
 * How long a search actually takes, in milliseconds.
 *
 * The same 3-character query six times: 127 · 128 · 130 · 131 · 142 · 149 —
 * median 131. Six *different* 2-character queries: 137 · 137 · 138 · 140 · 151 ·
 * 157 — median 140. So ~135 ms either way, with no sign that repeating a query
 * makes it cheaper.
 *
 * Cheap enough to query per keystroke — `x-ratelimit-cost` on a graph call was
 * **0** every time one was reported.
 */
export const SUBJECT_QUERY_TYPICAL_MS = 135

/**
 * The debounce {@link SUBJECT_QUERY_TYPICAL_MS} argues for: about the length of
 * one call.
 *
 * A debounce shorter than the round trip has a fast typist racing answers
 * against each other, and the endpoint gives no ordering guarantee. Much longer
 * than this is the picker feeling sluggish for no measured reason — the usual
 * 300–500 ms is not justified by a 135 ms call.
 */
export const SUBJECT_QUERY_DEBOUNCE_MS = 150

// ---------------------------------------------------------------------------
// Crossing the gap. The most important measurement in this file.
// ---------------------------------------------------------------------------

/**
 * What `_apis/identities` hands back: both names for one person, side by side.
 *
 * This is the join. `GET {vssps}/{org}/_apis/identities` with either
 * `subjectDescriptors={csv}` or `identityIds={csv}`, plus `queryMembership=None`
 * and `api-version=7.1`, answers `{count, value[]}` in the order the ids were
 * sent.
 *
 * **The parameter name matters more than it looks.** `descriptors=` takes the
 * *legacy* IMS descriptor
 * (`Microsoft.IdentityModel.Claims.ClaimsIdentity;<tenant>\<upn>`) and, handed
 * graph descriptors, answers **200 with `value: [null, null]`** — a successful
 * response containing nothing at all. `subjectDescriptors=` is the one that
 * works, and the two names differ by one word.
 */
export interface ResolvedIdentity {
  readonly id: IdentityId
  readonly subjectDescriptor: SubjectDescriptor
  /**
   * The *legacy* descriptor, e.g.
   * `Microsoft.IdentityModel.Claims.ClaimsIdentity;<tenant>\<upn>` or
   * `Microsoft.TeamFoundation.Identity;S-1-9-…`. Not a
   * {@link SubjectDescriptor}, despite the field name — that is
   * `subjectDescriptor`, one field up.
   */
  readonly descriptor: string
  /** The identity API's name for the display name. It is not `displayName` here. */
  readonly providerDisplayName: string
  readonly isActive: boolean
}

/**
 * A search result that can actually be acted on: a subject paired with its id.
 *
 * What the reviewer autocomplete and the @mention composer both consume.
 * Producing one costs a `subjectquery` plus **one batched** `identities` call for
 * the whole page of candidates — see {@link IDENTITY_RESOLVE_BATCH} — and
 * nothing per candidate.
 */
export interface ReviewerCandidate {
  readonly identityId: IdentityId
  readonly descriptor: SubjectDescriptor
  readonly kind: SubjectKind
  readonly displayName: string
  /** The mail address for a person, `''` for a group or a service identity. */
  readonly uniqueName: string
  readonly avatarHref: string
}

/**
 * How many descriptors (or ids) to put in one `identities` call.
 *
 * The limit is URL length, and it announces itself confusingly. Measured with
 * real descriptors: 10 → 200 (956 URL chars), 50 → 200 (4196), 60 → 200 (4879),
 * **70 → 404** (5695), 100 → 404, 200 → 404. Only at 344 descriptors does it
 * become a 414. So one descriptor too many is a **404**, indistinguishable from
 * a wrong path.
 *
 * The reverse direction is roomier, a GUID being shorter than a descriptor:
 * `identityIds=` with 100 ids (3897 chars) → 200, with 200 → 404.
 *
 * 50 rather than the 60 that worked, to leave headroom: descriptor length varies
 * by kind, and a page of `vssgp.` group descriptors is longer than a page of
 * `aad.` user ones.
 */
export const IDENTITY_RESOLVE_BATCH = 50

/**
 * What one batched crossing costs, in milliseconds.
 *
 * Six consecutive calls of 50 descriptors each: 140 · 145 · 184 · 201 · 218 ·
 * 227 — median 201. Two descriptors took 127 ms, so most of it is fixed cost and
 * batch size is close to free. A full `subjectquery` page of
 * {@link SUBJECT_QUERY_RESULT_CAP} candidates therefore crosses in two calls,
 * ~400 ms, and the handful the user can actually see crosses in one.
 *
 * The alternative is `GET graph/storagekeys/{descriptor}`, whose returned `value`
 * **is** the identity id — the same string, checked against a live reviewer `id`
 * and against `identities?subjectDescriptors=` for the same descriptor, not a
 * related key. But it takes one descriptor at a time at 112–145 ms each, so a
 * page of 100 that way costs ~12 seconds. Use it for a single subject, never for
 * a list.
 */
export const IDENTITY_RESOLVE_TYPICAL_MS = 201

/**
 * The whole directory in one response — the prefetch alternative to querying per
 * keystroke.
 *
 * `GET {vssps}/{org}/_apis/graph/users?api-version=7.1-preview.1` returned
 * **344** users as **457 KB** of JSON in **216 ms** with **no continuation
 * token**: one call, no paging. `graph/groups` returned 156 groups in 36 KB, and
 * `graph/users?subjectTypes=aad` narrows it to 191 users / 37 KB.
 *
 * Tempting, because it fixes the prefix-only matching in
 * {@link SUBJECT_QUERY_MATCHES} — a local list can be substring-matched. The
 * costs are that **not one of the 344 carried an `id`**, so a prefetch still has
 * to cross the gap for whoever gets picked, and 457 KB is a real download to
 * hold for a feature the user may never open.
 *
 * Recorded as a measured option, not a recommendation.
 */
export const DIRECTORY_PREFETCH_BYTES = 457_000

// ---------------------------------------------------------------------------
// Reviewers.
// ---------------------------------------------------------------------------

/**
 * A vote, as the numbers ADO actually sends.
 *
 * Sparse on purpose — these five values, nothing between them. All 30 sampled
 * reviewers voted `0`, so the non-zero values are documented rather than
 * observed: `10` approved · `5` approved with suggestions · `0` no vote · `-5`
 * waiting for author · `-10` rejected.
 */
export type ReviewerVote = 10 | 5 | 0 | -5 | -10

/**
 * A reviewer on a pull request, as `GET .../pullRequests/{id}/reviewers`
 * returns them.
 *
 * **That endpoint is probably unnecessary.** The PR listing already embeds
 * reviewer objects, and across the same 12 pull requests the embedded objects
 * and the endpoint's objects had **identical key sets** — no key on one that was
 * missing from the other, in either direction. Fetching reviewers separately
 * buys a round trip and nothing else. (30 reviewers over 12 PRs: mean 2.5, min
 * 0, max 5, 19 distinct people and groups.)
 *
 * Three fields are **present only when meaningful**, which is the trap in this
 * shape: `isContainer` appeared on 17 of 30, `isRequired` on 13 of 30 and
 * `votedFor` on 11 of 30 — in every case only where the value was `true` or the
 * array non-empty. A missing `isRequired` means `false`, not unknown.
 */
export interface PullRequestReviewer {
  readonly id: IdentityId
  readonly displayName: string
  /**
   * A mail address for a person; for a group, something like
   * `vstfs:///Classification/TeamProject/{projectId}\Contributors`.
   */
  readonly uniqueName: string
  readonly vote: ReviewerVote
  /** Absent unless `true` — 13 of 30. Read absent as `false`. */
  readonly isRequired: boolean
  /** Absent unless `true` — 17 of 30. A group, not a person. */
  readonly isContainer: boolean
  readonly hasDeclined: boolean
  readonly isFlagged: boolean
  /**
   * The groups whose membership put this person on the PR. Absent unless
   * non-empty — 11 of 30. Each entry is itself a reviewer object, which is how a
   * PR assigned to `[Products]\Contributors` surfaces as a named person's row.
   */
  readonly votedFor: readonly PullRequestReviewer[]
  /**
   * Lifted from `_links.avatar.href`, which is the only key in a reviewer's
   * `_links`.
   *
   * A reviewer carries **no `descriptor` field** — 0 of 30 — but this href ends
   * in one on **30 of 30** (`vssgp.`×17, `aad.`×13), and feeding those 19
   * distinct descriptors back through `identities?subjectDescriptors=` recovered
   * each reviewer's own `id` on 30 of 30. So a reviewer becomes a graph subject
   * with no extra call, and their avatar needs no credential — see
   * {@link AvatarRef}.
   */
  readonly avatarHref: string
}

/**
 * Adding and removing a reviewer — **documented, never sent.**
 *
 * Every pull request in this organisation belongs to a colleague, so no write
 * was issued during the census. These shapes are transcribed from Microsoft's
 * REST reference (`git/pull-request-reviewers`) and are **unproven against this
 * server**:
 *
 * - `PUT {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1`
 *   with body `{ "vote": 0, "isRequired": false }`
 * - `DELETE` on the same path to remove
 * - a documented `POST .../reviewers` taking an array, for several at once
 *
 * `{reviewerId}` is documented as an *identity id*, and the read-only evidence
 * agrees: `GET .../reviewers/{guid}` answers 200 while the same path with a
 * graph descriptor answers **400**. Treat it as GUID-only — which is exactly why
 * the autocomplete has to cross the gap before it can add anybody.
 *
 * Still unproven: whether `PUT` on an already-present reviewer upserts or
 * errors, what a removal of an absent reviewer returns, and whether `isRequired`
 * can be changed after the fact.
 */
export interface ReviewerWrite {
  readonly reviewerId: IdentityId
  readonly vote: ReviewerVote
  readonly isRequired: boolean
}

// ---------------------------------------------------------------------------
// Mentions.
// ---------------------------------------------------------------------------

/**
 * How a mention is stored in a comment's `content` — measured, not guessed.
 *
 * Verbatim, from 5 mentions in 5 comments found by scanning 29 pull requests,
 * 218 threads and 232 comments:
 *
 * ```
 * @<DDE322B5-997F-6B0C-8C02-E3C7B90F91D6>
 * @<FBFD3DD4-4D56-641D-9005-AE776A2D856C>
 * @<029ED1BC-3A37-681E-A58C-C15EA66CA450>
 * @<E0C4DCB2-0DD0-4BC8-BE59-0F7805931EA8>
 * ```
 *
 * and in context: `Would love to have
 * @<DDE322B5-997F-6B0C-8C02-E3C7B90F91D6> weigh in here`.
 *
 * Three things that rules out. There is **no display name in the body** — resolve
 * the GUID or the comment is unreadable. There were **zero** occurrences of
 * `#mention:` and **zero** of `<a href=` in all 232 comments, so the
 * anchor-markup guess is wrong. And the comment object carries **no `properties`
 * key at all**; the thread carries only
 * `Microsoft.TeamFoundation.Discussion.SupportsMarkdown` and `…UniqueID`, so
 * there is no side-channel listing who was mentioned — the body is the only
 * record.
 *
 * The GUID arrives **upper case**, 5 of 5, while `_apis/identities` answers
 * lower. `people.ts` owns the parsing and already compares case-insensitively.
 */
export interface MentionTarget {
  readonly identityId: IdentityId
  readonly displayName: string
}

/**
 * The exact form a composer must emit, as a template.
 *
 * The angle brackets are literal. Note that `<GUID>` is a syntactically valid
 * HTML tag name in CommonMark unless the GUID starts with a digit, so a markdown
 * renderer handed a raw mention will eat it — which is why `people.ts` splits
 * mentions out of the text *before* rendering.
 */
export const MENTION_TEMPLATE = '@<{IDENTITY_ID_UPPER_CASE}>' as const

/**
 * Resolving a mention costs nothing extra.
 *
 * `GET _apis/identities?identityIds={csv}&api-version=7.1` — the call
 * `threads.ts` already makes to turn a mention's GUID into a name — returned
 * `subjectDescriptor` alongside `id` on 4 of the 4 distinct mentioned
 * identities. So the avatar for a mentioned person is already in hand, with no
 * second request, and 100 GUIDs fit in one such call.
 *
 * `subjectlookup` cannot do this: handed the same GUIDs it answers 400, because
 * it takes descriptors only.
 */
export const MENTION_RESOLVE_IS_FREE = true

// ---------------------------------------------------------------------------
// Avatars. The one place where "does this need a credential" is the design.
// ---------------------------------------------------------------------------

/**
 * Which of ADO's two avatar URL forms a given href is.
 *
 * They are not interchangeable, and telling them apart is not optional, because
 * **`imageUrl` is not one URL form**. Of 171 `imageUrl` values read off live
 * objects, which form you got depended entirely on which object you read:
 *
 * - a comment `author.imageUrl` → `member-avatar`, 42 of 42
 * - a reviewer `imageUrl` → `identity-image`, 30 of 30
 * - a PR `createdBy.imageUrl` → `identity-image`, 99 of 99
 *
 * So a comment author's avatar can go straight into an `<img src>` and a
 * reviewer's or PR author's cannot. A client must look at the URL rather than
 * trust the field name.
 */
export type AvatarUrlForm = 'member-avatar' | 'identity-image'

/**
 * A face, and whether the browser can fetch it unaided.
 *
 * **`member-avatar`** — `https://dev.azure.com/{org}/_apis/GraphProfile/MemberAvatars/{descriptor}`,
 * the form `_links.avatar.href` always carries and the form a comment author's
 * `imageUrl` happens to carry too. With **no auth header at all**
 * it answers **200** with the same 3471-byte PNG as the authenticated request,
 * so it can go straight into an `<img src>`. Authenticated it sends
 * `Cache-Control: public, must-revalidate, max-age=172800` and an `ETag`;
 * anonymously the caching becomes `no-cache, no-store` and the `ETag` differs
 * from the authenticated one, so the browser re-asks but revalidates cheaply. An
 * unknown descriptor answers **500**, not 404.
 *
 * **`identity-image`** — `https://dev.azure.com/{org}/_api/_common/identityImage?id={guid}`,
 * the form a reviewer's and a PR author's `imageUrl` carries. Without an auth
 * header it answers
 * **302 to the sign-in page**, so in an `<img src>` from the browser it renders
 * as a broken image. An unknown GUID answers **200** with a generated 982-byte
 * `image/svg+xml`, so a wrong id fails silently instead of 404ing — nothing tells
 * you the id was wrong.
 *
 * **So no image proxy is needed for avatars**, as long as the client is handed a
 * descriptor rather than a GUID — and both {@link SearchableSubject} and
 * {@link PullRequestReviewer} supply one for free.
 *
 * A third form, `graph/Subjects/{descriptor}/avatars` on `vssps`, answers JSON
 * with a base64 `value` (6105 bytes decoded; 124377 at `?size=large`) rather
 * than image bytes, so it is only usable server-side.
 */
export interface AvatarRef {
  readonly href: string
  readonly form: AvatarUrlForm
  /** `false` for `member-avatar`, `true` for `identity-image`. Measured both ways. */
  readonly needsCredential: boolean
}

/**
 * How big an avatar is, in bytes — the number the "cache them in SQLite"
 * question needed.
 *
 * Eight avatars fetched with an image `Accept`: 404 · 474 · 485 · 487 · 522 ·
 * 3471 · 6150 · 6656. Median **522**, mean 2331, max under 7 KB. Small enough to
 * store as blobs without thinking about it.
 *
 * The `Accept` header matters when measuring: with `Accept: application/json`
 * some of these URLs answer with a base64 wrapper instead, which inflates every
 * count.
 */
export const AVATAR_TYPICAL_BYTES = 522

/**
 * What an authenticated avatar response says its lifetime is: 2 days, alongside
 * an `ETag`.
 *
 * Sent as `max-age=172800` by both URL forms when credentialed. Whether the
 * `ETag` actually changes when somebody changes their photo was **not tested**,
 * so a cache built on this number should still have a manual way to be cleared.
 */
export const AVATAR_MAX_AGE_SECONDS = 172_800
