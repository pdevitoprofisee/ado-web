import type { AdoClient } from './ado-client'

// Server-only. Answers one question: which active pull requests belong in front
// of this person right now, and in which of the two sections.
//
// The interesting part is that Azure DevOps cannot answer it. There is no "my
// inbox" endpoint, and `searchCriteria.reviewerId=<me>` does **not** expand team
// membership — measured against the live org, it returned 0 while 4 PRs had my
// team sitting on them as a reviewer. So we list the org's active PRs once and
// partition locally.

/**
 * `$top` clamps at 1000 (T-001). Asking for more is not an error, it is a lie —
 * you get 1000 and no indication you were trimmed.
 */
const PAGE_SIZE = 1000

/**
 * A backstop, not a limit we expect to reach: the loop's real exit is an empty
 * page, and an org with >25k active PRs has bigger problems than this app.
 */
const MAX_PAGES = 25

/** `connectionData` is preview-only; the plain `7.1` earns a 400. */
const CONNECTION_DATA_VERSION = '7.1-preview.1'

/** So is `teams`, on its own preview number. Both verified against a real PAT. */
const TEAMS_VERSION = '7.1-preview.3'

/** `_apis/teams` pages like everything else; 43 teams live, so one page covers it. */
const TEAM_PAGE_SIZE = 500

/**
 * Older than this and it is history, not a queue. Live, every PR in "Assigned
 * to me" was from early 2022 — abandoned work reaching this account through a
 * nested group, with the team's vote already recorded as rejected. Counted
 * rather than dropped: `hidden` is rendered, because a row disappearing with no
 * explanation is the same failure as the filter bugs this file keeps hitting.
 */
const MAX_AGE_MS = 3 * 365 * 24 * 3600e3

interface ConnectionData {
  readonly authenticatedUser?: {
    readonly id?: string
    readonly providerDisplayName?: string
  }
}

interface TeamList {
  readonly value?: ReadonlyArray<{
    readonly id?: string
    readonly name?: string
    readonly projectName?: string
  }>
}

interface IdentityList {
  readonly value?: ReadonlyArray<{
    readonly id?: string
    /** Present only on the `queryMembership=Expanded` lookup. */
    readonly memberOf?: readonly string[]
  }>
}

interface AdoReviewer {
  readonly id?: string
  readonly displayName?: string
  readonly vote?: number
  readonly isContainer?: boolean
}

/** Exported for `history.ts`, which lists the same shape with a different filter. */
export interface AdoPullRequest {
  readonly pullRequestId?: number
  readonly title?: string
  /** Truncated by the list endpoint; see `PullRequestRow.description`. */
  readonly description?: string
  readonly createdBy?: { readonly id?: string; readonly displayName?: string }
  readonly reviewers?: ReadonlyArray<AdoReviewer>
  readonly repository?: {
    readonly id?: string
    readonly name?: string
    readonly project?: { readonly id?: string; readonly name?: string }
  }
  readonly targetRefName?: string
  readonly creationDate?: string
  /** Present only once the PR is closed; `completed` and `abandoned` both carry it. */
  readonly closedDate?: string
  readonly isDraft?: boolean
  readonly lastMergeSourceCommit?: { readonly commitId?: string }
  /** `succeeded` | `conflicts` | `queued` | `rejectedByPolicy` | `failure` | `notSet`. */
  readonly mergeStatus?: string
}

interface PullRequestPage {
  readonly value?: ReadonlyArray<AdoPullRequest>
}

export interface Identity {
  readonly id: string
  readonly displayName: string | null
}

export interface Team {
  readonly id: string
  readonly name: string
}

/**
 * The two ways a pull request stops being open. `notSet` and `active` are the
 * other two `searchCriteria.status` values and neither is history, so they are
 * deliberately not in here.
 */
export type ClosedOutcome = 'completed' | 'abandoned'

