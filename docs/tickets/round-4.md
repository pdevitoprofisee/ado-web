# Round 4 — the conversation

Phase 4 of [the route](./round-1.md#the-route). [Round 3](./round-3.md) put the code on the
page. This round puts the review on it: what people said about the code, and what Sonar said
about it.

Same conventions: each ticket states **success criteria**, not steps; facts referenced by
number come from [the notes](../map.md#the-notes); every ticket carries a
**Type · Status · Blocked by** line.

**The fact that shapes this round: most of what `threads` returns is not a conversation.**
Of 56 threads measured across four real pull requests, **32 were `commentType: 'system'`** —
ADO narrating its own votes, pushes and policy evaluations — and **44 had no
`threadContext` at all**, so they hang on the pull request rather than on a line. The
endpoint is an activity log with a conversation mixed into it. Separating those is not
polish; it is the feature. A comments panel that renders what the endpoint returns renders
mostly noise.

**The second fact: this round writes.** Every call the app has made so far has been a `GET`.
Replying, resolving, editing and deleting are not, and they all have to go through the one
`AdoClient` chokepoint that implements the throttle gate (note 2) and `redirect: 'manual'`
(note 4) — because a write that bypasses it is a write that retries into a duplicate comment,
or posts into a sign-in page and reports success. **Likes stay read-only**: `usersLiked` was
present on 59 of 59 sampled comments and non-empty on none of them, and a `POST` to the likes
route has never been authorised against a real person's comment.

**What this round is not.** No checks, no builds, no logs, no test results, no merge. No
notifications. Voting is not here either — it is a write against someone else's pull request
with a different failure mode, and it belongs with the other actions in phase 5.

---

## T-022 — Comment, thread and Sonar endpoint inventory

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

Round 3 opened with an inventory because guessing at the diff endpoints would have cost a
rewrite. The same applies here twice over: threads have a documented shape that live data
contradicts in four places, and the Sonar half of the round rests on notes that turned out to
be partly wrong.

**Success:** for the threads endpoints, a field census over real pull requests — which fields
are actually present, on how many threads, and what the parameter surface does. For Sonar, the
same for issues, the quality gate and rule descriptions, plus the answer to how a pull request
finds its Sonar project without configuration. Every claim a number, every absence counted.
Read-only throughout: **no `POST`, `PUT`, `PATCH` or `DELETE` against a colleague's pull
request.**

### Resolution

Four probe passes — `scripts/comments-sonar-inventory.mjs` and `-2`, `-3`, `-4` — writing
`docs/research/comments-sonar-inventory.md`. **43 ADO calls and 58 SonarCloud calls**, all
GETs. The two contracts frozen out of it are `src/lib/comment-contract.ts` and
`src/lib/sonar-contract.ts`; every comment in those files that cites a number cites one of
these.

| what | measured |
|---|---|
| threads sampled | 56 across 4 pull requests · 59 comments |
| `commentType` | `system`×32 · `text`×27 |
| `threadContext === null` | **44/56** |
| anchored threads | 12/56, **right side only**, 5 of them spanning multiple lines |
| `status` absent | **32/56** — every one a system thread |
| `status` values seen | `closed`×10 · `active`×8 · `fixed`×6 |
| threads with >1 comment | **3/56** |
| soft-deleted | 5/56 threads · 7/59 comments |
| `usersLiked` non-empty | **0/59** |
| `properties` non-empty | 56/56, every value a `$type`/`$value` wrapper |
| thread parameter surface | `$top`, `$skip`, `$expand`, `iteration`+`baseIteration`, three api-versions — **all returned the same 9 threads** |
| ADO rate-limit headers | none, on any of 14 `threads` calls · 71–262 ms |
| SonarCloud rate-limit headers | **none, of 19 response headers** |

**The parameter surface is inert, and that is a saving rather than a limitation.** Note 174
in the map already said `threads` ignores `$top`. It also ignores `$skip`, `$expand=none`, and
`iteration`/`baseIteration` — nine threads came back every time, including with the
api-version omitted altogether. There is no paging loop to write and no way to ask for less.
One call gets everything for a pull request, and the filtering is ours.

**More than half of a pull request's threads are ADO talking to itself.** 32 of 56 were
`system`, and they are exactly the 32 with no `status` — which is coherent: a "Paul voted
Approved" entry is neither open nor done. The activity trail is genuinely useful later (it is
where votes and pushes are recorded) but it is not conversation, and `ThreadKind` in the
contract classifies it once, on the server, so no component has to ask.

**A deleted comment has no `content` key.** Not an empty string — the field is absent, on all
7 of them. `Comment.content` is therefore `string | null`, and a deleted comment renders as a
tombstone rather than vanishing, because 3 of the 56 threads have replies and dropping a
deleted parent orphans them.

**Anchors are right-side only in this sample, and the left fields are typed anyway.** All 12
anchored threads used `rightFileStart`/`rightFileEnd`; `leftFileStart` never appeared. A
comment on a deleted line is a thing ADO supports, so `ThreadContext` carries both sides and
`FileThreads.unanchored` catches what no visible line can hold. `offset` is **not always 1** —
threads can start mid-line — and `filePath` always arrived leading-slash, matching the change
list, so the two compare with plain equality.

**Sonar's project key needs no configuration, but a repository can have several.** The ADO
status's `targetUrl` is `https://sonarcloud.io/dashboard?id=<projectKey>&pullRequest=<prId>`
and the `pullRequest` value is the ADO id verbatim, confirming the map's note. What the note
missed: `context.name` is **either** `quality gate` **or** `quality_gate_<projectKey>`, and the
multi-project repositories post one status per Sonar project. `SonarReport.projects` is a list
for that reason.

**The Sonar identity is not a Sonar identity.** Every sampled Sonar status was created by the
same GUID — a general-purpose "QA Automation" account, not a service principal named for
Sonar. Matching `comments[0].author.id` against it is still the only available way to spot a
bot thread (the bot's threads carry no marker property, only
`Microsoft.TeamFoundation.Discussion.UniqueID`), but if that account ever comments as itself
its comment is misfiled. Recorded on `SonarAuthorship` where the code that relies on it will
read it.

**`issues/search` returns resolved issues by default, and this cost a whole probe pass.**
Pass 1 read `total: 0` on its sample pull request as "clean" and froze nothing, because there
was no shape to freeze. Pass 3 measured what the default means: one pull request answering
`total: 3` had three issues, **all `FIXED`**, and asking for
`issueStatuses=OPEN,CONFIRMED,ACCEPTED` returned zero. Any list that means "open" has to say
so.

**`line` is a duplicate that sometimes is not there.** On 4 open issues, `line` was present
and equal to `textRange.startLine` on all 4. On 3 fixed issues, `line` was absent on all 3
while `textRange` was present. The field a naive anchor reads is the field the API drops.
Anchor on `textRange.startLine`.

**The `rules` endpoints answered 400 for an entire pass, and the cause was one missing
parameter.** `api/rules/show` and `api/rules/search` both return
`The 'organization' parameter is missing` on SonarCloud. With `organization=<org>` both answer
200, which vindicates the map's two `[LIVE]` rule notes — they were right, and the call
reproducing them was wrong. Two further traps fell out: `f=` must **not** contain `type` (the
field is gone, and its presence 400s the whole request rather than being ignored), and
`rule_key=` singular still silently answers `total: 0` exactly as the map warns.

**One call describes every rule in a pull request.** `rule_keys=` plural with a legal `f=`
returned 3 rules with full descriptions in **28.0 KB / 392 ms**, and `rules/show` returned no
description field the batched form lacked. But `external_roslyn:CA1861` was requested and
**not returned at all** — externally-imported analyser rules are not in Sonar's rule
repository, and unknown keys are skipped rather than erroring, so an undescribable rule and a
typo are indistinguishable. `RuleGroup.name` is nullable for that reason.

**`descriptionSections` come back in an unstable order.** The same rule, `javascript:S4036`,
twice in one run: `root_cause, how_to_fix, resources, introduction` and then
`resources, introduction, root_cause, how_to_fix`. Whatever renders a rule must impose
`SECTION_ORDER`. The content is **HTML**, and `mdDesc` was byte-identical to `htmlDesc` on all
three rules that had descriptions — there is no markdown path to prefer.

**The deprecated quality-gate endpoint is the one that works.** `qualitygates/project_status`
was deprecated 2025-09-16 and still answers **200** with `metricKey`, `comparator`,
`errorThreshold` and `actualValue` per condition. The map's advice to prefer
`measures/component` came with metric names that **404** on Cloud ("The following metric keys
are not found"), and with a valid key set it answers 200 but hides `new_*` values under
`periods[0].value` and ships `quality_gate_details` as a JSON **string**. The deprecated
endpoint hands over the display shape directly. It stays until it stops answering.

**Not measured: anything written.** Every probe was a GET by construction, because the only
pull requests available are colleagues'. So the reply, status, edit and delete paths in T-024
are proven against fixtures and **unproven against ADO**, including the shapes of their
responses. The first live write is a smoke test on a pull request the user owns, and it is the
one thing in this round that cannot be finished without them.

**Not measured: `ps` paging on issues.** The ceiling is confirmed (`ps=501` → 400 `'ps' value
(501) must be less than 500`) but never approached — the largest sample had 4 findings. The PR
this project exists for reportedly has 300 Sonar comments, which fits in one page; a project
that does not is unhandled.

**Deliberately not probed:** `POST graph/subjectquery` for @mention autocomplete. It is a
write verb by HTTP method only, but it is also a whole identity-search surface, and the
composer in T-026 ships without mentions rather than guessing at it.

---

## T-023 — Threads, read

**Type:** feature · **Status:** resolved · **Blocked by:** T-022

The read half of the conversation: one call per pull request, classified and grouped so that
nothing downstream has to know what a `CodeReviewThreadType` property is.

**Success:**

- One `GET .../pullRequests/{id}/threads` per pull request through `AdoClient`, with no
  paging loop and no parameters beyond `api-version` — T-022 measured that every other
  parameter changes nothing.
- Every thread classified `human` / `bot` / `system` (`ThreadKind`) on the server. `bot`
  requires the Sonar identity, which comes from the PR's `statuses`; when no Sonar status
  exists there are no bot threads, and that path must not fail.
- Every thread carries a `resolution` of `open` or `done`, derived once: `active` and
  `pending` are open, the other five states and **a missing status** are done.
- `ThreadList` counts what it excluded. A pull request whose 32 system threads silently
  vanish should still be able to say "32 system".
- Anchored threads grouped into `FileThreads` per path, keyed by right-side line. A thread
  that cannot be placed on a line lands in `unanchored` rather than being dropped.
- A failing threads call costs the conversation and nothing else — the diff still reviews.
  Same `FailedSections` treatment the policies and files sections already get.
- Fixtures in the tests come from the real census in
  `docs/research/comments-sonar-inventory.md`: a system thread with no `status`, a deleted
  comment with no `content`, a multi-line right-side anchor with `offset` ≠ 1, and a thread
  with a reply.

### Resolution

`src/server/threads.ts` (711 lines) reads and classifies; `src/lib/comment-contract.ts` (330)
is the frozen shape both halves were written against; `src/lib/conversation.ts` (174) is the
client seam. **36 tests** in `threads.test.ts`.

| what | measured |
|---|---|
| ADO calls per read | **2** — `threads`, plus `statuses` to name the bot |
| parameters sent to `threads` | none but `api-version`, per T-022 |
| classification | `ThreadKind` on the server · `resolutionOf` maps 7 statuses **and a missing one** |
| counts carried | `openCount` · `doneCount` · `systemCount` · `botCount` |
| grouping | `fileThreads()` → `byRightLine` + `unanchored`, **run in the browser** |
| poll | the page's own cadence, `CADENCE.pullRequest` — the only thing on the page that changes while you read it |

**The read is two calls and the ticket asked for one.** The second is `statuses`, and it exists
only because the same ticket asks for a `bot` classification: the Sonar identity is not in a
thread, it is in the pull request's statuses (T-022 — and it is a general-purpose automation
account, not a service principal). It is wrapped in `.catch(() => NO_BOTS)`, so losing it costs
the robot's badge and nothing else — 6 of the 14 pull requests T-022 sampled had no Sonar status
at all, which makes "absent" a normal answer rather than an error.

**`FileThreads` cannot cross a server-function boundary, and that is why the grouping is
client-side.** It holds a `ReadonlyMap`, which serialises as `{}`. So `threadsQuery` returns the
plain `ThreadList` and `useConversation` calls `fileThreads()` on the browser side — which is
only possible because **every import in `threads.ts` is `import type`**. A value import of
`./ado-client` there would drag `@napi-rs/keyring` into the client bundle. That constraint is
load-bearing and invisible; it is written at the top of both files.

**Grouped once per answer, not once per panel.** A 294-file pull request would otherwise walk
the thread list 294 times. The memo is keyed on the array TanStack Query hands back, and that
array's *identity* is what makes the poll free: structural sharing returns the same object when
nothing changed, so the memo skips, `setThreads` identity-returns, and no file rebuilds its
rows. **Watch:** `structuralSharing: false` on that query would rebuild every row model in the
pull request every 30 seconds. `conversation.ts` says so where someone would type it.

**A failing threads read costs the conversation and nothing else**, and there is a test that
holds the line: with `threadsQuery` rejecting, the file list still renders and still says
`0 of 1 read`, the details tab shows a `Failed`, and the changes tab shows one quiet sentence
("Comments could not be read, so none are shown on these files") rather than a second alarm
about the same fact.

**44 of 56 sampled threads had no `threadContext`, so `Conversation.onPullRequest` exists.**
`fileThreads` drops a context-less thread — it has no path to key on — so the hook separates
them out before grouping. Without that, the majority of a real pull request's conversation would
have been silently discarded by the piece whose job is grouping.

**Not measured: a pull request with more than one page of threads.** There is no paging loop
because T-022 proved there is nothing to page with — `$top` and `$skip` are inert — so the
assumption is that one call is the whole conversation. If ADO ever caps that response, this read
truncates silently and nothing here would notice.

**Watch:** nothing asserts that `byRightLine` and `unanchored` stay disjoint. They are built
from one branch each so they are, today; a third caller of `fileThreads` is where that stops
being obvious.

---

## T-024 — The first write

**Type:** feature · **Status:** resolved · **Blocked by:** T-023

`AdoClient` has `get`, `getBytes` and `fanOut`. It has no write verb, and this is where that
changes — once, in the one place that knows about throttling and sign-in redirects.

**Success:**

- One new method on `AdoClient`, used by every write in the app. It shares `buildUrl`,
  `absorb` and the throttle gate with `get`, and it keeps `redirect: 'manual'` — a `POST`
  that follows a 302 to a sign-in page and reads the HTML as success is note 4 with a body.
- **It does not retry.** `get` retries 429 and 503; a write must not, because ADO's throttle
  arrives as a slow 200 (note 2) and a retried `POST` is a duplicate comment. A failed write
  is reported, not repeated.
- Reply to a thread, set a thread's status, edit a comment, delete a comment. Four
  operations, four server functions, each taking the contract's input type.
- **Replying and resolving are separate calls that the UI cannot accidentally combine.** The
  map is explicit: replying to a done thread must not silently reactivate it. Reopening is
  allowed and deliberate.
- Only `fixed`, `wontFix`, `pending` and `active` are settable. The other three states are
  readable and not writable.
- Edit and delete are refused for a comment whose author is not `pr.viewerId` — on the
  server, not only in the component that hides the button.
- The optimistic path matches `useViewedFiles`: the cache is written on the click and the
  call goes after it. Unlike a viewed tick, **a failed write here must say so** — a reply
  that silently disappears is worse than an error.
- Tests cover the refusals and the no-retry rule against a stub transport. **The live write
  is a smoke test for the user**, and the ticket's Resolution says which paths remain
  unproven against ADO.

### Resolution

One method — `AdoClient.write<T>(method, path, body?, params?)` — and **five** server functions
in `src/server/threads-fn.ts` (509 lines). `ado-client.ts` grew 92 lines and its test file 118,
to **27 tests**.

| what | shipped |
|---|---|
| write verbs | `POST` · `PATCH` · `PUT` · `DELETE` (`AdoWriteMethod`) |
| shared with `get` | `buildUrl` · auth header · `absorb` · the throttle gate · `redirect: 'manual'` |
| retries | **none, on any status** |
| return type | `T \| null` — a `DELETE` answers 204 and `JSON.parse('')` would fail a successful delete |
| settable statuses | `active` · `pending` · `fixed` · `wontFix`, via `isSettableStatus` |
| ownership check | `guardOwnComment` re-reads the comment from ADO before every edit and delete |

**Five writes, not four.** The ticket enumerated reply, status, edit and delete. T-026 needs a
*new* thread as well — "comment on this file", and "comment on this pull request" — so
`createThread`/`startThread` is the fifth, and it is the one write no line of this round's
specification asked for. It is also the one that carries `threadContext` and
`pullRequestThreadContext`, which makes it the write with the most invented shape.

**Ownership is checked by reading the comment back, not by trusting the screen.** `viewerId`
comes from the token on the server side and never from the request body — a client-supplied
`viewerId` is a field the caller fills in, not a check. ADO would refuse a foreign edit itself;
refusing here buys a sentence about ownership instead of a 401, and the write is never sent. The
cost is one extra `GET .../threads/{id}` per edit or delete, which is cheap because that endpoint
returns the thread unwrapped (T-022 §3).

**Replying and resolving cannot travel together, and that is enforced by shape.** They are two
server functions with two input types; there is no field on either that could carry the other.
Reopening a done thread is available and deliberate, through the status control alone.

**Deviation: nothing is optimistic.** The ticket asked for the `useViewedFiles` pattern — cache
first, call after. `conversation.ts` awaits the round trip, then awaits a re-read, and says why
at the top of the file:

- a viewed tick is a local SQLite row whose outcome is known before the call goes out; a comment
  is a remote object whose id, `publishedDate` and — for a status change — final state only ADO
  can supply;
- we have `pr.viewerId` and **no display name to go with it**, so an invented comment would
  render under the author "unknown" for as long as the write took. Showing someone their own
  paragraph attributed to nobody is worse than showing it a beat later.

What the ticket was actually protecting is intact and is the `settle` contract, not the optimism:
`ok: false` throws, the composer keeps the text, and the sentence appears beside it. A write
refused *before* it was sent — not connected, not your comment — reports `ok: false` with a
reason, and treating that as success is exactly how a reply appears to have posted and is not
there on the next read.

**Not measured: every one of the five writes, against Azure DevOps.** All are built from ADO's
documented request shapes and from the payloads T-022 read back; none has ever been sent, because
the only pull requests available belong to colleagues and this project's probes are read-only by
rule. Their *response* shapes are equally unproven — `postReply` parses an `AdoComment` out of
the answer, and if ADO returns something else the reply lands and the parse fails. **The first
live write is a smoke test on a pull request the user owns, and it is the one thing in this round
that cannot be finished without them.**

**Deliberately not built: likes.** `usersLiked` was empty on all 59 sampled comments and a like
is a write against a real person's comment that nobody has authorised. Read-only, as the map
says.

---

## T-025 — Threads in the diff

**Type:** feature · **Status:** resolved · **Blocked by:** T-023

A thread belongs on the line it is about, in a virtualizer built on the assumption that every
row is exactly 20 pixels tall.

**Success:**

- `DiffRow` gains a `thread` kind and `buildRows` places it under the line it anchors to.
  Rows stay a pure function of their inputs — `(diff, lines, layout, threads, reveals)` — and
  a thread row's key stays independent of its position, so expanding a gap above one does not
  remount it.
- **Only thread rows are measured.** `estimateSize` keeps returning `ROW_HEIGHT` for line,
  hunk and gap rows and `THREAD_ROW_ESTIMATE` for threads, and `measureElement` is attached
  to thread rows and to nothing else. The reason the diff does not measure everything is in
  `ROW_HEIGHT`'s own comment, and it still holds: a 5,000-line file must not do 5,000 layout
  reads to scroll.
- A done thread renders as a one-line stub **in place**, keeping its anchor, and expands.
  This is the shape the map asks for and it is also what keeps the row height honest.
- A per-PR "hide done" toggle. Hiding is a row-model input, not a CSS class — a hidden thread
  should not occupy a measured row.
- Both layouts. In side-by-side a thread row spans both columns; it is one conversation, not
  two halves.
- Threads on a file the diff cannot show (binary, too large, failed) still appear. The panel
  already has a notice; the threads go with it.
- `unanchored` threads render above the file's diff, labelled, rather than disappearing.
- A file with no threads pays nothing: no rows, no measurement, no change to what round 3
  renders today.

### Resolution

`diff-contract.ts` gained 9 lines, `diff-rows.ts` 135 (**31 tests**), `diff-view.tsx` 98
(**20 tests**), `file-diff.tsx` 51 (**18 tests**). The components are
`src/components/comments/thread-card.tsx` (**16 tests**) and `file-thread-list.tsx` (**6**).

| what | shipped |
|---|---|
| new row kind | `thread` — the union's one addition this round |
| measured rows | thread rows only · `estimateSize` returns `THREAD_ROW_ESTIMATE` for them and `ROW_HEIGHT` (20) for line, hunk and gap |
| `measureElement` | attached to thread rows and to nothing else |
| done threads | a one-line stub **in place**, keeping the anchor, expandable |
| hide done | a row-model input (`setHideDone`), applied to the diff *and* to the list above it |
| side-by-side | one row spanning both columns |
| no threads on a file | `setThreads(model, null)` identity-returns — no rows, no measurement, no rebuild |

**The virtualizer's assumption survives because only one row kind broke it.** `ROW_HEIGHT`'s
own comment already said why a 5,000-line file must not do 5,000 layout reads, and that is
unchanged: measurement is opt-in per row, keyed on `kind === 'thread'`. A pull request with no
comments measures exactly nothing, which is round 3's behaviour byte for byte.

**Hiding is a row-model input, not a class**, so a hidden thread occupies no measured row — and
it is applied in `FileThreadList` too, or "hide resolved" would clear the diff and leave the
unanchored list above it full of resolved threads.

**Deviation: a new thread is file-level, never line-anchored.** `context` names the file and no
position. A draft *on a line* would need a second new `DiffRow` kind (a composer row, placed
under a line that has no thread yet), and the union took its one addition this round. The cost
is real and worth naming: you can say "this file is wrong" from the diff but not "line 41 is
wrong" — for that, the reply path on an existing thread is the only anchored write.

**A defect this ticket's own integration test caught.** `FileThreadList` derived both its
composer label and its `context.filePath` from `threads?.path` — which is `null` on a file with
**no threads at all**, i.e. the common case. A comment written there would have posted as a
*pull-request-level* thread: it would appear, on the details tab, detached from the file it was
about, with no error anywhere. The fix is a required `path` prop, passed from `blobs.path` at
both call sites, and the doc comment on it says why it cannot be read off the threads. Found
because the test asserted the label named `/src/only-in-update.ts` and the label said something
else.

**Threads on a file the diff cannot show do appear.** A binary, a blob past the size ceiling, a
fetch that lost — `FileDiffPanel` renders a sentence instead of a `DiffView` in all three, and
`FileThreadList` switches to `all` so every thread on the file lists there rather than
disappearing with the diff.

**Not measured: a thread row's real height against a long conversation.** `THREAD_ROW_ESTIMATE`
is a first guess that `measureElement` corrects on the frame after mount; the correction was
observed in tests, never against a 40-comment thread in a browser. **Watch:** scroll-anchor
jitter while several thread rows resolve at once, if it shows up at all, shows up there.

---

## T-026 — The composer

**Type:** feature · **Status:** resolved · **Blocked by:** T-024

Where a reply gets written.

**Success:**

- Markdown, with a preview that uses the same `Markdown` component the description renders
  through — so what the preview shows is what the comment will look like, including the
  `remark-breaks` newline behaviour that ADO's own editor has.
- Reply, edit and new-thread all use it. Three call sites, one composer.
- Submit is disabled on empty or whitespace-only content. `Cmd`/`Ctrl`+`Enter` submits,
  `Escape` abandons — through the existing command registry rather than a bare key handler.
- A failed submit keeps the text. Losing a paragraph someone just wrote to a 503 is the worst
  outcome available here.
- Resolving with a comment is two visible actions, never one silent one (T-024).
- **No @mentions.** The map asks for them; T-022 declined to probe
  `POST graph/subjectquery`, so shipping them would mean guessing at an identity-search
  surface. Deferred explicitly, in the Resolution, with what it would take.

### Resolution

`src/components/comments/composer.tsx` (162 lines, **13 tests**), used from **four** call sites,
not three: reply (`thread-card.tsx`), edit (`comment.tsx`), new file thread
(`file-thread-list.tsx`), and new pull-request thread (`pr-detail.tsx`). The fourth arrived with
`createThread` in T-024.

| what | shipped |
|---|---|
| preview | the same `Markdown` the description renders through — `remark-breaks` on, `rehype-raw` absent |
| submit | disabled on empty **and** whitespace-only (`text.trim() === ''`) |
| keys | `⌘`/`Ctrl` + `Enter` submits · `Escape` abandons — **bound on the textarea** |
| failed submit | keeps every character, message underneath |
| resolve with a comment | two visible actions, never one call |

**Deviation: the keys are a textarea handler, not a command-registry binding.** The ticket asked
for the registry and the registry cannot serve this. `command-provider.tsx` early-returns on
`ctrl`/`meta`/`alt` — deliberately, so browser and OS shortcuts are never swallowed — and it
early-returns again on `isTextEntry`, so a bare `Escape` inside a textarea never reaches it
either. Both of those are correct for a global registry and both exclude exactly the two keys a
composer needs. So the handler is local, and `Escape` calls `stopPropagation()` so abandoning a
draft does not also close the panel the draft was in.

**The preview shares the renderer because a preview that lies is worse than no preview.**
`remark-breaks` is what makes ADO's newline behaviour visible before posting, and raw HTML is
escaped in both places, so `<b>` shows as three characters in the preview and three characters in
the comment. (This is the exact opposite of what a *rule description* needs — see T-028 — which
is why those are two components and not one with a flag.)

**Deferred: @mentions.** T-022 declined to probe `POST graph/subjectquery`, so there is no
measured identity-search surface to build against, and inventing one means inventing both the
request and the `<a href="#mention:...">` markup ADO stores. What it would take: one read-only
probe pass against `graph/subjectquery` on the user's own account (it is a write verb by HTTP
method only), the payload shape for a subject search, and the storage form of a mention in
`content` — after which the composer needs a token-aware textarea, which is the larger half.

