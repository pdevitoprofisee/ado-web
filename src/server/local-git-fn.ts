import { createServerFn } from '@tanstack/react-start'

import {
  loadCommitChanges,
  loadCommitPage,
  loadDirtyCount,
  loadLocalBlobs,
  loadLocalChanges,
  loadRemoteRefs,
  openRepository,
  scanRepositories,
} from './local-git'

import type { LocalBlobRequest } from './local-git'
import type {
  CommitChangeSet,
  CommitPage,
  GitRef,
  LocalChangeSet,
  LocalFileBlobs,
  RepositoryDetail,
  RepositoryScan,
} from '../lib/local-git-contract'

// The local repositories, as eight calls a route can await.
//
// Failures are **returned, not thrown**, for the reason rounds 3–5 return them:
// a page that renders a sentence about what went wrong is a page, and a thrown
// error is an error boundary. There is one result type per section rather than
// one shared `LocalGitResult`, because a scan that failed and a blob that failed
// are read by different components and each of them wants the payload it asked
// for typed, not a union to narrow.
//
// What is missing compared to `blob-fn.ts` is `connected` and `rateLimit`: there
// is no PAT here and no service to be throttled by. A repository on this disk is
// either readable or it is not.
//
// **The validators below are belt, not braces.** The braces are in
// `local-git.ts`: a slug is compared against directory names the filesystem just
// produced, and a branch against the refs `for-each-ref` just printed. Nothing
// here is trying to make an arbitrary string safe to hand to `git` — an
// arbitrary string never gets that far. These reject the obviously-wrong early
// so the message names the field instead of naming a repository that was never
// going to be found.

const SHA = /^[0-9a-f]{40}$/i
/** git's own six-digit octal. `100644`, `100755`, `120000`, `160000`, `040000`. */
const MODE = /^[0-7]{6}$/

export interface RepositoriesResult {
  readonly scan: RepositoryScan | null
  readonly error: string | null
}

export interface RepositoryResult {
  readonly detail: RepositoryDetail | null
  readonly error: string | null
}

export interface RemoteRefsResult {
  readonly refs: readonly GitRef[] | null
  /**
   * Served with the list, because the picker's sentence needs it before it can
   * decide what to show: 1,264 refs on `platform` is a filter with a count above
   * it, not a list. It is the length of what was served — nothing is capped here
   * — and it exists so the component does not have to make the reader count.
   */
  readonly count: number
  readonly error: string | null
}

export interface LocalChangesResult {
  readonly changes: LocalChangeSet | null
  readonly error: string | null
}

export interface LocalBlobsResult {
  readonly blobs: LocalFileBlobs | null
  readonly error: string | null
}

export interface DirtyCountResult {
  readonly count: number | null
  readonly error: string | null
}

export interface CommitPageResult {
  readonly page: CommitPage | null
  readonly error: string | null
}

export interface CommitChangesResult {
  readonly changes: CommitChangeSet | null
  readonly error: string | null
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * A slug is a directory basename and nothing else. A separator in one is not a
 * traversal that got through — `locate` would find no directory of that name —
 * it is a caller that built the wrong string, and saying so beats "no repository
 * named `../../etc`".
 */
function slug(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..') {
    throw new Error('slug must name a repository.')
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error('slug is a folder name, not a path.')
  }

  return value
}

/**
 * A ref name, or `null` for "resolve it now" — the branch from `HEAD`, the
 * target from the ladder.
 *
 * Absent and present are both ordinary; empty is not. `?branch=` with nothing
 * after it is a URL that lost its value somewhere, and reading it as "use HEAD"
 * would show a diff of something other than what the link said.
 */
function refName(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${field} must be a ref name.`)
  }

  return value
}

/** `null` is a real answer: an add has no before-sha and a delete has no after-sha. */
function sha(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${field} must be a 40-character hex object id.`)
  }

  return value
}

/** `null` is the side of an add or a delete that has no file to have a mode. */
function mode(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !MODE.test(value)) {
    throw new Error(`${field} must be a six-digit file mode.`)
  }

  return value
}

/** Absent is the first page. A history is paged by offset, so this is a count of commits. */
function offset(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('skip must be a whole number of commits.')
  }

  return value
}

/**
 * A commit id, checked for being a string and **deliberately not for being 40
 * hex**.
 *
 * The hex check lives in `local-git.ts`, where failing it produces the words
 * `COMMIT_LOOKUP_MESSAGE` holds — "That is not a commit id." A rejection here
 * would be a thrown validator instead of a page that says what is wrong, and this
 * is the one field a person can arrive with by editing a URL.
 */
function commitSha(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('sha must name a commit.')
  }

  return value
}

/** `null` takes the first parent. 1-based, the way `<sha>^1` reads. */
function parentIndex(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('parent must be a parent number, counting from 1.')
  }

  return value
}

const slugOnly = (input: unknown): { slug: string } => ({
  slug: slug((input as { slug?: unknown } | null)?.slug),
})

export interface LocalBlobsRequest {
  readonly slug: string
  readonly file: LocalBlobRequest
}

