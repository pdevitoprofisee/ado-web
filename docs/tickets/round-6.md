# Round 6 — local repositories

Phase 2 proper of [the route](./round-1.md#the-route), lifted out of
[the fog](../map.md#the-fog). [Round 5](./round-5.md) finished the pull request. This round
builds the one thing Azure DevOps cannot give you at all: **the whole-branch diff of a local
branch against the branch it will merge into, without opening a pull request.**

Same conventions: each ticket states **success criteria**, not steps; facts referenced by
number come from [the notes](../map.md#the-notes); every ticket carries a
**Type · Status · Blocked by** line, and a **Resolution** written after it lands.

**The fact that shapes this round: the inventory is already taken.** Rounds 3, 4 and 5 each
opened with a live probe against a credential nobody had used yet. Local git needs no
credential, and the measurements exist — 19 repositories under `C:\Users\PaulDe\repos`, 14,000+
tracked entries, spawn costs, ref costs, and two repositories that make `origin/HEAD` *fatal*
rather than empty. So T-041 is a transcription ticket, not a probe: the numbers move from a
conversation into `docs/research/local-git.md` and `src/lib/local-git-contract.ts` before any
code is written against them, which is the same freeze-first discipline rounds 3–5 used, minus
the probing.

**The second fact: the renderer was built for this.** The fog's phase 2 shaped exactly one
decision — "the diff renderer takes an abstract diff source, not an ADO-shaped one" — and that
decision was honoured. `src/lib/diff-contract.ts` names no vendor, and `FileDiffPanel` takes
`blobs`, `diff`, `rows` and `layout` with nothing ADO-shaped among them. The gap is one
component wide: `ChangedFileDiff` takes `projectId`, `repositoryId` and `id` for the sole
purpose of building `fileBlobsOptions`, and two notices name Azure DevOps in prose. That is
T-042, and it is the whole of the rendering work in this round. **No new `DiffRow` kind, no new
`BlobSide` arm, no second differ.**

**The third fact: nothing in this round touches the network.** This is the first feature in the
app whose server functions make no HTTP request of any kind — no `AdoClient`, no PAT, no
throttle gate, no `X-RateLimit-*`. Every hazard the notes accumulated about Azure DevOps is
irrelevant here, and a different set replaces it: a ref name is an argv position, a repository
name is a filesystem path, and `git status` writes to the index unless told not to. Traps 14–18
exist because of that swap, and the security rule T-041 adds is the one that matters most —
**refs and shas handed to `git` are values the server enumerated, never strings the request
supplied.**

**What this round is not.** **No mutations of any kind** — no `git fetch`, no checkout, no
branch create or delete, no stash, no index write. The feature is read-only by construction and
not merely by intent, which is what `--no-optional-locks` is for (note 18). No working-tree
diff: committed history only, with the dirty file count stated so its absence is visible, and
the toggle deferred (*Deferred, not refused*). No per-commit diffs and no commit browsing —
those two clauses of the fog's phase 2 stay in the fog. No file browser. No convergence with
phase 9's org-wide repository list; `/repos` is the local page now and the join on the `origin`
URL is later work. No comments, no Sonar, no checks, no votes, no policies on a local branch —
there is nothing there to read them from. No submodule rendering beyond a stated stub (0 of 19
repositories has one).

**And no HITL ticket.** Round 5 ended with [T-040](./round-5.md#t-040--the-first-real-write)
because eleven unproven writes needed a person to press the buttons. This round sends nothing
anywhere, so every ticket in it is an agent's to close.

---

## T-041 — Local git: the note, the contract, and the map

**Type:** task · **Status:** resolved · **Blocked by:** —

Everything measured about local git lives in one conversation and nowhere else. Two tickets in
this round are meant to run as independent tracks, and they can only be written against each
other's assumptions if those assumptions are on paper first — the same reason
[T-029](./round-5.md#t-029--build-timeline-log-and-test-result-endpoint-inventory) froze
`checks-contract.ts` before either half of phase 5 existed.

**Success, part one:** `docs/research/local-git.md` states, each as a number and each with the
command that produced it: the repository census (how many repositories under the root, how many
on a feature branch, how many dirty, how many sharing a branch name); `git` spawn cost on
Windows and what that implies per file at two blobs each; the cost of `status --porcelain=v2`
per repository, sequentially and in parallel; the cost of enumerating `refs/heads` against
`refs/remotes/origin`; how `origin/HEAD` resolves across the sample **including the two
repositories where it fatals**; the `cat-file --batch` framing; what `--raw` prints without
`--abbrev=40` and without `-z`; the mode census; the gitlink and `.gitmodules` census; and the
`core.autocrlf` / `core.fileMode` / `ls-files --eol` findings. Absences counted, not assumed —
"0 of 19 has a submodule" is a measurement and "submodules are rare" is not.

**Success, part two:** `src/lib/local-git-contract.ts` frozen. At minimum: a repository, its
`HEAD` (a branch, detached, or **unborn** — a repository with no commits, where `rev-parse HEAD`
fatals), a ref, and the **target resolution as a named union** — resolved, with which rung of
the ladder answered and the base commit's date so the page can state its age; or unresolved,
with the refs that were tried. Change vocabulary is **not** re-invented: `ChangedFile` and
`ChangeSet` are reused as they stand, type-imported the way `changed-file.tsx` already
type-imports them, because a second word for "this file was renamed" is a second thing to keep
in agreement.

**Success, part three:** five edits to [`docs/map.md`](../map.md).

1. The fog's **Phase 2** entry **shrinks rather than disappears** — branch and commit browsing
   and per-commit diffs stay there; the whole-branch diff moves to the destination as a
   **Local repositories** section describing what actually ships. "Nothing else about it is
   designed" comes out; twenty-two decisions made it untrue.
2. `### Repositories` — phase 9's org-wide list — gains the note that `/repos` is the local page
   and that the two converge later on the `origin` URL. Two sections describing one route
   without knowing it is how they drift.
3. **Traps 14–18**, under *Traps that fail silently*. Each one changed a decision in this
   design, which is the stated bar for entry:
   - **14. `--raw` abbreviates object ids to 7 characters.** Without `--abbrev=40` the blob
     cache key is a *prefix*, so a collision is a matter of luck rather than of content
     addressing. `-z` matters for the same class of reason: without it paths are C-quoted, and
     the quoting only appears on the paths that need it.
   - **15. `-M` stops detecting renames past `diff.renameLimit` (1000) and exits 0.** The
     warning goes to stderr. Every rename in a large refactor renders as an add plus a delete,
     with nothing on the page to say detection was skipped.
   - **16. `objectId === originalObjectId` does not mean "renamed".** A `100644 → 100755` mode
     flip arrives as `M` with identical shas *and identical paths*, so `blob.ts`'s `renamedOnly`
     derivation would claim a rename that never happened. The paths must differ too.
   - **17. Reading the worktree with `fs` under `core.autocrlf=true` makes every line changed.**
     `ls-files --eol` reports `i/lf w/crlf` here: the committed bytes and the on-disk bytes
     differ by design. The deferred working-tree arm must read through git's own filters.
   - **18. `git status` writes to `.git/index` unless told not to.** A "read-only" feature that
     refreshes the index can race the terminal the user is working in. `--no-optional-locks` on
     every invocation, and it is a construction rule rather than a review note.
4. A **`### Local git`** subsection under *Structural facts* for the costs that are not traps:
   ~52 ms per spawn on Windows and what that means per file; `cat-file --batch`'s
   `<sha> <type> <size>\n` framing and its `<sha> missing` reply; 107–216 ms per
   `status --porcelain=v2`, with parallelism buying almost nothing across 19 repositories
   (2.7 s → 2.16 s, so this is disk-bound, not concurrency-bound); **ref enumeration is not
   uniformly cheap** — `refs/heads` is 3 refs and 57 ms on `platform` while
   `refs/remotes/origin` is 1,264 refs and 308 ms, which is why the list page reads locals only;
   `origin/HEAD` resolving in 17 of 19 and fatalling in the 2 with no remote at all; and the
   minimum `git` version, since `diff --merge-base` needs 2.30 (measured against 2.55.0).
5. *Security constraints* gains the argv rule: **refs and object ids reaching `git` are values
   the server enumerated from the repository, not strings the request supplied**, with shape
   validation, `--end-of-options` and a leading-`-` rejection as the belt rather than the
   braces. And *Deferred, not refused* gains the working-tree toggle, in the user's words, next
   to auto-complete — it is the one thing here we build a shape for without building the
   feature, and a deferral recorded only in a type is a deferral nobody will find.

`## Decisions so far` is **not** written now. It records what was settled, and nothing in this
round has landed.

### Resolution

Uncommitted — no commit has been asked for. `docs/research/local-git.md`,
`src/lib/local-git-contract.ts`, and the five edits to `docs/map.md`: traps **14–18**, a
**`### Local git`** subsection of *Structural facts*, a **Local repositories** section in the
destination, the argv rule under *Security constraints*, and phase 2 shrunk to what is still
foggy.

**This one is a transcription, and the note says so before it says anything else.** Every other
file in `docs/research/` was written by a script in `scripts/` and can be re-run; this one was
taken interactively and cannot. So `local-git.md` opens with a *Provenance* section stating that
the numbers are what was observed while the commands beside them are the invocations that produce
them written in the form the server layer will use — a figure is a measurement, an argv is a
recipe — and that anything marked *not recorded* is a gap in the record and not a zero. Two
things are so marked: the trivial subcommand the ~52 ms spawn figure was taken with, and the
exact text of git's rename-limit warning, which matters because T-043 has to recognise a string
nobody has seen fire.

**The census does not add up, and it says that too.** 7 on a feature branch plus 11 on their
default branch is 18, not 19, and the transcription does not say which repository the nineteenth
is. Recorded as a hole rather than rounded into the larger number: the round's own rule is that
an absence is counted, not assumed, and "about nineteen" is not a measurement.

The contract went one field past the ticket's minimum, twice, and both times because a sentence
the design already committed to had nowhere to live:

- **`LocalChangedFile` adds the two modes** to `ChangedFile`. It is not a second change
  vocabulary — the words are unchanged — but git's `--raw` carries a before-mode and an
  after-mode that Azure DevOps has no equivalent for, and they are the only thing that keeps
  `160000` away from `cat-file` and the only thing that tells a `100644 → 100755` flip from a
  file that did not change at all (identical shas, identical paths, arrives as `M`).
- **`LocalFileBlobs` adds a `note`** for the two sentences T-043 owes the page — "Submodule,
  moved from `abc1234` to `def5678`" and "Mode changed, 100644 → 100755". Deliberately *not* a
  fifth `BlobSide` arm, which is forbidden and would also be wrong: the arms describe one side of
  one file and these describe the file. Reusing the `failed` arm would have rendered "did not
  return this file: Submodule…", which is a lie about a fetch that never happened.
  **This leaves T-045 one open thread**: `blobNotice()` in `diff-view.tsx` must widen its
  parameter to read the field. Until it does, `note` is carried and not read.

Two smaller calls worth naming. `baseCommittedAt` is the **target ref tip's** committer date, not
the merge base's, because the risk being communicated is "your `origin/main` is three weeks old
and this app never fetches" and not "your branch diverged three weeks ago". And `RefSet.remote`
has no separate count field — nothing truncates the list, so the count a picker prints is
`remote.length`; 1,264 refs is a small payload and a large dropdown, and only the second of those
is a problem.

`RepositoryEntry` is a discriminated union in one array rather than `ChecksReport`'s parallel
`failed` list, so an unreadable repository renders in scan order in one pass and cannot be
dropped — a list quietly one row short reads as "you have eighteen repositories".

What remains unproven is listed in the note's own *What was not measured*: no repository in the
sample has a submodule, a symlink or an executable bit; neither a detached nor an unborn HEAD was
observed, so both arms of `RepoHead` are transcribed from documented behaviour; a slug collision
is impossible under the single default root, so `unaddressable` has never been rendered; nothing
confirms what a >1 MiB blob costs through `cat-file --batch` specifically; and every figure is a
warm-cache figure.

`pnpm typecheck` green. No test touches this yet — the contract is types, one label map, and no
logic.

---

## T-042 — The diff source seam

**Type:** refactor · **Status:** resolved · **Blocked by:** T-041

The fog promised an abstract diff source and `diff-contract.ts` delivered one. The seam stops
one component short.

**Success: the ADO pull request view is observably unchanged, and `ChangedFileDiff` no longer
knows what Azure DevOps is.** Its `projectId`, `repositoryId` and `id` props exist only to build
`fileBlobsOptions(ref, file)`; they are replaced by an injected source — the query options
factory, plus the name the source is called in prose. The two notices that hard-code a vendor
(`diff-view.tsx:135`, "Azure DevOps did not return this file"; `changed-file.tsx:225`, "Azure
DevOps did not answer.") say whatever the source is called, so a local failure does not blame a
service that was never asked.

Non-negotiables:

- **No behaviour changes.** No new render, no reordering, no wording change on the ADO path, no
  new prop with a default that quietly alters an existing call site. The existing suite passing
  unmodified is most of the criterion; a test that had to be edited to keep passing is the
  signal to stop and explain why.
- **The key still lives in one place.** `fileBlobsOptions` is deliberately the only speller of
  the blob cache key, because "a key spelled in two places is two cache entries and twice the
  calls for one file". The factory indirection must not become a second speller, and the
  local factory in T-043 gets its own key namespace rather than sharing one.
- `enabled` stays the caller's, per the existing bargain: the warmer fetches regardless, the
  panel fetches when it is being read.

**This is the only ticket in the round that can regress something in daily use**, and unlike
T-040 it has no human-in-the-loop step — the existing tests are the entire safety net. It lands
alone, on its own commit, so that a later misbehaviour on the local page can be attributed
without bisecting a feature.

### Resolution

Uncommitted — no commit has been asked for. **When one is asked for, this is the one that lands
alone**, per the paragraph above; T-041's docs and contract are the only other thing outstanding
and they are not part of it.

New: `src/lib/diff-source.ts` (`DiffSource`, `BlobQuery`, `BlobAnswer` — types only) and
`adoDiffSource(ref)` in `blob-query.ts`. Changed: `ChangedFileDiff` takes `diffSource` where it
took three GUIDs; `blobNotice(blobs, source)` takes the name; `FileDiffPanel` gained a
`sourceName` prop to carry it; `pr-detail.tsx` builds the source at the one call site.

**1,115 tests in 58 files pass, and no assertion was touched.** Two test files changed and both
changes are *construction*: `changed-file.test.tsx`'s `panel()` helper now passes
`adoDiffSource(REF)` instead of spreading `REF` field by field, and the eight `blobNotice(…)`
calls in `diff-view.test.tsx` gained a second argument. The one test in the whole suite that
asserts a vendor sentence — `diff-view.test.tsx:736`, "Azure DevOps did not return this file:
Azure DevOps answered 400." — is byte-identical, because the source it is handed is called
`'Azure DevOps'`. That was the point of the gate and it is worth stating that it held: the ADO
path renders the same words in the same order.

Three decisions the ticket did not settle:

- **`FileDiffPanel.sourceName` is optional; `blobNotice`'s parameter is not.** The panel is
  constructed two dozen times in `file-diff.test.tsx` with no source at all, because a panel
  handed raw blobs did not fetch them from anywhere — the same reason `kind` is optional, in the
  same words. Making it required would have been two dozen mechanical edits to prove nothing. But
  the default is deliberately **not** a vendor: `'The diff source'`, so a panel that forgot cannot
  blame Azure DevOps for a file it never asked Azure DevOps for. `blobNotice` itself takes it
  required, because a pure function with a defaulted accusation in it is exactly the "default that
  quietly alters an existing call site" the ticket forbids.
- **The prop is `diffSource`, not `source`.** `changed-file.tsx` already has a local `source`
  meaning "the blobs the current row model was built from", and shadowing it would have made the
  file read as though the row model were rebuilt when the *service* changed.
- **`BlobQuery` names only `queryKey` and `queryFn`.** The obvious spelling —
  `UseQueryOptions<BlobAnswer, …>` — does not compile: TanStack's option type mentions its own
  generics in argument position (`enabled` may be a predicate over the `Query`), so widening
  `FileBlobsResult` to `BlobAnswer` makes `fileBlobsOptions`' perfectly good return value
  unassignable for reasons that have nothing to do with blobs. `staleTime` is left off the type
  for the same family of reason — it may be a number, the word `static`, or a function — and the
  `Infinity`/`Infinity` policy is stated in the doc comment as a source's obligation instead.
  Runtime is unaffected: the spread carries every field whether or not the type mentions it.

**The key is still spelled once.** `adoDiffSource` closes over the ref and calls
`fileBlobsOptions` — it repeats no part of the key, and `useWarmDiff` still prefetches through
`fileBlobsOptions` directly, so the warmer and the panel remain the same cache entry. The source
object is rebuilt on every render of the file list and that is free: `useQuery` compares the key,
not the object it arrived in.

`enabled` did not move. It is still the only thing about the query the panel decides.

Unproven: nothing here was run against a live Azure DevOps. The ticket's own safety net is the
unmodified suite, and that is what was used.

---

## T-043 — Local git: the server layer

**Type:** feature · **Status:** resolved · **Blocked by:** T-041

**Success:** one call lists the repositories under the configured root; one call gives a
repository's refs and its resolved target; one call gives the changed files between a branch and
its target; one call gives both blobs of one of those files. No UI, and no `git` invocation
anywhere outside this layer.

The shape is rounds 3–5': loaders in `src/server/local-git.ts`, a `local-git-fn.ts` whose
handlers **return** failures rather than throwing, and one failure type per section so a single
unreadable repository does not blank the list.

**The single-spawn rule.** One function builds every `git` invocation, and it is the only place
`child_process` appears. It uses `spawn` with an **argv array** — never a shell, never `exec`,
never a string — passes `--no-optional-locks` (note 18) and `--end-of-options`, sets
`GIT_TERMINAL_PROMPT=0` so no invocation can ever block waiting for a credential, captures
stderr, checks the exit code, and carries a timeout. `simple-git` is not a dependency of this
layer: the map's constraint on it (`>=3.36.0`, and request data must never reach its options
array) is satisfied most cheaply by not having it.

**Argv safety is a whitelist, not a predicate.** Nothing from a request reaches `git`'s argv. A
slug is looked up in the scanned set, so no filesystem path is expressible in a URL. A branch or
target is looked up in the refs this server just enumerated for that repository, so the string
passed to `git` is one the server produced and the request only *selected*. An object id is
matched against 40 hex digits before it is written to `cat-file`'s stdin. Belt as well as
braces: a leading `-` is rejected outright, and a ref that is not in the enumerated set **fails
closed with words** — "no branch named `x`" — and never falls back to the default, because a
silent fallback shows a diff of something other than what was asked for.

The rest, each a stated requirement rather than a step:

- **Discovery.** `ADO_WEB_REPOS_ROOT`, `path.delimiter`-separated, defaulting to `~/repos`, **one
  level deep and never recursive** — the root holds orphaned `node_modules` directories and
  `platform` alone has 13,807 tracked files. A child is a repository if
  `git rev-parse --show-toplevel` says so, which also admits worktrees, where `.git` is a file.
  **Never cached**: a repository appeared under the root during this design session. A root that
  does not exist is reported as a missing directory, distinctly from a root that holds no
  repositories.
- **Slugs.** The basename. Two repositories sharing one basename across two roots is possible,
  and the answer is not silent disambiguation — a slug renumbered by a third arrival would
  silently re-point the viewed marks keyed on it. Both are listed with their full paths and
  **neither is addressable**, disabled with the reason beside it, which is this repo's existing
  idiom for an action that does not apply. Impossible under the default single root, where all
  19 basenames are distinct.
- **The target ladder**, as a resolution value the page can render: `origin/HEAD` →
  `origin/main` → `origin/master` → a local `refs/heads` match → unresolved, with what was
  tried. `origin/HEAD` **fatals** rather than emptying in a repository with no remote (2 of 19),
  so the ladder is driven by exit codes, not by empty output. The base commit's date comes back
  with it: the app never fetches, so the page's only honest move is to say how old the base is.
- **Refs.** Locals eagerly (57 ms), remotes **on demand only** (308 ms for 1,264 on
  `platform`) — and when a remote list is served it is served with its count, because a picker
  cannot present 1,264 refs as a list.
- **The change set.** `diff --merge-base <target> <branch> --raw -M --abbrev=40 -z` (notes 14,
  15), mapped onto `ChangedFile`'s existing four words: `A→add`, `D→delete`, `M→edit`,
  `R→rename` (plus `edit` when the bytes moved too), `C→add`, `T→edit`. No `-C`: Azure DevOps
  has no word for a copy, so a detected one would render as an add anyway. `U` is unreachable
  from a tree-to-tree diff and stays that way. `X` fails with its letter in the message. The
  rename-limit warning on stderr is surfaced as "too many changes to detect renames" rather than
  swallowed. `FILE_LIMIT` and `truncated` are reused exactly as the ADO list uses them.
- **Blobs: one spawn per *file*, not per side.** `cat-file --batch` takes both shas on stdin and
  is framed by the declared size — `<sha> <type> <size>\n`, exactly *size* bytes, `\n`, or
  `<sha> missing`. Measured: 200 blobs through one batch is ~10 ms each against ~52 ms for a
  spawn, which on a 294-file change is the difference between ~6 s and ~31 s. The declared size
  is also what finally gives `too-large` a non-empty domain — `BlobSide`'s own comment records
  that ADO's chunked responses left the length check with nothing to refuse. Here the size is
  known before the bytes are, so an over-limit blob is refused **without being buffered**,
  though its bytes are still *drained* — skipping them would desynchronise the stream for every
  file after it.
- **Classification is shared, not duplicated.** `MAX_BLOB_BYTES` (1 MiB) and the 8 KiB NUL
  sniff are `blob.ts`'s, and the bytes→`BlobSide` decision is extracted so both sources reach
  the same verdict about the same file. Two definitions of "binary" is two answers on one
  screen.
- **Mode `160000` never reaches `cat-file`.** A gitlink names a commit that is not in this
  object database and would come back `missing`; it is recognised from the mode and stated —
  "Submodule, moved from `abc1234` to `def5678`". No fifth `BlobSide` arm for a case that 0 of
  19 repositories can produce.
- **`renamedOnly` requires the paths to differ** (note 16), and a mode-only change says "mode
  changed, 100644 → 100755" instead of claiming a rename.
- **The dirty count** from `status --porcelain=v2 --no-optional-locks`, 107–216 ms, fetched
  separately from the change set so a slow `status` never delays the diff.

**Tests run real `git`.** A helper builds fixture repositories under `mkdtempSync` — the idiom
six server tests already use for real `node:sqlite` databases — each with `// @vitest-environment
node`, and each setting `core.autocrlf` and `core.fileMode` **explicitly**, because they are set
globally on this machine and a fixture that inherits them passes or fails depending on whose
machine ran it. Fixtures are built in `beforeAll`, not `beforeEach`: ~8 spawns is ~0.4 s.
Coverage is the awkward set — add, edit, delete, rename, mode flip, binary, CRLF, over-1-MiB,
empty file, no-final-newline, unborn `HEAD`, no remote, and a repository sitting on its own
target branch. **Hand-authored `--raw` and `--batch` strings are not the input**: this design
already caught two beliefs about git's output being wrong (`--abbrev`, C-quoting), and neither
would have been caught by a fixture whose bytes I typed.

### Resolution

Uncommitted — no commit has been asked for.

New: `src/server/local-git.ts` (the loaders and the one `spawn`), `src/server/local-git-fn.ts`
(six server functions), `src/server/local-git.test.ts` (30 tests, real `git`, ~6 s). Changed:
one word in `pull-request.ts` — `FILE_LIMIT` is now exported, with a sentence added to its doc
comment saying who else uses it and why. **1,145 tests in 59 files pass and typecheck is clean.**

`grep -rn "child_process" src/` finds two files: `local-git.ts` and its test. Nothing else in
the app spawns anything.

**Measured against the real root** with a throwaway probe, since fixtures cannot prove any of
this. **20 repositories**, not the note's 19 — one appeared between the research session and
this one, which is the "never cached" requirement arriving on its own. The whole scan is
**755 ms** for 60 spawns, no unreadable rows. Three of the twenty have no remote at all
(`ado-web`, `DevLaunchpad`, `xshot`) and land on `local-branch → main` with no fatal anywhere;
the other seventeen resolve through `origin/HEAD`, which is a symref, so what comes back is
`origin/master` or `origin/main` by name rather than the alias. `platform`'s current branch is
**13 files and 25 commits in 315 ms**; its dirty count is 130 ms; ten of those files' blobs are
890 ms end to end. `ado-web`'s own `main` against its own `main` is 0 files and 0 commits —
the "sitting on its own target branch" case, live.

Six decisions the ticket did not settle:

- **The ladder reads refs; it is not driven by `rev-parse` exit codes.** The ticket says it must
  be, and the hazard behind that sentence is real — `rev-parse origin/HEAD` *fatals* rather than
  emptying, so a ladder that reads a crash as a blank falls through by accident. One
  `for-each-ref` over `refs/heads` plus the three named remote rungs **removes** the hazard
  instead of handling it: absence is a ref that is not in the enumeration, failure is the whole
  enumeration failing, and nothing asks `rev-parse` a question it can fatal on. It is also three
  spawns per repository for a whole list row instead of seven, which is the difference between a
  755 ms scan and a two-second one.
- **HEAD needs its own invocation, and it is `branch --show-current`.** Two probes settled this.
  `for-each-ref … HEAD refs/heads` does **not** match `HEAD` — it silently returns only the
  branches — so HEAD cannot ride along with the refs. And `rev-parse HEAD` fatals on a
  repository with no commits, where the branch *name* is perfectly readable; a fresh `git init`
  rendering as an error row is exactly what makes a list untrustworthy. Reading the name first
  makes unborn fall out for free: a branch that names no row in `refs/heads` has no commit yet.
- **`--end-of-options` is omitted when there are no operands**, because `git rev-parse
  --show-toplevel --end-of-options` **prints the flag as an output line** (measured, 2.55.0)
  instead of ignoring it, which would put a line of garbage in front of every answer. The one
  `rev-parse` that does take an operand uses `--verify --quiet`, which prints only the sha.
- **The repository test is a path *equality*, not `rev-parse` succeeding.** `--show-toplevel`
  answers from anywhere *inside* a repository, so every plain child of a checkout — and every
  child of a root that is itself a repository — would have been listed as a repository of its
  own. A child qualifies only when the toplevel git names is the child itself, compared
  case-insensitively on Windows and `resolve`d because git prints `C:/Users/…` with forward
  slashes while everything beside it on the page is spelled the other way. There is a test for
  this that points the root at a repository and expects nothing back.
- **Resolving a slug is not a full scan.** A `readdir` plus one `rev-parse` on the children that
  match the name, rather than `scanRepositories` — otherwise opening one file's blobs costs
  three spawns times every repository under the root. It keeps the collision check honest, since
  it still counts matches across every root instead of stopping at the first. The cost is
  visible and accepted: ~89 ms per blob fetch, of which about half is this lookup.
- **`LC_ALL=C` on every invocation.** One git message is *matched* rather than merely shown —
  the rename-limit warning — and Git for Windows ships translations. Pinning the locale is what
  keeps that recogniser from quietly failing on somebody else's machine.

**Nothing needed extracting for classification.** `readBlob` and `MAX_BLOB_BYTES` are already
exported from `blob.ts`, and its `./db` import has no top-level side effects, so a git-only
module importing it costs nothing at load. Two definitions of "binary" was the thing to avoid and
there is still one.

**The two paths that had never been observed are now observed.** `renameDetectionSkipped` is
tested by a fixture with `diff.renameLimit = 1` and three renames: git skips detection, warns on
stderr, exits 0, and the six files come back as three adds and three deletes with the flag set.
And the `cat-file` drain has a fixture of its own — a file that is 1.2 MB on one side and one
line on the other — because refusing the big side without reading past its bytes leaves 1.2 MB
of `x` where the next record's header should be, and the test that catches that is the one that
asks for the *second* side.

Unproven, and the reason: **`UnreadableRepository` has no test.** It needs a directory that
answers `--show-toplevel` and then fails to enumerate its refs, and every corruption tried fails
the toplevel test first and is simply not listed — which is the correct behaviour, just not the
one being aimed at. The path is four lines and a catch. The submodule note is also
hand-constructed rather than built from a real gitlink: a real one needs a second repository and
`protocol.file.allow`, to exercise a branch that by construction never reaches git.

---

## T-044 — The repositories list

**Type:** feature · **Status:** resolved · **Blocked by:** T-043

**Success:** `/repos` lists every repository under the root, instantly, and every one of them is
one click from its branch diff. Reaching it costs one link — **Repositories**, beside History in
the inbox header — and **no new global key**: a page you open once a session from a link already
on screen has no wording worth printing in the `?` sheet, and the four `nav.*` commands are
claimed with `useCommand` the way every other list claims them.

**Instant means ref-reads only.** Name, current branch — or *detached*, or *unborn* — and the
resolved target with the rung that answered it. **Not** the commit count, **not** the dirty
count, **not** the file list: those are the diff page's, because `status` is 107–216 ms per
repository and parallelism does not rescue it (2.7 s → 2.16 s across 19). Refreshed on window
focus, since you switch branches in a terminal and not in this app, and never cached across a
scan — a repository appeared under the root mid-design.

**Four empty states, and none of them is "no repositories found":** the root is not configured;
the root does not exist, named; the root exists and holds no repositories, named; and a
repository that could not be read, listed with its reason and not silently dropped. A page that
lists nothing is otherwise indistinguishable from a page that failed.

Prof throughout: existing tokens, existing `ui/` primitives, no new colours, the `Empty`/`Failed`
pair reused rather than re-invented.

### Resolution

Uncommitted, with the rest of the round. New: `src/components/repo-list.tsx` (`RepositoryList`,
`useRepoSelection`, `openable`), `src/components/repo-list.test.tsx` (19 tests),
`src/routes/repos.tsx`, and `src/routes/repos.$repo.tsx`. Changed: `src/routes/index.tsx` gained
one link, and `src/routeTree.gen.ts` regenerated. **1,164 tests in 60 files pass**; `pnpm
typecheck` is clean.

The split is `pr-list.tsx`'s and for its reason — the list is a component so it can be rendered
without a fetch, and the route's only other job is the fetch. Nothing new went into
`registry.ts`: the page claims `nav.next`, `nav.previous`, `nav.open` and `nav.back` with
`useCommand`, and the test that pins this asserts the `?` sheet lights **exactly** the same six
entries the inbox lights.

`src/routes/repos.$repo.tsx` is T-045's page, landed here as a heading and a param. A list whose
success criterion is "one click from its branch diff" needs the click to have somewhere *typed*
to go — `<Link to="/repos/$repo">` does not compile against a route that does not exist — so the
address is claimed in this ticket and filled in by the next one.

Five decisions the ticket did not settle:

- **No Refresh button**, unlike the inbox and the history page. Theirs forces an answer past an
  ETag; here `gcTime: 0` and no `staleTime` mean leaving the page throws the list away and
  arriving re-reads it, so a button's only effect is the one that already happened on the way in.
  Window focus — which is what returning from a terminal *is* — is already covered by the
  client's default. That is the whole of "never cached across a scan".
- **The cursor moves over openable rows only.** Every other list in this app can say each row
  goes somewhere: an inbox row with no GUIDs still opens in Azure DevOps. Here an unreadable
  repository and a collided one go nowhere at all, and a cursor exists so that Enter has
  something to open. Stopping on a row where Enter does nothing is a cursor that sometimes lies —
  and it would also mean focusing a row with no focusable element, so the highlight and the
  screen reader would disagree. Both kinds of row are still on the page, saying why.
- **The rung is printed in full, in `TARGET_RUNG_LABEL`'s words.** "a local branch — this
  repository has no origin" is long for a list column, and the shorter wording this page would
  otherwise have invented is precisely the drift the constant exists to prevent. It truncates at
  narrow widths like every other secondary column.
- **A missing root is stated even when the list is not empty.** The ticket frames "the root does
  not exist" as an empty state, but roots are `path.delimiter`-separated: with two roots, one
  gone and one full, the page would draw a plausible list and never mention that half of what was
  asked for is not there. So a configured-and-absent root is a `Failed` line unconditionally, and
  only "holds no repositories" is gated on the list being empty.
- **Rows are keyed by `path`, not by `slug`.** The one case where two rows share a slug is the
  collision, which is exactly the case where React would warn and reconcile the two into one.

The **one level deep** rule is said out loud in two places — the empty root's sentence and the
footer — because a directory of nested checkouts is otherwise indistinguishable from an empty
one, and that is the one wrong conclusion this page can lead someone to.

Unproven: the page has not been rendered against the real disk. Every shape it draws comes from
`local-git-contract.ts` and is exercised by the component tests, and T-043's live probe measured
the scan those shapes arrive from (20 repositories, 755 ms, 0 unreadable) — but nobody has
watched the two meet in a browser. `detached`, `unborn`, `unreadable` and the collision have no
live source at all: 0 of 20 repositories can produce one.

---

## T-045 — The branch diff

**Type:** feature · **Status:** resolved · **Blocked by:** T-042, T-043

**Success:** on a local repository with a feature branch, `/repos/$repo` shows the whole-branch
diff against the resolved target, rendered by the same view a pull request uses, with the same
sidebar, the same side-by-side toggle, the same expand-context, the same syntax highlighting and
the same viewed marks. Nothing about the diff body should be recognisably different from the PR
page, because it is the same component.

- **The first `validateSearch` in this app.** `?branch=` and `?target=`, both optional; absent
  means "resolve now" — branch from `HEAD`, target from the ladder — and present means pinned.
  **The URL is the only memory**: nothing is persisted, no preferences table, no `localStorage`,
  because a remembered target silently diffs against a stale base when a repository's default
  moves, and the mitigation is already agreed — **the target is always displayed**.
- **What the header states**, always, not on hover and not on demand: the branch, the target and
  which rung resolved it, **how old the base is** (the app never fetches, so staleness is the
  reader's to judge), the commit count, and the **dirty file count** — the diff is committed
  history, and a count of 6 uncommitted files is the difference between "my change is missing"
  and "my change is not committed".
- **The legitimate empty case says so.** 11 of 19 repositories sit on their own default branch,
  where the whole-branch diff is correctly empty. "This branch is the target — there is nothing
  to compare" is the answer; an empty file list is not.
- **Viewed marks in their own table**, keyed `(slug, branch, viewedKey)` — the sixth migration.
  `viewedKey(objectId, path)` and `contentId` are reused verbatim; they name no vendor. Like
  `viewed_file`, this is **not a cache**, and the migration rule that follows from that status
  follows it here.
- **Withheld, deliberately:** no threads, no composer, no Sonar, no checks, no votes, no
  policies, no details tab. `ChangedFileDiff` already defaults `threads`, `threadActions` and
  `iterationContext` to `null`, and withholding `onNewThread` is what takes the compose buttons
  off every row — so a local diff offers no invitation to write something that goes nowhere.
- **A ref that has gone** — a branch deleted in the terminal after the page loaded — fails
  closed with words and a click to the resolved default, per T-043's whitelist. Not a silent
  fallback.

### Resolution

Uncommitted, with the rest of the round. New: `src/components/branch-diff.tsx` (`BranchDiff`,
plus `Diffed`, `Dirty` and the local `Empty`), `src/components/branch-diff.test.tsx` (19 tests),
`src/components/diff/layout-toggle.tsx`, and `src/routes/repos_.$repo.test.tsx` (5 tests).
Changed: `src/routes/repos_.$repo.tsx` filled in from the heading T-044 landed as
`repos.$repo.tsx` — see the underscore below,
`src/components/pr-detail.tsx` now imports the toggle it used to hold, and `src/server/db.test.ts`
and `tsr.config.json` for the two reasons below. **1,193 tests in 62 files pass**; `pnpm
typecheck` is clean.

The split is T-044's and for its reason: the view is a component so it can be rendered without a
fetch, and the route's other job is the two fetches. The diff body is not written here at all —
`ChangedFileDiff` draws every file exactly as the pull request page draws it, and the only thing
that differs is where the bytes come from, which is `localDiffSource`'s whole job. A test asserts
the withholding directly: no button matching `/comment/i` and no textbox anywhere in the list.

**The route file is `repos_.$repo.tsx`, with an underscore, and this was a bug before it was a
decision.** Named `repos.$repo.tsx` — which is how T-044 landed the heading and how this page was
first written — TanStack makes it a *child* of `/repos`, and a child renders inside its parent's
`<Outlet />`. The repositories list has none, so clicking a repository resolved the address,
changed the URL, and left the list on screen: the diff never mounted. Nothing in the test suite
could see it, because every test here renders a component and none of them renders the route tree.
Found by opening the app. The trailing underscore opts the segment out of nesting and the URL is
unchanged at `/repos/$repo`, so every `<Link to="/repos/$repo">` still compiles; the alternative —
an `<Outlet />` on the list plus an index route — would say the diff is drawn inside the list,
which it is not.

Nine more decisions the ticket did not settle:

- **The search parser is an exported pure function**, `branchDiffSearch`. A route module is a
  fetch and cannot be rendered in jsdom without one; its `validateSearch` is the one part that is
  neither, so it is exported and tested on its own. That test file is the first under
  `src/routes/`, which is why `tsr.config.json` gained `routeFileIgnorePattern` — `tsr generate`
  otherwise warns on every typecheck that a route file exports no route.
- **An empty pin is dropped, not thrown.** `?branch=` with nothing after it is a URL that lost its
  value; reading it as "use HEAD" would diff something other than what the link said. Thrown would
  be an error boundary, and this page is meant to be the thing that says what went wrong. A
  repeated key (an array) and a number go the same way.
- **Nothing is sanitised here.** `?branch=--upload-pack=touch` passes through untouched and is
  pinned by a test that says so, because the thing that makes a ref safe is T-043's lookup in the
  set the server just enumerated, and a second half-measure in the client would only suggest the
  first one is optional.
- **The way out is conditional on something being pinned.** A dead pinned ref gets a click that
  clears both pins; with nothing pinned there is no default to fall back *to* — the failure is the
  repository or the ladder — so it degrades to a link back to `/repos`, because a link to the page
  you are on is not an escape.
- **No `Esc`, no `nav.back`.** The command sheet is a fixed set that a test pins to exactly what
  the two lists and the pull request page claim, and a whole-branch diff was not asked to grow it.
  The header link is the way out.
- **Two queries, both `gcTime: 0`, on separate keys.** `status --porcelain=v2` is the slow one at
  107–216 ms and the diff must not wait behind it. The pins are in the diff's key as `null` rather
  than `undefined`, because the pinned and the resolved diff of one repository are genuinely
  different answers. Neither is cached: returning from a terminal is a window focus, and a diff of
  what your disk held ten minutes ago is the one thing this page must not be.
- **The view reads its own marks.** The branch they hang on is the *resolved* one, which arrives
  with the change set — on `/repos/platform` with nothing after it the route does not know that
  name, so a route holding the hook would have to key it on something it has not been told yet.
  `layout` goes the other way for the mirror-image reason: the container widens for side-by-side
  and only the route can widen it.
- **`LayoutToggle` was extracted rather than copied.** "The same side-by-side toggle" has to mean
  the same component; a copy is a second place to remember that the pressed option is a teal wash
  and not `bg-muted`, and the second one to be forgotten.
- **"base last committed 7d ago", not "base is 7d old".** `age` is the inbox's and returns a
  finished phrase, so the sentence is built around it instead of composing one out of it — the
  first draft read "base is 7d ago old". The exact timestamp is on the `title`, because the
  relative form is what you triage on and the date is what you check afterwards.

The ticket calls the marks table "the sixth migration" and it landed in T-042 as the **seventh**;
round 5's `pr-signal` took six. `db.test.ts` pins the shipped tables and every version row by
hand, so this round's own migration broke two of its assertions — corrected here rather than in
T-042, because that is where it was found. Both failures came with an `EPERM` from the `afterEach`
that deletes the temp directory: the assertion throws before `db.close()`, so Windows still holds
the file. That is a knock-on and not a second bug.

**The server half is now proven live**, by a throwaway probe run through `local-git.ts` itself
against the real root and then deleted — 22 repositories (three more than T-041 counted; the root
keeps moving), every one of them either diffed or refused with a sentence:

- `platform` 13 files across 25 commits, `chore/support-aspire-and-containers → origin/master`
  by `origin-head`, 9 uncommitted; `auth` 17 files across 24; `rest-api` 10 across 14;
  `file-provider` 4 across 2 from `feature/ntfs-os-agnostic`.
- **12 repositories are the legitimate empty case** — on their own default branch, 0 files and 0
  commits — which is the state the page's own sentence exists for, and it is the majority state.
- **`ado-web` and `xshot` resolve to `local-branch`**, having no remote, exactly as T-041
  measured. Their base timestamp comes back with a local offset (`…-04:00`) where a remote's
  comes back as `Z`; `age` parses both.
- **Both detached checkouts refuse**, with "HEAD is detached, so there is no branch to diff. Name
  one in the URL with `?branch=`." That is the returned-error path the page draws as an `Alert`,
  reached without contriving it.
- Blobs load: the first changed file of every non-empty repository came back with real `text`
  sides and no note.

Still unproven: the *view*. jsdom implements no `IntersectionObserver`, so no panel in these tests
ever decides it is on screen, and no test in this round has put those bytes through the
highlighter — the expand-context and the split view are covered against the same component by the
pull request page's tests, but never once against bytes that came off this disk.
