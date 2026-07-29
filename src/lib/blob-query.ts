import { useEffect, useMemo } from 'react'
import { queryOptions, useQueryClient } from '@tanstack/react-query'

import { buildFileTree, treeFiles } from '@/lib/file-tree'
import { onIdle } from '@/lib/idle'
import { fileBlobsQuery } from '@/server/blob-fn'

import type { QueryClient } from '@tanstack/react-query'
import type { ChangedFile, PullRequestRef } from '@/server/pull-request'

// One file's two blobs, asked for from two places: the panel that renders the
// diff, and the page that warms the top of it while you are still reading the
// details tab.
//
// **The point of this file is that those two ask the same question.** A prefetch
// that lands under a key the component does not read is not a warm cache — it is
// the same two calls again, paid twice and looking like a win. So the key, the
// fetcher and the cache policy are defined once here and spread by both callers,
// the way `pullRequestKey` in `requeue.ts` is shared by the route that reads it
// and the mutation that invalidates it.

/**
 * The blob query for one changed file.
 *
 * Keyed by the shas rather than by the pull request: the same blob pair in
 * another PR, or in this one after a rebase that did not touch this file, is the
 * same answer. `staleTime`/`gcTime` are `Infinity` because a blob is addressed by
 * the sha of its own content — refetching one would spend a call to be told the
 * same thing, and letting it fall out of the cache would spend two.
 *
 * `enabled` is deliberately *not* set here. Whether this file is worth fetching
 * yet is the caller's business — a panel asks when it is nearly on screen, the
 * warmer asks for the first few regardless — and it is the only thing about this
 * query the two of them disagree on.
 */
export function fileBlobsOptions(ref: PullRequestRef, file: ChangedFile) {
  return queryOptions({
    queryKey: ['file-blobs', ref.repositoryId, file.path, file.objectId, file.originalObjectId],
    queryFn: () =>
      fileBlobsQuery({
        data: {
          projectId: ref.projectId,
          repositoryId: ref.repositoryId,
          id: ref.id,
          path: file.path,
          objectId: file.objectId,
          originalObjectId: file.originalObjectId,
        },
      }),
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/**
 * How many files a page open may warm before anybody has clicked a diff tab.
 *
 * Six, and it is a policy choice rather than a fitted one. A file costs two blob
 * calls (map: the diff pipeline), so this is **at most 12 calls** on top of the
 * five a page open already spends — against the 588 that warming all 294 files of
 * !24766 would cost for a tab nobody clicked, which is precisely what
 * `changed-file.tsx` defers a screen at a time and what this must not quietly
 * undo.
 *
 * Twelve is also about what the top of the list needs: a panel fetches when it is
 * within `useNearViewport`'s 800px, so the files a switch to the diff tab paints
 * from are the first few in tree order and no more. Past those, scrolling is
 * still what pays.
 *
 * On the budget: T-016 measured 195 blob calls at 1.01 TSTU billed, which puts 12
 * on the order of 0.06 of the 200-per-five-minutes window. That figure is
 * extrapolated and not read — blob text carries no `X-RateLimit-Cost` at all
 * (T-015), so `calls` is the only honest meter here. Which is the other reason
 * the number is small, named, and spent on the details tab only.
 */
const WARM_FILES = 6

/**
 * Warms `files` one at a time, stopping the moment the caller says to.
 *
 * `prefetchQuery` and not `fetchQuery`: an entry already in the cache is left
 * alone — `staleTime: Infinity` means it cannot have gone off — and a fetch the
 * diff tab has already started is *joined* rather than repeated, because it is the
 * same key in the same client. It also swallows a failure, which is right for
 * work nobody asked for: a blob that will not load should say so in the panel
 * that wanted it, not from behind a tab.
 *
 * Sequential, and awaited. Twelve blob calls fired at once would sit in front of
 * this page's own poll in `ado-client.ts`' concurrency gate, which is how a
 * background courtesy becomes the reason the thing you are looking at feels slow.
 */
async function warm(
  client: QueryClient,
  ref: PullRequestRef,
  files: readonly ChangedFile[],
  cancelled: () => boolean,
): Promise<void> {
  for (const file of files) {
    if (cancelled()) return
    await client.prefetchQuery(fileBlobsOptions(ref, file))
  }
}

/**
 * Fetches the top of the diff in the background, so switching to it paints.
 *
 * Mounted by the PR detail view and nothing else, so it cannot fire from the
 * inbox — where hovering a row would multiply it by however many rows a cursor
 * crosses, and where the router's `defaultPreload: 'intent'` already makes that a
 * standing hazard the detail route is shaped around.
 *
 * `enabled` is false on the diff tabs on purpose. The panels there are doing this
 * same work against the same keys as they come into view, and a warmer running
 * beside them is at best redundant and at worst 12 calls competing with the
 * screenful being read right now.
 */
export function useWarmDiff(
  ref: PullRequestRef,
  files: readonly ChangedFile[],
  enabled: boolean,
): void {
  const client = useQueryClient()

  // Tree order, from the two functions the diff tab itself orders by: the payload's
  // first six files are not the list's first six — a tree puts `Api/` above
  // `src/` whatever order ADO answered in — so warming the payload's would warm
  // six files nobody sees first.
  const top = useMemo(() => treeFiles(buildFileTree(files)).slice(0, WARM_FILES), [files])

  // The page polls every ~30 s, so `files` is a fresh array while its contents sit
  // perfectly still. Keyed on the shas instead — the same fingerprint trick
  // `useHydration` uses, and for the same reason: an effect that re-runs on every
  // poll would re-schedule this work on a diff that has not moved.
  const fingerprint = top.map((file) => `${file.path}@${file.objectId}`).join(' ')

  useEffect(() => {
    // The file list arrives with the page, but "arrives with" is not "is here":
    // a PR whose changes call failed has none, and a warmer that ran anyway would
    // schedule idle work to iterate nothing.
    if (!enabled || top.length === 0) return

    let cancelled = false
    // Off idle rather than in this commit. The details tab has a description to
    // paint, a policy checklist to lay out and a Sonar panel to fill; none of them
    // should queue behind bytes for a tab that is not on screen.
    const cancelIdle = onIdle(() => void warm(client, ref, top, () => cancelled))

    return () => {
      cancelled = true
      cancelIdle()
    }
    // `top` is read through `fingerprint`, which is what actually changes, and
    // `ref` is rebuilt inline by the route on every render — both would restart
    // this on renders that changed nothing about the diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, enabled, client])
}
