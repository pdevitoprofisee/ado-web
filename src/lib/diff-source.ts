import type { QueryFunctionContext } from '@tanstack/react-query'
import type { NotedBlobs } from './diff-contract'
import type { ChangedFile } from '@/server/pull-request'

// Where a diff panel gets its bytes from, and what to call that place in a
// sentence.
//
// `ChangedFileDiff` used to take a `projectId`, a `repositoryId` and a pull
// request id, and the only thing it did with the three of them was build
// `fileBlobsOptions(ref, file)`. That is a service's address sitting in a
// component whose job is to render two columns of text — and round 6 needs the
// same component to render a branch diff read off the local disk, where there
// is no project, no repository GUID and no pull request.
//
// So the address leaves and a source arrives in its place: one function that
// answers "how do I fetch this file", and one string for the two notices that
// have to name whoever failed. **The string is the reason this is an object and
// not a bare function.** A local diff that cannot read a blob must not print
// "Azure DevOps did not answer" about a service nobody asked.
//
// What is deliberately *not* here: the cache key. `fileBlobsOptions` in
// `blob-query.ts` is the only place the ADO blob key is spelled — the page warms
// the top of a diff against that key while the panels read from it, and a second
// speller is two cache entries and twice the calls for one file. This interface
// asks a source for its options and does not build any; the local source gets
// its own key namespace rather than sharing this one.

/**
 * What a blob fetch answers, whichever side of the app answered it.
 *
 * The two fields the panel actually reads, out of the four `FileBlobsResult`
 * carries: `connected` and `rateLimit` are Azure DevOps' own vocabulary and mean
 * nothing to a repository on this disk. A source is free to return more — this
 * is the floor, not the shape.
 *
 * `blobs` is null only when the fetch could not be made at all; a blob the source
 * refused is a `failed` side inside a perfectly good `FileBlobs`.
 *
 * `NotedBlobs` and not `FileBlobs`: the local source answers with a sentence of
 * its own for a submodule and for a mode-only change, and typing the seam
 * narrower than that would hand the note through to `blobNotice` untyped —
 * present at run time, invisible to everyone reading the code.
 */
export interface BlobAnswer {
  readonly blobs: NotedBlobs | null
  /** `null` when the file loaded. Shown verbatim, so it must not carry a secret. */
  readonly error: string | null
}

/**
 * The query options a panel spreads into `useQuery`.
 *
 * The key and the fetcher only, and everything else on the object rides along
 * untyped. Not `UseQueryOptions` widened to `BlobAnswer`, which is the obvious
 * spelling and does not work: that type mentions its own generics in argument
 * position — most visibly in `enabled`, which may be a predicate over the
 * `Query` — so widening it makes a perfectly good options object unassignable
 * for reasons that have nothing to do with blobs. `ReturnType<typeof
 * fileBlobsOptions>` would be worse still: it makes this file import the Azure
 * DevOps one and defeats the point.
 *
 * `queryFn` is a method rather than a property, and optional, so that whatever
 * `queryOptions()` hands back satisfies it — a property arrow is checked
 * strictly against a key type this deliberately does not pin down.
 *
 * Which leaves two things a source is expected to get right that the type cannot
 * make it. The cache policy: `staleTime` and `gcTime` of `Infinity`, for a blob
 * addressed by the sha of its own content, because refetching one spends a call
 * to be told the same thing. It is absent above because `staleTime` alone may be
 * a number, the word `static` or a function, and pinning it down here costs more
 * than it catches. And a key namespace of its own, so that two sources cannot
 * collide on a path that exists in both.
 *
 * `enabled` is deliberately absent, for the reason `fileBlobsOptions` spells out:
 * whether a file is worth fetching yet is the caller's half of the bargain.
 */
export interface BlobQuery {
  readonly queryKey: readonly unknown[]
  queryFn?(context: QueryFunctionContext<readonly unknown[]>): BlobAnswer | Promise<BlobAnswer>
}

/** One place a diff panel can read files from. Injected; never constructed here. */
export interface DiffSource {
  /**
   * What this source is called in prose — "Azure DevOps", or the repository's
   * slug. Read by exactly two sentences, both of them about something going
   * wrong: the panel's "did not answer", and `blobNotice`'s "did not return this
   * file".
   */
  readonly name: string
  /** How to fetch one file's two blobs. Key, fetcher and cache policy together. */
  blobsOptions: (file: ChangedFile) => BlobQuery
}
