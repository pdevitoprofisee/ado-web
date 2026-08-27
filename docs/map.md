# The Map

A local-only, single-user web client for reviewing Azure DevOps pull requests.

This document is the agreed route. Four sections: **the destination** (what we're
building and why), **the notes** (facts and constraints we paid for, which the build
must not rediscover), **decisions so far** (an index of resolved tickets), and **the
fog** (deliberately unmapped).

Detailed API evidence lives in [`docs/research/`](./research/). Anything marked
`[LIVE]` there was verified against real endpoints; trust it over intuition.

---

## The destination

A dense, keyboard-driven PR review client that beats the ADO web UI at the one thing
it's bad at: reviewing a real pull request with 300 Sonar comments, a failing build,
and a diff you actually need to read.

It runs on `localhost` for one person. That is a design licence, not an oversight —
it removes multi-tenancy, sessions, and hosted-deployment concerns from every ticket.

### Shape

| Layer | Choice |
|---|---|
| Runtime | TanStack Start (SSR **off** for app routes; we want its server half + Router) |
| UI | React + TypeScript + Tailwind 4 + shadcn `--base aria` (React Aria Components) |
| Data | TanStack Query (client) · TanStack Virtual (rows) |
| Server | Start server functions — the only thing that talks to ADO or Sonar |
| Persistence | SQLite, server-side |
| Secrets | Windows credential store via `@napi-rs/keyring` |
| Package manager | pnpm |

**The server is not optional and not just a proxy.** Four separate requirements
collapse into it: reading rate-limit headers the browser can't see, keeping the PAT
out of the page, owning the SQLite cache, and shelling out to `git` in phase 2. That
is why we chose Start over a plain Vite SPA — `configureServer` middleware does not
exist in a production build.

### Auth

One ADO PAT (`vso.code_write` + `vso.build_execute` + read scopes) and one SonarCloud
personal token. Both in the credential store; the browser never receives either.

### The inbox

Sectioned dense list: **Mine** first, then **Assigned to me** (including PRs where a
*team you belong to* is the reviewer). Rows carry check state, unresolved *human*
comment count, staleness, conflict state, and whether a push reset your approval.

Rows hydrate lazily — visible rows first, the rest on idle — because check state and
comment counts for N PRs is irreducibly 1+N calls (see notes). Cache keyed on
`lastMergeSourceCommit.commitId`, so an unchanged PR costs nothing on re-poll.

Refresh: ~30 s for the open PR, ~2 min for the inbox, backing off when unfocused.

**History** (`/history`, linked from the inbox header) is the same list with the
opposite filter: pull requests *you* authored that are `completed` or `abandoned`,
newest-closed first. Two ADO calls, one per outcome, both filtered by `creatorId`;
no hydration and no polling, because a finished pull request does not change.

### The PR review view

File-by-file navigation over a diff we render ourselves:

- One virtualized row list across **all** files, hunks, comment threads, and
  expand-context rows — a heterogeneous row list, not one document per file.
- Shiki tokens produced in a **worker pool** with an LRU cache keyed by content hash.
- **Plain text paints first**; rows upgrade in place when tokens arrive.
- Unified and side-by-side; unified is default.
- Ignore-whitespace toggle, per-file *viewed* checkbox, copy-permalink,
  open-line-in-web.
- **"Changes since my last review"** via iteration comparison (`$compareTo`).
- Binary files render a stub: "binary — open in web".
- Comment threads are rows **inline in the diff**, not a sidebar.

Alongside the diff: the title (editable in place while the PR is active) and the
description (read-only), branches, conflict state stated
loudly, a policy checklist of what is actually blocking completion, reviewer votes,
the commit list, read-only labels, and ADO's own activity trail as a collapsed
section.

### Comments

`active` and `pending` read as **open**. `fixed` / `wontFix` / `byDesign` / `closed`
read as **done** and collapse to a one-line stub *in place*, keeping their diff
anchor — GitHub-style disclosure, expandable. Per-PR "hide done" toggle.

You can reopen a thread. Replying to a done thread does **not** silently reactivate
it. As a setter the app offers only **Resolved / Won't fix / Pending** — the other
states are readable but not writable, because they carry meaning we'd be guessing at.

Composer is markdown with preview, @mentions, visible likes, and edit/delete on your
own comments only.

### Sonar

Findings come from **SonarCloud's API, not from ADO's comment threads.** ADO caps
Sonar's PR comments at 50, so on exactly the PRs where this feature matters the
threads are structurally incomplete.

- Sonar-authored ADO threads are detected and kept out of the human conversation.
- Findings **group by rule**, count descending, severity badge. Expanding a group
  lists its `file:line` occurrences, each of which jumps into the diff.
- Quality gate plus failing conditions in a PR-level panel.
- Rule detail rendered in-app, with a verified fallback to the public rule site if
  descriptions turn out to be plan-gated.

### Checks, builds, actions

Per-step pass/fail from the build timeline; the failing step's log inline; **failed
tests only** (name, class, message, stack). Re-run at whichever granularity fits:
requeue the policy, retry the build, or retry a single stage.

Write actions: comment, resolve, vote, add reviewers (org-wide autocomplete),
**squash merge**, abandon, reactivate.

The squash merge is the only write that changes a branch, and it always does two
things: the commit message is the reviewer's, written in fields on the page rather
than composed by ADO, and the source branch is deleted. Both are named in the one
confirmation in front of it.

### Notifications

In-app only, while the app is open. Events: build failed · new comment on my PR ·
someone voted on my PR · a PR I'm reviewing got new commits.

A global slide-over panel backed by SQLite with per-item read state and an unread
badge, plus **sounds differentiated per event type** and a mute toggle.

### Repositories

Deliberately minimal: a searchable flat list across the org — name, project, default
branch — with copy-clone-URL and open-in-web. No in-app file browser.