**Deferred: avatars.** `imageUrl` on an author needs a credential the browser has not got, so a
comment renders with a name and no picture. Fetching them means proxying images through a server
function, which is a new endpoint class for a cosmetic gain.

**Not measured: any of it against ADO.** The composer's contract is "resolve means it landed",
and what lands is T-024's five unproven writes. A rejection renders correctly against a stub;
whether ADO's actual error text is readable to a person is unknown until the first live write.

---

## T-027 — Sonar findings, read

**Type:** feature · **Status:** resolved · **Blocked by:** T-022

Findings come from SonarCloud, not from ADO's threads, because ADO caps Sonar's comments at
50 (note 5) — so on exactly the pull requests where this matters, the threads are
structurally incomplete.

**Success:**

- Sonar project keys discovered from the PR's own `statuses`, with **no configuration**: parse
  `id=` and `pullRequest=` out of each SonarCloud status's `targetUrl`. A repository with
  several Sonar projects yields several, and all of them are queried.
- Open findings only, and the filter is explicit: `issueStatuses=OPEN,CONFIRMED,ACCEPTED`.
  T-022 measured that the default includes `FIXED`.
- Findings anchored on `textRange.startLine`, never on `line`. `component` split into a path,
  normalised to ADO's leading-slash form so it compares to a changed file by equality.