export interface PullRequestRow {
  readonly id: number
  readonly title: string
  /**
   * The opening of the description, and `''` when there is none.
   *
   * **The list endpoint truncates this at 400 characters, mid-word, with no flag
   * to say it did.** Measured against the live org: of 49 active pull requests,
   * 43 carried a description and 21 of those came back at exactly 400–403 —
   * !25033's is 2283 characters long and arrives here as its first 400. The full
   * text costs one detail call per pull request, which is the whole reason
   * hydration exists and is not a price an inbox poll can pay.
   *
   * So it is carried for what it is worth — searching (`pr-search.ts`) — and the
   * page says out loud that it is searching 400 characters, rather than letting
   * somebody conclude the term they typed is nowhere in the description.
   */
  readonly description: string
  readonly project: string
  readonly repository: string
  readonly author: string
  readonly targetBranch: string
  readonly createdAt: string
  readonly isDraft: boolean
  /** T-007's cache key — the row is stale exactly when this changes. */
  readonly commitId: string | null
  readonly url: string
  /** Which team put this in front of me, `null` when I am a direct reviewer. */
  readonly viaTeam: string | null
  /**
   * The two GUIDs hydration needs to address this PR. Ids rather than names
   * because ADO's own responses give ids here, and a GUID is the one path
   * segment shape that cannot be anything else (see hydrate-fn.ts).
   */
  readonly projectId: string | null
  readonly repositoryId: string | null
  /**
   * Conflict state, and the one piece of "rich" row data that is free: it is on
   * the list entry already. The per-PR detail call adds only `_links` and
   * `artifactId` over what we have, so hydration never makes it.
   */
  readonly conflicted: boolean
  /** My standing vote: 10 approved, 5 with suggestions, -5 waiting, -10 rejected. */
  readonly myVote: number
  /**
   * How and when this pull request stopped being open — `null` on the inbox,
   * where every row is `active` by construction.
   *
   * Required rather than optional so that a future caller listing closed PRs
   * cannot forget it: the whole point of the history page is that a completed
   * pull request and an abandoned one are different news, and a missing field
   * would render them identically rather than fail.
   */
  readonly closed: { readonly at: string; readonly outcome: ClosedOutcome } | null
}

export interface Inbox {
  readonly identity: Identity
  readonly teams: readonly Team[]
  readonly assignedToMe: readonly PullRequestRow[]
  readonly mine: readonly PullRequestRow[]
  /** Active PRs org-wide — the denominator the two sections were drawn from. */
  readonly scanned: number
  /** Of those, how many were mine or my team's but too old to show. */
  readonly hidden: number
}

/**
 * ADO is not consistent about GUID casing between endpoints, and every identity
 * decision here is a string comparison. A casing mismatch would not throw; it
 * would render an empty inbox, which reads as "nothing to review".
 */
const key = (id: string | undefined): string | null => id?.toLowerCase() ?? null

const branch = (ref: string | undefined): string => ref?.replace(/^refs\/heads\//, '') ?? ''

export async function resolveIdentity(client: AdoClient): Promise<Identity> {
  const data = await client.get<ConnectionData>('_apis/connectionData', {
    'api-version': CONNECTION_DATA_VERSION,
  })
  const id = data.authenticatedUser?.id

  if (!id) {
    throw new Error(
      'Azure DevOps accepted the token but returned no authenticated user, so there is no identity to build an inbox around.',
    )
  }

  return { id, displayName: data.authenticatedUser?.providerDisplayName ?? null }
}

/** A long `descriptors` list is a query string; chunk rather than find the limit. */
const DESCRIPTOR_CHUNK = 100

/**
 * The teams whose review requests are genuinely mine, which is two questions
 * and **not** the one `$mine=true` answers.
 *
 * `_apis/teams?$mine=true` is not membership. Measured live: it returned exactly
 * one team while the account was a direct member of **0 of 43**, and reported
 * 1 of the 28 containers the account actually belongs to. It got the right
 * answer here by luck. Trusting it means a real team assignment can go missing
 * with no error to see — the silent-empty-inbox failure this ticket is about.
 *
 * So: ask the identity service for the *transitive* closure
 * (`queryMembership=Expanded`, one call, no walk — the earlier Graph attempt
 * needed 1+N calls and I got the walk wrong), then intersect it with the org's
 * team list.
 *
 * The intersection is the load-bearing half. The closure is full of security
 * groups, and branch policy staples them to PRs wholesale: `[Products]\
 * Contributors` is a reviewer on **119 of 163** active PRs and this account is
 * in it. Matching the raw closure yields 120 "assigned" PRs — technically
 * correct, useless as an inbox. Intersecting leaves the ticket's actual
 * wording: a team you belong to.
 */
export async function resolveMyTeams(client: AdoClient, identity: Identity): Promise<Team[]> {
  const [self, all] = await Promise.all([
    client.get<IdentityList>(
      '_apis/identities',
      { identityIds: identity.id, queryMembership: 'Expanded' },
      'vssps',
    ),
    client.get<TeamList>('_apis/teams', { $top: TEAM_PAGE_SIZE, 'api-version': TEAMS_VERSION }),
  ])

  const descriptors = self.value?.[0]?.memberOf ?? []
  if (descriptors.length === 0) return []

  const chunks: string[][] = []
  for (let at = 0; at < descriptors.length; at += DESCRIPTOR_CHUNK) {
    chunks.push(descriptors.slice(at, at + DESCRIPTOR_CHUNK))
  }
  const resolved = await client.fanOut(chunks, (chunk) =>
    client.get<IdentityList>('_apis/identities', { descriptors: chunk.join(',') }, 'vssps'),
  )

  const closure = new Set(
    resolved.flatMap((page) => (page.value ?? []).map((entry) => key(entry.id))),
  )

  return (all.value ?? [])
    .filter((team) => team.id !== undefined && closure.has(key(team.id)))
    .map((team) => ({
      id: team.id as string,
      name: team.projectName
        ? `${team.projectName} \\ ${team.name ?? ''}`
        : (team.name ?? (team.id as string)),
    }))
}

/**
 * Every active PR in the org, paged the only way that is correct here.
 *
 * The usual `count < $top` stop condition is *wrong* for this endpoint and it
 * fails silently: the service applies `$top` and only then filters for
 * permissions, so a short page is not the last page — it is a page you were not
 * allowed to see all of. T-001 measured this. There is no continuation token.
 * Advance by the *requested* size, stop on empty, dedupe by id.
 */
export async function listActivePullRequests(client: AdoClient): Promise<AdoPullRequest[]> {
  const seen = new Map<number, AdoPullRequest>()

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.get<PullRequestPage>('_apis/git/pullrequests', {
      'searchCriteria.status': 'active',
      $top: PAGE_SIZE,
      $skip: page * PAGE_SIZE,
    })
    const batch = result.value ?? []
    if (batch.length === 0) break

    for (const pr of batch) {
      if (typeof pr.pullRequestId === 'number') seen.set(pr.pullRequestId, pr)
    }
  }

  return [...seen.values()]
}

