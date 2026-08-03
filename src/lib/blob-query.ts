import { useEffect, useMemo } from 'react'
import { queryOptions, useQueryClient } from '@tanstack/react-query'

import { buildFileTree, treeFiles } from '@/lib/file-tree'
import { onIdle } from '@/lib/idle'
import { fileBlobsQuery } from '@/server/blob-fn'
import { localBlobsQuery } from '@/server/local-git-fn'

import type { QueryClient } from '@tanstack/react-query'
import type { DiffSource } from './diff-source'
import type { LocalChangedFile } from './local-git-contract'
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
 * The pull request view's diff source: this key, and the name of the service it
 * came from.
 *
 * A wrapper and nothing more — `fileBlobsOptions` above stays the only speller of
 * the key, and this hands it to the panel without repeating a word of it. Built
 * inline on each render, which is free: the panel spreads the options into
 * `useQuery`, which compares the key and not the object it arrived in.
 *
 * The name is what the two failure sentences say. It is hard-coded here rather
 * than passed in because there is only one of it: everything reachable through
 * `fileBlobsOptions` is Azure DevOps by construction.
 */
export function adoDiffSource(ref: PullRequestRef): DiffSource {
  return {
    name: 'Azure DevOps',
    blobsOptions: (file) => fileBlobsOptions(ref, file),
  }
}

/**
 * The same query for a file on this disk.
 *
 * The key namespace is its own — `local-file-blobs` and a slug, not
 * `file-blobs` and a repository GUID — because the two stores answer different
 * shapes for the same path and sha. A local answer carries `note`, and a slug is
 * a directory basename that could perfectly well be spelled like one of the
 * GUIDs above.
 *
 * `LocalChangedFile` and not `ChangedFile`, because the two modes are what keeps
 * a `160000` gitlink away from `cat-file` — the whole reason `LocalBlobRequest`
 * asks for them. The six fields are spread out rather than the row passed whole:
 * the validator on the other end reads exactly these, and a `changeType` on the
 * wire is bytes nobody unpacks.
 */
export function localBlobsOptions(slug: string, file: LocalChangedFile) {
  return queryOptions({
    queryKey: ['local-file-blobs', slug, file.path, file.objectId, file.originalObjectId],
    queryFn: () =>
      localBlobsQuery({
        data: {
          slug,
          file: {
            path: file.path,
            originalPath: file.originalPath,
            objectId: file.objectId,
            originalObjectId: file.originalObjectId,
            beforeMode: file.beforeMode,
            afterMode: file.afterMode,
          },
        },
      }),
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/**
 * The branch diff's source: this repository's files, by path.
 *
 * **The file list is a parameter and that is not incidental.**
 * `DiffSource.blobsOptions` is handed a `ChangedFile`, which is what the panel
 * has and all the panel should need — but a local fetch needs `beforeMode` and
 * `afterMode`, which live on the `LocalChangedFile` the change set answered with
 * and nowhere else. So the source closes over the list and looks the row back up
 * rather than widening the seam for one vendor's two extra fields.
 *
 * A miss is a caller error — a panel rendering a file this change set does not
 * contain — and it answers with a sentence rather than a request with two null
 * modes, which would send a submodule to `cat-file` and report `missing` as a
 * fetch failure. The name is the slug, per `DiffSource.name`: "`platform` did not
 * answer" is true, where "Azure DevOps did not answer" would name a service
 * nobody asked.
 *
 * The `Map` costs one pass over the list, so callers build this in a `useMemo`
 * — unlike `adoDiffSource`, which is free to be inline.
 */
export function localDiffSource(slug: string, files: readonly LocalChangedFile[]): DiffSource {
  const byPath = new Map(files.map((file) => [file.path, file]))

  return {
    name: slug,
    blobsOptions: (file) => {
      const local = byPath.get(file.path)
      if (local !== undefined) return localBlobsOptions(slug, local)

      return {
        // A namespace of its own under the same prefix, so this cannot land on
        // top of a real answer for the same path if the list arrives later.
        queryKey: ['local-file-blobs', slug, file.path, 'not-in-change-set'],
        queryFn: () => ({
          blobs: null,
          error: `\`${file.path}\` is not in this change set.`,
        }),
        staleTime: Infinity,
        gcTime: Infinity,
      }
    },
  }
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
