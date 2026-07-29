# Round 5 — the rest of it

Phases 5, 7, 8 and 10 of [the route](./round-1.md#the-route). [Round 4](./round-4.md) put the
review on the page. This round puts the *build* on it, lets the page finally act on a pull
request, tells you when something changed, and pays off the six things earlier rounds
deliberately declined.

Same conventions: each ticket states **success criteria**, not steps; facts referenced by
number come from [the notes](../map.md#the-notes); every ticket carries a
**Type · Status · Blocked by** line, and a **Resolution** written after it lands.

**The fact that shapes this round: the app has still never sent a write to Azure DevOps.**
Round 4 built five write paths — reply, start thread, set status, edit, delete — and phase 7
had already landed two more out of band (squash merge, rename). Seven unproven writes, and
every one of them was reasoned about rather than observed: the response shapes are inferred
from documentation, the failure modes from the client's own contract. This round adds four
more (vote, abandon, reactivate, add/remove reviewer). That is eleven write paths whose first
real exercise is a side effect on a colleague's pull request, which is why
[T-040](#t-040--the-first-real-write) exists and why it is the only ticket in this round that
is not mine to close.

**The second fact: two of the four features rested on APIs nobody had measured.** Phase 5 is
"per-step pass/fail, the failing step's log inline, failed tests only" and not one of the
build, timeline, log or test-result endpoints had ever been called from this repo. Phase 7's
reviewer autocomplete and phase 10's `@mentions` both hang off `graph/subjectquery`, which
[T-026](./round-4.md#t-026--the-composer) explicitly declined to probe. So this round opens
the way rounds 3 and 4 did: **two read-only inventories first, two contracts frozen out of
them, and only then code.** Freezing the shape before the parallel work starts is what lets
five agents write against it without agreeing with each other.

**The third fact: notifications are a diff between two polls, and the substrate already
exists.** `hydrate` already caches per-pull-request checks, unresolved count, vote and
merge-readiness in SQLite, keyed on the head commit; `useCadence` already decides when a
surface re-asks. A notification is what changed between the cached row and the fresh one.
Nothing in this round polls in the background, opens a socket, or runs while the app is
closed — that is [the fog](../map.md#the-fog), and it stays there.

**What this round is not.** No repository list (phase 9 — it is independent and cheap, and it
can be had any time). No service hooks. No push notifications, no OS notifications, no
notifications while the app is closed. No comment likes (`usersLiked` was non-empty on 0 of
59 sampled comments; there is still nothing to like).

---

## T-029 — Build, timeline, log and test-result endpoint inventory

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

Phase 5 is four features stacked on endpoints this repo has never called. `src/lib/requeue.ts`
proves the *policy* half — requeuing an evaluation is the documented way to re-run a PR build —
and nothing else. Guessing at the timeline's record tree would cost the panel a rewrite,
because whether the failing **step** is identifiable separately from the failing **job**
decides the whole shape of the UI.

**Success:** a field census over real builds, taken from real pull requests, answering at
minimum: how a pull request reaches a build id (via `statuses` `targetUrl`, via a `Build`
policy evaluation, or both); the build status/result enums *actually observed* rather than the
documented list; the timeline's record tree — `type` values, how parent/child is expressed,
how many records a real timeline holds, and **how the failing step is told from the failing job
that contains it**; whether a step log is text or JSON, whether a tail can be asked for, and
the measured byte size of a real failing step's log; which of the test-result endpoints answers,
and whether it can return failures only or whether we filter client-side. Every claim a number,
every absence counted. At least one **failed** build with a **failing step** in the sample, and
a build with **failing tests** if one can be found — round 3 learned that an all-happy sample
hides whole categories of case.

Read-only throughout: **GET only.** The re-run request shapes are documented from Microsoft's
reference and marked **unproven**, because sending one would re-run a colleague's build.

Then `src/lib/checks-contract.ts` is frozen out of it — the types the server layer and the
panel are both written against, before either exists.

### Resolution

`ceb07c1`. `scripts/checks-inventory.mjs` (GET-only by construction — its `ado()` helper has no
`method` parameter at all, so a write is not something you have to remember not to write), 176
requests over two passes, output in `docs/research/checks-inventory.md`, and
`src/lib/checks-contract.ts` frozen from it.

The finding that shaped the contract: **a timeline is 9.7–69.1 KB and a failed-test list up to
191 KB, and a pull request can carry five build policies.** Eager-fetching everything a panel
*might* show is 24 calls where 6 will do, so `CheckDetail` is a separate second fetch from
`ChecksReport` rather than a richer version of it. The sample did contain a failed build with a
failing step and a build with failing tests, which is where `isFailingStep`'s
`errorCount > 0 && children.length === 0` came from — a failed *parent* record is not a failing
step, and an all-happy sample would have hidden that.

Two numbers to design around: ADO truncates a stack trace at exactly **4000** characters (8 of
28 were 4000 on the nose, so a trace at the limit is a floor not a length), and every log
response carries `cache-control: no-cache, expires: -1`, which makes caching the app's decision
rather than the transport's — hence `LOG_CACHE_MS`.

`RequeueRequest` is transcribed and **unproven**: `PATCH policy/evaluations/{id}` with no body,
where the `-preview.1` suffix is not optional (plain `7.1` answers 400, "The -preview flag must
be supplied"). Requeueing **cancels a build that is currently running**, which is why
`requeueTarget()` refuses a `running` policy.

---

## T-030 — Identity search and avatar inventory

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

Three features were deferred for want of exactly this measurement:
[T-026](./round-4.md#t-026--the-composer) declined to probe `graph/subjectquery`, so `@mentions`
would have meant inventing both the request *and* the markup ADO stores in comment content;
the same endpoint is phase 7's reviewer autocomplete; and avatars need a credential the browser
has not got.

**Success:** the searchable identity surface, measured. What `POST graph/subjectquery` takes and
returns, on which host, at which api-version; how short a query can be before it stops matching;
whether it matches display name, unique name or both; whether the result count is capped and
whether the cap is admitted; and its **latency, measured several times** — an autocomplete that
costs 800 ms a keystroke needs its debounce designed around the real number rather than a
guess.

The load-bearing question: **how the descriptor↔GUID gap is crossed, and what it costs.** The
graph API is descriptor-based and `PUT .../reviewers/{id}` is GUID-based. If closing that gap
costs an extra call per candidate, autocomplete has a different shape than if it does not.

Then: a reviewer field census over real pull requests, including how many are `isContainer`;
the **verbatim** storage form of an `@mention` in a real comment's `content`, found by reading
real threads (or an honest "not found in *n* threads searched", which is worth more than a
guess); and for avatars, whether the URL is fetchable **without** a credential — if it is, the
image proxy this project deferred may not need to exist at all.

Authorised exception to the read-only rule: `POST graph/subjectquery` and
`POST graph/subjectlookup`. They are searches that carry their query in a body; they mutate
nothing, and neither is a pull request. **No other non-GET request.**

Then `src/lib/identity-contract.ts` is frozen out of it.

### Resolution

`5e176fc`. `scripts/identity-inventory.mjs`, `docs/research/identity-inventory.md`, and
`src/lib/identity-contract.ts` frozen from it. The authorised exception was used exactly twice;
the probe refuses any other non-GET at its single request chokepoint rather than trusting itself
not to write one.

**Host first, because it looks like a typo and is not.** Everything identity-related is on
`vssps.dev.azure.com`. `graph/subjectquery` and `graph/users` on `dev.azure.com` answer **404**
with "The controller for path … was not found or does not implement IController" — which reads
like a wrong path and is a wrong host.

**The search:** `POST graph/subjectquery`, preview-only (`7.1` → 400), **~135 ms** at
`x-ratelimit-cost` 0 — fast enough for a keystroke at a 150 ms debounce. Two behaviours that
matter more than the latency: it is a **prefix match, not a substring search** (`Jordan` → 2
hits, the surname `Vincent` → **0**, `orda` → 0), and it caps at **100** silently, ignoring
`$top`, with no continuation token.

**The descriptor↔GUID gap costs one call, not one per candidate.**
`GET _apis/identities?subjectDescriptors={csv}` crosses it for a whole page at once — six calls
of 50 took 140–227 ms, and two descriptors took 127, so batch size is nearly free. The ceiling is
URL length and it arrives as a **404**: 60 descriptors → 200, **70 → 404**. Three dead ends,
measured so nobody tries them again: `descriptors=` (the wrong parameter name) answers **200 with
`[null, null]`**; `subjectlookup` carries no `id` either; and `originId` equalled the identity id
**127 of 299** times — right for two people in five, which is worse than reliably wrong.
Base64-decoding the descriptor matched **0** times in 300.

**The mention form, verbatim and real:** `@<DDE322B5-997F-6B0C-8C02-E3C7B90F91D6>` — literal
angle brackets, **upper case** — 5 of 5, found across 29 pull requests / 218 threads / 232
comments. So T-035 does not have to fabricate markup. T-026's `#mention:` guess is **wrong**:
zero occurrences, and zero `<a href=` in any comment body. The comment has **no `properties`
key**, so the body text is the only record of who was mentioned. `identities?identityIds=`
answers `id` in **lower** case, which is exactly the casing hazard `people.ts` already guards.

**The image proxy does not need to exist.** `MemberAvatars/{descriptor}` answers 200 with the
identical image and **no auth header at all** (on `dev.azure.com`, not vssps); `identityImage?id=`
302s to the sign-in page. The catch, dug out late and verified: **`imageUrl` is not one URL
shape.** Comment authors carry the credential-free form (42/42); reviewers (30/30) and pull
request authors (99/99) carry the one that redirects. So a client must inspect the URL, not trust
the field name. Reviewers carry no `descriptor` field (0/30) but `_links.avatar.href` ends in one
on 30/30, so the swap costs nothing.

Unmeasured and marked so: `PUT`/`DELETE .../reviewers/{id}` is transcribed from Microsoft's
reference, because sending one would edit a colleague's pull request — upsert-vs-error, removing
an absent reviewer, and changing `isRequired` after the fact are all unproven. Also unmeasured:
throttling under real load (only `x-ratelimit-cost` ever appeared, on 25 of 182 responses), and
`subjectquery` paging in an org with more than 100 matches.

One flag carried into T-035: `ado-client.ts`'s `write()` hard-codes host `'core'`, and the only
authorised POST here is on `vssps`.

---

## T-031 — Checks: the server layer

**Type:** feature · **Status:** open · **Blocked by:** T-029

**Success:** one call from the client gets everything the checks panel needs for a pull request,
and a failure in any part of it costs only that part. Concretely: the checks for a pull request,
each linked to its build where one exists; for a build, its timeline reduced to something
renderable; for a failing step, its log; and for a build with failures, the failed tests only.

The shape is round 3's and round 4's, not a new one: loaders in `src/server/checks.ts` taking
`(client, ref)`, a `checks-fn.ts` whose handlers **return** errors rather than throwing, a
per-section failure type so one dead service does not blank the others, and a `RateLimit`
carried out with every result. `AdoClient` is the only transport — a call that bypasses it
bypasses the throttle gate (note 2) and `redirect: 'manual'` (note 4).

Two things this ticket must decide with numbers rather than taste, using T-029's measurements:

- **What is fetched eagerly and what on demand.** A timeline with hundreds of records and a
  multi-megabyte log cannot both be part of the page load. The split is a measured one.
- **What is cached and keyed on what.** A finished build never changes and a running one
  changes every few seconds; `pr_cache`'s commit-id-as-validity-token idiom does not fit a
  build id, so if anything is cached, its key says why it is still true.

The re-run writes are typed and reachable but **unproven** — same standing as round 4's five.
`requeueEvaluation` already exists in `pull-request.ts` and is not duplicated here.

---

## T-032 — Checks: the panel

**Type:** feature · **Status:** open · **Blocked by:** T-031

**Success:** on a pull request whose build failed, the failing step is on screen without a
click, its log is readable in the app, and the failed tests are listed with name, class,
message and stack. A passing build says so in one line and takes no more room than that. A
build still running says which step it is on.

Non-negotiables:

- **Failed tests only.** Not a test list with failures highlighted. The map says failures, and
  a build with 4,000 passing tests must cost nothing to render.
- **A log is not a page.** Whatever T-029 measured a real failing log to be, the panel renders
  it without freezing the tab — which for a large log means the tail, virtualized, or both,
  and an honest control to get the rest.
- **Re-run at whichever granularity fits:** requeue the policy, retry the build, retry a single
  stage. Each one disabled with a reason when it does not apply, rather than absent. Nothing
  optimistic — the button settles on the round trip and then a re-read, per
  [T-024](./round-4.md#t-024--writing)'s contract.
- Prof, throughout: existing tokens and existing `ui/` primitives, no new colours, and the
  `Empty`/`Failed` pair reused rather than triplicated.

---

## T-033 — Vote, abandon, reactivate

**Type:** feature · **Status:** resolved, unproven against the live API · **Blocked by:** —

**Success:** I can set my own vote on a pull request from its header — approve, approve with
suggestions, wait for author, reject, and reset to no vote — and I can abandon a pull request I
own and reactivate one I abandoned. Each action names what it will do before it does it, and
each is refused with a reason rather than hidden when it does not apply.

The votes are the wire values, not new ones: `10` approved, `5` approved with suggestions, `0`
no vote, `−5` waiting for author, `−10` rejected. `PUT .../pullRequests/{id}/reviewers/{me}`
takes them; the `{me}` is `viewerId`, which comes **from the token server-side and never from
the request body** — the round-4 rule, and the reason a vote cannot be cast as someone else by
editing a request.

**Abandon is a status transition, not a delete:** `PATCH` the pull request to `abandoned`, and
back to `active` to reactivate. It is destructive in the sense that matters (it closes work
other people are waiting on) so it confirms first; a vote does not, because a vote is
correctable by voting again.

Two things must stay true:

- **Voting resets on a new push, and the UI must not pretend otherwise.** `hydrate` already
  computes `approvalReset`; a header that shows a stale approval after a force-push is worse
  than one that shows nothing.
- **Nothing is optimistic**, and invalidation happens `onSettled`, not `onSuccess` — a write
  that timed out may already have applied (note 2). `useRequeue`, `useSquashMerge` and
  `useRename` are the pattern; follow them rather than inventing a fourth.

### Resolution

Three writes in `pull-request.ts` — `castVote`, `abandon`, `reactivate` — three server functions
beside `squashMerge`, two hooks (`src/lib/vote.ts`, `src/lib/lifecycle.ts`), and one header row
holding both controls. **No write was ever sent to Azure DevOps.** Every path below is proven
against captured writes and unproven against the live API; the first real one is T-040.

| action | request |
|---|---|
| vote | `PUT {pr}/reviewers/{viewerId}` · body `{ vote }` · api-version 7.1 |
| abandon | `PATCH {pr}` · body `{ status: 'abandoned' }` |
| reactivate | `PATCH {pr}` · body `{ status: 'active' }` |

Learned in-repo rather than by probing: the vote route and its five wire values are this
ticket's own text and map note "Reviewer votes"; the status transition is corroborated by
`setTitle`'s own comment that the same `PATCH` completes, abandons, retargets and undrafts a pull
request, and by `completePullRequest`, which is that `PATCH` with `status: 'completed'`. Each body
is asserted **whole**, for `setTitle`'s reason — this one route is four actions, and a key that
leaked into the abandon body would be a different one.

**`{me}` is enforced by absence.** `castVote(client, ref, vote)` has no parameter for a reviewer
id: it resolves the viewer from `connectionData` through `pull-request.ts`' memoised
`resolveViewer` and refuses outright when ADO will not say. `VoteRequest` has no such field
either, and `voteRequest` rebuilds its answer out of `pullRequestRef(input)` plus the vote, so a
`reviewerId` in the body never reaches a variable — that is a test rather than a claim.

**The vote is guarded server-side, unlike the merge, and for a reason peculiar to it.** ADO does
not re-judge a vote: `PUT .../reviewers/{id}` *creates* the reviewer row when there is none, so a
vote on a pull request you are not on silently becomes an add-reviewer write, which is T-034's
scope and not this one's. So `castVote` re-reads the pull request and refuses when the viewer is
neither on the list nor reachable through a container — the container exception is what keeps the
guard from killing the dominant case, since a group is the reviewer on 119 of 163 active PRs and
its members are legitimately absent until they vote.

**`approvalReset` is on the detail page now, and it survives voting.** It was in
`hydrate`'s cache and nowhere the header could see it; `loadPullRequest` cannot read SQLite and
its five-call budget cannot afford a `threads` call, so `pullRequestQuery` reads
`readPrCache<Hydration>(id, lastMergeSourceCommit)` — no network, and commit-keyed, so a push
makes it miss. `PullRequestDetail.approvalReset` is `boolean | null` where **`null` renders as
silence**: the ticket prefers nothing to a stale approval, and that cuts both ways. The notice is
gated on the vote the page last *read*, not on the vote just sent, so pressing Approve does not
take it down — until the re-read comes back, "a push reset your approval" is still the true
sentence. That is tested directly.

**Five states, presented as five actions plus one fact.** The buttons are imperative and the
badge is past tense — "Approve" against "approved" — because a row of five buttons that all read
like statuses is a row nobody can tell they may press. They sit in ADO's own order so the group
reads yes to no with the neutral in the middle, the current one is `aria-pressed` and filled in,
and the state is *also* said in words in the badge: colour is never the only thing telling
"approved" from "waiting for author". "No vote" keeps ADO's phrase rather than "Clear", because
`0` is a position on the scale and not the absence of one. All five go quiet while one is in
flight, and the pending label names which — on a scale where only the last write survives, two
queued votes is a race a reviewer would lose.

**Reactivate does not confirm, deliberately.** The ticket's line is what is correctable: a vote
does not ask because voting again fixes it, abandoning does because it closes work other people
are waiting on. Reactivating reopens work rather than closing it and abandoning again undoes it
exactly, so a dialog would be asking whether you meant to press the button you pressed.
Abandon's dialog names the pull request and says what abandoning does **not** do — the word
sounds like a delete, and a reviewer who believes it is one will not use it when it is the right
answer. Neither verb is on the command palette: no unmodified keystroke should close a pull
request.

Both controls stay on the page when they do not apply, disabled with the sentence saying why
(`voteBlocker`, `lifecycleAction`), which is `mergeBlocker`'s shape. Abandon and reactivate are
offered on your own pull request only — this app's rule rather than a claim about ADO's
permissions, and the refusal is worded that way. **44 files / 796 tests**, up from 41 / 718;
`tsc --noEmit` clean.

---

## T-034 — Reviewers, with org-wide autocomplete

**Type:** feature · **Status:** open · **Blocked by:** T-030, T-033

**Success:** I can add a reviewer to a pull request by typing two or three letters of their name
and choosing from a list, and I can remove one I added. Required and optional are
distinguishable, and a group reviewer is not mistaken for a person.

Designed around T-030's measured numbers, not around a guess: the debounce is derived from the
measured search latency, the minimum query length from the measured shortest matching query,
and if the descriptor↔GUID gap costs a call, that call happens **once on selection** rather
than once per keystroke. In-flight searches are abandoned when the query moves on; a search
that fails says so in the field rather than emptying the list.

`isContainer` reviewers are labelled as groups — [T-006](./round-1.md#t-006--identity) already
paid for the lesson that ADO's identity surfaces conflate people and containers, and a
container's `votedFor[]` is how a group approval is actually expressed.

Keyboard first, per the standing rules: the list is arrow-navigable, `Enter` selects, `Escape`
closes without selecting, and the field is reachable without a pointer.

---

## T-035 — `@mentions` in the composer

**Type:** feature · **Status:** open · **Blocked by:** T-030, T-034

Phase 10. [T-026](./round-4.md#t-026--the-composer) deferred this twice over: the search was
unmeasured, and the stored form of a mention was unknown. `src/lib/people.ts` already **reads**
mentions — `splitMentions`, `mentionTag`, `mentionedIds`, `mentionsIn` — so the render half is
done and the write half is not.

**Success:** typing `@` in a comment composer offers people, choosing one inserts a mention that
ADO renders as a mention when the comment is read back **in ADO's own web UI**, and the
composer's plain text still round-trips through `markdown.tsx` unchanged for everything that is
not a mention.

That "in ADO's own web UI" is the whole acceptance criterion, and it is why T-030 had to find a
real one verbatim: a mention we invent renders in our app and nowhere else, which is worse than
no mention at all because it looks like it worked. If T-030 could not find a real example, this
ticket ships the search and the picker and stores **plain `@Display Name` text**, saying so
out loud, rather than fabricating markup.

The textarea is token-aware, which is the larger half of the work: the trigger fires on `@`
at a word boundary and not inside a word or a code fence, the caret survives insertion, the
picker is arrow-navigable, and `Escape` dismisses the picker without dismissing the composer.
Reuse T-034's search — one identity search hook, two consumers.

---

## T-036 — Avatars

**Type:** feature · **Status:** open · **Blocked by:** T-030

Phase 10. [T-026](./round-4.md#t-026--the-composer) left comment authors as initials because
`imageUrl` needs a credential the browser has not got, and standing up an image-proxying
endpoint for a cosmetic gain was not worth it mid-round.

**Success:** a comment author, a reviewer and a pull-request author show a real avatar where one
exists, and initials where one does not — with **no token leaving the server**, no layout shift
when an image arrives late, and no request storm on a pull request with sixty comments.

The design follows T-030's finding, and this ticket has two legitimate shapes:

- If an avatar URL is fetchable **without** a credential, there is no proxy: the browser loads
  it directly, and this ticket is the fallback-to-initials component plus caching by the
  browser. That is the cheap outcome and it should be taken if it is available.
- If it is not, a server function proxies the bytes, and the bytes are cached the way blobs
  are — a SQLite table, a byte ceiling, and an `ETag` honoured if T-030 measured one. A new
  migration, appended, never an edit to a shipped one.

Either way the fallback is not a broken-image icon: `initials()` in `people.ts` already exists
and stays the answer for a missing, failed or slow avatar.

---

## T-037 — A new thread on a line

**Type:** feature · **Status:** resolved · **Blocked by:** —

Phase 10. [T-025](./round-4.md#t-025--inline-threads) shipped file-level threads and stopped:
anchoring a *new* thread to a line needs a second new `DiffRow` kind, so today you can say
"this file is wrong" from the diff but not "line 41 is wrong" — which is most of what line
comments are for.

**Success:** from a diff row I can start a thread on that line, it posts with the right
`threadContext`, and after it posts it appears as an inline thread on that same line without a
reload.

What must not break, because it is measured and paid for:

- **The row list is virtualized and content-keyed.** `RowModel`'s keys are derived from content
  (`@old,new`, `~old,new`, `old/new`) precisely so that a re-measure does not scramble the list;
  a composer row needs a key with the same property, and it must not collide with the thread row
  that replaces it.
- **Only thread rows are measured.** Everything else is a flat `ROW_HEIGHT` of 20 px. A composer
  is variable-height, so it joins the measured set — and `THREAD_ROW_ESTIMATE` was chosen from a
  thread, not a textarea.
- **The anchor is right-side, one-based, and `offset` is not always 1.** Round 4 measured 12
  anchored threads, all `rightFileStart`/`rightFileEnd`. Posting on a **deleted** line is a
  thing ADO supports and this ticket does not have to solve, but it must refuse it clearly
  rather than post a wrong anchor.
- One composer open at a time, `Escape` closes it, and closing a composer with text in it does
  not silently discard the text.

### Resolution

A fifth `DiffRow` kind, `ComposerRow`, keyed `+<line>` — content-derived like the other four, and
it cannot collide with the thread row that replaces it once the draft posts, because that one is
`!<threadId>`. The row is emitted by `attach` **below** any thread already on the same line, so a
new comment lands under the conversation it is joining, and both cursors run through one forward
pass so the order never depends on map iteration order.

The composer is a sixth **input** to `RowModel` (`composer: ThreadContext | null`) with a
`setComposer(model, context)` transition, not local component state. That is forced by the poll:
`changed-file.tsx` rebuilds the whole model from its six inputs every 30 seconds when threads
arrive, so anything that is not an input is erased mid-sentence. `setComposer` identity-returns
when the anchored line has not moved — pressing the same button twice builds an equal-but-new
context — and refuses a context with no `rightStart`, which is what keeps a file-level comment in
`FileThreadList` where it belongs.

How the reviewer opens it: a per-line gutter button (`CommentAdd01Icon`, `aria-label="Comment on
line N"`), not a keyboard shortcut, because the diff has no line cursor for a shortcut to act on.
It is absolutely positioned and `opacity-0` until `group-hover`/`focus-visible`, so 5,000 rows
neither reflow on hover nor leave the tab order. It is **absent on a delete-only row** — nothing
to press is the clearest refusal of a left-side anchor — and withheld from every row on a page
with no `onNewThread`, rather than offering 5,000 invitations that go nowhere.

Two things the ticket asked for that cost more than they look. `COMPOSER_ROW_ESTIMATE = 160`
joins `THREAD_ROW_ESTIMATE` in the measured set, so "only thread rows are measured" is now "only
these two are" and the other three are still flat 20 px. And the draft survives a close: the text
is stashed in a `useRef` in `DiffView` and fed back through `Composer`'s `initial` on reopen —
a ref rather than state because a `useState` there re-renders all ~56 visible rows on every
keystroke. Reopening a *different* line starts empty, since inheriting the text would misattribute
it. That same ref also fixes losing a draft when the row scrolls out of the overscan window.

**744 tests over 41 files**, up from 718: 15 new in `diff-rows.test.ts` for the transition
(placement in both layouts, key uniqueness and order, one at a time, identity returns, survival
of `setThreads`/`setLayout`/`setHideDone`/`expandGap`, following its line out of an expanded gap)
and 11 in `diff-view.test.tsx` for the behaviour (the button's presence and absence, the posted
`NewThread`, the measured-row count, `Escape` keeping the draft).

---

## T-038 — The three Sonar shortfalls

**Type:** feature · **Status:** parts 1 and 3 resolved · **part 2 still open** · **Blocked by:** —

Phase 10. [Round 4](./round-4.md) delivered phase 6 early and named exactly three things it
left. None is a defect; each was measured and declined.

**1. Paging past 500 findings.** `SONAR_PAGE_SIZE` is 500 and the ceiling is hard —
`ps=501` answers `400`. A pull request with more findings than that is silently short today.
**Success:** all findings are fetched, in a loop that keeps the existing per-project degradation
intact (one project failing must not cost the others their findings), with a stated ceiling on
total pages so a pathological repository cannot hang the panel, and the truncation admitted in
the UI when the ceiling is hit rather than silently.

**2. The line-level jump.** A finding jumps to its file today, not to its line, because
**Sonar's lines drift from the diff** (note 6): Sonar analyses the merge result, the diff shows
the iteration, and the numbers disagree. **Success:** a finding jumps to its line when that
line is in the diff, scrolls it into view inside the virtualized row list, and says so plainly
when the line is not there — landing on the file with "line 214 is not in this diff" beats
landing on the wrong line silently. Note 6 is the reason this is a two-outcome feature and not
a one-outcome one.

**3. The compliant/non-compliant `<pre>` pairing.** Sonar rule descriptions mark their example
blocks with `data-diff-id` and `data-diff-type`, and `rehype-sanitize`'s unextended
`defaultSchema` strips both, so a rule's "do this / not this" pair renders as two unlabelled
code blocks. **Success:** the pair renders as a pair. The schema extension is **narrow** — those
two attributes, by name, on `pre` — not a widened schema and not `rehype-raw` without sanitize
after it. The order stays `rehype-raw` **then** `rehype-sanitize`; reversing it is how untrusted
HTML gets through, and Sonar's rule HTML is third-party content.

### Resolution

**Parts 1 and 3 only. Part 2 was not attempted, deliberately.** The line-level jump needs
`src/lib/diff-rows.ts` and `src/components/diff/diff-view.tsx`, and T-037 was rewriting both at
the same time in another worktree — two agents editing the row model of the same virtualized
list produces a merge, not a feature. It stays open with its success criteria unchanged; nothing
here forecloses it, and `SonarJump` already carries the line.

**1. Paging.** `loadIssues` is a loop, `p` alongside `ps: 500`, bounded by
`SONAR_MAX_PAGES = 20`. It ends on `total` — the top-level count, present on every 200 measured,
and the same number `paging.total` repeats, which is why only one of them is modelled. With no
`total` at all it ends on a page shorter than the maximum, which is the only signal left; that
ordering matters, because a *short* page is not proof of a last page (the ADO side measured a
service that filters after it pages) so `total` is asked first and the length only when there is
no count to compare against.

**The ceiling is arithmetic and cannot be beaten.** `ps` will not exceed 500 (`ps=501` and
`ps=1000` both `400`, in the probe table), and `p * ps` cannot exceed 10 000 on
`issues/search` — that half is this ticket's reconnaissance and Sonar's documented limit, not a
row in `docs/research/`, because no probe ever sent a `p`; it is flagged as the number to
re-measure in both note 8 and the constant's own doc. So page 20 is the last page that exists:
`SONAR_ISSUE_CEILING = 10 000` findings per project, per pull request.
Twenty sequential requests is also the answer to "cannot hang the panel": the two timed
`issues/search` calls took 615 ms and 788 ms, and the twentieth page is only reached on a project
with more than 9 500 open findings. Recorded as note 8 in [the map](../map.md#the-notes).

**Truncation is admitted in a new `SonarReport.truncated`, not in `failed`.** The two lists
answer different questions: `failed` is "we could not read this project", `truncated` is "these
findings are on your screen and there are more". A project that answers pages 1 and 2 and then
fails belongs in the second — filing it in the first tells a reviewer to disregard findings they
can see. So `loadIssues` no longer throws: it returns its partials with a `shortfall` carrying
Sonar's `total` and the unwrapped error, and `loadSonarReport` decides. Nothing at all →
`failed`, exactly as before. Something, then a failure → `truncated` with the request's own
words. Something, then page 20 → `truncated` with `message: null`, which is what distinguishes
"we backed off" from "that was the end". A 429 still skips the gate call either way, because the
client is closed to every further request and asking would only manufacture a second identical
failure.

The panel says it above the findings — `Showing 10000 of 24312 findings for profisee_matching.`
plus which of the two reasons it was — in ink with an amber mark, because `--pen-amber` is
3.39:1 on this paper: fine for a glyph, short of the 4.5:1 a sentence needs.

**3. The pairing.** One narrow schema extension: `dataDiffId` and `dataDiffType`, by name, on
`pre`. **The names are the whole trap.** `hast-util-sanitize` filters the parsed tree, where the
property is `dataDiffId`, while react-markdown hands the component back the *attribute*,
`data-diff-id` — spell either one the other way and nothing errors, the attributes are simply
gone. Proved with a throwaway probe test that printed the props react-markdown actually passes
(`["data-diff-id","data-diff-type","node","children"]`), then deleted.

A typed pair renders as a captioned block: `pen-green`/`pen-red` at the pen's 1.5px, a
Hugeicons tick or alert, and **`Compliant solution` / `Noncompliant code example` in words** —
those two pens are 4.01:1 and 4.65:1, which is a stroke and not a message, and a "do this, not
this" pair that distinguishes itself only by hue distinguishes itself only for some readers.
`data-diff-id` rides onto a wrapping `div` so a rule with two pairs still says which block
answers which. An unrecognised `data-diff-type` falls through to the plain block. `rehype-raw`
still runs **before** `rehype-sanitize`. `rule-detail.tsx` has two render paths — sectioned and
whole-`html` — and both go through `RuleHtml`, so one schema covers both; there is a test that
says so, because "one change covers both" is only true while that stays the case.

**41 files / 730 tests**, up from 718, `tsc --noEmit` clean. Four call sites needed
`truncated: []` added to a `SonarReport` literal (`sonar-fn.ts`'s `EMPTY_REPORT`, two fixtures
in `pr-detail.test.tsx`, one in `panel.test.tsx`) — the field is required rather than optional
because the server always knows the answer.

---

## T-039 — Notifications

**Type:** feature · **Status:** resolved · **Blocked by:** T-031, T-033

**Success:** while the app is open, four events find me: a build failed · a new comment on my
pull request · someone voted on my pull request · a pull request I am reviewing got new commits.
Each lands in a global slide-over panel with per-item read state, an unread badge, and a sound
that differs by event type with one mute toggle over all of them.

The design constraints, all of which come from something already built or already decided:

- **Detection is a diff between two polls, and it runs where the poll already runs.** `hydrate`
  already caches checks, unresolved count, vote state and merge-readiness per pull request,
  keyed on the head commit; `useCadence` already decides the interval, and already stops
  entirely on a hidden tab. Nothing new polls, and nothing polls faster than it does today.
- **Events are persisted, deduplicated, and idempotent.** A notification that reappears every
  two minutes is worse than one that never fires. Each event has a key derived from what
  happened — not from when it was noticed — so the same comment cannot notify twice, and a
  restart does not replay the backlog.
- **The first poll after a cold start announces nothing.** There is no honest way to tell "new
  since you last looked" from "new to this database", and firing forty sounds on launch is the
  failure mode that gets a feature muted permanently.
- **Sound is opt-in-shaped even though it defaults on:** muted state persists, a sound never
  plays for something I did myself, and the audio is bundled, not fetched.
- SQLite, a new appended migration, and the notification log is exactly the kind of table
  [T-011](./round-1.md#t-011--sqlite) said migrations exist for.

Out of scope and stated so it is not silently attempted: nothing runs while the app is closed,
there are no OS notifications, and there are no service hooks (they need a reachable HTTP
endpoint, which a localhost app has not got).

### Resolution

All four events ship, but they are not detected on the same schedule, and the honest version of
that is worth stating before the parts list. **New commits on a pull request I am reviewing** is
diffed on *every* inbox poll and costs nothing: `PullRequestRow.commitId` is already on the one
cheap list call, so `watch()` compares it against the stored one and says so. **A build failed**,
**a new comment on my pull request** and **someone voted on my pull request** are diffed only on
a *fetched* hydration — a cache miss, which is what a push causes, or an explicit Refresh —
because the signals live in `policy/evaluations` and `threads`, and diffing them on every poll
would restore the 1+3N cost the commit-keyed cache exists to remove. So a vote cast on a quiet
pull request is noticed the next time anything makes that pull request's head commit change or
the user refreshes it, not two minutes later. Nothing was added to the inbox poll, per the
ticket. One signal is genuinely unavailable rather than merely deferred: **other reviewers'
votes cannot come from the list call at all**, because `toRow` drops `reviewers[]` and only
`myVote` survives — the vote event therefore comes from the `VoteUpdate` system threads, which
is a fetched-hydration signal.

Migrations **5 (`notification-log`)** and **6 (`pr-signal`)**, both `STRICT`. `notification` is
the log: `key TEXT PRIMARY KEY` plus kind, pull request, title, detail, project, repository,
`created_at`, `announced_at`, `read_at`. Every key is derived from what happened —
`commits:<pr>:<commit>`, `comment:<pr>:<thread>:<comment>`, `vote:<pr>:<thread>`,
`build:<pr>:<commit>` — and inserts are `ON CONFLICT(key) DO NOTHING`, so dedup is structural
rather than a policy anyone has to remember. `pr_signal` is one row per watched pull request
holding the three watermarks (`comment_at`, `vote_at`, `failed`) and the last commit. Two things
follow from it, and both are the cold-start rule: **`pr_signal` is the watch list**, so
`noteActivity` says nothing at all about a pull request the inbox has never shown — which is what
keeps the detail route silent for a colleague's pull request you merely opened — and each
watermark starts at `UNOBSERVED = -1`, which primes instead of firing. `pr_cache` needed no
migration: detection reads the raw responses, and the cached payload shape is untouched.

Detection is wired into `hydrate()` immediately after `writePrCache`, in a `try`/`catch` that
lets a failed notification cost the panel an entry rather than cost the row its badges, and into
`watch()` on the inbox side. `viewerId` comes from `me()` — the credential — never from the
request body, so a comment or vote of my own is skipped, as are the bots `botIds` already
identifies and every `commentType: 'system'` thread. `role` (author vs reviewer) *is* supplied by
the client, because `PullRequestRow` carries a display name and no author GUID and `inbox.ts` was
not this ticket's file; it is validated to the literal union, and it decides only which events a
pull request is eligible for, never who "me" is.

The panel is built on `react-aria-components` directly rather than on `Dialog`, because `Dialog`
is a centred, zooming `sm:max-w-sm` card and every one of its positioning classes would have had
to be overridden; it reuses `DialogOverlay` (identical dim, blur and dismiss behaviour) and
`DialogTitle`. It mounts as a sibling of `{children}` inside `CommandProvider` in `__root.tsx`,
with no wrapper div, so `b` opens it from the diff as well as the inbox, and a `nav.back` binding
takes Escape off the shell while it is open so dismissing a notification cannot also navigate the
page underneath. Sound is WebAudio synthesis in `src/lib/notify.ts` — bundled by definition,
there is no asset and no request — four distinguishable shapes, one tone per batch (the
highest-priority kind present, so the first poll after lunch does not play four at once), silent
until a real gesture has unlocked the context, and the mute is checked *before* the context is
ever constructed, which the tests assert as `built === 0`. Hydration-detected events reach the
client through `announced_at`: `observeNotifications` claims the un-announced rows once per
inbox poll, keyed on `query.dataUpdatedAt`, so there is no new interval anywhere.

**45 test files, 766 tests, all passing** (from 41 / 718); `tsc --noEmit` clean. The tests
covering the rules the ticket names: cold-start silence in both layers, dedup across a simulated
restart (a real file database, closed and reopened), the viewer's own comment and vote ignored at
either casing while the watermark still advances past them, read state and the badge count, the
migration count bump, mute, and the hydration wiring end to end.

---

## T-040 — The first real write

**Type:** task (HITL — **needs the user, not an agent**) · **Status:** open · **Blocked by:**
T-033, T-034

Eleven write paths will exist when this round lands — reply, start thread, set status, edit,
delete, squash merge, rename, vote, abandon, reactivate, add/remove reviewer — and **not one of
them has ever been sent.** Their response shapes are inferred, their failure modes reasoned
about. Round 4 said this out loud and left it; this round says it again louder, because the
count has doubled.

**Success:** each write path is exercised once against a real pull request the user owns, and
what came back is written down: the status code, the response body's actual shape versus the
inferred one, and whether the follow-up re-read saw the change. A `null` where an object was
expected, or a 200 with a body we cannot parse, is the exact class of bug that no amount of
reading the documentation finds.

This ticket is not an agent's to close. Every pull request in this organisation but the user's
own belongs to a colleague, and the standing rule — no `POST`, `PUT`, `PATCH` or `DELETE`
against a colleague's pull request — has no exception for "just to check". It needs a throwaway
pull request in a repository the user owns, and a person deciding to press the buttons.