- Grouped by rule, count descending, worst impact as the group's badge. Grouped where the
  data is fetched, not in a component.
- Rule names and descriptions in **one** batched `rules/search?rule_keys=` call per pull
  request, with `organization` (mandatory — T-022) and an `f=` list that does not contain
  `type` (400s the request — T-022). A rule the API will not describe leaves `name` null and
  the panel shows the bare key.
- The quality gate from `qualitygates/project_status`, failing conditions first. Deprecated
  and answering 200; the ticket records what to switch to when it stops.
- **One project failing does not lose the others.** `SonarReport.failed` names what was lost,
  by project, with the reason.
- A 429 backs off for minutes, not seconds, and does not retry immediately: SonarCloud sends
  no rate-limit headers of any kind, so there is nothing to read and no budget to track.
- The token is read server-side only and never reaches the browser, including in error text —
  the `serviceDetail` rule from T-004 applies unchanged.

### Resolution

`src/server/sonar.ts` (822 lines, **18 tests**), one server function in `sonar-fn.ts` (150), and
`src/lib/sonar-contract.ts` (296) as the frozen shape.

| what | shipped |
|---|---|
| project discovery | `sonarProjects(statuses)` parses `id=` and `pullRequest=` out of each SonarCloud status's `targetUrl` — **no configuration**, several projects per repository |
| findings filter | `issueStatuses=OPEN,CONFIRMED,ACCEPTED`, explicitly |
| anchor | `textRange.startLine`, never `line` |
| path | `component` split and normalised to ADO's leading-slash form, so it compares by equality |
| grouping | by rule, count descending, worst impact as the badge — on the server |
| rule descriptions | **one** `rules/search?rule_keys=` per pull request, with `organization`, and an `f=` that omits `type` |
| gate | `qualitygates/project_status`, failing conditions first |
| partial failure | `SonarReport.failed`, by project, with the reason |
| 429 | `SONAR_BACKOFF_MS` = **120 000 ms**, no immediate retry |

