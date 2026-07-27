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

interface AdoPullRequest {
  readonly pullRequestId?: number
  readonly title?: string
  readonly createdBy?: { readonly id?: string; readonly displayName?: string }
  readonly reviewers?: ReadonlyArray<AdoReviewer>
  readonly repository?: {
    readonly name?: string
    readonly project?: { readonly name?: string }
  }
  readonly targetRefName?: string
  readonly creationDate?: string
  readonly isDraft?: boolean
  readonly lastMergeSourceCommit?: { readonly commitId?: string }
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

export interface PullRequestRow {
  readonly id: number
  readonly title: string
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

function toRow(pr: AdoPullRequest, org: string, viaTeam: string | null): PullRequestRow {
  const project = pr.repository?.project?.name ?? ''
  const repository = pr.repository?.name ?? ''

  return {
    id: pr.pullRequestId as number,
    title: pr.title ?? '(untitled)',
    project,
    repository,
    author: pr.createdBy?.displayName ?? 'unknown',
    targetBranch: branch(pr.targetRefName),
    createdAt: pr.creationDate ?? '',
    isDraft: pr.isDraft === true,
    commitId: pr.lastMergeSourceCommit?.commitId ?? null,
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${pr.pullRequestId}`,
    viaTeam,
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
      else mine.push(toRow(pr, org, null))
      continue
    }

    let direct = false
    let viaTeam: string | null = null
    for (const reviewer of pr.reviewers ?? []) {
      const id = key(reviewer.id)
      if (id === null) continue
      if (!reviewer.isContainer && id === me) direct = true
      else if (reviewer.isContainer && teamNames.has(id)) viaTeam ??= teamNames.get(id) as string
    }
    if (!direct && viaTeam === null) continue

    // Counted only once it is established the PR was going to be shown, so
    // `hidden` means "yours, and stale" rather than "old, somewhere in the org".
    if (tooOld(pr)) hidden++
    else assignedToMe.push(toRow(pr, org, direct ? null : viaTeam))
  }

  return { assignedToMe: assignedToMe.sort(byNewest), mine: mine.sort(byNewest), hidden }
}

/** Teams need the identity, so the pair chains; kept together so it can run alongside. */
async function resolveWho(client: AdoClient): Promise<{ identity: Identity; teams: Team[] }> {
  const identity = await resolveIdentity(client)

  return { identity, teams: await resolveMyTeams(client, identity) }
}

export async function loadInbox(client: AdoClient): Promise<Inbox> {
  const [{ identity, teams }, pullRequests] = await Promise.all([
    resolveWho(client),
    listActivePullRequests(client),
  ])

  return {
    identity,
    teams,
    ...partition(pullRequests, identity, teams, client.org),
    scanned: pullRequests.length,
  }
}
