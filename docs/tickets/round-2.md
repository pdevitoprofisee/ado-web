# Round 2 — the pull request detail shell

Phase 2 of [the route](./round-1.md#the-route): the page you land on when you pick a row
out of the inbox. Header, conflict state, the policy checklist, votes, commits, and the
list of files that changed.

Same conventions as [round 1](./round-1.md): each ticket states **success criteria**, not
steps; facts referenced by number come from [the notes](../map.md#the-notes); every ticket
carries a **Type · Status · Blocked by** line and is claimed before it is worked.

**What this round is not.** No diff — that is phase 3, and the file list here exists partly
to hand it a starting point. No comments, no threads, no activity trail — phase 4. No write
actions: nothing on this page votes, merges, or abandons. It is a reading surface, and
every request it makes is a `GET`.

**Why it is worth building at all**, given that the inbox already links to `dev.azure.com`:
the ADO PR page loads the diff, the overview, the policy widget, and the comment tree
together, and none of it tells you the one thing you opened it for — *what is actually
stopping this from merging*. The measured payloads say that question is answerable in
four calls. The link out stays, demoted to a secondary affordance, because there will
always be something only ADO can do.

(**Four became five**, and six on the first pull request of a session or on a conflicted
one — the working figures are in [T-012](#t-012--pr-detail-server-layer) and
[T-013](#t-013--pr-detail-ui).)

---

## T-011 — PR detail endpoint inventory

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

The map records that no PR-detail endpoint inventory was ever done: *"those belong to the
phases that use them."* This is that phase. Four of the five endpoint families inventoried
so far needed a preview `api-version` that only a real credential reveals — ADO validates
the token **before** the version, so a bad-token test 401s and never reaches the version
check, and a whole green suite can sit on a URL no authenticated request can use.

**Success:** for each endpoint phase 2 needs, the accepted `api-version`, the response
shape, and the `x-ratelimit-cost` are recorded from a live call, with the raw responses
kept. Where a payload is empty on the sampled PR, that is written down as *unverified*
rather than filled in from documentation.

### Resolution

Run read-only against `Profisee`, target !24698 in `Products/utilities` (mine, so nothing
probed is a colleague's PR). 10 calls total.

| Endpoint | api-version | ms | Result |
|---|---|---|---|
| `pullRequests/{id}` | **7.1** | 132 | OK |
| `.../commits` | **7.1** | 127 | 4 commits |
| `.../iterations` | **7.1** | 150 | 2 iterations |
| `.../workitems` | **7.1** | 107 | 0 — **shape unverified** |
| `.../labels` | **7.1** | 114 | 0 — **shape unverified** |
| `policy/evaluations` | **7.1-preview.1** | 395 | 7 evaluations |
| `.../iterations/{n}/changes` | **7.1** | 116 | OK |
| `.../changes?$compareTo=1` | **7.1** | 153 | OK |

**No new api-version traps.** Plain `7.1` everywhere except `policy/evaluations`, which
[T-006](./round-1.md) already knew about. First endpoint family in this project that cost
nothing to version — and still worth the probe, because the only way to learn that was to
ask with a real token.

**The single-PR call earns its place on `description` and nothing else.** Compared key by
key against the list entry the inbox already holds, it adds exactly `_links` and
`artifactId`. But the list truncates `description` at 400 characters and the detail call
returned **1710**. That is the whole justification for the call, and it is enough: a PR
description cut off mid-sentence is the most common reason to go and open ADO anyway.

**Policy evaluations are the payload worth having.** Seven on one PR, each with
`configuration.type.displayName`, `isBlocking`, `isEnabled`, and a `settings` object:

| Status | Policy | Settings that matter |
|---|---|---|
| `approved` | Require a merge strategy | `allowNoFastForward`, `allowSquash` |
| `rejected` | Comment requirements | — |
| `rejected` | Work item linking | — |
| `queued` | Build | `buildDefinitionId: 320`, `displayName: "utilities.logging"` |
| `queued` | Minimum number of reviewers | `minimumApproverCount: 1`, `creatorVoteCounts: true`, `resetOnSourcePush: false` |
| `queued` | Required reviewers | `requiredReviewerIds: [...]` |
| `queued` | Minimum number of reviewers | **a second one — see below** |

Two findings from that table that the checklist has to be built around:

- **`displayName` is not unique.** Two "Minimum number of reviewers" policies on one PR,
  differing only in scope. A checklist with two identical rows and different verdicts is a
  checklist nobody can act on, so rows carry `configuration.id` and are qualified from
  `settings` where there is anything to qualify them with.
- **`queued` on a reviewer policy means "not yet satisfied", not "something is running".**
  This matters beyond this page: `readChecks` in `hydrate.ts` folds `queued` and `running`
  together into `pending`, which is right for a *build* status and misleading for a policy
  evaluation. The inbox badge is unaffected — it reads `statuses`, not evaluations — but
  the distinction is now written down before phase 5 reads the same field.

The build evaluation's `context` carries `buildId`, `buildDefinitionName`,
`buildIsNotCurrent`, and `lastMergeCommitId` / `lastMergeSourceCommitId` /
`lastMergeTargetCommitId`. `buildIsNotCurrent` is what distinguishes "the build passed" from
"a build passed, on an older commit" — phase 5 will want it; this round only needs to not
throw it away.

**Correction to [T-008](./round-1.md#t-008).** T-008's resolution states that
`x-ratelimit-cost` arrives *"on `_apis/connectionData` and on nothing else"*, and its real
TSTU accounting was built on that floor. Measured here, the header arrives on **six of the
eight** endpoints above:

| Endpoint | `x-ratelimit-cost` |
|---|---|
| `pullRequests/{id}` | 0.01325 |
| `.../changes?$compareTo` | 0.00838 |
| `.../iterations/{n}/changes` | 0.00705 |
| `.../commits` | 0.0055 |
| `.../labels` | 0.0031 |
| `.../workitems` | 0.00276 |
| `.../iterations` | *(absent)* |
| `policy/evaluations` | *(absent)* |

So the accounting is not a floor derived from one endpoint — it is a real per-call sum over
most of them, with two known gaps. T-008's conclusion that the header is rare was drawn from
the endpoints the inbox happened to call; it generalised from a sample of one family. The
footer's `≥ N TSTU` phrasing stays correct and now understates by less.

**Other shapes, as measured:**

- `commits`: `commitId, author, committer, comment, commentTruncated, url`. `commentTruncated`
  **is** set on real entries, so the commit list cannot assume `comment` is whole.
- `iterations`: `id, description, author, createdDate, updatedDate, sourceRefCommit,
  targetRefCommit, commonRefCommit, hasMoreCommits, reason`. `description` is the full
  multi-line commit message. `push.pushId` was present on iteration 2 and **absent** on 1.
- `changes`: top-level `nextTop, nextSkip, changeEntries`. Asked for `$top=5` and got back
  `nextTop=1, nextSkip=5` — **`nextTop` is not a page size and should not be treated as
  one.** Entries carry `item.path`, `item.objectId` (blob sha after), `item.originalObjectId`
  (before), `item.isFolder`. `changeType` values seen: `add`, `edit`.
- Detail payload: `mergeStatus=succeeded`, `mergeFailureMessage=null`,
  `completionOptions=null`, `labels=null`, `workItemRefs=null`. Reviewers came back as
  `[Products]\Contributors=0 (team, required)`, plus two people at `0` — confirming
  `isContainer` and `isRequired` on live data.

Everything above came from **one** PR. Every "unverified" in it was then chased down by a
second, wider probe — ~1,300 read-only GETs across the org, recorded in
[`docs/research/pr-detail-inventory.md`](../research/pr-detail-inventory.md). It contradicted
the single-PR reading in three places, which is the argument for having run it.

**`mergeFailureMessage` does not exist.** Not empty, not null — the key is **absent** on
15/15 conflicted active PRs, as are `mergeFailureType` and `lastMergeCommit`. Reading it off
the single clean PR above, where every field was `null`, would have produced a conflict
banner that renders nothing on precisely the PRs it was built for. Conflicts come from
`GET .../pullRequests/{id}/conflicts` on plain `7.1`: `conflictPath` (matches
`changeEntries[].item.path` exactly) and `conflictType` — live values `editEdit` 36,
`deleteEdit` 4, `editDelete` 1 across 41 conflicts. A clean PR answers 200 with `count: 0`,
and conflicts resolved in ADO's UI additionally carry `resolutionStatus` / `resolvedBy` /
`resolvedDate`. This is why `MergeState` carries a conflict list and not a message.

**`votedFor[]` points the opposite way from the intuitive reading, and has a trap inside
it.** It hangs off the **person** — 117 of 197 people, **0 of 160 containers** — and names
the containers whose vote that person's vote counted toward. The trap: **the `vote` nested
inside a `votedFor` entry is always 0**, on all 117 measured. Reading it renders an approved
team as "no vote". A container's real vote is its own top-level `vote`, and it agreed with at
least one member in 86/86 containers, including 31 with multiple voters — zero disagreements.
Hence `Person` in the contract has no `vote` field: the safest way to not read a field that
lies is for it not to exist.

**Containers are not an edge case.** 45 % of all reviewer rows are containers, and
`isRequired` sits on **127 containers against 23 people**. A reviewer section that treats
teams as a footnote, or a "required reviewers" line filtered to people, shows almost nothing
on real data.

**The `changes` paging rules, settled.** The round-1 *short-page-is-not-the-last-page* trap
**does not apply here** — three independent enumerations of the 1,096-file !23194 (a single
`$top=2000`, a blind `$skip`-25 walk over 45 pages, and a service-directed walk) produced an
identical path set. `$top` does not clamp: 100000 works, and that whole PR is one 288 KB /
230 ms call. But **`nextTop = min($top, remaining)`** — feeding it back as the next page size
makes you crawl the tail one file at a time — and **omitting `$top` silently truncates to
100**. Two different ways to quietly return a wrong file list, which is why T-012 requires an
explicit `$top` and forbids trusting `nextTop`.

**`changeType` live:** `edit` 2578 · `add` 588 · `delete` 77 · `edit, rename` 40 · `rename` 5.
The comma form confirms flag-set parsing. `sourceRename` and friends could not be measured.
**Zero `isFolder` entries in 3,288.** Two placement traps: `originalPath` sits at the *entry*
level while `originalObjectId` sits at the *item* level, and a pure rename has
`objectId === originalObjectId` — no diff needed, which phase 3 will care about. `changeId`
is not returned sorted.

**`labels` is a wasted call; `workitems` is not.** The labels endpoint is byte-identical to
what the inbox list already carries, verified across all 164 PRs — it adds only a `url`.
`workItemRefs`, by contrast, is never on the list, and the refs are `{id, url}` with no title,
so rendering them needs a separate `_apis/wit/workitems` batch: plain `7.1`, **max 200 ids**
(210 returns HTTP 500 `VS403474`), **`errorPolicy=omit` mandatory** because one unreadable id
404s the entire batch, and `fields=` cuts the response from 283,839 to 14,253 bytes. Neither
is built this round — recorded so the phase that wants them does not re-derive it.

**Refining the T-008 correction above.** `x-ratelimit-cost` is not merely present on more
endpoints; it is **deterministic per endpoint**: 329/329 responses on `labels`, 275/275 on
`changes`, 30/30 on detail, 16/16 on `conflicts` — and 0/178 on `iterations`, 0/33 on the PR
list, 0/12 on `policy/evaluations`, 0/11 on `threads` and `statuses`. One detail-page open
bills **≈ 0.06 TSTU** against a 200-TSTU five-minute window. Cost is not the constraint, and
was never going to be; latency remains the only throttle signal we get (note 2). One gap
worth flagging for phase 3: the blob route bills on `$format=json` but **not** on
`$format=text`, and `$format=text` is the diff pipeline's real read path — so the read that
matters most is the one we cannot price.

**Also confirmed:** `mergeStatus` is `string | undefined`, absent on all 1,480 abandoned PRs,
and `queued` / `rejectedByPolicy` / `failure` / `notSet` never occurred in 21,133 PRs — treat
an unknown value as neutral, never as a conflict. And the description finding hardens: 59 of
165 list values sit at exactly 400 characters, detail values ran 436–3,024, and the list
value was a byte-exact prefix every time.

**Still not verified:** `isFlagged` (never true in the sample); `changeType` values beyond
the five seen; the cost of the diff pipeline's actual blob read.

**Surfaced for T-012:** four calls cover this page — detail, evaluations, commits, changes —
with `iterations` a fifth only because `changes` needs an iteration id, and `conflicts` a
sixth **only when `mergeStatus` is `conflicts`**.

---

## T-012 — PR detail server layer

**Type:** feature · **Status:** resolved · **Blocked by:** T-011 (resolved)

Assemble one pull request into [`PullRequestDetail`](../../src/server/pull-request.ts). The
type contract is already committed; this ticket fills in the function behind it and the
server function that exposes it.

**Success:**

- `loadPullRequest(client, ref)` returns a fully populated `PullRequestDetail` against the
  live org, and the page's whole data need is met in **five ADO calls or fewer** — six on a
  conflicted PR, which is the only case that fetches `conflicts`.
- The calls that do not depend on each other are issued through `client.fanOut`, not
  awaited in sequence.
- Conflicts are read from the `conflicts` endpoint, because `mergeFailureMessage` is not a
  field that exists. `MergeState` carries the conflicting paths and their types — the paths
  are what tell a reviewer whether this is a rebase or an afternoon.
- The file list passes an **explicit** `$top` (omitting it silently truncates to 100) and
  never feeds `nextTop` back as a page size (it is `min($top, remaining)`).
- A failure in any *one* of commits, evaluations, or changes degrades that section rather
  than emptying the page. The header and conflict state come from the detail call and are
  the only hard dependency.
- `changeType` is parsed as the comma-separated `[Flags]` set it is, never string-compared.
- The file list either is complete or reports itself `truncated`. It does not silently stop
  at one page.
- Policy rows are stable under two policies sharing a `displayName`, and `blocking` means
  *blocking and not yet satisfied* — a passing required policy is required, not blocking.
- `pull-request-fn.ts` validates `projectId` and `repositoryId` as GUIDs and `id` as a
  positive integer **by shape**, for the same reason [`hydrate-fn.ts`](../../src/server/hydrate-fn.ts)
  does: three of them are interpolated into an ADO path, and a GUID cannot contain a
  traversal sequence while an encoded one still can.
- Errors are returned, not thrown, in the shape the inbox already uses: not-connected, ADO
  said no, and the PR does not exist are three different things to a person.
- Unit tests cover the derivations against fixtures taken from the T-011 raw responses —
  the vote vocabulary, the flags parsing, the two-policies-one-name case, `commentTruncated`,
  and the degrade-one-section path.

**Deliberately not in scope:** caching to SQLite. The inbox caches because it hydrates 160
rows on a poll; this page is one PR, opened deliberately, and the correct answer to "is it
stale" on a page someone is actively reading is to have asked just now.

### Resolution

[`pull-request.ts`](../../src/server/pull-request.ts) fills in the contract;
[`pull-request-fn.ts`](../../src/server/pull-request-fn.ts) exposes it. Verified live
against `Profisee`, read-only, and by 29 fixture tests in
[`pull-request.test.ts`](../../src/server/pull-request.test.ts).

| Success criterion | Evidence |
|---|---|
| Five calls, six when conflicted | detail · evaluations · commits · iterations · changes, then `conflicts` only under `mergeStatus === 'conflicts'` |
| Independent calls fan out | four thunks through `client.fanOut`; only `changes` awaits, because it needs an iteration id |
| Conflicts from the `conflicts` endpoint | `MergeState.conflicts` carries path + type + resolved; live types `editEdit` (36), `deleteEdit` (4), `editDelete` (1) |
| Explicit `$top`, no `nextTop` feedback | `FILE_LIMIT = 5000`; `nextTop` and `nextSkip` ignored |
| One section fails, the page does not | `section()` returns `{data, error}`; only the detail call throws |
| `changeType` parsed as flags | `changeFlags` splits; live `edit` 2578, `add` 588, `delete` 77, `edit, rename` 40, `rename` 5 |
| Complete or `truncated` | `entries.length >= FILE_LIMIT` |
| Policies stable under a duplicate name | `id` from `configuration.id`; `policyName` qualifies with a build's `displayName` or the scoped branch |
| `blocking` means blocking *now* | `isBlocking && isEnabled !== false && !SATISFIED.has(status)` |
| Shape validation | `GUID` regex on both ids, `Number.isSafeInteger(id) && id > 0` |
| Three failures, three answers | `PullRequestDetailResult` carries `connected`, `notFound`, `error` separately |

**The file list is not paged, and that is a measurement rather than an omission.** Three
independent enumerations of the same 1096-file PR — one `$top=2000` call, a blind `$skip`
walk in pages of 25, and a service-directed walk — returned identical path sets. So note 6's
*a short page is not the last page* trap, which is real on `_apis/git/pullrequests`, does
**not** reach `changes`: nothing filters entries inside a PR you can already read. The
endpoint does not clamp either — `$top=100000` was accepted, and the 1096-file PR came back
whole in one 288 KB response. What does bite is `nextTop`, which is `min($top, remaining)`
and looks exactly like a page size; feeding it back walks the tail one file at a time.

**`resolveViewer` is memoised on the client, without a TTL, on purpose.** Marking "that's
you" in the reviewer list needs an identity, and that would have been a sixth call on every
page. The inbox memoises the same answer behind a TTL because *team membership* can change
under it; an account's own id cannot, so there is nothing here for a TTL to protect and the
second PR you open still costs five. A rejection is evicted rather than cached, because this
fails on a network blip far more often than on a bad token, and a cached rejection would be
permanent. Keyed by `WeakMap` on the client, so a re-entered PAT or a switched org gets a
fresh answer.

**Two of the derivations exist because the intuitive version is wrong**, both recorded in
T-011 and both now structural rather than commented: `Person` has no `vote` field, so the
always-zero vote nested inside `votedFor` cannot be read by accident; and `mergeStatus`
missing entirely yields `status: ''`, which is neutral — inventing the documented-but-never-
observed `notSet` would be reporting an answer ADO did not give.

**Deliberately not done:** SQLite caching, as scoped. Also no retry on a failed section — a
section that failed says so and the page renders; the poll is the retry.

**Watch:** `FILE_LIMIT` at 5000 against a measured maximum of 1096. If a PR ever trips
`truncated`, the fix is paging on `$skip` with a fixed `$top`, not a bigger number.

**Not verified:** `isFlagged` on a reviewer (never true live); `changeType` values beyond the
five seen; whether `conflicts` pages at all — the largest live conflict list was 36 entries.

**Surfaced for T-013:** `errors.conflicts` fails independently of `merge.conflicted`. The
banner must still say *conflicted* when the path list could not be fetched.

**Corrected during T-013, in this file.** Two of the derivations above were wrong against
live data and are now fixed: `commentTruncated` is surfaced as `Commit.bodyOmitted` because
it marks a dropped message *body*, not a clipped subject, and `policyDetail` reads
`requiredReviewerIds` before `minimumApproverCount` because a real policy carries both. The
criteria above still say `commentTruncated` — that was the name at the time, and the
measurements that changed it are in [T-013](#t-013--pr-detail-ui).

---

## T-013 — PR detail UI

**Type:** feature · **Status:** resolved · **Blocked by:** T-012 (resolved)

The reading surface. Presentational only — it takes a `PullRequestDetail` and renders it.

**Success:**

- Header: title, `!id`, author, age, draft state, and `source → target` branches.
- The description renders in full, and is visibly the full text rather than the inbox's
  400-character truncation.
- **Conflict state is stated loudly** when it exists — the map's word. A conflicted PR
  should be unmissable above the fold, and a PR that merely has not been merge-tested yet
  must not be dressed up as one. Loudly means the **paths**, not the word: T-011 measured
  that ADO sends no failure message, and a banner that says "conflicts" and stops is the
  thing you would go back to ADO to resolve.
- Reviewers are weighted for real data, where **45 % of rows are containers** and
  `isRequired` sits on 127 containers against 23 people. A person's `votedFor` reads as "on
  behalf of …", and the vote nested inside it is never read — it is always 0.
- The policy checklist is the primary content of the page: what is blocking, what passed,
  what is not applicable, each row naming the specific thing (a build, an approval count, a
  named required reviewer) rather than a policy type.
- Reviewer votes render with the vote vocabulary spelled out, teams distinguished from
  people, required distinguished from optional, and the viewer's own row marked.
- The commit list shows subject, short sha, author, and date; a truncated commit message is
  marked as truncated rather than presented as whole.
- The file list groups by change type and shows the path in a form that survives a 90-column
  monorepo path.
- Every section renders sensibly when its data is empty *and* when its fetch failed — those
  are different states and they read differently.
- Tests cover the vote vocabulary, the conflict banner appearing only on a real conflict,
  the blocking/passing split, and the failed-section state.

**Deliberately not in scope:** labels, work items, and the activity trail. The map lists the
first two alongside the diff, and T-011 now knows both shapes — which is exactly why they are
out. Labels are already on the inbox row, byte for byte, so a page that wants them does not
need a call; work items need a second `_apis/wit/workitems` batch with its own 200-id cap and
`errorPolicy` trap to turn refs into anything a person can read. Neither is worth widening
this round for, and neither has to be re-derived when its round comes.

### Resolution

[`pr-detail.tsx`](../../src/components/pr-detail.tsx) is the reading surface;
[`pr.$projectId.$repositoryId.$prId.tsx`](../../src/routes/pr.$projectId.$repositoryId.$prId.tsx)
is the route that fetches and hands it a `PullRequestDetail`. 27 tests in
[`pr-detail.test.tsx`](../../src/components/pr-detail.test.tsx), plus a live render check
described below.

| Success criterion | Evidence |
|---|---|
| Header | title, `!id`, `project/repository`, author, `age()` reused from the inbox, `source → target` with `refs/heads/` stripped, `draft` chip |
| Description in full | `whitespace-pre-wrap`, unparsed and untruncated; the live !24795 description rendered 583 characters against the inbox row's 400 |
| Conflict stated loudly, as paths | `MergeBanner` keys on `merge.conflicted`, never on the status, and lists path + ADO's own conflict type; conflicted paths are also marked in the file list, matched on `item.path` |
| …and three states, not two | T-012 surfaced that `errors.conflicts` fails independently: the banner still says *conflicted* and says the paths could not be read |
| Untested merge not dressed up as a conflict | `UNTESTED = {queued, notSet}` gets one quiet sentence; an empty `status` gets nothing, because not saying is not the same as saying "not tested" |
| Reviewers weighted for real data | `team` chip, `you` chip against `viewerId`, "on behalf of …" from `votedFor`, and `required` in full weight against a recessive `optional` — `isRequired` sits on 127 containers to 23 people live |
| Checklist is the primary content | rendered above the description, grouped `Blocking · Passed · Not applicable · Optional`, first group to claim a policy wins |
| Each row names the specific thing | `name — detail`; a row that still collides after its detail carries `#id`, because the probe found two "Minimum number of reviewers" on one PR |
| Vote vocabulary spelled out | `voteWord` maps the five integers and falls through to `vote N` rather than inventing a word |
| Commits | short sha linking out, subject, author, `age()` |
| Files survive a long path | the directory truncates and the filename never does |
| Empty ≠ failed | `Empty` and `Failed` are different components with different words, and a failed section drops its count rather than rendering `0` |

**Two things the component said were corrected by live data, not by review.** Both had
green tests over them, and both are worth writing down because the cause was the same in
each case: a fixture narrower than what the service sends.

- The commit chip said **truncated**. ADO's `commentTruncated` was true on 9 of 21 live
  commits, at message lengths of 33–86 characters, so it is not a length limit. Compared
  against the standalone commit resource, which returns the whole message: on 4 of 4 the
  `comment` we were handed was **exactly the complete first line** and what had been dropped
  was the body under the blank line. The subject is whole. The field is now
  `Commit.bodyOmitted` and the chip reads **+ body** — the previous wording told the reader
  that nearly half the subjects on this org were cut off, and none were.
- Every required-reviewer row read **"1 approval, author counts"**. A live "Required
  reviewers" policy carries both `requiredReviewerIds` *and* `minimumApproverCount` — 10 of
  10 across 12 PRs — and `policyDetail` checked the count first, which is the less specific
  of the two. Reordered; the same row now reads "1 required reviewer". The unit fixture had
  carried only one of the two keys, which is exactly how a green suite sat on a visibly
  wrong page.

**The route fetches in a `useQuery`, deliberately not in a loader.**
[`router.tsx`](../../src/router.tsx) sets `defaultPreload: 'intent'`, so a route loader would
fire this page's five ADO calls on **hover** — running the cursor down the inbox would spend
hundreds of calls on pull requests nobody opened. Fetching in the component sidesteps that by
construction, and `router.tsx` was left untouched rather than made to special-case one route.

**The URL is validated before it is spent.** `prId` can be typed, pasted, or stale, so the
route checks `Number.isSafeInteger(id) && id > 0` itself and answers a bad one with a
sentence. `enabled` on the query keeps a malformed URL from costing a round trip. The four
outcomes the server function distinguishes — not connected, 404, ADO refused, the function
itself threw — each get their own message, because "nothing here" and "your token cannot see
this" send a person to different places.

**Polling is worth more here than on the inbox**, because this is the page you leave open
while a build finishes: `CADENCE.pullRequest` through `useCadence`, so a page left open
overnight stops rather than asking until morning. `Esc` is bound to `nav.back` and means
"return to the inbox" here, against "clear the selection" on the inbox — see T-014's note on
the last-binding-wins stack.

**Live verification.** The real `PullRequestDetailView` was rendered in jsdom against
payloads fetched live from `Profisee` — !24790 (conflicted, 1 conflict path, 5 reviewers, 9
files), !24795 (8 policies, 3 reviewers of which 2 are containers, 6 files), !24797 (9
policies, 1 file). No throw on any of them, and both defects above were found this way. The
route itself was checked only as far as the dev server answering **200** for
`/pr/<guid>/<guid>/24795`; SSR is off for app routes, so that proves the router resolved the
path, not that the page painted.

**Call accounting, precisely.** T-012 says five calls, six when conflicted. Measured, the
*first* PR of a session costs **six** either way: `resolveViewer` spends one identity call to
find out whose row gets the `you` chip. It is memoised on a `WeakMap` keyed by client, so
every PR after the first is back to five.

**Deliberately not done:** a markdown renderer for the description. It is often markdown-ish,
and a dependency this round did not agree to. No comment count, no labels, no work items — as
scoped.

**Not verified:** the file list's `truncated` line (no live PR came near `FILE_LIMIT`), the
`resolved` chip on a conflict (never true live), and `broken` / `unknown` policy statuses,
which have icons and words but no live sighting.

---

## T-014 — Open the detail page from the inbox

**Type:** feature · **Status:** resolved · **Blocked by:** T-013 (resolved)

Today an inbox row is an `<a href={row.url} target="_blank">` — clicking a pull request
leaves the app. That was right when there was nowhere to go; it is not right now.

**Success:**

- A row navigates internally to the detail route. The route addresses a PR by
  `projectId / repositoryId / id`, GUIDs and all, because those are what the server function
  validates and what the inbox row already carries.
- Opening ADO is still one gesture away, as an explicit secondary affordance rather than the
  primary click.
- `j` / `k` / `Enter` / `Esc` are bound through the [T-009](./round-1.md#t-009) command
  registry, so the three entries currently rendered dimmed in the `?` sheet go solid because
  they do something — not because the sheet was edited.
- Back from the detail page returns to the inbox with its scroll position and hydration
  intact; it does not refetch 160 rows because someone looked at one PR.
- The detail route handles being loaded cold — pasted URL, hard refresh — not only navigated
  into.
- Tests cover the row rendering as an internal link, the secondary ADO affordance still being
  present, and the keyboard bindings resolving through the registry.

### Resolution

[`pr-list.tsx`](../../src/components/pr-list.tsx) and [`index.tsx`](../../src/routes/index.tsx).
21 tests in [`pr-list.test.tsx`](../../src/components/pr-list.test.tsx).

| Success criterion | Evidence |
|---|---|
| Row navigates internally | `<Link to="/pr/$projectId/$repositoryId/$prId">` wraps the row body |
| ADO still one gesture away | a second `<a target="_blank">` with an `ExternalLink` icon and an `sr-only` name |
| `j` `k` `Enter` `Esc` through the registry | `useInboxSelection` binds `nav.next`/`nav.previous`/`nav.open`/`nav.back` via `useCommand` — **no edit to [`registry.ts`](../../src/commands/registry.ts)**, the four commands were already declared in T-009 and were dimmed only because nothing handled them |
| Cold load | the route reads its three params and fetches in the component; nothing depends on having come from the inbox |

**The selection is a pull request id, not an index.** The inbox polls every two minutes and
the poll can reorder rows or drop them. An index survives that and quietly points at a
different pull request; an id either still exists or the selection is gone. `move()` clamps
at both ends rather than wrapping, `j` from nothing selects the first row and `k` the last.

**Both sections are one list for the keyboard**, because `j` off the end of "Assigned to me"
lands on the top of "Mine" — which neither section can know on its own. `index.tsx` already
built that concatenation for hydration ("visible first" is a property of the page, not of a
list); it is now a named `rows` that both consumers share.

**Selection moves focus rather than painting a highlight.** That is what puts the row in
front of a screen reader, and it scrolls the row into view for free. `scrollIntoView` is
optional-chained because jsdom does not implement it and the selection is still correct
without it.

**A row without GUIDs keeps its old behaviour.** `addressable()` is a type guard: when ADO
answers without `projectId`/`repositoryId` the row's own click opens ADO, because a route
that cannot be built is worse than the tab that used to open.

**On back-navigation, honestly.** The 160-row inbox query is *not* refetched:
`staleTime: CADENCE.inbox` covers it and both `refetchOnMount` and `refetchOnWindowFocus`
respect it, and `scrollRestoration: true` was already set in
[`router.tsx`](../../src/router.tsx). But `useHydration` holds its results in component
`useState`, so hydration does **not** survive the unmount — rows repaint plain and re-issue
`hydrateQuery`. That costs **zero ADO calls**, because `hydrate()` reads `pr_cache` keyed by
`id@commitId` whenever `fresh` is false: it is a repopulate, not a reload. The criterion said
"intact", and this is a flicker, not intact. Fixing it properly means lifting that state out
of the hook, which is a refactor this ticket was not scoped to do.

**Deliberately not done:** prefetch on hover. `router.tsx` sets `defaultPreload: 'intent'`,
which is why the detail route fetches in a `useQuery` inside its component and not in a
loader — see T-013.

**Watch:** the sheet dims a row when nothing has bound the command, so all four `nav` rows
go solid on the inbox by being handled rather than by being edited. `nav.back` is now bound
in two places that mean different things by it — clear the selection on the inbox, go back
to the inbox on the detail page. The provider's last-binding-wins stack is what keeps that
honest, and it is the first command that has needed it.

---