**There is no "last updated" column, and there cannot be a cheap one** `[LIVE]`. This line
used to promise one; T-046 looked and found that a repository carries **no timestamp of any
kind**. `project.lastUpdateTime` is the *project's* and is actively misleading — `SaaS` reports
`2022-03-03` while a repository in it was last pushed `2022-06-06`, and all seventeen would
print the same date. A real one costs `pushes?$top=1` per repository: ~66 ms × 114 ≈ 7.5 s
serial. If it is ever wanted, it is lazy hydration like the inbox rows, not a column — and
`pushes` is the source, not `commits`, whose date is the commit's and so goes backwards after a
rebase.

**This is the org-wide list, and it does not exist yet.** `/repos` is the *local* page
(see below), shipped first because it needs no credential. The two are the same subject
seen from two sides and they converge later — but **not on the `origin` URL as a string**.
The identity of a repository is the triple **org / project / name**; the host is not part of
it. A clone taken before the migration still says `https://{org}.visualstudio.com/{project}/_git/{name}`
and ADO's `remoteUrl` is always the `dev.azure.com` spelling and **will never report the legacy
one back**. Measured on one disk: string equality joined 3 of 18, the triple joined 18 of 18.
A join written on the URL would report fifteen clones as unrelated to the org they came from,
silently, looking exactly like a correct empty answer. And a remote that parses as neither shape
— a fork, a mirror, a `file://` path, a non-ADO host — means **"cannot tell"**, never "no match".
Until that join is built, treat them as two lists — and do not add a second local-repository
concept to this one.

### Local repositories

The thing Azure DevOps cannot give you at all: **the whole-branch diff of a local branch
against the branch it will merge into, with no pull request open.** Read-only by
construction — no fetch, no checkout, no stash, no index write.

`/repos` lists every repository under `ADO_WEB_REPOS_ROOT` (default `~/repos`, one level
deep, never cached) with its current branch and the branch a diff would be taken
against; `/repos/$repo` renders that diff in the same view a pull request uses, keyed
entirely off the URL. `/repos/$repo/commits` walks one branch's history 50 commits at a
time — two links and no page numbers, because totalling a 90,000-commit history is a
second walk of all of it — and `/repos/$repo/commit/$sha` renders one commit's diff in
that same view. A merge is the ordinary case rather than the edge (26.4% of the sampled
history), so the commit page states **which parent** its diff is against and links the
others; a root commit says *first commit* instead of failing. The target is resolved down a
ladder — `origin/HEAD`, then
`origin/main`, then `origin/master`, then a local branch — because 2 of the 19
repositories here have no remote at all, and the page states which rung answered and how
old the base commit is, since the app never fetches.

What it deliberately is not: no comments, no Sonar, no checks, no votes, no policies —
there is nothing local to read them from. No working-tree diff (see *Deferred, not
refused*); committed history only, with the dirty file count stated so its absence is
visible. No commit graph — a history is a list. **No viewed marks on a commit**, unlike the
branch diff: a mark keyed on a commit a rebase will replace is a mark that rots. Branch
browsing stays in the fog.

### Standing assumptions

Stated so they aren't silent. Dark theme default, light available, compact density.
Edit and delete are limited to your own comments. Failures degrade inline — a PR
whose checks won't load still reviews — with a global banner when ADO is throttling.
No PAT scope introspection beyond a "test connection" check at setup.

---

## The notes

Hard-won facts. Each one has already changed a decision; violating one costs a
rewrite. Evidence in [`docs/research/`](./research/).

### Traps that fail silently

1. **`searchCriteria.creatorId` fails open.** A non-GUID value is *silently ignored*
   and ADO returns **unfiltered** results — no 400. "My PRs" would render as
   everyone's PRs. **Validate GUID shape before sending.**
2. **Throttling arrives as slow HTTP 200s with `Retry-After`, not 429s.** MS's own
   words: "The response still returns HTTP 200, so retry logic isn't required." A
   client that only branches on 429 eats stalls of up to 30 seconds and looks broken.
   Limit is 200 TSTU per sliding 5-minute window.
3. **`X-RateLimit-*` and `Retry-After` are not in `Access-Control-Expose-Headers`**
   `[LIVE]` — browser JS cannot read them. This, not CORS, is why we have a server.
4. **On auth failure ADO returns 302 to a sign-in page, not 401.** Send
   `X-TFS-FedAuthRedirect: Suppress` to get a clean 401.
5. **ADO caps Sonar PR comments at 50.** Read findings from the Sonar API.
6. **Sonar's line numbers can drift** from the diff if the PR was pushed to after
   analysis. Anchor defensively; don't assume a line exists.