**The token never reaches the browser and the error text is filtered, not trusted.**
`serviceDetail` from T-004 applies unchanged: a response body that contains the secret is dropped
wholesale rather than trimmed. `connected` can only be false once a pull request has been shown to
have a Sonar project, because no credential is read before that — which is what lets the details
tab say "add a token and the findings will appear here" instead of "not connected" on the 6-in-14
pull requests that have no Sonar analysis at all.

**A 429 is the entire signal.** T-022 measured **no rate-limit headers of any kind** across 19
response headers, so there is no budget to track and nothing to read off a success. The response
is a two-minute gate — minutes, because a header-less service that says "too many" has given no
grounds for guessing that seconds would be enough.

**The deprecated gate endpoint is the one in use, and here is the switch.**
`qualitygates/project_status` was deprecated 2025-09-16 and answers 200 with `metricKey`,
`comparator`, `errorThreshold` and `actualValue` per condition — the display shape, directly. When
it stops: `measures/component` is the replacement, and it needs a valid metric-key set (the map's
names 404 on Cloud), it hides `new_*` values under `periods[0].value`, and it ships
`quality_gate_details` as a JSON **string** that has to be parsed to recover the conditions. That
is the work, recorded here so it is not rediscovered.

**One project failing does not lose the others**, and the reason is that multi-project
repositories are real: `context.name` is either `quality gate` or `quality_gate_<projectKey>`, and
a repository with several Sonar projects posts one status each. Issues, rules and gate degrade
independently per project.