/**
 * The three fields a list entry cannot tell you on its own: two are local
 * decisions about *me*, and the third is the caller's own filter restated —
 * `status` is what we asked ADO for, not something the row carries back.
 */
type RowFacts = Partial<Pick<PullRequestRow, 'viaTeam' | 'myVote' | 'closed'>>

/**
 * One ADO list entry flattened into a row. Exported so `history.ts` gets the
 * same URL construction, the same missing-field defaults and the same two GUIDs
 * the detail route is keyed by — a second copy of this would drift, and the
 * failure would be a history page whose rows quietly stop linking into the app.
 */
export function toRow(
  pr: AdoPullRequest,
  org: string,
  { viaTeam = null, myVote = 0, closed = null }: RowFacts = {},
): PullRequestRow {
  const project = pr.repository?.project?.name ?? ''
  const repository = pr.repository?.name ?? ''

  return {
    id: pr.pullRequestId as number,
    title: pr.title ?? '(untitled)',
    description: pr.description ?? '',
    project,
    repository,
    author: pr.createdBy?.displayName ?? 'unknown',
    targetBranch: branch(pr.targetRefName),
    createdAt: pr.creationDate ?? '',
    isDraft: pr.isDraft === true,
    commitId: pr.lastMergeSourceCommit?.commitId ?? null,
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${pr.pullRequestId}`,
    viaTeam,
    projectId: pr.repository?.project?.id ?? null,
    repositoryId: pr.repository?.id ?? null,
    conflicted: pr.mergeStatus === 'conflicts',
    myVote,
    closed,
  }
}

/** Newest first, which is what the ADO web UI shows and what we compare against. */
const byNewest = (a: PullRequestRow, b: PullRequestRow) => b.createdAt.localeCompare(a.createdAt)

export function partition(
  pullRequests: readonly AdoPullRequest[],
  identity: Identity,
  teams: readonly Team[],
  org: string,
  now: number = Date.now(),
): { assignedToMe: PullRequestRow[]; mine: PullRequestRow[]; hidden: number } {
  const me = key(identity.id)
  const teamNames = new Map(teams.map((team) => [key(team.id) as string, team.name]))
  const assignedToMe: PullRequestRow[] = []
  const mine: PullRequestRow[] = []
  let hidden = 0

  /**
   * A date ADO did not send is *kept*. "We could not tell how old this is" is
   * not a reason to hide a review request, and the age column already renders
   * blank for it.
   */
  const tooOld = (pr: AdoPullRequest): boolean => {
    const at = Date.parse(pr.creationDate ?? '')

    return !Number.isNaN(at) && now - at > MAX_AGE_MS
  }

  for (const pr of pullRequests) {
    if (typeof pr.pullRequestId !== 'number') continue

    if (key(pr.createdBy?.id) === me) {
      // A PR cannot be both. Authoring wins: your own PR appearing under
      // "Assigned to me" is a review request you cannot act on.
      if (tooOld(pr)) hidden++
      else mine.push(toRow(pr, org))
      continue
    }

    let direct = false
    let viaTeam: string | null = null
    let myVote = 0
    for (const reviewer of pr.reviewers ?? []) {
      const id = key(reviewer.id)
      if (id === null) continue
      if (!reviewer.isContainer && id === me) {
        direct = true
        myVote = reviewer.vote ?? 0
      } else if (reviewer.isContainer && teamNames.has(id)) {
        viaTeam ??= teamNames.get(id) as string
      }
    }
    if (!direct && viaTeam === null) continue

    // Counted only once it is established the PR was going to be shown, so
    // `hidden` means "yours, and stale" rather than "old, somewhere in the org".
    if (tooOld(pr)) hidden++
    else assignedToMe.push(toRow(pr, org, { viaTeam: direct ? null : viaTeam, myVote }))
  }

  return { assignedToMe: assignedToMe.sort(byNewest), mine: mine.sort(byNewest), hidden }
}

/** Teams need the identity, so the pair chains; kept together so it can run alongside. */
interface Who {
  readonly identity: Identity
  readonly teams: Team[]
}

async function resolveWho(client: AdoClient, fresh: boolean): Promise<Who> {
  const identity = await identityOf(client, fresh)

  return { identity, teams: await resolveMyTeams(client, identity) }
}

/**
 * Who you are, remembered between polls — the single biggest lever on what an
 * inbox left open costs (T-008).
 *
 * Measured live: one `loadInbox` is **6** calls and **4** of them re-derive an
 * answer that does not change — `connectionData`, two `identities` and `teams`.
 * The PR list is the only part of a poll that has news in it. Memoising this
 * takes a poll from 6 calls to 2, which is a larger saving than any interval
 * this ticket could have chosen.
 *
 * Keyed on the client object, so a re-entered PAT or a switched org gets a new
 * client (see `ado.ts`) and therefore a new entry rather than the old identity.
 * The TTL is the bound on how long a genuine membership change stays invisible;
 * an explicit refresh passes `fresh` and skips it entirely, so the staleness is
 * never something you have to wait out.
 */
const WHO_TTL_MS = 30 * 60_000

interface Memo<T> {
  readonly at: number
  readonly value: Promise<T>
}

/**
 * The in-flight promise is what gets stored, not the settled value, so two
 * surfaces asking at once share one call rather than racing to make two.
 */
function memoise<T>(
  store: WeakMap<AdoClient, Memo<T>>,
  client: AdoClient,
  fresh: boolean,
  derive: () => Promise<T>,
): Promise<T> {
  const hit = store.get(client)
  if (!fresh && hit !== undefined && Date.now() - hit.at < WHO_TTL_MS) return hit.value

  const value = derive()
  // A cached rejection would be permanent, and the failure here is a network
  // blip far more often than it is a bad token.
  value.catch(() => {
    if (store.get(client)?.value === value) store.delete(client)
  })
  store.set(client, { at: Date.now(), value })

  return value
}

const rememberedIdentity = new WeakMap<AdoClient, Memo<Identity>>()
const remembered = new WeakMap<AdoClient, Memo<Who>>()

/**
 * Who you are, and nothing else.
 *
 * Memoised separately from `whoAmI` because the two callers want different
 * halves of it: the inbox needs team membership to fill "Assigned to me", and
 * the history page needs only the GUID to filter on. Making history go through
 * `whoAmI` would have made a page of finished pull requests cost `teams` and two
 * `identities` calls it never reads — six instead of two. Nested rather than
 * parallel, so `whoAmI` still buys `connectionData` exactly once.
 */
export function identityOf(client: AdoClient, fresh: boolean): Promise<Identity> {
  return memoise(rememberedIdentity, client, fresh, () => resolveIdentity(client))
}

function whoAmI(client: AdoClient, fresh: boolean): Promise<Who> {
  return memoise(remembered, client, fresh, () => resolveWho(client, fresh))
}

export async function loadInbox(client: AdoClient, fresh = false): Promise<Inbox> {
  const [{ identity, teams }, pullRequests] = await Promise.all([
    whoAmI(client, fresh),
    listActivePullRequests(client),
  ])

  return {
    identity,
    teams,
    ...partition(pullRequests, identity, teams, client.org),
    scanned: pullRequests.length,
  }
}
