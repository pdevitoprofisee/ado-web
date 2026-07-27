import type { AdoClient } from './ado-client'

// Server-only. One pull request, assembled into the shape the detail page reads.
//
// This file is the **contract** between three things built in parallel: the
// fetch/derivation below, the presentational components in
// `src/components/pr-detail.tsx`, and the route that wires them. The exported
// types are the agreement — change a shape here and both sides move with it.
//
// What the live probe settled, so nothing below re-derives it:
//
//   - Every endpoint here takes plain `api-version=7.1`. Only `policy/
//     evaluations` needs `7.1-preview.1`, which `hydrate.ts` already knew. That
//     is the first time in this project a new endpoint family cost nothing to
//     version, and it was still worth checking: four of the previous five
//     needed a preview suffix that only a real credential reveals.
//   - **The single-PR call earns its place on `description` alone.** Measured,
//     it adds only `_links` and `artifactId` in keys over what the list already
//     returned — but the list truncates `description` at 400 characters and the
//     detail call returned 1710. Everything else on this page could have come
//     from the inbox row.

/** The one endpoint in this file that is preview-only. */
const POLICY_VERSION = '7.1-preview.1'

export interface Person {
  readonly id: string
  readonly displayName: string
}

/**
 * Conflict state, which the map asks to be "stated loudly".
 *
 * `status` is ADO's own vocabulary — `succeeded`, `conflicts`, `queued`,
 * `rejectedByPolicy`, `failure`, `notSet` — kept verbatim rather than folded
 * into a boolean, because "we have not tried to merge yet" and "we tried and it
 * failed" are different things to tell someone. `conflicted` is the one case
 * that changes what the reviewer should do.
 */
export interface MergeState {
  readonly status: string
  readonly conflicted: boolean
  /** ADO's `mergeFailureMessage`, when it sent one. */
  readonly message: string | null
}

/**
 * Votes: `10` approved · `5` approved with suggestions · `0` none ·
 * `-5` waiting for author · `-10` rejected.
 */
export interface Reviewer {
  readonly id: string
  readonly displayName: string
  readonly vote: number
  /** A team or group rather than a person — how team assignment reaches you. */
  readonly isContainer: boolean
  readonly isRequired: boolean
  /**
   * Present on a *person* who voted on behalf of a container: the containers
   * their vote was recorded against. This is the only way to attribute a team's
   * vote to whoever actually cast it.
   */
  readonly votedFor: readonly Person[]
}

/** ADO's evaluation vocabulary. `queued` covers "not yet satisfied", not just builds. */
export type PolicyStatus =
  | 'approved'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'broken'
  | 'notApplicable'
  | 'unknown'

/**
 * One line of the checklist: what is actually standing between this PR and a
 * merge.
 *
 * `name` is `configuration.type.displayName` — except that it is **not unique**.
 * The live probe found two "Minimum number of reviewers" policies on one PR,
 * differing only in scope, so the id is carried and the name is qualified where
 * the settings offer something to qualify it with (a build policy's
 * `displayName`, for instance). A checklist with two identical rows and
 * different verdicts is a checklist nobody can act on.
 */
export interface Policy {
  /** `configuration.id`, because `name` collides. */
  readonly id: string
  readonly name: string
  readonly status: PolicyStatus
  /**
   * Blocking *and not yet satisfied* — i.e. this row is a reason the PR cannot
   * complete right now. A passing required policy is required, not blocking.
   */
  readonly blocking: boolean
  /** The specific thing: a build number, an approval count, a required reviewer. */
  readonly detail: string | null
  /** A build result, when the policy has one to point at. */
  readonly url: string | null
}

export interface Commit {
  readonly id: string
  /** First line only. ADO sets `commentTruncated` when it clipped the rest. */
  readonly subject: string
  readonly author: string
  readonly at: string
  readonly url: string
}

/**
 * `changeType` is a `[Flags]` enum and arrives as a comma-separated string
 * (`"edit, rename"`), so it is parsed to a set rather than compared as a word.
 */
export interface ChangedFile {
  readonly path: string
  readonly changeType: readonly string[]
  /** Blob sha *after* the change — works directly as a blob id (map: the diff pipeline). */
  readonly objectId: string | null
  /** Blob sha *before*. Absent on an add. */
  readonly originalObjectId: string | null
}

export interface FileList {
  readonly files: readonly ChangedFile[]
  /** The iteration these files belong to — phase 3 needs it for `$compareTo`. */
  readonly iterationId: number | null
  /** More files exist than were fetched. Rendered, never silently dropped. */
  readonly truncated: boolean
}

export interface PullRequestDetail {
  readonly id: number
  readonly title: string
  /** Full text. The inbox's copy is truncated at 400 characters; this is not. */
  readonly description: string
  readonly author: Person
  readonly createdAt: string
  readonly isDraft: boolean
  /** `active` | `completed` | `abandoned`. */
  readonly status: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly merge: MergeState
  readonly reviewers: readonly Reviewer[]
  readonly policies: readonly Policy[]
  readonly commits: readonly Commit[]
  readonly files: FileList
  readonly project: string
  readonly repository: string
  /** The dev.azure.com permalink — this app replaces it, it does not hide it. */
  readonly url: string
  /** Who is looking, so the UI can mark their own row. `null` if unresolved. */
  readonly viewerId: string | null
}

/** Addresses one PR. GUIDs because they are interpolated into an ADO path. */
export interface PullRequestRef {
  readonly projectId: string
  readonly repositoryId: string
  readonly id: number
}

export async function loadPullRequest(
  _client: AdoClient,
  _ref: PullRequestRef,
): Promise<PullRequestDetail> {
  throw new Error('not implemented')
}

export { POLICY_VERSION }
