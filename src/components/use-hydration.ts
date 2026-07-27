import { useCallback, useEffect, useRef, useState } from 'react'

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
const keyOf = (row: PullRequestRow): string => `${row.id}@${row.commitId}`

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const hydratable = (
  row: PullRequestRow,
): row is PullRequestRow & { commitId: string; projectId: string; repositoryId: string } =>
  row.commitId !== null && row.projectId !== null && row.repositoryId !== null

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

/** `requestIdleCallback` is still missing in Safari and in jsdom, so it degrades. */
function onIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    // The timeout is the point: idle may never come on a busy tab, and the rest
    // of the inbox filling in eventually beats it never filling in at all.
    const handle = requestIdleCallback(run, { timeout: 2000 })

    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, 200)

  return () => clearTimeout(handle)
}

export interface Hydrating {
  /** What a row should render, or `undefined` while it is still plain. */
  hydrationOf: (row: PullRequestRow) => HydrationResult | undefined
  /** Ref callback for each `<ul>`; how the hook finds rows to measure. */
  registerList: (element: HTMLUListElement | null) => (() => void) | undefined
}

export function useHydration(rows: readonly PullRequestRow[]): Hydrating {
  const [results, setResults] = useState<ReadonlyMap<string, HydrationResult>>(() => new Map())
  const lists = useRef(new Set<HTMLElement>())

  const registerList = useCallback((element: HTMLUListElement | null) => {
    if (element === null) return undefined
    lists.current.add(element)

    return () => {
      lists.current.delete(element)
    }
  }, [])

  // The effect keys on the rows' *content*, not the array's identity: react-query
  // hands back a fresh array on every poll, and re-hydrating an unchanged inbox
  // each time is precisely what the commit-keyed cache exists to prevent.
  const fingerprint = rows.map(keyOf).join(' ')

  useEffect(() => {
    const wanted = new Map<number, PullRequestRow>()
    for (const row of rows) if (hydratable(row)) wanted.set(row.id, row)
    if (wanted.size === 0) return

    let cancelled = false
    let cancelIdle = () => {}

    const target = (row: PullRequestRow): HydrationTarget => ({
      id: row.id,
      commitId: row.commitId as string,
      projectId: row.projectId as string,
      repositoryId: row.repositoryId as string,
      myVote: row.myVote,
    })

    async function run(batch: readonly PullRequestRow[]): Promise<void> {
      for (let at = 0; at < batch.length && !cancelled; at += CHUNK) {
        const slice = batch.slice(at, at + CHUNK)
        // A transport failure is turned into per-row failures rather than being
        // swallowed: the ticket's rule is that a row whose data did not arrive
        // says so, and a row stuck plain forever says nothing.
        const answers = await hydrateQuery({ data: { targets: slice.map(target) } }).catch(
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
  }, [fingerprint])

  return {
    hydrationOf: (row) => results.get(keyOf(row)),
    registerList,
  }
}
