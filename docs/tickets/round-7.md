# Round 7 — the org-wide list, the first real write, and walking a history

Three tracks that do not touch each other. **Phase 9** of [the route](./round-1.md#the-route) —
the org-wide repository list, and the only phase that has never had a round against it. **The rest
of phase 2**, lifted out of
[the fog](../map.md#the-fog): browsing a local history and diffing a single commit. And
**[T-040](./round-5.md#t-040--the-first-real-write)**, the oldest open ticket in the project,
which this round finally makes cheap enough to be worth a person's afternoon.

Same conventions: each ticket states **success criteria**, not steps; facts referenced by number
come from [the notes](../map.md#the-notes); every ticket carries a **Type · Status · Blocked by**
line, and a **Resolution** written after it lands.

**The fact that shapes this round: the probe already ran, and it took a promise off the map.**
The destination has said since round 1 that a repository row carries "name, project, default
branch, last updated". Three of those are on the response. **The fourth does not exist.** There
is no timestamp of any kind on a repository in `_apis/git/repositories` — not `lastUpdateTime`,
not `pushDate`, not anything. The only timestamp anywhere near it is `project.lastUpdateTime`,
which belongs to the *project*, and the evidence that it is not a substitute is in the same
report: `SaaS` reports `2022-03-03` while the first repository in it was last pushed to
`2022-06-06`, and all seventeen repositories in that project would print the same wrong date.
A real per-repository timestamp costs one call each — 114 of them, ~66 ms apiece, ~7.5 s serial —
which makes it a hydration decision and not a column. T-046 is where that is written down, and it
is already resolved.

**The second fact: there are fifteen write paths, not eleven.** T-040 lists eleven and the tree
holds fifteen `client.write(...)` call sites. The three it never counted are `requeuePolicy`,
`retryBuildRun` and `retryBuildStage` — the last of which sends `{ state: 'retry',
forceRetryAllJobs }` and the middle of which sends a literal `{}`, described at its own call site
as a guess at the minimum. A ticket whose whole point is "these have never been sent" was
undercounting the things that have never been sent, which is the most ordinary way an inventory
goes stale.

**The third fact: a bad write response does not throw here — it renders.** `toComment` and
`toThread` are defensive to a fault: `raw.id ?? 0`, an author falling back to `'unknown'`,
`content` kept only if it is a string. So a `{}` where a comment was expected produces a comment
with id `0`, no author and no content, and the page draws it. `threadStatus(undefined)` returns
`null`, which `resolutionOf` reports as *done*. **That is the exact class of bug T-040 was written
to catch, and it is worse than the one the ticket describes**: not a 200 we cannot parse, but a 200
we parse into something plausible and wrong. Ten of the fifteen paths discard the response
entirely, so on those the drift is invisible until the following re-read. This is why the ledger
(T-049) records the bytes and not the parse.

**The fourth: three worktrees, and only one of them is dangerous.** The repository list is all new
files. The local-history work extends `local-git.ts`, which nothing in daily use depends on yet.
The ledger touches **`ado-client.ts`, the one file every read in the app goes through** — which is
also where note 12 already says a change is owed and "worth doing once rather than per feature".
That ticket lands alone, on its own commit, for [T-042](./round-6.md#t-042--the-diff-source-seam)'s
reason.

**What this round is not.** **No in-app file browser** and no repository content browsing — the
destination says so twice and phase 9 is "deliberately minimal". **The join is not built.** T-046
proves it is possible and names the one rule it needs; wiring the two lists together is later work
and the map still says so. **No repository writes**: no create, no rename, no fork, no policy
edit — a list page's verbs are copy and open-in-web. **No `includeAllUrls`** — it is a 16×
response for a field nothing reads. **No working-tree diff** and no mutations in the local git
layer: still no fetch, checkout, branch create or delete, stash, or index write, and still
`--no-optional-locks` on every invocation (note 18). **No merge-commit diff beyond a stated
meaning** — see T-052. And the ledger **sends nothing**: it is an observer, and every byte it
records is a byte some other code decided to send.

**The HITL ticket is back, and it is not new.** Round 6 ended by pointing out that it sent nothing
anywhere and so every ticket in it was an agent's to close. That is not true of this round. T-040
still needs a throwaway pull request in a repository the user owns and a person deciding to press
fifteen buttons, and the standing rule has not moved: **no `POST`, `PUT`, `PATCH` or `DELETE`
against a colleague's pull request, with no exception for "just to check"**. What changes is the
cost of the afternoon, not who owns it.

---

## T-046 — The repository listing inventory

**Type:** task · **Status:** resolved · **Blocked by:** —

Phase 9 has never had a request sent at it. The destination's four-column row is an assumption
about a response shape, the documented claim that the org-level route spans projects is
*documented and not verified*, and the map's promised convergence with `/repos` — "a clone whose
remote matches an ADO repository is that repository" — is a claim about string equality between a
field nobody has printed and a value nobody has read.

Rounds 3, 4 and 5 each opened with a live probe, and round 6 could skip one only because local git
needed no credential and the numbers already existed. Phase 9 has neither excuse.

**Success:** `docs/research/repositories-inventory.md`, written by a re-runnable script in
`scripts/`, answers each of the following with the raw response printed beneath it — whether the
org-level route is genuinely cross-project, verified the way T-001 verified the pull request list
(against per-project enumeration over every project, compared by id in both directions); the field
census across every repository, with **whether a "last updated" field exists at all** as its own
line; how `defaultBranch`, `isDisabled` and `isFork` are distributed, counting absences rather
than assuming them; whether `$top` and `$skip` are honoured, whether the route clamps and
short-pages the way the pull request list does, and whether a continuation token arrives as the
response header note 12 describes; what `includeLinks`, `includeAllUrls` and `includeHidden` each
add, in bytes; and the exact shapes of `remoteUrl`, `sshUrl` and `webUrl`.

**And then the cheap half nobody has to ask ADO for:** `git remote get-url origin` across the
repositories under the local root, compared against `remoteUrl`, because that is the only way to
find out whether the promised join is a string comparison or something else.

Read-only. Every request is a `GET`, there is no `--allow-writes` gate, and there is nothing in
phase 9 that would want one.

### Resolution

Uncommitted — no commit has been asked for. New: `scripts/repositories-inventory.mjs` and
`docs/research/repositories-inventory.md` (org `Profisee`, 114 repositories, 6 projects).

**The org-level route is genuinely org-wide.** `GET /_apis/git/repositories` with no project
segment answers 200 with 114 repositories in 87 ms and 100 KB, and the per-project union over all
six projects is the same 114 ids — nothing in one set and not the other, in either direction. So
this is the second endpoint after `_apis/git/pullrequests` that needs no fan-out, and unlike that
one it was documented as such and is now measured as such.

**There is no repository timestamp.** The census is `id`, `name`, `url`, `project`,
`defaultBranch`, `size`, `remoteUrl`, `sshUrl`, `webUrl`, `isDisabled`, `isInMaintenance` — all
114 of 114 — plus `isFork`, which is present on **4 and absent on the other 110** rather than
`false`. The only timestamp is `project.lastUpdateTime`, and it is the project's: `SaaS` says
`2022-03-03T16:18:19Z` while the first repository in it was last pushed `2022-06-06T15:35:26Z`, so
drawing it as a repository's age would print one date across seventeen repositories and be wrong
about at least sixteen. **Two of the four promised columns' worth of work turns out to be one
field that does not exist**, and the map now says so.

**What it would cost, measured rather than guessed.** `pushes?$top=1` answers in ~66 ms and
carries both the date and `pushedBy`; `commits?searchCriteria.$top=1` answers in ~138 ms, twice as
slow, and its date is the *commit's* rather than the push's — a rebased branch pushed today
reports a date from last week. So pushes is the better source if the column is ever built, and at
114 repositories it is ~7.5 s of serial latency for one column on a list page. Recorded as a
hydration shape, not built.

**`$top` and `$skip` are ignored outright.** Not clamped — *ignored*. `?$top=5` returns all 114
rows and `?$top=5&$skip=5` returns all 114 rows, byte-identically to the baseline. This is a
**different** failure from the pull request list, which clamps `$top` to 1000 and short-pages, and
the difference matters: on the PR list a `count < $top` stop condition is wrong, and here a paging
loop would never terminate at all, because every page is the whole list. No
`x-ms-continuationtoken` and no `Link` header appeared on any of the seven runs.

`includeHidden=true` returns **117** rows, three more than the default — so hidden repositories
exist in this org and the default hides them. `includeLinks=true` adds `_links` and takes the
response from 99,986 bytes to 235,254. `includeAllUrls=true` adds `validRemoteUrls` and takes it
to **1,579,130 bytes — 16× the baseline** for a field nothing on the page would read. `isDisabled`
is true on **11 of 114**, which is a tenth of the list needing a word rather than an edge case.

`defaultBranch` is present on 114 of 114, so the empty-repository case is **unmeasured here, not
disproven** — the type still has to admit its absence, on the documentation rather than on this
evidence.

**The join works, and not the way the map says.** Of 24 directories under the local root, 18 have
an `origin`. Exact string equality against `remoteUrl` joined **3**. Cosmetic normalisation —
dropping `.git`, stripping the `user@` prefix, lowercasing — joined **3**, adding nothing.
Reducing both sides to the triple **org/project/name** joined **18 of 18**.

The reason is one substitution and it is not cosmetic: fifteen of these clones were taken before
the migration and still say `https://profisee.visualstudio.com/Products/_git/{name}`, while ADO's
`remoteUrl` is always `https://Profisee@dev.azure.com/Profisee/Products/_git/{name}` and **will
never report the legacy spelling back**. The host is therefore not part of a repository's
identity; the triple is. A join written on the URL as a string would have reported 15 of 18
clones as unrelated to the organisation they were cloned from — silently, and looking exactly like
a correct empty answer.

Three map edits followed: `### Repositories` loses "last updated" and gains why; *Structural
facts* gains the org-wide confirmation, the ignored-`$top` finding beside the PR list's clamp so
the two are not confused, and the `includeAllUrls` cost; and the convergence sentence gains the
org/project/name rule with the `visualstudio.com` alias named, because that sentence is what
somebody will implement from.

Unproven, and stated in the report: every figure is one org on one morning; no repository here
lacks a `defaultBranch`; no rate-limit headers came back on the repository call at all, which per
T-001 is a *could not measure* and not a *cost nothing*; and the join sample is one person's disk,
where every clone was made by one tool — a fork, a mirror, a `file://` remote or a non-ADO origin
all reach that parse, and it returning nothing has to mean "cannot tell" rather than "no match".

---

## T-047 — The org-wide repository list: the server layer

**Type:** feature · **Status:** resolved · **Blocked by:** T-046

**Success:** one call returns every repository in the organisation, shaped for a list row, with
the failure returned rather than thrown — and it is **one** request to Azure DevOps, not one per
project, because T-046 measured that it can be.

The shape is rounds 3–6': a loader in `src/server/repositories.ts`, a `repositories-fn.ts` whose
handler returns `{ repositories, error, connected, rateLimit }` the way every ADO-backed server
function already does, and a contract in `src/lib/` naming the row.

- **The row is what exists.** Name, project name, default branch as a **branch name and not a
  ref** (`refs/heads/main` is not what a person calls it), the clone URL, the web URL, and
  `isDisabled`. **No `lastUpdated` field, on the row or in the type** — T-046 proved there is
  nothing to put in it, and a nullable field that is always null is a promise the next person
  will try to keep.
- **`defaultBranch` is optional in the type even though it was present 114 of 114.** The absence
  is documented behaviour for a repository with no commits; this org merely has none. The row
  needs a word for it, and "no commits yet" is not a blank.
- **`isFork` is absent, not `false`, on 110 of 114** — so it is read as "absent means no", once,
  where the row is built, rather than at each place that asks.
- **`$top` and `$skip` are not sent.** They are ignored (T-046), so sending them would look like
  paging that works. If a future org is large enough to need paging, the honest first move is to
  find out how this route actually truncates, and there is no evidence it ever does.
- **`includeLinks` and `includeAllUrls` are not sent either.** 235 KB and 1.58 MB respectively for
  fields the row does not read.
- **`includeHidden` is not sent**, and that is a decision rather than an omission: three
  repositories in this org are hidden and Azure DevOps' own UI does not list them.
- **No SQLite cache.** The inbox has none either and this is the closer analogue of `/history`
  than of the pull request page: one cheap call, a long `staleTime`, and Refresh as the whole
  freshness mechanism. A seventh migration for a 100 KB response that changes when somebody
  creates a repository would be storage for its own sake.

**The clone URL is `remoteUrl` verbatim**, `Profisee@` prefix and all, because that is the string
that works when pasted into `git clone` and a helpfully cleaned-up one is a support question.

Tests: node-environment, `stubFetch` over `globalThis.fetch` the way `inbox.test.ts` and
`ado-client.test.ts` do, asserting the **exact** path and the **absence** of the four parameters
above — a test that pins what is not sent is the only thing that stops a later "while I'm here"
from adding 1.5 MB to a page load. Plus the row mapping against a fixture built from T-046's
recorded response, including the 110-of-114 `isFork` absence, a disabled repository, and a
repository with no `defaultBranch`.

### Resolution

Uncommitted — no commit has been asked for. New: `src/lib/repositories-contract.ts`,
`src/server/repositories.ts`, `src/server/repositories-fn.ts`, and
`src/server/repositories.test.ts` with 13 tests.

**The server function is `orgRepositoriesQuery`, not `repositoriesQuery`.** `local-git-fn.ts`
already exports that second name for the list of repositories on this disk. Two exports called the
same thing across two layers is how the wrong one gets imported, and the name now says which
organisation-or-disk it means.

**One deviation from the ticket, and the ticket was wrong.** It says to stub `globalThis.fetch`
"the way `inbox.test.ts` and `ado-client.test.ts` do". `ado-client.test.ts` does. `inbox.test.ts`
does not — it hands the loader a hand-written fake `AdoClient`. The fake is the better tool here,
because the assertion this ticket cares most about is what was **not** sent: the fake records
`params` as the value it was passed, so the test reads `expect(calls[0].params).toBeUndefined()`.
A stubbed `fetch` would only see a URL, where "sent no parameters" and "sent parameters that
serialised to nothing" look the same. The fake records the argument with **no `= {}` default**
for that reason.

**The absences are pinned.** One test says the path is exactly `_apis/git/repositories` with no
project segment. One says no parameters at all. Together they are what stops a later
`includeAllUrls` from adding 1.5 MB to a page load.

**`isFork` is answered once, at the boundary.** `toRow` writes `repository.isFork === true`, so no
reader downstream has to know the field arrives absent on 110 of 114 rather than `false`. Tests pin
both halves.

**A malformed row is dropped and the count is not.** A repository with no name, no project or no
`remoteUrl` cannot be drawn as a row, so `toRow` returns `null`. `returned` stays Azure DevOps' own
count, so the page can say "112 of 114" instead of quietly reporting 112 as the whole organisation.

---

## T-048 — The org-wide repository list: the page

**Type:** feature · **Status:** resolved · **Blocked by:** T-047

**Success:** a searchable flat list of every repository in the organisation, where typing narrows
it, and each row can be copied as a clone URL or opened in Azure DevOps. 114 rows, one call, no
fan-out, no file browser.

- **The address is not `/repos`.** That is the local page and it stays the local page; the map is
  explicit that two sections describing one route is how they drift. This is a new address, and
  the two link to each other **without** either claiming to be the other's list.
- **Search is local and immediate.** The whole list is in hand, so it is filtered client-side with
  no debounce, no minimum length and nothing to cancel — the same bargain `reviewer-picker.tsx`
  strikes and for the same stated reason. The matcher is a **pure function in `src/lib/` with its
  own unit test**, the way `filterPeople` is, and the input is the component's. It matches on name
  **and project**, because "the repository called `data`" and "the repositories in `SaaS`" are the
  same question asked two ways.
- **No "last updated" column, and the page does not pretend otherwise.** T-046 is why. If sorting
  by recency is wanted later it is a hydration ticket, not a column, and it costs 114 calls.
- **Copy-clone-URL is `remoteUrl` and says when it has been copied.** A copy button that gives no
  feedback is a button people press twice.
- **Open-in-web is `webUrl`**, which is a different field from `remoteUrl` and from `url` — the
  last of which is the API address and would open JSON.
- **Disabled repositories are shown, marked.** Eleven of 114 are disabled; dropping them makes the
  count disagree with the web UI, and this app's idiom for an action that does not apply is to
  show the row with the reason beside it.
- **Empty states are distinguishable**: not connected; the call failed, with what came back;
  and — the new one — **the search matched nothing**, which must not look like "this organisation
  has no repositories". A filtered-to-zero list says what was typed.
- Prof throughout: existing tokens, existing `ui/` primitives, no new colours. `nav.*` claimed
  with `useCommand` the way the other three lists claim them, and **no new global key** — a page
  reached from a link on screen has no wording worth adding to the `?` sheet.

The split is `pr-list.tsx`'s and `repo-list.tsx`'s: the list is a component that renders without a
fetch, the route's only other job is the fetch. Beware the trailing-underscore trap
[T-045](./round-6.md#t-045--the-branch-diff) walked into if any child route is ever added here.

### Resolution

Uncommitted — no commit has been asked for. New: `src/lib/repository-search.ts` and its 10 tests,
`src/components/org-repo-list.tsx` and its 14 tests, and `src/routes/org-repos.tsx`. Edited:
`src/routes/index.tsx` and `src/routes/repos.tsx` for the cross-links, plus the generated route
tree.

**The address is `/org-repos`.** `/repositories` was rejected because it sits one keystroke from
`/repos` in the URL bar and names the same word twice. `/ado-repos` reads as a vendor prefix on a
page where every other route is a plain noun. The inbox's one "repositories" link became two —
**"your repositories"** and **"org repositories"** — reusing the phrase `repos_.$repo.tsx` already
prints as "Back to your repositories". One label on two lists would send people to the wrong one.

**The matcher does not rank, and `filterPeople` does.** Every term must match, in any order, across
`project/name`. The order of the rows is left exactly as the loader sorted it. The reason is the
difference between the two lists: the reviewer picker shows 8 of 344, so ranking is the only way the
right name reaches the screen, while here every match is already on screen in a project-grouped
list. Re-sorting under the cursor would move rows a reader is in the middle of reading. An empty
query returns the same array back, so a component can compare identities.

**The search box is deliberately not autofocused**, and that is the one difference from
`reviewer-picker.tsx`. The command layer returns early on `isTextEntry(event.target)`, so a focused
filter holds `j`, `k` and Enter away from the list for as long as it keeps focus — on a page whose
whole content is a list you navigate. It is the first focusable thing in the main content, so it is
one Tab away. Escape inside the box clears the query, and clears focus when the query is already
empty, because the command layer never sees that key here.

**`nav.open` opens the tab itself.** The provider calls `event.preventDefault()` on every key it
handles, so the focused anchor's own Enter never fires. There is also nowhere in the app for an
org repository to go — no file browser — so the row's primary action is a link out either way.

**The selection lives inside the component, not lifted into the route** the way `useRepoSelection`
is. The cursor has to move over what the search left, and the search box belongs to the component.
The cost is that this list cannot render without a `CommandProvider`, so the test wraps it in one
and says why.

**The page loads.** `/org-repos` answers 200 with `<title>Org repositories · ado-web</title>`, so
the router matched the route and T-045's trailing-underscore trap is not present. `/`, `/repos` and
`/history` still answer with their own titles.

**One fix outside this ticket.** `src/server/local-git.test.ts` failed the whole suite with "Hook
timed out in 10000ms" whenever it ran beside the other 65 files. Its `beforeAll` spawns roughly 90
synchronous `git` processes to build the fixture, which is about 11 seconds alone and more under
load. That hook now states its own 120 second budget, rather than raising the default for every
hook in the suite. `pnpm test` is 1269 passing across 66 files, and `pnpm tsc --noEmit` is clean.

**Unproven:** nobody has looked at the rendered page in a browser. The 200 and the title prove the
route resolves, not that the list is drawn correctly at 114 rows.

---

## T-049 — The write ledger

**Type:** feature (harness) · **Status:** resolved · **Blocked by:** —

T-040 needs a person, and a person's afternoon is worth spending once. The question that ticket
asks — what actually comes back, and did the re-read see the change — cannot be answered by a
script that re-implements the fifteen requests, because that would prove the *API* while leaving
the app's parsers exactly as unproven as they are now. And it cannot be answered by driving the
real UI either, because the interesting bytes never reach the screen: ten of the fifteen paths
discard the response, and the five that keep it hand it to a mapper defensive enough to turn `{}`
into a comment with id `0` and no author.

So the app records what it sent and what came back, and the person just uses the app.

**Success: with one environment variable set, every write the app performs appends a verbatim
record to a file, and the next read of the same resource appends beside it.** Unset — which is
always, in normal use — nothing is captured, nothing is written, and no code path behaves
differently. A second script turns the file into `docs/research/live-writes.md`, one section per
path, stating the status code, the response body as it arrived, the shape the code *infers*, and
the difference between them.

- **`ado-client.ts` is the only file that changes, and it changes at the transport boundary.**
  Every request in the app already goes through it (T-004), which is what makes this one edit
  instead of fifteen. No signature moves: `write` still returns `T | null` and `get` still returns
  `T`. **Callers cannot tell whether capture is on**, which is the whole point — a harness that
  alters the code path proves the harness.
- **The bytes, before the parse.** The record holds the method, the URL with the org substituted
  out, the request body, the status, the response headers, and the response body *as text*. What
  `JSON.parse` made of it is a separate field, and the difference between "the body was `''`" and
  "the body was `null`" and "there was no body" must survive into the file — because
  `write` currently collapses a `204` and an empty `200` to the same `null` and no caller can tell
  them apart.
- **The re-read is the second half of the answer.** T-040's criterion is not just what came back,
  it is *whether the follow-up re-read saw the change*, and every write path already invalidates a
  query key in `onSettled` so the re-read happens on its own. The ledger correlates it — the next
  `GET` whose path is the written resource or its parent, recorded against the write that
  preceded it. That turns "did it land" into a line in a file rather than something the person has
  to remember having seen.
- **The PAT never reaches the file.** Redaction is not optional and not best-effort: the same
  `serviceDetail` redaction `AdoError` already applies, plus the `Authorization` header dropped
  outright rather than masked. A record containing a credential is a worse outcome than no record.
- **Response headers are captured without being exposed.** Note 12 says the client owes callers a
  way to see headers and that it is worth doing once rather than per feature. This ticket does
  **not** do it — it records them, which is the read-only half, and leaves the API change to the
  ticket that actually needs a continuation token. Recording is additive; changing `get`'s return
  type is not.
- **JSONL, appended, one record per line**, so a crashed run leaves a readable file and a long
  session does not hold the transcript in memory.
- **It sends nothing.** There is no request in this ticket. Every byte in the ledger was sent by
  code that existed before it.

**This is the only ticket in the round that can regress something in daily use**, because it edits
the file every read goes through. The existing `ado-client.test.ts` suite passing unmodified is
most of the criterion, plus new tests for the disabled path asserting that with the variable unset
nothing is opened, nothing is written, and the return values are byte-identical. It lands alone, on
its own commit.

### Resolution

Uncommitted — no commit has been asked for. New: `src/server/write-ledger.ts` (283 lines),
`src/server/write-ledger.test.ts` (11 tests) and `scripts/live-writes.mjs` (269 lines). Changed:
`src/server/ado-client.ts`, +110/-13. `src/server/ado-client.test.ts` is byte-identical, and its
27 tests still pass beside the 11 new ones. The full suite is 1,243 tests across 64 files.

**No write has ever been sent.** Not one `POST`, `PUT`, `PATCH` or `DELETE` went to Azure DevOps in
this ticket. So the ledger has recorded exactly zero real responses, and
`docs/research/live-writes.md` does not exist. T-040 still needs the person. The harness is ready,
and it is no longer the reason to wait.

**One environment variable, one comparison per call.** `openWriteLedger` returns `null` when
`ADO_WEB_WRITE_LEDGER` is unset, and `null` is the whole disabled path. The test points the
variable at a file one directory below the temp root. With the variable unset it asserts that the
directory was never created, which covers the `mkdirSync` as well as the append.

**A 204 and an empty 200 are now different records.** `new Response(null, { status: 204 }).body` is
`null` while `new Response('', { status: 200 }).body` is not. That is the discriminator, so the
record carries `present` beside `text` and `chars`. The caller still receives the same `null` from
both, which was the point of recording the bytes instead of the return value.

**The pre-written ledger cleans strings, and `parsed` is not one.** `clean` drops any string
holding the credential, and it reaches `headers`, `body.text`, `requestBody` and `error`. It cannot
reach inside the parsed object, because that object is the app's own. A test wrote
`{"token":"pppp…"}` through `write` and found the token in the file. The fix sits at the client
rather than in `write-ledger.ts`: if the raw body contains the PAT, the record drops `parsed` and
keeps `caller` as `value`. So a body that carried the credential loses its parse and its bytes
together, and `body.text` says which reason applies. **This deviates from the ticket**, which asked
only for `serviceDetail`'s redaction, and it is the one place that holds both the body and the
token.

**A write with no answer is a record, not a gap.** The client writes `status: 0` when `fetch`
rejects. Note 2 makes that the ambiguous case, because a timed-out `POST` may already have been
applied. An omitted record would read exactly like a button nobody pressed. **This deviates from
the ticket's field list**, which enumerates a status that arrived.

**The read is claimed before the request goes out.** `get` calls `claimRead` first, then observes
the response before `demand`. Both orderings matter. Claiming late would record the second read
rather than the first one that could have seen the write, and observing after `demand` would find
the body already spent by `serviceDetail`. `observe` takes a `clone`, so the parse still reads its
own copy. A test posts a comment, then reads the thread list twice, and finds one correlated read
matched as `ancestor`.

The generator takes the ledger path and the output path as positional arguments, defaulting to
`ADO_WEB_WRITE_LEDGER` and `docs/research/live-writes.md`. The second argument exists so
verification can write somewhere else, and it did: a hand-made 12-line fixture in the system
scratchpad produced 9 writes, 2 re-reads, 8 path sections and 1 unreadable line, with nothing
written into `docs/research/`. The fixture covers the 200 that parses into `{}`, the 204, the empty
200, a 403, a 200 carrying a sign-in page, a write with no response, a dropped-credential body and
a truncated last line.

One edit outside the ticket: `src/server/local-git.test.ts`'s `beforeAll` now takes `120_000`. It
builds eight repositories and failed the file at Vitest's 10 second default on this machine.

Unproven, and the list is long because nothing has been observed yet. The record format has never
met a real Azure DevOps response, so every field is a prediction. `MAX_PENDING` is 8 and no real
page has ever filled it, so a person clicking faster than the re-reads return may drop a
correlation. The headers are recorded and read by nobody, so note 12's API is still owed. The
`{org}` substitution replaces the first path segment only, which is right for `dev.azure.com` and
untested against `vssps` or a legacy `visualstudio.com` host. And the credential drop is a
substring test against one PAT, so a body echoing a *different* secret would go into the file
intact.

---

## T-040 — The first real write

**Status: still open, and now blocked by T-049.** The ticket is in
[round 5](./round-5.md#t-040--the-first-real-write) and is not restated here. Two corrections from
this round attach to it:

1. **Fifteen paths, not eleven.** Add `requeuePolicy` (`PATCH
   {project}/_apis/policy/evaluations/{id}`, the only call site that names its own api-version,
   `7.1-preview.1`, and sends no body), `retryBuildRun` (`PATCH
   {project}/_apis/build/builds/{id}?retry=true` with a literal `{}` body its own docblock calls a
   guess) and `retryBuildStage` (`PATCH …/stages/{refName}` with `{ state: 'retry',
   forceRetryAllJobs }`). Two of those three plausibly answer **403** on a repository the user
   does not administer, which is itself a finding worth writing down.
2. **The bug class is worse than the ticket says.** It names "a 200 with a body we cannot parse".
   The likelier failure is a 200 with a body we parse *successfully into the wrong thing* — see
   this round's third framing fact. So the ledger records bytes, and the comparison in
   `live-writes.md` is against the inferred shape rather than against whether the parse threw.

Three things the user has to decide, and no agent can decide for them: which repository and pull
request the afternoon happens against; whether the destructive paths — `deleteThreadComment`,
`abandonPullRequest`, and `squashMerge`, which sets `deleteSourceBranch: true` — are in scope on
that pull request; and the order, since `reactivatePullRequest` proves nothing until `abandon` has
fired and `squashMerge` ends the pull request for every path after it.

---

## T-050 — Local history: the note and the contract

**Type:** task · **Status:** resolved · **Blocked by:** —

The fog's phase 2 has two clauses left, and both are one sentence long: *"walking a history and
diffing a single commit against its parent are a different page and are not designed."* Round 6
resolved the rest of the phase and left these deliberately, having measured nothing about them.

T-041 is the model — a transcription, frozen before code is written against it — with one
difference: **these numbers do not exist yet and have to be taken.** Local git needs no credential
and the repositories are on the disk, so this is a measurement ticket rather than a probe against
a service.

**Success, part one:** `docs/research/local-git.md` gains a section — appended, in the existing
voice, rewriting nothing already there — stating each of the following as a number with the
invocation that produced it:

- **The cost of a commit walk**, at `-n 50`, `-n 200` and `-n 1000`, on one branch and on `--all`,
  with the `--format` string the server layer will actually use. And the field separator that
  format needs, chosen because it **cannot appear in a commit message** — with the sample searched
  to confirm that no subject or author in it contains the candidate, since a separator that
  appears in the data is a parser that silently splits one commit into two.
- **The cost of `--skip=N`** shallow and deep, because paging a history by skipping is O(depth) and
  a page that pretends otherwise gets slower the further you scroll.
- **The per-commit diff, including the two cases that are not a diff of one commit at all.** The
  **root commit**, where `<sha>^` is *fatal* rather than empty — with the exit code and the
  verbatim stderr, plus the invocation that does work. And a **merge commit**, which has two
  parents, so "the diff of this commit" has no meaning until one is chosen: `^` against the first
  parent, `-m`, `--cc`, and `--first-parent` measured against each other, with the merge count in
  the sample stated, because if merges are a third of the history this is a design decision and if
  they are 2 of 500 it is a sentence on the page.
- **Branch enumeration for a picker**, via `for-each-ref` with the format such a picker needs, and
  **whether ahead/behind counts are free** or a second walk. Round 6 already measured that
  `refs/heads` is cheap and `refs/remotes/origin` is 1,264 refs and 308 ms; what is not known is
  what upstream tracking information costs on top.
- **`rev-parse --verify --end-of-options <sha>^{commit}` across six cases**: a valid full sha, a
  valid abbreviated sha, a well-formed 40-hex string that is not in the object database, a tree
  rather than a commit, a string beginning with `-`, and a ref name passed where a sha was
  expected. Each with its exit code and its output.

That last one exists because **the security rule cannot be satisfied by enumeration here.** A slug
is checked against `readdir` and a ref against `for-each-ref`, but there is no finite set of
commits to check a sha against — enumerating a history to validate a member of it is the walk you
were trying to avoid. So the whitelist becomes: ask git to resolve it, and use *git's output*
rather than the request's string. Whether that is sound is exactly what those six cases decide,
and it has to be decided before code depends on it.

**Success, part two:** `src/lib/local-git-contract.ts` extended — not replaced — with a commit, a
page of commits carrying whatever "there is more" turns out to cost, and the per-commit diff's
**parent choice as a named thing** rather than a boolean, so a merge's diff says which parent it is
against. Change vocabulary is not re-invented: `ChangedFile`, `ChangeSet` and `LocalChangedFile`
are reused exactly as they stand. `LocalFileBlobs.note` already exists and already has a home for
a sentence like these.

Absences counted, not assumed, and the section closes with a **What was not measured** subsection —
T-041's does, and both of this round's other tracks have already needed it.

### Resolution

Uncommitted — no commit has been asked for. Changed: `docs/research/local-git.md` and
`src/lib/local-git-contract.ts`. Both were appended to rather than rewritten.

The note gained eight sections and a second **What was not measured**: §10 the commit record and why
the separator is `0x1f`, §11 why a tab-separated format shatters on 2 commits in 90,788, §12 that
`--skip` is near-flat and silent past the end, §13 the per-commit diff and what `<sha>^` does to a
root commit, §14 what a merge commit's diff actually is, §15 branch enumeration for a picker, §16
resolving a request's sha and the flag that echoes itself, §17 what fatals rather than returning
empty. The contract gained `LocalCommit`, `CommitPage`, `DiffedAgainst`, `CommitChangeSet`,
`COMMIT_LOOKUP_MESSAGE`, `BranchRow` and `AheadBehind`, and reuses `ChangedFile`, `ChangeSet` and
`LocalChangedFile` unchanged.

**§13 has one wrong claim in it, and T-051 found it.** It says `parseRaw`'s `header.startsWith(':')`
guard skips `diff-tree`'s leading sha token. It throws. The correction and the one-line fix are
recorded in T-051's resolution, and §13 is left as written — the note is a transcription of what was
measured, and editing it after the fact would make it a worse record rather than a better one.

**The contract was reopened once, in T-052, for one value.** `COMMIT_PAGE_SIZE` moved out of
`local-git.ts` and into the contract, because the walker and the paging control have to agree on the
step and a component cannot import a value from the module that spawns `git`. No type changed.

Unproven: `BranchRow` and `AheadBehind` are declared and nothing implements them — the branch picker
was not built, and a contract nothing consumes has never been tested against real output. §15's
numbers are therefore the only evidence they are right.

---

## T-051 — Local history: the server layer

**Type:** feature · **Status:** resolved · **Blocked by:** T-050

**Success:** one call returns a page of commits on a named ref; one call returns the changed files
of a single commit against a named parent; and the blobs of those files come back through the
mechanism that already exists. No new `git`-spawning file — this extends `local-git.ts`, which is
the only file in the app allowed to touch `child_process` and must remain so.

Everything T-043 established holds without exception. The single-spawn rule: `spawn` with an argv
array, `--no-optional-locks`, `--end-of-options`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, stderr
captured, exit code checked, timeout carried. Handlers return failures rather than throwing.

The parts that are new:

- **A commit sha is validated by resolution, not by enumeration**, per T-050. What reaches a
  subsequent argv is the 40-hex string **git printed**, never the request's copy of it — the same
  rule as a ref, satisfied by a different mechanism because there is no set to look in. `^{commit}`
  is part of the check and not decoration: it is what makes a tree, a tag or a blob fail here
  rather than three invocations later.
- **A root commit is a first-class case, not an error.** Its diff is against the empty tree, and
  the page that shows it should say "first commit" rather than surfacing git's fatal.
- **A merge commit states which parent.** Whatever T-050 measures decides the default; what is not
  negotiable is that the answer is *named on the response* so the page can say it. A diff silently
  taken against the first parent is a diff that omits everything the merge brought in from the
  other side.
- **Paging is by whatever T-050 finds to be cheap**, and if `--skip` is O(depth) then the honest
  page says "next" rather than offering a page number it cannot reach quickly.
- **Blobs are the existing mechanism, unchanged.** `cat-file --batch`, one spawn per file rather
  than per side, the declared-size framing, the over-limit blob refused without being buffered but
  **still drained**, `160000` never reaching `cat-file`. If any of that needs a second
  implementation, something has gone wrong.

Tests run **real `git`** against fixtures built under `mkdtempSync` in `beforeAll`, with
`core.autocrlf`, `core.fileMode` and `commit.gpgsign` set explicitly — T-043's idiom, for its
stated reason. The fixtures have to include the awkward set this ticket is actually about: a root
commit, a merge commit, a commit that only changes a mode, an empty commit, and a history long
enough to page. **Hand-authored `git log` output is not the input** — round 6 caught two wrong
beliefs about git's output that a typed fixture would have confirmed instead of catching.

### Resolution

Uncommitted — no commit has been asked for. Changed: `src/server/local-git.ts`,
`src/server/local-git-fn.ts` and `src/server/local-git.test.ts`. No new file, no new dependency,
and still one file in the app that spawns `git`.

New: `loadCommitPage(slug, ref, skip)` returning `CommitPage`, `loadCommitChanges(slug, sha,
parent)` returning `CommitChangeSet`, and the two server functions `commitsQuery` and
`commitChangesQuery`. The contract is implemented as frozen — no type in
`src/lib/local-git-contract.ts` was touched. Blobs are `loadLocalBlobs` unchanged, and a test now
reads a commit's file through it to prove the second implementation was not needed.

**One thing in T-050's note is wrong, and the fix is in `parseRaw`.** §13 and the contract both say
`diff-tree`'s leading sha token is skipped by `parseRaw`'s existing `header.startsWith(':')` guard.
That guard **throws** — round 6 wrote it against `diff`, which prepends nothing, so nothing had
ever handed it a sha. One line was added: a 40-hex token at a record boundary is skipped, because a
raw record always begins with `:` and nothing else 40 hex digits could be. §13 is left as T-050
wrote it and the correction lives here. That is the third wrong belief about git's output that a
real fixture caught and a typed string would have confirmed.

**Two diff spellings, because §14 proves one cannot serve both.** A root or single-parent commit is
`diff-tree --root -r --raw -M --abbrev=40 -z <sha>`, which §13 measured at 38.6–44.0 ms and which
needs no `<sha>^` to be built and no empty-tree constant to be named. A merge is `diff --raw -M
--abbrev=40 -z <parent> <sha>`, on git's own parent sha, because `diff-tree` answers a merge with
**zero bytes and exit 0** and `--first-parent` is a silent no-op on it. So the response says which
parent it took — `{ kind: 'nth', parent, index, of }` — and the second-parent diff of the fixture's
merge is measurably a different file set from the first's.

**An empty commit is 0 bytes, and that is data.** Not even the sha token, which `diff-tree`
prepends only when there is a record to prepend it to. Read as no files, next to a `commit` and an
`against` the page can still print.

**A tree and an absent sha are told apart by stderr and by nothing else.** Both exit 128 with
`fatal: Needed a single revision` on 2.55.0.windows.3. Only the tree also prints `error: <sha>^{commit}:
expected commit type, but the object dereferences to tree type`, so `not-a-commit` is matched on
that fragment rather than bought with a second `cat-file -t` spawn. `LC_ALL=C` is what makes
matching English safe, and it was already on every invocation.

Paging is `--skip` and an n+1 probe, per §12's near-flat 41.4 ms at 0 and 61.8 ms at 50,000. The
page carries `skip` and `more` and no total, because a count is a second walk of the whole history
for a number nothing needs. A negative `skip` is refused in words: `--skip=` is a flag, so
`gitArgs`'s leading-dash rule cannot see `--skip=-1`, and this is the check that can.

Both new calls throw and both handlers return `{ …: null, error }`, which is round 3–5's rule. The
ref is still whitelisted by `for-each-ref`, the slug by `readdir`, and a ref that is not in the set
fails with "No branch named ... in this repository." and walks nothing — proven by a test, because
the failure a fallback to `HEAD` would produce looks exactly like a correct answer.

17 new tests, 52 in the file, 1,249 in the suite, `tsc --noEmit` clean. The fixture is a seventh
repository, `history`: a root commit, an ordinary one, a mode-only one made with `update-index
--chmod=+x`, an empty one, a `--no-ff` merge whose second parent sits behind the mode change, and
48 empty filler commits. The filler is 6.1 s of process starts on its own, which is why that
`beforeAll` now carries its own `120_000` and a comment saying so.

Unproven: every number here is one repository on one Windows machine with git 2.55.0.windows.3, and
the paging figures are §12's rather than this fixture's — 54 commits cannot show what `--skip`
costs at depth. An octopus merge is handled by construction and not by test, the fixture has no
submodule commit and no commit whose subject contains a US byte, and nothing here has been read
against a repository being written to from a terminal at the same time.

---

## T-052 — The commits page and the per-commit diff

**Type:** feature · **Status:** resolved · **Blocked by:** T-051

**Success:** from a local repository you can walk its history, pick a commit, and see that
commit's diff rendered by the same view a pull request uses — same sidebar, same side-by-side
toggle, same expand-context, same highlighting.

- **The renderer is not touched.** `ChangedFileDiff` takes a `DiffSource` (T-042) and
  `localDiffSource` already exists (T-045). If this page needs a new `DiffRow` kind, a new
  `BlobSide` arm or a second differ, the answer is no and the design is wrong.
- **The URL is the only memory**, as on the branch diff: the ref and the commit are in the address,
  nothing is persisted, and a link is shareable within the one machine this app runs on.
- **What the header states, always:** the commit's subject, its author and date, its abbreviated
  sha in full-selectable form, and — when it is a merge — **which parent this diff is against**,
  because that is the one thing about this page that can quietly show you less than the truth.
- **A root commit says "first commit"** rather than showing an empty diff or an error.
- **Withheld, deliberately:** no threads, no composer, no Sonar, no checks, no votes, no policies,
  and no blame. There is nothing on a local commit to read them from, and `ChangedFileDiff` already
  defaults them to `null`; withholding `onNewThread` is what takes the compose buttons off every
  row.
- **No commit graph.** A history is a list here. Drawing the topology is a different feature and
  the destination has never asked for it.
- **A commit or ref that has gone** — the branch rewritten in a terminal after the page loaded —
  fails closed with words and an offer to go back, never a silent fallback to something else.

Prof throughout, and the same split: a component that renders without a fetch, a route that
fetches. Viewed marks are **not** extended to commits in this ticket — a mark keyed on a commit
that a rebase will replace is a mark that rots, and nobody has asked to track having read a
commit.

### Resolution

Uncommitted — no commit has been asked for. New: `src/components/commit-history.tsx`,
`src/components/commit-diff.tsx`, `src/routes/repos_.$repo_.commits.tsx` and
`src/routes/repos_.$repo_.commit.$sha.tsx`, with a test file each. Changed:
`src/routes/repos_.$repo.tsx` gained a `commits` link, `src/routeTree.gen.ts` was regenerated, and
`src/lib/local-git-contract.ts` was reopened for one line.

**The renderer was not touched.** `ChangedFileDiff` takes the `DiffSource` that `localDiffSource`
already builds, and the tree is the same `FileTree`. No new `DiffRow` kind, no new `BlobSide` arm,
no second differ. Two props are simply not passed: no `onNewThread`, which takes the compose
buttons off every row, and no `onViewedChange`, which takes the box off the panel rather than
leaving a tick that goes nowhere.

**One contract change, and it is a number.** `COMMIT_PAGE_SIZE` was added, because the paging
control has to step back by a page and the server had the only copy of how big a page is. Nothing
else in `src/lib/local-git-contract.ts` moved.

**Two routes, not one page with a mode.** A history and a commit want different widths — the
commit page widens to 1600px when the layout is split — and different titles, and the history is
still readable while a commit is being read. Both file names carry **two** trailing underscores:
`/repos` and `/repos/$repo` are pages and not layouts, so without them the address would resolve,
the URL would change, and the list would stay on screen. The generated tree was read back to
confirm `getParentRoute: () => rootRouteImport` on both.

**The merge hazard is answered with links and not only with a warning.** A merge is 26.4% of the
sampled history, so the amber line states "A merge of 2 parents. This diff is against parent 1
only — what the other side brought in is not below." and a `Merge parents` nav offers the others.
Parent 1 is spelled as **no** `?parent=`, so the default and the explicit choice are one address.
The links are written with `search={(prev) => …}`, which is what carries `ref` and `skip` across a
parent switch without the component being told what they are.

**`ref` and `skip` are parsed with opposite failure modes, deliberately.** An unreadable `ref` is
dropped, an unreadable `skip` falls back to the top. A bad offset shows the head of the history,
which is where a reader without an offset was going anyway; a bad ref would show the history of
something other than what was asked for. A too-high `parent` is **not** rejected client-side,
because the server answers "This commit has no parent 3 — it has 2." and that sentence on the page
beats a thrown search error, which is an error boundary.

The commit page holds one shared `history` object that both its header link and its error alert
spend, so the two cannot disagree about where "back" is. The `commits` link on the branch diff
passes `?branch=` through as `?ref=`, because the branch is that page's subject rather than an
option on it. Paging is two links and no page numbers — a total is a second walk of the whole
history — and prints a one-based range, `51–100`.

**Two of my own premises were wrong and the tests say so.** `getByText('2')` matched many
elements, because a rendered diff is full of `2`s; the count is asserted as the line `2 files`
instead. And asserting no `Loading…` failed: the branch diff's `Loading…` is a whole-list gate on
local SQLite marks, but each panel *also* says `Loading…` for its own blob bytes, which are mocked
here. Different wait, so the assertion was dropped and the comment names the distinction.

57 new tests across 4 files, **1,306 in the suite over 67 files**, `tsc --noEmit` clean.
`pnpm generate-routes` produced `/repos/$repo/commits` and `/repos/$repo/commit/$sha` at the root.
On a dev server both answer 200 with their own titles — `ado-web commits · ado-web` and `aeedd20 ·
ado-web · ado-web` — which is what proves neither is rendering its parent.

Unproven: nobody has looked at either page, so the visual pass is outstanding. There is **no
keyboard selection** — `j`/`k` down a history is not built and was not asked for. An octopus merge
renders by construction and not by test. The 26.4% is one repository's history. And a commit or ref
rewritten in a terminal between the list and the click is handled by the server's words, which no
test races.
