import type { FileBlobs } from './diff-contract'
import type { ChangedFile, ChangeSet } from '@/server/pull-request'

// The shape of a local repository: what is under the root, what each one's HEAD
// is, which branch a diff should be taken against, and what came back. Frozen
// before the server layer (T-043) and the two pages (T-044, T-045) exist, for
// the reason `checks-contract.ts` was: they are meant to be written as
// independent tracks and cannot be, unless they agree on paper first.
//
// Evidence: `docs/research/local-git.md` — 19 repositories under
// `C:\Users\PaulDe\repos`, 14,000+ tracked entries, git 2.55.0.windows.3.
// Unlike the other contracts in this directory, that note is a transcription
// from a design session rather than the output of a script, so a figure quoted
// below is a measurement and the command beside it is a recipe.
//
// **Change vocabulary is not re-invented here.** `ChangeSet` and the
// `ChangedFile` it is made of come from `@/server/pull-request` unchanged, the
// way `changed-file.tsx` already type-imports them. A second word for "this file
// was renamed" is a second thing to keep in agreement, and the diff renderer
// already speaks the first one.
//
// Nothing in this round touches the network. Every hazard the map accumulated
// about Azure DevOps — throttling, 302s, rate-limit headers, paging — is
// irrelevant, and a different set replaces it: a ref name is an argv position, a
// repository name is a filesystem path, and `git status` writes to the index
// unless told not to.

// ---------------------------------------------------------------------------
// The root, and the four ways a list can be empty.
// ---------------------------------------------------------------------------

/**
 * One directory that was scanned for repositories.
 *
 * Two booleans rather than a status enum, because the page has to tell four
 * emptinesses apart and each is a different sentence:
 *
 * - `!configured && !exists` — nobody set `ADO_WEB_REPOS_ROOT` and the `~/repos`
 *   default is not there either. "Point the app at your repositories."
 * - `configured && !exists` — a root was named and is gone. Say **which**.
 * - `exists` with nothing in `repositories` under it — a real directory holding
 *   no repositories. Also say which.
 *
 * The fourth is not about a root at all: see `UnreadableRepository`. A page that
 * lists nothing is otherwise indistinguishable from a page that failed.
 *
 * `ADO_WEB_REPOS_ROOT` is `path.delimiter`-separated, so there can be several.
 * Every measurement in the research note came from one.
 */
export interface ScannedRoot {
  readonly path: string
  /** `false` when this is the `~/repos` default rather than a configured value. */
  readonly configured: boolean
  readonly exists: boolean
}

/**
 * What one scan found. **Never cached** — `dev-utilities` appeared under the
 * root during the design session, and a cached scan is a list that is wrong
 * exactly when somebody has just cloned something.
 *
 * The scan is **one level deep and never recursive**: the root holds three
 * orphaned `node_modules` directories, and `platform` alone has 13,807 tracked
 * files, so a recursive walk reads tens of thousands of directories to find
 * nineteen `.git`s.
 */
export interface RepositoryScan {
  readonly roots: readonly ScannedRoot[]
  /** In scan order. Failures are entries, not omissions — see `RepositoryEntry`. */
  readonly repositories: readonly RepositoryEntry[]
}

export type RepositoryEntry = LocalRepository | UnreadableRepository

/**
 * A repository that could not be read, kept in the list rather than dropped.
 *
 * One unreadable repository must not blank the other eighteen — the same bargain
 * `SectionErrors` makes in `pull-request.ts` — and it must not vanish either,
 * because a silently shortened list reads as "you have eighteen repositories".
 */
export interface UnreadableRepository {
  readonly kind: 'unreadable'
  readonly slug: string
  readonly path: string
  readonly message: string
}