**Not measured: more than 500 open findings.** `ps: SONAR_PAGE_SIZE` is 500, the ceiling is hard
(`ps=501` → 400), and there is no paging loop. The pull request this project exists for reportedly
has ~300 Sonar comments, which fits. Beyond 500 the report is silently short — **knowingly
unhandled rather than accidentally so**, and the comment at the call site says exactly that.

**Not measured: a failing gate.** Every `project_status` payload sampled came back `status: OK`
with all conditions `OK` — 6 conditions on one project, 7 on another. The failing-condition path
(actual value against threshold, `ERROR` first) is built from the documented fields and exercised
only against fixtures, even though one sampled pull request's *ADO status* read "failed".

**Not measured: a rule Sonar will not describe, in the wild.** `external_roslyn:CA1861` was
requested and not returned — externally-imported analyser rules are not in Sonar's rule
repository, and unknown keys are skipped rather than erroring. So `RuleGroup.name` is nullable and
the panel shows the bare key; what cannot be distinguished is an undescribable rule from a typo.

---

## T-028 — The Sonar panel

**Type:** feature · **Status:** resolved · **Blocked by:** T-027

**Success:**

- A PR-level panel: quality gate status, then the failing conditions with actual value against
  threshold, then findings grouped by rule with a count and a severity badge.