7. **The 30-second thread poll silently erases anything in the diff that is not a
   `RowModel` input.** `changed-file.tsx` rebuilds the whole model from its inputs
   whenever threads arrive, so a composer — or any other transient row — held in
   component state vanishes mid-sentence, with no error and nothing in the console to
   look at. Every such thing is an input with a transition beside `setThreads`
   (T-037's `composer` / `setComposer`), never local state.
8. **`issues/search` cannot return more than 10 000 issues for one project, by any
   route.** `ps` maxes at 500 (`ps=501` and `ps=1000` both `400`, in the probe table) *and*
   `p * ps` cannot exceed 10 000, so page 20 at the maximum page size is the last page
   that exists — there is no request that reads the 10 001st issue. Paging fixes 500;
   nothing fixes 10 000. A client that pages until a page comes back empty therefore has
   to also stop at 20 and **say the list is short** (`SonarReport.truncated`), because the
   alternative is a panel that silently shows 10 000 of 24 000 findings and reads as
   complete. Two caveats worth carrying: no probe in `docs/research/` ever sent a `p`, so
   the second cap is documented-and-briefed rather than in the tables — re-measure it
   before relying on a page 21. And a main branch answered `total: 10000` exactly, so a
   `total` of the ceiling is a floor rather than a count. `total` is still the field that
   says where a list ends (present on every 200 measured); a *short* page is not proof of
   a last page — compare the ADO paging rule below, where a service filters after it
   pages.
9. **Detection that trusts "a poll happened" announces the wrong things, quietly.**
   Three ways, all found building T-039. (a) `hydrate` runs on the *detail* route too,
   for pull requests that are nobody's business here — so the watch list has to be an
   explicit table (`pr_signal`, written only by the inbox poll) and not "whatever got
   hydrated". (b) The same table is what makes a cold start silent: each watermark
   starts at `−1` and primes rather than fires, because "new since you last looked" and
   "new to this database" are indistinguishable and the second one plays forty sounds
   at launch. (c) **The list row cannot tell you whether a pull request is yours** —
   `toRow` keeps a display *name* and no author GUID, and drops `reviewers[]` entirely
   — so author-vs-reviewer must come from which inbox section the row was in, and
   "me" must still come from `connectionData` server-side. Deriving either from the
   list entry mislabels without erroring. Events that live in `threads` or
   `policy/evaluations` are therefore diffed only on a *fetched* hydration; doing it
   per poll restores the 1+3N the commit-keyed cache exists to remove.
10. **Voting and adding a reviewer are the same request.**
   `PUT .../pullRequests/{id}/reviewers/{reviewerId}` is documented as *create or update* a
   reviewer, so a vote addressed to somebody who is not on the pull request **adds them** —
   quietly, with a 200, and with no way to tell the two intents apart from the wire. ADO does
   not re-judge a vote the way it re-judges a merge, so this is the one write where the app is
   the only guard there is: `castVote` re-reads the reviewer list and refuses rather than
   sending. Not live-verified — from the "Pull Request Reviewers" reference at 7.1 — and no
   write on this path has been sent yet (T-040).
11. **`imageUrl` is not one URL shape, and the wrong one fails without erroring.** The same
   field name carries `_apis/GraphProfile/MemberAvatars/{descriptor}` on a comment author
   (42/42) and `_api/_common/identityImage?id={guid}` on a reviewer (30/30) and a PR author
   (99/99) — so a client must inspect the URL, and a client that trusts the field works on
   every comment and breaks on every reviewer. Only `MemberAvatars` answers anonymously;
   `identityImage` **302s to the sign-in page**, which in an `<img>` is a broken glyph and in
   `fetch` is an HTML page with a 200 on it. Two silent failures underneath that, both from
   T-030's table: `identityImage` with an **unknown GUID** answers `200 image/svg+xml` with a
   *generated* monogram, so a wrong id looks like a working avatar forever; and `MemberAvatars`
   with an unknown descriptor answers **500, not 404**, so "no such person" and "ADO is unwell"
   are the same response. Match on the parsed `URL.pathname` and allowlist the one measured
   form — a substring test accepts `identityImage?redirect=/_apis/GraphProfile/MemberAvatars/x`.
12. **A `graph/*` list cannot be paged through `AdoClient.get`, and says nothing about it.**
   The continuation token for the graph APIs is a *response header*
   (`x-ms-continuationtoken`), and `get` hands back parsed JSON and exposes no headers at
   all — so a caller reading `_apis/graph/users` gets page one and no way to learn that
   page one is all it got. The body carries no token and no `count`, so there is not even
   a short-page heuristic of the kind the PR list has (see the paging rule under
   *Structural facts*, which is also the reason a short page proves nothing anyway). T-030
   measured 344 users in one page, so this bites nobody today and bites silently the day
   an org crosses the page size: the picker would offer a truncated directory as if it
   were everybody. `loadDirectory` therefore reports `complete: false` at the documented
   page size of 500 and the mention picker prints that the list may be short, which is a
   count-based guess standing in for a fact the transport cannot see. Fixing it properly
   means giving the client a way to return headers — a change to the file every read goes
   through, and worth doing once rather than per feature.
13. **You cannot find a diff row in the DOM, and the two ways of trying both look like they
   worked.** (a) A per-line `getElementById` answers `null` for precisely the jumps that had
   somewhere to go: the row for line 214 is in the document only while 214 is one of the ~56
   lines the virtualizer currently renders, so the lookup succeeds for lines already on screen
   and fails silently for every line worth scrolling to. `scrollToIndex` on the virtualizer is
   the only mechanism, because it is the only thing that knows where an unrendered row *would*
   be. (b) A line inside collapsed context has **no row at any index** — `expandGap` has to run
   first, and a scroll issued before it lands on the nearest row that does exist, which reads as
   a successful jump onto the wrong line. Found building T-038 part 2. Two smaller ones ride
   along: a lookup that matches either side of a row puts a right-side line two rows out in any
   file with an insertion above it, and in jsdom every offset a virtualizer computes is clamped
   to `scrollHeight - clientHeight`, which is `0` for every element — so a test that asserts
   *which* offset was scrolled to has to define both.
14. **`git diff --raw` abbreviates object ids to 7 characters.** Without `--abbrev=40`
   every sha in the change set is a *prefix*, so a blob cache keyed on it is keyed on luck
   rather than on content — and the failure is a wrong file's contents under the right
   file's name, which no error path catches. `-z` is the same class of mistake one field
   over: without it paths are C-quoted, and **only the paths that need quoting are
   quoted**, so a naive parser is correct on every file in the repository until somebody
   commits one with a space or a non-ASCII character in its name. Both defaults were
   believed to be otherwise until they were looked at, and neither would have been caught
   by a hand-written fixture — which is why the local git tests run real `git`.
15. **`-M` stops detecting renames past `diff.renameLimit` (1000) and exits 0.** The
   warning goes to **stderr**, and the exit code says success. Every rename in a large
   refactor then arrives as an add plus a delete, and the page has nothing to say about
   it — a silently *worse* diff, not a broken one. stderr is captured on every invocation
   for this reason and the condition is surfaced in words. `-C` is deliberately not
   passed: `ChangedFile.changeType` has no word for a copy.
16. **`objectId === originalObjectId` does not mean "renamed".** A `100644 → 100755` mode
   flip arrives as `M` with identical shas **and identical paths**, which is exactly the
   condition `blob.ts`'s `renamedOnly` derivation tests — so the page would claim a rename
   that never happened, on a file whose name did not change. The paths must differ too.
   Not reachable through Azure DevOps, and not authorable on this machine either
   (`core.fileMode=false` in every repository), only pulled from a filesystem with an
   executable bit — so it is a case that must render and cannot be produced locally to
   look at.
17. **Reading the worktree with `fs` under `core.autocrlf=true` makes every line
   changed.** `ls-files --eol` reports `i/lf w/crlf attr/text=auto` here and
   `core.autocrlf` is `true` *globally* on this machine: the committed bytes and the
   on-disk bytes differ by design. Anything comparing a blob against a file read around
   git — the deferred working-tree arm, most obviously — must read through git's own
   filters. The same setting makes a test fixture pass or fail depending on whose machine
   ran it, so fixtures set `core.autocrlf` and `core.fileMode` explicitly, per repository.
18. **`git status` writes to `.git/index` unless told not to.** Refreshing stat
   information is a normal part of the read, and it takes a lock — so a "read-only"
   feature can stall or race the terminal the user is working in, which is the one thing a
   tool that watches your repositories must never do. `--no-optional-locks` goes on
   **every** invocation, as a construction rule and not a review note: it is cheap
   everywhere and load-bearing in one place, and remembering which place is how it gets
   left off.
19. **A tab-separated `git log` format shatters, and `%s` is not one line.** `%s` folds the
   whole first *paragraph* of a message: newlines become spaces and **tabs survive**.
   `platform` holds a commit whose subject is 46,490 characters containing 1,079 tabs, so a
   tab-separated 7-field format yields **1,086 fields** for it. 2 of 90,788 commits do
   this — a rate at which every fixture, every spot check and every day of real use looks
   fine. The separator is `%x1f` (US), which no commit in the sample contains. Note that
   `REF_FORMAT` in `local-git.ts` **does** use tabs and is correct to: a ref name cannot
   contain one. The idiom does not transfer from `for-each-ref` to `log`.
20. **`rev-parse --verify` is not a validator, and `--end-of-options` prints itself.** A
   well-formed 40-hex sha absent from the object database comes back **exit 0 with the
   input echoed**, and so does a *tree* sha; `--quiet` changes neither. The load-bearing
   part is the **`^{commit}` suffix**, which with `--quiet` fails as **exit 1 with
   completely empty stderr** — so the check reads the exit code and never the message.
   Separately, `git rev-parse --end-of-options HEAD` prints `--end-of-options` as its own
   first stdout line and exits 0; `--verify` suppresses it. That one corrupted a batch of
   T-050's own measurements before it was caught. And the shape check has to come first,
   because the revision grammar is a **query language**: `:/fix` searches messages and
   `HEAD@{1}` reads the reflog, both resolving exit 0 to real commits.
21. **Five of the nine ways to diff a merge return empty output with exit 0**, on a commit
   that changed 795 files. `diff-tree -r <merge>`; `diff-tree -r --first-parent <merge>`,
   where the flag is a **silent no-op** though it works on `show`; `diff-tree -r --cc` on a
   clean two-parent merge, which emits **41 bytes** — the sha token alone — so an
   "is there output" check reads success; `show --raw <merge>`, whose default *is* `--cc`;
   and `show --raw --cc`. Two more in the same family: `show --raw -m` concatenates
   per-parent diffs **with no delimiter at all**, so a naive parser emits the same path
   twice, and `--cc` on an octopus emits the `:::` combined format, which passes a
   `startsWith(':')` guard and then throws on the mode letter. **An annotated tag's sha
   diffs to nothing, silently** — 40 of `platform`'s 41 tags are `tag` objects, and
   `diff-tree --root -r <tag sha>` is 0 bytes, exit 0, empty stderr, so an unpeeled sha
   draws a blank page with no evidence anywhere. 26.4% of the sampled history is a merge,
   which makes this the ordinary case and not the edge.
22. **`%(ahead-behind:<deleted ref>)` fatals the whole enumeration.** Exit 128, zero
   rows — so one branch whose upstream was deleted on the server takes away **every**
   branch in the picker rather than one column of one row, and `[gone]` upstreams are
   ordinary. It is also 8.6× the cost of the enumeration it rides on (613.5 ms against
   71.0 on 1,211 refs) where a single `rev-list --left-right --count` is 40.9 ms. Per
   branch on request, never as a column. In the same format string,
   **`%(upstream:track)` is empty both for "in sync" and for "no upstream configured"** —
   13 of 41 branches have none — and what it does print is pre-formatted English
   (`[behind 167]`, `[gone]`); **`%(HEAD)` is `*` or a single space, never empty**; and
   `%(committerdate:iso-strict)` is in each committer's own offset, un-normalised and mixed
   within one repository.

### Structural facts about the ADO API

- **CORS works** (`ACAO: *`, verified `[LIVE]`) — we're just choosing not to depend
  on it. If you ever call ADO from the browser: `credentials: 'omit'`.
- **No `$batch`, no `pullrequestsbatch`, no PR data in Analytics OData.** The list
  response has no statuses and no threads, and `pullRequestId` is a mandatory path
  segment. **1+N is irreducible** — design around it, don't hunt for an escape.
- **No ETags on any PR endpoint.** Invalidate on `lastMergeSourceCommit.commitId`
  from the single list call instead.
- **`graph/subjectlookup`** batch-resolves identities in one POST — the one real
  fan-out win, for avatars and names.
- Own identity GUID: `GET /{org}/_apis/connectionData` → `authenticatedUser.id`.
  Not `profiles/me.id`, which diverges for guests and multi-tenant accounts.
- Reviewer votes: `10` approved · `5` approved w/ suggestions · `0` none ·
  `−5` waiting for author · `−10` rejected. **`isContainer` + `votedFor[]`** are what
  surface PRs assigned to a group you belong to.
- `threads` **ignores every parameter you can give it** `[LIVE]` — `$top`, `$skip`,
  `$expand=none`, `iteration`+`baseIteration`, and three api-versions including omitting it
  altogether, all returned the identical 9 threads. No paging, no filtering, no projection:
  one call gets everything and the selection is yours.
- **Most threads are not a conversation** `[LIVE]`: 32 of 56 sampled threads were
  `commentType: 'system'` — ADO's own vote/push/policy trail — and those are exactly the 32
  with **no `status` field**. 44 of 56 had **no `threadContext`**, so they hang on the PR and
  not on a line. Classify before rendering.
- **A soft-deleted comment has no `content` key at all** `[LIVE]` (7/59), and threads do have
  replies (3/56), so dropping a deleted parent orphans its children. Render a tombstone.
- Anchored threads were **right-side only** in every live sample (12/12), `filePath` always
  leading-slash, and `offset` is **not always 1**. `properties` values are all
  `{"$type", "$value"}` wrappers — and `SupportsMarkdown` arrives as a `System.Int32`.
- **Org-wide `/{org}/_apis/git/pullrequests` is genuinely cross-project** `[LIVE]` — 164
  active PRs spanning two projects, matching per-project enumeration over all six exactly.
  **There is no per-project fan-out**; one call covers the org.
- **The PR list clamps `$top` to 1000 and returns fewer rows than asked for even when more
  exist** `[LIVE]`. `$top=2000` and `$top=5000` both silently return the same 991 as
  `$top=1000`; `$top=500` returned 497; `$top=100` returned 100 but `$skip=100` returned
  98. So **a short page is not the last page** — the service appears to filter after
  applying `$top`. Page on `$skip`, advance by the *requested* `$top`, stop only on an
  **empty** page, and dedupe by `pullRequestId`: whether `$skip` is applied before or
  after that filter is unresolved, so overlap is possible.
- `GET _apis/git/pullrequests` truncates `description` to 400 chars.
- **Org-wide `/{org}/_apis/git/repositories` is genuinely cross-project too** `[LIVE]` — 114
  repositories in one 87 ms / 100 KB call, matching the union of per-project enumeration over
  all six projects exactly, in both directions. Second endpoint after the PR list that needs no
  fan-out.
- **The repository list ignores `$top` and `$skip` outright** `[LIVE]` — not clamped, *ignored*.
  `$top=5` returns all 114 and `$top=5&$skip=5` returns the same 114, byte-identically. **Do not
  confuse this with the PR list two bullets up**: there a short page is not the last page, here
  *every* page is the whole list, so a paging loop never terminates. No `x-ms-continuationtoken`
  and no `Link` header on any run.
- **Repository flags cost money.** `includeLinks` takes the response 100 KB → 235 KB;
  **`includeAllUrls` takes it to 1.58 MB — 16×** — for `validRemoteUrls`, which nothing reads.
  `includeHidden` reveals 3 repositories the default omits. `isDisabled` is true on 11 of 114, and
  `isFork` is **absent rather than `false`** on 110 of 114.
- **Comment likes are a real route** `[LIVE]`: `.../threads/{t}/comments/{c}/likes`
  answers 200 authenticated, 401 anonymously, against 404 for an invented sibling path.
  Reading is measured. The write rides the same route — `PUT` to like, `DELETE` to
  unlike, both bodyless — and is not measured; see the unknowns below.
- `changeType` is a `[Flags]` enum — parse as a comma-separated *set* (`"edit, rename"`).
- Requeuing the **policy evaluation** is the documented way to re-run a PR build; it
  preserves the policy linkage. `stageRefName` is the YAML stage *id*, not the display
  name — `__default` when the pipeline declares no stages.
- Prefer a hand-rolled fetch client over `azure-devops-node-api`, which does not
  surface response headers at all (issue #661) — that would blind us to note 2 and 3.

### Local git

The costs, as opposed to the traps. Measured on this machine against
`C:\Users\PaulDe\repos` — 19 repositories, 14,000+ tracked entries, git
`2.55.0.windows.3`. Full note: [`docs/research/local-git.md`](./research/local-git.md).

- **A `git` spawn costs ~52 ms on Windows and the cost is linear** (10 spawns 0.523 s,
  20 spawns 1.085 s) — so essentially all of it is process start and none of it is the
  work. That makes the unit of cost the *invocation*, not the byte, and it is the fact
  every other decision here falls out of. A file needs two blobs, so a spawn per side is
  ~105 ms per file — **~31 s on a 294-file change** (the largest this app has measured).
- **`cat-file --batch` is ~10 ms a blob** — 200 blobs through one process in 2.09 s, so
  the same 294-file change is **~6 s batched against ~31 s spawned**. Shas go in on stdin
  and the framing coming back is `<sha> SP <type> SP <size> LF`, then exactly *size*
  bytes, then `LF`; a sha the object database does not hold answers `<sha> SP missing LF`.
  Two consequences: the **size is declared before the bytes**, which is what finally gives
  `BlobSide`'s `too-large` arm a live domain (ADO goes chunked above ~256 KiB and declares
  nothing, so the check is dead there) — and an over-limit blob's bytes must still be
  **drained**, because the stream is one sequence of framed records with nothing to
  resynchronise on and every file after a half-read one parses garbage.
- **`status --porcelain=v2` is 107–216 ms per repository, and parallelism barely helps** —
  19 sequentially is 2.7 s, 19 fully parallel is 2.16 s. Nineteen processes against one
  disk is **disk-bound, not concurrency-bound**, so "fan it out" does not rescue it. Which
  is why the repository list reads refs and not status: a list that waited for the dirty
  count would take two and a half seconds to draw nineteen rows. `--branch` makes the same
  call answer the current branch, so branch-and-dirty is one invocation when both are
  wanted.
- **Walking a history is free; the process is the price.** Re-measured at 21 repositories /
  90,792 commits: a 50-commit page off `platform` is **40.9 ms against a 40.1 ms empty
  spawn on the same run**, 1,000 commits is 64.7 ms, and `--all` adds +7 ms at `-n 1000`
  over 1,211 refs. **`--skip` is near-flat** — 41.4 ms at 0, 61.8 ms at 50,000 — so a
  history pages by offset and needs no cursor. Enumerating refs is expensive and walking
  from them is not, which is the same lesson one level up.
- **A commit's diff is one spawn**: `diff-tree --root -r --raw --abbrev=40 -z -M` at
  38.6–44.0 ms, against 52.5 ms for `diff --raw <sha>^ <sha>`, and `--root` is what makes a
  root commit answer instead of exiting **128** with `fatal: ambiguous argument`. 37 root
  commits exist in the sample. `diff-tree` prepends the commit sha as its own
  NUL-terminated token before the first record, and one per parent under `-m`.
- **A correction to the figure above**: `platform`'s `refs/remotes` re-measures at **1,211
  refs in 71.0 ms**, not the 1,264 in 308 ms recorded from the design session. The
  conclusion that enumeration is two operations at two prices stands; the 308 ms does not
  reproduce, and `RefSet` still fetches `remote` lazily on the shape rather than the
  number.
- **Ref enumeration is not uniformly cheap.** On `platform`, `refs/heads` is **3 refs in
  57 ms** and `refs/remotes/origin` is **1,264 refs in 308 ms**. Two operations at two
  prices: locals eagerly, remotes only when something asks for them.
- **`origin/HEAD` resolves on 17 of 19** (`main` ×11, `master` ×6) and **fatals on the
  other 2**, which have no remote at all — it does not come back empty. So the target
  ladder (`origin/HEAD` → `origin/main` → `origin/master` → a local branch) must be driven
  by **exit codes**; a ladder testing for empty output reads a crash as a blank and falls
  through by accident. `refs/remotes/*` is also just a namespace — one repository here
  carries a stray `refs/remotes/local-main` under no remote.
- **Minimum git is 2.30**, because `diff --merge-base` needs it. Verified against 2.55.0,
  as was `--no-optional-locks`.
- **Every one of the 14,000+ tracked entries is `100644`**, and **0 of 19 repositories has
  a gitlink or a `.gitmodules`**. Absences counted, not assumed: a `160000` gitlink is
  worth recognising by its mode so it never reaches `cat-file` (it names a commit this
  object database does not hold, and the answer is `missing`), and it is not worth a fifth
  `BlobSide` arm.

### The diff pipeline

**There is no unified-diff text anywhere in the ADO API.** Not on `diffs/commits`,
not via a media type, and `GitChange.newContent` is never populated on read.

    iterations → iterations/{id}/changes (+$compareTo) → blobs/{sha}?$format=text ×2 → diff locally

`changeEntries[].item.objectId` works **directly** as a blob sha (`objectId` = after,
`originalObjectId` = before) — verified `[LIVE]`, and rename-proof, so no path/commit
resolution is needed. Read `$format=json` first for `size` to skip huge or binary
files cheaply. `changes` supports real server-driven paging via `nextTop`/`nextSkip`.

`POST .../FileDiffs` (7.2-preview.1) optionally gives ADO's own hunk geometry with no
line text — useful only to make our hunk boundaries match theirs. It's preview; guard it.

### Rendering

- **Shiki is the only library that returns line-split tokens with colors.** Use
  `codeToTokensBase` → `ThemedToken[][]`; the first dimension *is* lines, so indexing
  tokens by line number falls out for free.
- Fine-grained setup: `shiki/core` + `createHighlighterCore` +
  **`createJavaScriptRegexEngine()`** (~70–78 KB gzip vs ~200 KB for Oniguruma wasm;
  the docs explicitly recommend the JS engine for web). Do **not** use the raw engine
  or precompiled langs — both are experimental and unsupported.
- Inside a worker: `createHighlighterCoreSync`. Batch **per file, not per line**;
  Pierre's write-up warns that worker round-trips on very large files can dominate
  main-thread time.
- **`getLastGrammarState`** resumes tokenizing for lazily-expanded context without
  re-tokenizing from line 0.
- **Keep the per-line component tree flat.** GitHub's 8-components-per-line → 2 was
  worth ~50% memory and 78% INP *independently* of virtualization.
- No existing React diff library virtualizes. react-diff-view's own published
  benchmark: **26,072 ms render** on a 375-file diff. Rolling our own is the cheap
  option, not the ambitious one.
- **Icons are hugeicons, not lucide.** `<HugeiconsIcon icon={Tick02Icon} size={14} />`,
  with the icon objects from `@hugeicons/core-free-icons`. `lucide-react` is gone from
  the dependencies, so anything shadcn generates — it writes lucide imports — has to be
  translated by hand.

### Sonar

- `Authorization: Bearer <token>`; only a *personal* token can read issues.
- **SonarCloud rejects CORS outright** (preflight 405, "no plans to enable") — the
  proxy is mandatory here, not a preference.
- **Sonar's `pullRequest` key == the ADO `pullRequestId` verbatim**, and the Sonar
  `projectKey` is recoverable from the `id=` param of the ADO status's `targetUrl`.
  Zero configuration.
- Identify Sonar-authored ADO threads by matching `comments[0].author.id` against
  `createdBy.id` on the Sonar quality-gate status. There is no documented marker
  property; this needs no manual config.
- The **MQR / Clean Code taxonomy is authoritative** (`impacts[]`,
  `cleanCodeAttribute`, `issueStatus`). Legacy `type`/`severity` are unreliable.
- Param is `componentKeys`, not `components`, on Cloud.
- **`api/rules/*` requires `organization` on Cloud** `[LIVE]` — without it every request,
  `show` and `search` alike, answers 400 `The 'organization' parameter is missing`. This
  made the whole endpoint look dead for a probe pass; see T-022.
- **Rule descriptions are served to any authenticated token** `[LIVE]` — `rules/show`
  returned `htmlDesc`, `mdDesc` and `descriptionSections` for all three probe rules
  (3.0–12.8 KB, against 1101 metadata-only bytes unauthenticated) with an empty
  `requiredEntitlements`. Not plan-gated: **render rule detail in-app**, and drop the
  `rules.sonarsource.com/<lang>/RSPEC-<n>/` fallback.
- **Batch rule lookups with `rule_keys`, plural** `[LIVE]`. `rule_key=a,b,c` is not an
  error — it silently returns `total: 0`, so the wrong parameter reads as "no such rules"
  rather than as a mistake. `rule_keys=a,b,c` with `f=name,htmlDesc` returns all three
  with descriptions: one request warms every rule in a PR (measured: 3 rules, 28.0 KB,
  392 ms). **`f=` must not contain `type`** — the field is gone, and an illegal `f` entry
  400s the entire request instead of being ignored.
- **A rule can be undescribable.** `external_roslyn:*` keys are requested and simply not
  returned — externally-imported analyser rules are not in Sonar's repository — and
  unknown keys are skipped rather than erroring, so an undescribable rule and a typo look
  identical. Fall back to the bare rule key.
- **`descriptionSections` arrive in an unstable order** `[LIVE]`: the same rule, twice in
  one run, gave `root_cause, how_to_fix, resources, introduction` then
  `resources, introduction, root_cause, how_to_fix`. Impose your own order. The content is
  HTML, and `mdDesc` was byte-identical to `htmlDesc` — there is no markdown path.
- **`issues/search` returns resolved issues by default** `[LIVE]`. A PR answering `total: 3`
  had three `FIXED` issues and zero open ones. Say
  `issueStatuses=OPEN,CONFIRMED,ACCEPTED` when you mean open. `ps` is capped at 500
  (`ps=501` → 400), and `p * ps` at 10 000 — see note 7 for what that costs.
- **Anchor a finding on `textRange.startLine`, not `line`** `[LIVE]`. `line` was present on
  4/4 open issues (and equal to `startLine`) and **absent on 3/3 fixed** ones; `textRange`
  was present on all 7.
- `api/qualitygates` was deprecated 2025-09-16 with no v2 replacement, and **still answers
  200** `[LIVE]` with per-condition `metricKey`/`comparator`/`errorThreshold`/`actualValue`.
  Prefer it anyway for the gate panel: `measures/component` is the documented replacement
  but the metric names in this note's earlier draft **404** on Cloud, `new_*` values hide
  under `periods[0].value` rather than `value`, and `quality_gate_details` is a JSON
  *string*.
- **SonarCloud sends no rate-limit headers at all** `[LIVE]` — 19 response headers, none
  mentioning a limit, retry or quota. A bare 429 is the whole signal, so back off in
  minutes and do not look for a `Retry-After`.
- A repository can map to **several** Sonar projects `[LIVE]`: `context.name` on the ADO
  status is either `quality gate` or `quality_gate_<projectKey>`, and multi-project repos
  post one status each. Query all of them.

### Security constraints (localhost is not a security boundary)

- Bind to `127.0.0.1`, validate `Origin` and `Host`, and require a per-launch random
  token header. A localhost server that shells out to `git` is reachable by any page
  the user has open, and DNS rebinding defeats naive IP checks.
- **The token cannot stop a local process that knows the protocol** (T-010). With SSR
  off and a prerendered shell there is nowhere to inline a per-launch value, so the
  token must be fetched at runtime by one request that cannot itself carry a token.
  That bootstrap is `Host`- and `Origin`-checked, which makes it browser-only — but a
  process running as this user can forge `Sec-Fetch-Site` and collect a token. The
  keychain, not this layer, is what keeps a secret from its owner's processes.
- Read `Host` from the **raw header**, never from `request.url`: srvx falls back to the
  socket's local address when `Host` is absent, so a header-less request presents a
  perfectly innocent `http://127.0.0.1:7331/…` URL.
- **Refs, object ids and repository names reaching `git` are values the server
  enumerated from the repository — never strings the request supplied.** This is a
  whitelist, not a validator: a slug is looked up in the set the scan just produced, a ref
  in the set `for-each-ref` just listed, a sha in the change set just parsed, and what
  goes into argv is the *enumerated* value, not the request's copy of it. A request naming
  something not in the set **fails closed with words** — "no branch named `x`" — and never
  falls back to the default, because a silent fallback shows the diff of something other
  than what was asked for and looks like it worked. Shape validation (40 hex for a sha), a
  leading-`-` rejection and `--end-of-options` are the belt, not the braces: they are
  there for the day somebody adds a call that forgets the lookup. `spawn` with an argv
  array, never a shell and never `exec`.
- `simple-git` must be `>=3.36.0` (three 2026 option-injection RCEs) and request data
  must never reach its options array. Round 6 satisfies this by **not having it** — the
  local git layer is `node:child_process` and nothing else.
- `@napi-rs/keyring`, never `keytar` — archived and deprecated.

---

## Decisions so far

One line per resolved ticket — the gist, plus a link to the ticket that holds the
detail. Nothing is restated here; this is an index, not a store.

- [T-001 — Live API inventory spike](./tickets/round-1.md#t-001--live-api-inventory-spike) —
  all six unknowns answered against the live org. Two deleted planned work (no per-project
  PR fan-out, no rule-description scrape); one rewrote the paging loop. Three of the
  script's own verdicts contradicted its own raw data and were overridden.
- [T-002 — Scaffold](./tickets/round-1.md#t-002--scaffold) — the shape above is real and
  running: Start with SSR off, shadcn locked to the aria base, loopback-bound in dev
  *and* in the Nitro build, a server function answering the client, tests and typecheck
  green.
- [T-003 — Credential capture](./tickets/round-1.md#t-003--credential-capture-and-storage) —
  onboarding that tests each connection before storing it, tokens readable only inside
  server functions. Two bugs only a real PAT could reach: `connectionData` needs
  `7.1-preview.1`, and a *public* org answers it anonymously with a well-formed 200, so
  the identity has to be checked for a `System:` descriptor before it counts as auth.
- [T-004 — ADO HTTP client](./tickets/round-1.md#t-004--ado-http-client) — one chokepoint
  in `src/server/ado-client.ts`: auth headers and `redirect: 'manual'` by construction, a
  throttle gate that reads note 2 the way Microsoft wrote it (a delayed **200** is good
  data — slow the *next* call, don't re-request), rate-limit headers surfaced for the
  banner, a GUID guard that throws before the request leaves, and a conservative,
  explicitly-guessed concurrency cap.
- [T-005 — SQLite](./tickets/round-1.md#t-005--sqlite) — `node:sqlite` (no native addon,
  proven inside the Nitro build), a `schema_migrations` table applied transactionally at
  first use, and one round-1 table: a PR cache whose staleness check lives inside the
  read, so a caller cannot serve a row from before the last push.
- [T-006 — Identity and PR listing](./tickets/round-1.md#t-006--identity-and-pr-listing) —
  the inbox is real: one org-wide listing, partitioned locally into **Assigned to me** and
  **Mine**. ADO's own `searchCriteria.reviewerId=<me>` does *not* expand team membership —
  live it returned 0 while 4 PRs had my team on them — so the filter that looks right is a
  silent empty inbox. **`teams?$mine=true` is not membership either** — it shipped that
  way, Paul challenged the result, and checking every roster showed the account is a direct
  member of **0 of 43** teams while the filter reported 1 of its 28 real containers.
  Membership now comes from `identities?queryMembership=Expanded` on `vssps`, intersected
  with the org's team list — the intersection matters, because `[Products]\Contributors` is
  a container reviewer on 119 of 163 PRs and the raw closure "assigns" all of them. Paging
  was forced past one page at `$top=50` and three short pages were not the last.
- [T-009 — Command registry](./tickets/round-1.md#t-009--command-registry-and-shortcut-sheet) —
  one keydown listener for the app, keys declared in `src/commands/registry.ts` and claimed
  by surfaces with `useCommand`, the `?` sheet generated from that array and dimming what
  nothing is listening for, and a text-entry guard that knows React Aria's widgets.
- [T-010 — Localhost hardening](./tickets/round-1.md#t-010--localhost-hardening) — one
  request guard in `src/start.ts` that every handler sits behind: raw-header `Host`
  validation against DNS rebinding, a per-launch token on every server-function call,
  and Start's origin check re-declared because declaring a start instance would
  otherwise have removed it. The tokenless bootstrap is the stated, unclosable limit.

---

## The fog

Not on the route. Listed so it stays a decision rather than becoming a surprise.

### Phase 2: local repositories — the rest of it

The whole-branch diff shipped in [round 6](./tickets/round-6.md) and history and
per-commit diffs in [round 7](./tickets/round-7.md). Both are in the destination now,
under *Local repositories*. What stays here is **the branch picker**: `BranchRow` and
`AheadBehind` are in the contract and nothing implements them, so a history is reached by
typing `?ref=` rather than by choosing from a list. §15 of the note has already measured
that list — never more than four local branches, up to 1,211 remote-tracking ones, and an
`ahead-behind` field that costs 8.6× over the wide namespace — so it is undesigned rather
than unknown.

Known: browser-only local git is dead (File System Access is Chromium-only and ~100×
slower than native), so this shells out to real `git` server-side. isomorphic-git has
no diff command. The shelling-out is built — see *Local git* under *Structural facts*
for what it costs.

### Deferred, not refused

**Auto-complete** on merge. The user's words: "we may want to bring it in at some
point. I just don't need it for the initial setup."

**The working-tree diff** — a toggle on the local diff that adds uncommitted changes to
what a branch is compared against. Wanted, and explicitly not now: the round-6 diff is
committed history only. The room is left rather than the feature built — the page states
the dirty file count, so "6 uncommitted files" is on screen and the absence of their
contents is visible rather than silent, and note 17 is already written for the day
somebody builds it. *(The user's exact wording for this one is not in the record, unlike
auto-complete's above; the deferral is theirs, the phrasing is not.)*

### Out of scope

Creating PRs · editing the description · work-item editing · batched
"start a review, submit all comments at once" · image and binary diffing · OS-level
notifications · running while the app is closed · multi-user or hosted deployment ·
per-repository settings.

Branch policies **are** bypassable, which this list said they were not. The merge offers
Azure DevOps' own "Override branch policies and enable merge", unticked by default, and only
where the override would clear the refusal — a blocking policy or a required reviewer who
has not approved. It is app-wide rather than scoped to one repository, because there is
nowhere to scope it to.

### Unknowns that needed a real credential — answered

Settled by T-001 against the live `Profisee` org. Raw responses:
[`docs/research/live-inventory.md`](research/live-inventory.md).

1. **Org-wide cross-project PR listing — YES.** The per-project fan-out is deleted.
2. **SonarCloud rule descriptions to an authenticated user — YES.** Rule detail renders
   in-app; no scraping fallback. *Re-confirmed by T-022, which also found what T-001's
   working call had and a later one lacked: `organization` is mandatory on `api/rules/*`.*
3. **Sonar `statuses` `genre` / `name` — confirmed:** genre `SonarCloud`, name
   `quality gate` — *or* `quality_gate_<projectKey>`, one status per Sonar project, on a
   repository that has more than one (T-022).
4. **Comment likes: the route exists and reads** (200 authenticated, 401 anonymous, 404
   for an invented path). **The write is now built and offered** — a `PUT` to like and
   a `DELETE` to unlike, on that same collection. It is still unmeasured: the only proof
   is a real like on a real comment, and the first one somebody sends is that proof.
5. **Line drift — not reproduced,** on a PR whose analysis post-dated its last push by
   eight minutes. That is one negative sample, not a guarantee. Note 6 stands unchanged:
   anchor defensively.
6. **`$top` clamps at 1000, and short pages are not last pages.** See the paging rule in
   *Structural facts* — this one bit the spike's own conclusions before it was measured.

**Still unmeasured: the rate-limit cost of the inbox fan-out.** Not one `X-RateLimit-*`
header came back across ~30 calls — ADO emits them only near the limit, so this is a
*couldn't measure*, not a *costs nothing*. T-004's concurrency cap is therefore still a
guess and must be labelled one, with the 200-TSTU/5-minute budget as the only anchor.