/**
 * One repository under the root, as the list page draws it.
 *
 * Everything here is a **ref read**. No `status`, no commit count, no file list:
 * `status --porcelain=v2` is 107–216 ms per repository and fanning it out across
 * 19 buys ~20% (2.7 s → 2.16 s, disk-bound), so a list that waited for the dirty
 * count would take two and a half seconds to draw nineteen rows. The dirty count
 * is the diff page's, fetched on its own.
 */
export interface LocalRepository {
  readonly kind: 'repository'
  /**
   * The directory basename, and the only name a URL ever carries. A slug is
   * looked up in the scanned set on the way back in, so **no filesystem path is
   * expressible in a URL**.
   */
  readonly slug: string
  /** Absolute, from `rev-parse --show-toplevel`. Displayed; never accepted. */
  readonly path: string
  readonly head: RepoHead
  readonly target: TargetResolution
  /**
   * Why this repository cannot be opened, or `null` when it can.
   *
   * The one live cause is a **slug collision**: two repositories sharing a
   * basename across two roots. Both are listed with their full paths and
   * **neither is addressable** — numbering them would mean a third arrival
   * renumbers the second, and the viewed marks keyed on the slug would silently
   * re-point at a different repository. Disabled with the reason beside it is
   * this app's existing idiom for an action that does not apply.
   *
   * Impossible under the default single root, where all 19 basenames are
   * distinct — so this path has never been rendered.
   */
  readonly unaddressable: string | null
}

// ---------------------------------------------------------------------------
// HEAD, refs, and the branch a diff is taken against.
// ---------------------------------------------------------------------------

/**
 * Where a repository is sitting.
 *
 * Three arms and not `string | null`, for `BlobSide`'s reason: "no branch" means
 * two genuinely different things to a reader, and the row for each is a
 * different sentence.
 *
 * **`unborn` is not hypothetical bookkeeping.** In a repository with no commits
 * `rev-parse HEAD` *fatals* — it does not answer empty — while
 * `symbolic-ref --short HEAD` still names the branch that would be created. Any
 * code that treats a non-zero exit as "unreadable repository" turns a fresh
 * `git init` into an error row.
 *
 * Neither `detached` nor `unborn` was found in the sample (0 of 19); both are
 * transcribed from documented behaviour rather than observed.
 */
export type RepoHead =
  | { readonly kind: 'branch'; readonly name: string; readonly commit: string }
  | { readonly kind: 'detached'; readonly commit: string }
  | { readonly kind: 'unborn'; readonly name: string }

/**
 * One ref, carrying both of its names on purpose.
 *
 * `name` is what a person reads (`main`, `origin/main`). `fullName` is what goes
 * into `git`'s argv, because it is unambiguous — `main` could be a branch, a tag
 * or a file, and `refs/heads/main` is exactly one thing — and because a full ref
 * name cannot begin with `-`.
 *
 * **Both are values the server enumerated.** A request selects a ref out of the
 * set the server just produced for that repository; it never supplies the
 * string. A ref that is not in that set fails closed with words ("no branch
 * named `x`") and never falls back to the default, because a silent fallback
 * shows the diff of something other than what was asked for.
 */
export interface GitRef {
  readonly name: string
  readonly fullName: string
  /** 40 hex. Validated before it is written to `cat-file`'s stdin. */
  readonly commit: string
}

/**
 * The refs a repository has, and the price of each half.
 *
 * On `platform`: `refs/heads` is **3 refs in 57 ms** and
 * `refs/remotes/origin` is **1,264 refs in 308 ms**. So enumeration is two
 * operations at two prices, and the list page can afford one of them per
 * repository and not the other.
 *
 * The count a picker prints ("1,264 branches — type to filter") is
 * `remote.length`; there is no separate total, because nothing truncates the
 * list — 1,264 refs is a small payload and a large dropdown, and only the second
 * of those is a problem.
 */
export interface RefSet {
  readonly local: readonly GitRef[]
  /** `null` until something asks. Fetching it eagerly is 308 ms nobody requested. */
  readonly remote: readonly GitRef[] | null
}