- Expanding a group lists its `file:line` occurrences. Clicking one **jumps into the diff** —
  the changes tab, the right file, that line — using the existing `fileAnchor` scheme.
- A finding on a file that is not in the diff (Sonar analysed a path this pull request did not
  change, or the line drifted — note 6) says so instead of scrolling nowhere.
- Rule detail rendered in-app, sections ordered by `SECTION_ORDER` because the API's order is
  not stable (T-022).
- **The rule HTML is sanitised, and this is a new dependency decision.** Sonar sends HTML
  under both `htmlDesc` and `mdDesc`, so there is no markdown path — unlike a PR description,
  which round 3 renders with raw HTML *escaped* precisely so it can never become markup. A
  rule description has to become markup to be readable (it is `<pre>`, `<ul>`, `<code>`), so
  it goes through an allowlist sanitiser rather than through trust in sonarcloud.io. The
  ticket names the dependency and the schema; hand-rolling a sanitiser is not on offer.
- Findings and gate degrade independently, and a project whose issues failed is named.
- A pull request with no Sonar status shows nothing at all — not an empty panel, and not an
  error.

### Resolution

`src/components/sonar/panel.tsx` (441 lines, **14 tests**), `rule-detail.tsx` (91, **7**) and
`rule-html.tsx` (130, **5**). Two new dependencies: **`rehype-raw` ^7.0.0** and
**`rehype-sanitize` ^6.0.0**.

