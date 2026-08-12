import { useCallback, useEffect, useRef, useState } from 'react'

import { onIdle } from '@/lib/idle'
import { hydrateQuery } from '@/server/hydrate-fn'

import type { HydrationResult, HydrationTarget } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

// Rich row data, fetched after the rows are already on screen. The client drives
// this rather than the server because only the client knows what is above the
// fold — and "visible rows first" is the difference between a list that fills in
// as you read it and one that spends its first second on PRs you scrolled past.

/** Under `MAX_TARGETS` in hydrate-fn.ts, and small enough that badges arrive in waves. */
const CHUNK = 12

/**
 * Keyed by row *and* commit, not by id alone. When a PR is pushed to, its old
 * badges stop matching and the row falls back to plain until the new ones land —
 * which is the honest state. Keying by id would leave the pre-push counts on
 * screen looking current.
 */
const keyOf = (row: PullRequestRow): string =>
  // The draft and conflict flags are in the key for the same reason, one step
  // further on: they feed the ready mark and they move *without* the commit
  // moving, so a published draft would otherwise keep its "not ready" badge for
  // the life of the page. Re-asking costs no ADO call — the server's cache is
  // keyed on the commit, which has not changed, so it answers from sqlite.
  `${row.id}@${row.commitId}${row.isDraft ? '+draft' : ''}${row.conflicted ? '+conflict' : ''}`

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const hydratable = (
  row: PullRequestRow,
): row is PullRequestRow & { commitId: string; projectId: string; repositoryId: string } =>
  row.commitId !== null && row.projectId !== null && row.repositoryId !== null

/**
 * One row as the server asks about it.
 *
 * Module scope rather than inside the effect that used to hold it, because the
 * per-row re-ask below needs the same shape and two spellings of "what this row
 * is" would be two places for the readiness inputs to drift.
 */
const targetOf = (row: PullRequestRow): HydrationTarget => ({
  id: row.id,
  commitId: row.commitId as string,
  projectId: row.projectId as string,
  repositoryId: row.repositoryId as string,
  myVote: row.myVote,
  // Free on the row, and the other half of the readiness judgement the server
  // makes — sending them saves it a detail call it would otherwise need for facts
  // we already have.
  isDraft: row.isDraft,
  conflicted: row.conflicted,
})

/**
 * Which rows are above the fold, read straight off the DOM after paint.
 *
 * Deliberately one measurement rather than an IntersectionObserver: this runs
 * once per inbox load to decide an order, not continuously to track scrolling,
 * and an observer would be a subscription to maintain for an answer we need
 * exactly once.
 */
function visibleIds(lists: ReadonlySet<HTMLElement>): ReadonlySet<number> {
  const ids = new Set<number>()

  for (const list of lists) {
    for (const item of Array.from(list.children)) {
      const id = Number((item as HTMLElement).dataset.prId)
      if (Number.isNaN(id)) continue
      if (item.getBoundingClientRect().top < window.innerHeight) ids.add(id)
    }
  }

  return ids
}

export interface Hydrating {
  /** What a row should render, or `undefined` while it is still plain. */
  hydrationOf: (row: PullRequestRow) => HydrationResult | undefined
  /** Ref callback for each `<ul>`; how the hook finds rows to measure. */
  registerList: (element: HTMLUListElement | null) => (() => void) | undefined
  /**
   * Re-ask Azure DevOps about one row, now, past both halves of the server's
   * cache — what a write made from the table has to do afterwards.
   *
   * Neither of the two things that normally refresh a row can serve that. The
   * commit has not moved, so the fingerprint below is unchanged; and the row is
   * settled, so the server would hold its answer for fifteen minutes. Resolving a
   * comment and watching the badge sit there for a quarter of an hour reads as a
   * button that did nothing.
   *
   * Resolves once the row on screen is the row Azure DevOps holds, so the control
   * that called it can stay busy until then. A row missing any of its ids resolves
   * immediately, because there is nothing to ask about.
   */
  refresh: (row: PullRequestRow) => Promise<void>
}