/**
 * Which rung of the ladder answered, in the order it is tried.
 *
 * The ladder exists because there is no single question that works. `origin/HEAD`
 * answered on 17 of 19; the other 2 (`ado-web`, `xshot`) have **no remotes at
 * all**, where it does not come back empty — it **fatals**. So the ladder is
 * driven by exit codes, not by empty output, and a rung that crashes is a rung
 * that did not answer rather than an error to surface.
 */
export type TargetRung = 'origin-head' | 'origin-main' | 'origin-master' | 'local-branch'

/**
 * How the rung reads on the page. Here rather than in either page, because
 * T-044 and T-045 both state it and two wordings for one fact is how they drift.
 *
 * The ref's own name is printed alongside; this says how it was *found*, and the
 * last one is the one that matters — it means the repository has no `origin` to
 * ask.
 */
export const TARGET_RUNG_LABEL: Record<TargetRung, string> = {
  'origin-head': "origin's default branch",
  'origin-main': 'origin/main',
  'origin-master': 'origin/master',
  'local-branch': 'a local branch — this repository has no origin',
}

/**
 * What to diff against, or why there is nothing to diff against.
 *
 * A named union rather than `GitRef | null` because the unresolved case has to
 * say what it tried. "No target" on a repository with three remotes and a
 * `develop` default is a bug report; "tried origin/HEAD, origin/main,
 * origin/master" is an explanation.
 */
export type TargetResolution =
  | {
      readonly kind: 'resolved'
      readonly rung: TargetRung
      readonly ref: GitRef
      /**
       * The committer date of the target ref's tip, ISO-8601.
       *
       * **The app never fetches** — no `git fetch`, by construction — so this
       * repository's idea of `origin/main` is as old as the last time the user
       * pulled. The only honest move is to say so: a diff against a three-week-
       * old base is not wrong, but a reader who thinks it is current is.
       *
       * The tip's date and not the merge base's, deliberately. The merge base
       * would answer "how long has this branch been diverged", which is a
       * different and less urgent question than "should I fetch".
       */
      readonly baseCommittedAt: string
    }
  | {
      readonly kind: 'unresolved'
      /** The refs tried, in ladder order, so the page can print the attempt. */
      readonly tried: readonly string[]
    }

/** One repository opened: everything `/repos/$repo` needs before it asks for a diff. */
export interface RepositoryDetail {
  readonly repository: LocalRepository
  readonly refs: RefSet
}

// ---------------------------------------------------------------------------
// The change set.
// ---------------------------------------------------------------------------

/**
 * A `ChangedFile` plus the two modes, which git has and Azure DevOps does not.
 *
 * The modes are not decoration. They are what keeps `160000` away from
 * `cat-file` — a gitlink names a commit that is not in this object database and
 * would come back `missing` — and they are the whole of what distinguishes a
 * `100644 → 100755` flip from a file that did not change, since such a flip
 * arrives as `M` with **identical shas and identical paths**.
 *
 * Everything else is `ChangedFile` unchanged. From
 * `diff --merge-base <target> <branch> --raw -M --abbrev=40 -z`:
 *
 * | `--raw` | `changeType` |
 * |---|---|
 * | `A` | `add` |
 * | `D` | `delete` |
 * | `M` | `edit` |
 * | `R` | `rename`, plus `edit` when the bytes moved too |
 * | `C` | `add` — no `-C` is passed, so this should not arrive; ADO has no word for a copy |
 * | `T` | `edit` |
 * | `U` | unreachable from a tree-to-tree diff |
 * | `X` | fails, with its letter in the message |
 *
 * **The absent side is forty zeros, not an empty field.** git prints
 * `0000000000000000000000000000000000000000` for the before of an add and the
 * after of a delete; both map to `null` here, matching ADO's own convention
 * (`blob.ts` already keys the whole fetch on which sha is null). Passing the
 * zero sha through to `cat-file` would answer `missing` and read as a fetch
 * failure.
 */