| what | shipped |
|---|---|
| order | gate status → failing conditions with actual against threshold → rule groups with count and badge |
| jump | `onJump` selects the changes tab, an effect scrolls once the file list has arrived |
| jump target | **the file, not the line** — `fileAnchor(path)` |
| a finding off the diff | a `not in this diff` chip instead of a click that goes nowhere |
| rule sections | ordered by `SECTION_ORDER`, because the API's order is not stable |
| sanitiser | `rehype-raw` **then** `rehype-sanitize` with `defaultSchema` |
| no Sonar status | renders `null` — not an empty panel, not an error |

**The sanitiser order is the whole safety property.** `rehype-raw` turns raw HTML nodes into real
hast and `rehype-sanitize` filters the result against an allowlist, in that order. Reversed, the
sanitiser would inspect one text node, find nothing that looks like an element, and pass a
`<script>` straight through to `rehype-raw` to parse. Nothing here uses
`dangerouslySetInnerHTML` and nothing hand-rolls a filter — an allowlist is a corpus of edge
cases (`<svg>` foreign content, `<math>` namespace confusion, attribute-value escapes) and a
hand-rolled one is a list of the cases its author thought of.

**The schema is `defaultSchema` unextended, and that is measured rather than lazy.** Every tag the
sampled description corpus uses is already allowed; `<script>`, `<style>`, `<iframe>`, every `on*`
handler, inline `style` and any exotic `href` scheme are already denied. `RuleHtml` is the
deliberate mirror of `markdown.tsx`, which does **not** install `rehype-raw` precisely so a
colleague's `<script>` in a PR description shows as eleven characters — the two requirements are
opposite, which is why they are two components.

