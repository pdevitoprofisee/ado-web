import { identityOf, toRow } from './inbox'

import type { AdoClient } from './ado-client'
import type { AdoPullRequest, ClosedOutcome, Identity, PullRequestRow } from './inbox'

// Server-only. My own pull requests that are over: completed or abandoned,
// newest-closed first.
//
// The inbox cannot answer this and must not try. It lists the org's *active* PRs
// and partitions locally, which is the right shape there because "assigned to
// me" is a question about team membership that ADO will not answer. Here neither
// half applies: the filter is "I wrote it", ADO answers that one directly with
// `searchCriteria.creatorId`, and closed pull requests are unbounded in a way
// active ones are not — this account's history is years deep, so scanning it the
// way the inbox scans the org would be the most expensive page in the app.
//
// So: two targeted calls, capped, and no per-PR hydration. Check state and
// comment counts are 1+N (note: "1+N is irreducible") and they are news about a
// pull request you might still act on. Nothing here is actionable, so nothing
// here is worth N calls.

/**
 * The two closed states, each its own query — `searchCriteria.status` takes one
 * value and `all` would drag every active PR back in with them.
 */
const OUTCOMES: readonly ClosedOutcome[] = ['completed', 'abandoned']

/**
 * The cap, per outcome. Chosen to be a page of reading rather than a scroll
 * through a career, and low enough that the whole page stays inside a single
 * request's worth of ADO budget.
 *
 * It is a real limit and the UI says so. Silently showing the newest 100 of a
 * 600-PR history would be the same class of failure as the filters this codebase
 * keeps getting bitten by: a plausible-looking list that is not the list you
 * asked for.
 */
const PER_OUTCOME = 100

interface PullRequestPage {
  readonly value?: ReadonlyArray<AdoPullRequest>
}

export interface History {
  readonly identity: Identity
  /** Both outcomes interleaved, newest-closed first. */
  readonly rows: readonly PullRequestRow[]
  /**
   * ADO filled at least one of the two requests to the brim, so there is older
   * history this page does not reach.
   *
   * The converse does **not** hold, and the UI must not imply it does: this
   * endpoint returns fewer rows than asked for even when more exist (it filters
   * for permissions after applying `$top`), so a short page is not proof of a
   * complete list. `false` means "we were not told there is more", never "this
   * is all of it".
   */
  readonly capped: boolean
  /** The cap itself, so the page can name the number it was bounded by. */
  readonly perOutcome: number
}

/**
 * One outcome's worth of my closed pull requests.
 *
 * No paging loop on purpose. This is the one listing in the app that is
 * deliberately incomplete, and `$skip` here would be a loop with no natural end
 * — the correct stop condition for this endpoint is an empty page, and an
 * account's closed history never gives one.
 *
 * `searchCriteria.creatorId` is note 1's trap: ADO *silently ignores* a
 * malformed identity filter and answers 200 with everyone's PRs, so this page
 * would render the whole org's history as mine with no error to see. The GUID
 * check is not repeated here because `ado-client.ts` asserts it inside
 * `buildUrl` for every `creatorId`/`reviewerId` param — one chokepoint, and a
 * second copy would be a second thing to keep true.
 */
async function listClosed(
  client: AdoClient,
  creatorId: string,
  status: ClosedOutcome,
): Promise<ReadonlyArray<AdoPullRequest>> {
  const result = await client.get<PullRequestPage>('_apis/git/pullrequests', {
    'searchCriteria.status': status,
    'searchCriteria.creatorId': creatorId,
    $top: PER_OUTCOME,
  })

  return result.value ?? []
}

/**
 * Newest-closed first. A PR ADO gave no `closedDate` for sorts to the bottom
 * rather than to the top, which is where an empty string would otherwise put it
 * under an ascending compare — and the age column already renders blank for it.
 */
const byNewestClosed = (a: PullRequestRow, b: PullRequestRow) =>
  (b.closed?.at ?? '').localeCompare(a.closed?.at ?? '')

export async function loadHistory(client: AdoClient, fresh = false): Promise<History> {
  // Sequential, because the GUID is the filter: there is nothing to ask ADO
  // until we know who we are. Two calls warm — the inbox has already memoised
  // the identity by the time anyone clicks through to this page — and three on a
  // cold process, which is the only case that pays for `connectionData`.
  const identity = await identityOf(client, fresh)
  const pages = await client.fanOut(OUTCOMES, (status) =>
    listClosed(client, identity.id, status).then((value) => ({ status, value })),
  )

  // Keyed by id rather than concatenated, which also drops the entries ADO
  // answered without one — there is no row to build and no link to build to it.
  const seen = new Map<number, PullRequestRow>()
  for (const { status, value } of pages) {
    for (const pr of value) {
      if (typeof pr.pullRequestId !== 'number') continue
      seen.set(
        pr.pullRequestId,
        toRow(pr, client.org, { closed: { at: pr.closedDate ?? '', outcome: status } }),
      )
    }
  }

  return {
    identity,
    rows: [...seen.values()].sort(byNewestClosed),
    capped: pages.some((page) => page.value.length >= PER_OUTCOME),
    perOutcome: PER_OUTCOME,
  }
}