export interface LocalChangedFile extends ChangedFile {
  /** `100644`, `100755`, `120000`, `160000` — or `null` on the side that does not exist. */
  readonly beforeMode: string | null
  readonly afterMode: string | null
}

/**
 * The two refs a change set was actually taken between, as the server resolved
 * them.
 *
 * The page cannot reconstruct any of this from the URL, and that is the point:
 * `?branch=` and `?target=` are both optional, so on the common URL — `/repos/
 * platform` with nothing after it — the branch came from `HEAD` and the target
 * came off the ladder, and the header still has to name both. Sending them back
 * is also what lets the page tell the legitimate empty case ("this branch **is**
 * the target") from the alarming one (0 files, 12 commits): the first is
 * `branch.commit === base.commit`, and no file count can say it.
 *
 * `rung` is `null` when the URL pinned the target, because then no rung was
 * climbed and "origin's default branch" would be a claim nobody made.
 */
export interface DiffPair {
  readonly branch: GitRef
  readonly base: GitRef
  readonly rung: TargetRung | null
  /** The base tip's committer date, ISO-8601. See `TargetResolution`. */
  readonly baseCommittedAt: string
}

/**
 * The files between a branch and its target, plus the two things the page states
 * that `ChangeSet` has no room for.
 *
 * `truncated` and `FILE_LIMIT` are reused exactly as the ADO list uses them.
 */
export interface LocalChangeSet extends ChangeSet {
  readonly files: readonly LocalChangedFile[]
  /** Which two refs this is the diff of. Stated in the header, always. */
  readonly diffed: DiffPair
  /**
   * **`-M` gave up.** Past `diff.renameLimit` (1000 by default) git stops
   * detecting renames, writes a warning to **stderr**, and **exits 0** — so every
   * rename in a large refactor renders as an add plus a delete with nothing on
   * the page to say detection was skipped. Surfaced as "too many changes to
   * detect renames", never swallowed.
   *
   * The warning's exact text was never seen firing, so the recogniser is
   * matching a string nobody has observed.
   */
  readonly renameDetectionSkipped: boolean
  /**
   * Commits on the branch that are not on the target. Stated in the header
   * because "0 files changed" and "0 commits" are different problems.
   */
  readonly commits: number
}

// ---------------------------------------------------------------------------
// Blobs.
// ---------------------------------------------------------------------------

/**
 * `FileBlobs` plus the sentence to print when there are no bytes worth showing
 * and an empty pane would read as a bug.
 *
 * Two cases, both local-only, and **neither is a fifth `BlobSide` arm** — the
 * arms describe one side of one file, and these describe the file:
 *
 * - **A gitlink.** "Submodule, moved from `abc1234` to `def5678`". Recognised
 *   from mode `160000` so it never reaches `cat-file`. 0 of 19 repositories can
 *   produce one, which is exactly why it gets a sentence and not a subsystem.
 * - **A mode-only change.** "Mode changed, 100644 → 100755". Identical shas,
 *   identical paths, so both sides fetch to the same text and the diff is empty.
 *   `core.fileMode` is `false` in every repository here, so this cannot be
 *   authored on this machine — only pulled.
 *
 * `renamedOnly` is inherited and its derivation is **not**: `blob.ts` derives it
 * from `objectId === originalObjectId`, which a mode flip satisfies, so the local
 * source additionally requires the **paths to differ**. Otherwise the page claims
 * a rename that never happened.
 *
 * `blobNotice()` in `diff-view.tsx` prefers this over everything it computes
 * itself. It reaches there as `NotedBlobs` — `FileBlobs & { note?: string | null
 * }`, declared in `diff-contract.ts` so the seam between a panel and its source
 * can carry the field without knowing whose it is.
 */
export interface LocalFileBlobs extends FileBlobs {
  readonly note: string | null
}