**Deferred: the compliant/non-compliant code pairing.** Sonar hangs `data-diff-id` and
`data-diff-type` on the `<pre>` pairs it uses to draw "this, not that", and `defaultSchema` drops
both. The blocks still render, in order, with their surrounding prose, so the pairing survives as
text. Recovering the border means allowing arbitrary `data-*` back in, which is a bigger door than
the gain.

**The jump lands on the file, not the line, and that is the honest destination.** Sonar's line
numbers drift from the diff when the branch was pushed to after analysis (note 6), so a
line-level anchor would be a promise the panel cannot keep — the line is printed on the row that
got you there instead. The cross-tab wiring is two pieces: the panel's `onJump` sets state and
switches tabs, and an effect in `pr-detail.tsx` scrolls once the tab has rendered *and*
`changes.pending` is false, then clears the jump so a later file-list change cannot drag the page
back.

**Fetched from the route, not from the panel's parent.** A second service that can be rate-limited
for two minutes must not be able to hold up the pull request page, so `sonar` arrives as a prop
that is `null` while in flight — which is also what a test that does not care about Sonar passes.

**Not measured: the panel against a failing gate or a large finding set.** Same gap as T-027 —
every sampled gate was `OK`, and the largest sample had 4 findings, so "failing conditions first"
and the grouped list at 300 findings are both fixture-only. **Watch:** the group list is not
virtualized; 300 findings across ~40 rules is 40 collapsed rows, which is fine, but a project that
puts hundreds of *rules* on one pull request would render them all.

---

## Closing the round

Six tickets, four of them built in parallel git worktrees against contracts frozen first
(`comment-contract.ts`, `sonar-contract.ts`) so that agents on disjoint file sets could not
disagree about a shape. The contracts were authored from T-022's census, before any of the code
that consumes them.

| what | measured |
|---|---|
| tests | **619 passing across 37 files**, from 460 across 29 at `7cb7913` |
| typecheck | `pnpm exec tsc --noEmit` clean |
| new source | `src/server/threads.ts` · `threads-fn.ts` · `sonar.ts` · `sonar-fn.ts` · `src/lib/comment-contract.ts` · `sonar-contract.ts` · `conversation.ts` · `src/components/comments/` (5) · `src/components/sonar/` (3) |
| new dependencies | `rehype-raw` ^7.0.0 · `rehype-sanitize` ^6.0.0 |
| touched from round 3 | `ado-client.ts` (+92) · `diff-rows.ts` (+135) · `diff-view.tsx` (+98) · `file-diff.tsx` (+51) · `changed-file.tsx` (+44) · `pr-detail.tsx` (+330) |

**One read for the whole page, and it is asserted.** `useConversation` runs once in
`PullRequestDetailView` and both tabs consume the same answer — the details tab's Conversation
section takes `onPullRequest`, and every file panel takes its slice of the grouped map. A test
asserts `threadsQuery` is called exactly once per page, because the shape that would otherwise
emerge is one read per file panel, which is 294 reads on the pull request this project exists for.

**"Hide resolved" is rendered twice, deliberately.** One control above the diff and one inside the
details-tab Conversation section, sharing a single piece of state. The two tabs are never on screen
together, and a filter you cannot reach from the tab it affects is worse than a duplicated control.
In the section it is suppressed entirely when there is nothing resolved to hide.

**Writes are not offered rather than disabled.** Every write handler is gated on
`conversation.connected`, so a page that can read the conversation but not write it shows no
composer and no status control at all — "not offered" is how this seam spells a write that cannot
land. `viewerId` survives either way, because it came from the pull request, not from the token.

**Out of ownership, and worth naming:** four round-3 test fixtures gained one line each —
`write: () => Promise.reject(new Error('this fixture is read-only'))` in `blob.test.ts`,
`hydrate.test.ts`, `inbox.test.ts` and `pull-request.test.ts`. Their stub `AdoClient` objects
stopped satisfying the interface the moment `write` was added to it, and a rejecting stub is the
honest fill: those tests assert reads, and any of them that starts writing should fail loudly.

**`pnpm typecheck` was avoided in favour of `pnpm exec tsc --noEmit`.** The former runs
`tsr generate` first, which rewrites `src/routeTree.gen.ts` and **deletes the committed
`declare module '@tanstack/react-start'` block** from it. That is a round-2 hazard and it is still
live; the direct `tsc` invocation is the way to typecheck this repo without dirtying a generated
file. Verified: `routeTree.gen.ts` is not modified.

**What the round did not do.** No line-anchored new threads (T-025), no @mentions and no avatars
(T-026), no paging past 500 Sonar findings (T-027), no line-level jump (T-028), and **no write has
ever been sent to Azure DevOps** (T-024). That last one is the round's real boundary: five write
paths, all built from documented shapes and measured read payloads, none exercised against the
service. The first live write is a smoke test on a pull request the user owns.

**Housekeeping seen and left alone**, per surgical-changes: `Empty` and `Failed` are now duplicated
between `pr-detail.tsx` and `sonar/panel.tsx` — worth lifting on the third consumer, not the
second — and nothing asserts server-side that `FileThreads.byRightLine` and `unanchored` stay
disjoint.