/**
 * `generation` is how Refresh reaches this hook. Bumping it re-runs hydration
 * for rows whose `commitId` has not moved and asks the server to skip its cache
 * entirely.
 *
 * `polledAt` is how the inbox's own clock reaches it: the timestamp of the last
 * successful poll, which advances every cadence whether or not anything changed.
 * Without it this effect fires once per push and never again, and a tab left
 * open would hold the badges it drew on arrival — a PR that finished its builds
 * an hour ago would still be wearing them, because nothing was ever going to
 * move the commit that keys them. Re-asking is not the same as re-fetching:
 * the server decides per row whether its cached answer has aged out, and a
 * settled pull request costs a local sqlite read and no ADO call at all.
 */
export function useHydration(
  rows: readonly PullRequestRow[],
  generation = 0,
  polledAt = 0,
): Hydrating {
  const [results, setResults] = useState<ReadonlyMap<string, HydrationResult>>(() => new Map())
  const lists = useRef(new Set<HTMLElement>())
  const hydrated = useRef(generation)

  const registerList = useCallback((element: HTMLUListElement | null) => {
    if (element === null) return undefined
    lists.current.add(element)

    return () => {
      lists.current.delete(element)
    }
  }, [])

  // The effect keys on the rows' *content*, not the array's identity: react-query
  // hands back a fresh array on every poll, and every keystroke in the list
  // re-renders this component. `polledAt` beside it is the deliberate re-ask, on
  // the inbox's cadence and nothing faster; the fingerprint is what keeps the
  // renders in between from each becoming one.
  const fingerprint = rows.map(keyOf).join(' ')

  useEffect(() => {
    const wanted = new Map<number, PullRequestRow>()
    for (const row of rows) if (hydratable(row)) wanted.set(row.id, row)
    if (wanted.size === 0) return

    let cancelled = false
    let cancelIdle = () => {}
    // True only for the run a Refresh caused, so a subsequent poll that changes
    // the fingerprint goes back to being cache-first.
    const fresh = generation !== hydrated.current
    hydrated.current = generation

    async function run(batch: readonly PullRequestRow[]): Promise<void> {
      for (let at = 0; at < batch.length && !cancelled; at += CHUNK) {
        const slice = batch.slice(at, at + CHUNK)
        // A transport failure is turned into per-row failures rather than being
        // swallowed: the ticket's rule is that a row whose data did not arrive
        // says so, and a row stuck plain forever says nothing.
        const answers = await hydrateQuery({ data: { targets: slice.map(targetOf), fresh } }).catch(
          (error: unknown): HydrationResult[] =>
            slice.map((row) => ({ id: row.id, ok: false, error: message(error) })),
        )
        if (cancelled) return

        const byId = new Map(slice.map((row) => [row.id, row]))
        setResults((previous) => {
          const next = new Map(previous)
          for (const answer of answers) {
            const row = byId.get(answer.id)
            if (row !== undefined) next.set(keyOf(row), answer)
          }

          return next
        })
      }
    }

    const visible = visibleIds(lists.current)
    const above = [...wanted.values()].filter((row) => visible.has(row.id))
    const below = [...wanted.values()].filter((row) => !visible.has(row.id))

    void run(above).then(() => {
      if (cancelled || below.length === 0) return
      cancelIdle = onIdle(() => void run(below))
    })

    return () => {
      cancelled = true
      cancelIdle()
    }
    // `rows` is read through `fingerprint`, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, generation, polledAt])

  const refresh = useCallback(async (row: PullRequestRow): Promise<void> => {
    if (!hydratable(row)) return

    // A failure is stored as this row's failure, exactly as the poll above stores
    // one: the amber "could not load" mark is the honest state, and it is a
    // smaller lie than leaving the badges the write just invalidated on screen.
    const answers = await hydrateQuery({ data: { targets: [targetOf(row)], fresh: true } }).catch(
      (error: unknown): HydrationResult[] => [{ id: row.id, ok: false, error: message(error) }],
    )
    const answer = answers.find((one) => one.id === row.id)
    if (answer === undefined) return

    setResults((previous) => new Map(previous).set(keyOf(row), answer))
  }, [])

  return {
    hydrationOf: (row) => results.get(keyOf(row)),
    registerList,
    refresh,
  }
}