/**
 * The changed file comes back with the request, as it does for Azure DevOps and
 * for the same reason: the caller is rendering the row it came from, and
 * resolving a path to its two shas server-side would mean running the whole diff
 * again for every file opened.
 */
export function localBlobsRequest(input: unknown): LocalBlobsRequest {
  const raw = (input ?? {}) as Record<string, unknown>
  const file = (raw.file ?? {}) as Record<string, unknown>

  // A label carried through to the view, never part of a path this layer builds
  // — the shas address the content and `-C` addresses the repository.
  if (typeof file.path !== 'string' || file.path === '') {
    throw new Error('path must be a file path.')
  }
  if (file.originalPath !== null && typeof file.originalPath !== 'string') {
    throw new Error('originalPath must be a file path or null.')
  }

  return {
    slug: slug(raw.slug),
    file: {
      path: file.path,
      originalPath: file.originalPath as string | null,
      objectId: sha(file.objectId, 'objectId'),
      originalObjectId: sha(file.originalObjectId, 'originalObjectId'),
      beforeMode: mode(file.beforeMode, 'beforeMode'),
      afterMode: mode(file.afterMode, 'afterMode'),
    },
  }
}

/** Every repository under every configured root. No input: the roots are the environment's. */
export const repositoriesQuery = createServerFn({ method: 'GET' }).handler(
  async (): Promise<RepositoriesResult> => {
    try {
      return { scan: await scanRepositories(), error: null }
    } catch (error) {
      // A single unreadable repository is a row in the scan, not this. Reaching
      // here means git could not be started at all, or a root could not be read.
      return { scan: null, error: message(error) }
    }
  },
)

/** One repository: its local refs, its HEAD and its target. */
export const repositoryQuery = createServerFn({ method: 'GET' })
  .validator(slugOnly)
  .handler(async ({ data }): Promise<RepositoryResult> => {
    try {
      return { detail: await openRepository(data.slug), error: null }
    } catch (error) {
      return { detail: null, error: message(error) }
    }
  })

/** The remote-tracking refs, only when something asks. */
export const remoteRefsQuery = createServerFn({ method: 'GET' })
  .validator(slugOnly)
  .handler(async ({ data }): Promise<RemoteRefsResult> => {
    try {
      const refs = await loadRemoteRefs(data.slug)

      return { refs, count: refs.length, error: null }
    } catch (error) {
      return { refs: null, count: 0, error: message(error) }
    }
  })

/** What is between a branch and its target. */
export const localChangesQuery = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>

    return {
      slug: slug(raw.slug),
      branch: refName(raw.branch, 'branch'),
      target: refName(raw.target, 'target'),
    }
  })
  .handler(async ({ data }): Promise<LocalChangesResult> => {
    try {
      const changes = await loadLocalChanges(data.slug, data.branch, data.target)

      return { changes, error: null }
    } catch (error) {
      return { changes: null, error: message(error) }
    }
  })

/** Both blobs of one changed file. */
export const localBlobsQuery = createServerFn({ method: 'GET' })
  .validator(localBlobsRequest)
  .handler(async ({ data }): Promise<LocalBlobsResult> => {
    try {
      return { blobs: await loadLocalBlobs(data.slug, data.file), error: null }
    } catch (error) {
      // `loadLocalBlobs` turns a refused blob into a `failed` side rather than a
      // throw, so reaching here is the repository or the process, not the file.
      return { blobs: null, error: message(error) }
    }
  })

/** One page of a ref's history. `ref` is `null` for the branch HEAD is on. */
export const commitsQuery = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>

    return { slug: slug(raw.slug), ref: refName(raw.ref, 'ref'), skip: offset(raw.skip) }
  })
  .handler(async ({ data }): Promise<CommitPageResult> => {
    try {
      return { page: await loadCommitPage(data.slug, data.ref, data.skip), error: null }
    } catch (error) {
      return { page: null, error: message(error) }
    }
  })

/**
 * The files in one commit, against one of its parents.
 *
 * A commit that has gone — the branch rewritten in a terminal after the page
 * loaded — comes back as words here and **never as a fallback to HEAD**, for the
 * reason a missing ref does: showing the diff of something other than what was
 * asked for is worse than an error.
 */
export const commitChangesQuery = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>

    return { slug: slug(raw.slug), sha: commitSha(raw.sha), parent: parentIndex(raw.parent) }
  })
  .handler(async ({ data }): Promise<CommitChangesResult> => {
    try {
      const changes = await loadCommitChanges(data.slug, data.sha, data.parent)

      return { changes, error: null }
    } catch (error) {
      return { changes: null, error: message(error) }
    }
  })

/** Uncommitted entries, separately, so a 216 ms `status` never delays the diff. */
export const dirtyCountQuery = createServerFn({ method: 'GET' })
  .validator(slugOnly)
  .handler(async ({ data }): Promise<DirtyCountResult> => {
    try {
      return { count: await loadDirtyCount(data.slug), error: null }
    } catch (error) {
      return { count: null, error: message(error) }
    }
  })
