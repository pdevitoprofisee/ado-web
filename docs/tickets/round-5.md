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

**Type:** feature · **Status:** resolved · **Blocked by:** T-029

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

### Resolution

`src/server/checks.ts` (1071 lines) and `src/server/checks-fn.ts` (309) against the frozen
`src/lib/checks-contract.ts` (558). **33 tests** in `checks.test.ts`, all against a local fake
client, no live call of any kind.

| what | shipped |
|---|---|
| the only route to a build | `policy/evaluations` at **`7.1-preview.1`** — 0 of 286 sampled statuses carried a build id, so `pullRequests/{id}/statuses` cannot answer this at all |
| eager, per page | **1 + N**: the evaluations call, then one `build/builds/{id}` per *distinct* build through `fanOut` (up to five build policies on one PR) |
| on demand, per opened row | **5 or 6**: the build again, `timeline`, the `logs` collection, one log, `test/runs?buildUri=…`, and `results?outcomes=Failed&$top=25` **only** for a run whose failure count is non-zero |
| what is cached | timeline · log slice · test runs — keyed `projectId/buildId` plus the section, in a `WeakMap` per `AdoClient`, for `LOG_CACHE_MS` (**1 hour**) |
| what is never cached | the build read itself. It is the validity token, so it is the one call that repeats |
| what invalidates | a completed build only — a running one is not cached at all — and `clearBuildCache` on the way out of either retry |
| log ceiling | `MAX_LOG_BYTES = 1_000_000` on `getBytes`, and at most `LOG_TAIL_LINES` (200) lines ever cross to the browser |

**Eager/on-demand was decided by the byte counts, not by taste.** A timeline is 9.7–69.1 KB and a
failed-test list reached 191 KB on one build, against a page that can hold five build policies —
so a panel that fetched detail eagerly would spend a quarter of a megabyte and thirty calls to
draw a list of five rows nobody has opened. The evaluations call and the build reads are eager
because they are what the *rows* say; everything inside a row is a second read.

**The cache key says why it is still true.** `pr_cache`'s commit-id idiom does not fit a build,
so the condition is the build's own `status`: `completed` is cacheable because a finished
build's timeline, logs and test results can never change again, and anything else is not cached
at all. That is also why the build read is excluded — it is the thing that tells us whether the
rest may be reused.

**Two writes ship unproven**, and no request of any kind was sent to Azure DevOps for this
ticket: `retryBuild` — `PATCH build/builds/{id}` with `{}` and `retry=true` — and `retryStage` —
`PATCH build/builds/{id}/stages/{ref}` with `{ state: 'retry', forceRetryAllJobs }`. Both are
written from Microsoft's reference, both are exercised only against the fake, and the stored PAT
was only ever proved to hold `vso.build` rather than `vso.build_execute`, so **403 is a
realistic first answer**. [T-040](#t-040--the-first-real-write) makes the first live attempt.
The third granularity, requeueing the policy, is `pull-request.ts`' existing `requeueEvaluation`
reused rather than reimplemented — one act, one implementation.

Two things a human should check when the first live retry happens, written down here because
this branch would not probe for them: whether a retry **mints a new build id** (if it does, the
invalidation is right but the row's id is stale until the next evaluations read), and whether
`retry=true` on an *unfinished* build cancels it. The control is disabled for unfinished builds
on the assumption that it might.

---

## T-032 — Checks: the panel

**Type:** feature · **Status:** resolved · **Blocked by:** T-031

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

### Resolution

`src/components/checks/panel.tsx` (304 lines) and `detail.tsx` (525), on `src/lib/checks.ts`
(263) as the query seam. **50 tests**: 7 in `panel.test.tsx`, 24 in `detail.test.tsx`, 19 in
`lib/checks.test.tsx`.

| what | shipped |
|---|---|
| a failed build | its row **arrives open** — the failing step, its log and its failed tests are on screen with no click |
| a passing build | one line, shut, and **never fetched**: `checkDetailQuery` is not called for it at all |
| a running build | opens itself and names the **deepest** `inProgress` record — the sampled in-flight timeline said `inProgress` on four at once (Stage, Phase, Job, Task) and only the innermost one is an answer |
| a queued build | opens and says no step has started yet, rather than "no failing step" about a build that has not had the chance to fail |
| the log | the last **200 lines** in a scrolling `<pre>`, a caption that names the window (`the last 200 of 2727 lines`), and a link to ADO's own log tab when lines were withheld |
| failed tests | failures only, 25 of them, count by subtraction, stack cut at 1200 characters and labelled twice — ours and the 4000 ADO had already cut |
| re-runs | three granularities, each disabled **with a reason beside it** rather than absent; nothing optimistic, every one settles on a re-read |
| polling | only while something is unsettled — `isRunning` asks the policies *and* the builds, because they disagree — and it stops in a hidden tab through `useCadence` |

**"The failing step is on screen without a click" and "opening a row is five ADO calls" are the
two halves that had to be reconciled.** The rule is `opensItself`: `inProgress`, or completed and
not `succeeded`. So the reads happen exactly for the rows that have news, a green pull request
costs the evaluations call plus one build read per policy and nothing else, and the seed is taken
**once** — a poll that turns a running build into a failed one must not reopen a row somebody
just closed.

**The log is a tail plus a link, and not virtualisation.** 200 lines is a `<pre>` the tab does
not notice, so the third option in the non-negotiable ("the tail, virtualized, or both") was not
needed. The honest control for the remainder is a link to `…/_build/results?buildId=N&view=logs`,
because ADO's log viewer pages 2727 lines better than anything this panel could grow, and
because a "load more" here would be a second windowed read of a log the server already caches by
window. The rule for *whether* to offer it is not `lines.length < totalLines` — those two counts
disagree by one on a log nothing was withheld from, since the text form ends in a newline — it
is "was a window applied", which is `truncated` or a full 200-line slice of a longer log.

**No new `ui/` primitive.** The disclosure is this repo's existing idiom — a `<button
type="button">` with `aria-expanded`/`aria-controls` and a conditionally mounted panel, as
`diff/file-diff.tsx`, `diff/file-tree.tsx` and `sonar/panel.tsx` all do — and not a `<details>`
and not RAC's `Disclosure`. Conditional mounting is load-bearing rather than cosmetic here: the
detail's `useQuery` lives inside the panel, so mounting *is* the fetch. Colour is never the only
channel (every row prints its verdict as a word beside the glyph), and the running-step line is
plain text rather than a live region — it re-renders on every poll, and a politeness
announcement every few seconds would talk over the reader it is meant to help.

**The panel is not wired into the page on this branch.** `src/components/pr-detail.tsx` was owned
by another agent for the duration, so `<ChecksPanel prRef={prRef} />` is handed back as a
one-line insertion between the Sonar block and the Conversation section of the details tabpanel.
Until that lands, the component is complete and tested but not on screen.

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

**Type:** feature · **Status:** resolved · **Blocked by:** T-030, T-034

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

### Resolution

**The snapshot, not the live search.** One `GET _apis/graph/users` on `vssps` plus one batched
`GET _apis/identities?subjectDescriptors=` per fifty people (`src/server/identity.ts`), held in
the query cache for half an hour under a single key and filtered in memory
(`src/lib/identity-query.ts`). Eight `GET`s per session at most, and none of them until somebody
types an `@`: the picker is what reads the query, and it does not mount before then.

**Why `POST graph/subjectquery` was rejected**, having read T-030's tables rather than the
summary of them:

1. **It matches a prefix of the whole display name.** Searching `Vincent` returns Jordan Vincent
   zero times, and a picker that cannot find a colleague by surname is one people stop using
   without ever filing a bug. That is a *wrong-answers* problem, not a performance one, and no
   amount of debouncing fixes it. In memory, the same query is a substring match with a ranking
   (`rank`: whole name, then a word inside it, then the mail address) and the surname works.
2. **It is a `POST`, and the only `POST` path in this app is `write()`** — which hardcodes the
   `core` host, and the graph API answers only on `vssps`. Making it work means widening the one
   chokepoint every write goes through, in a round where three other tickets are writing through
   it. The snapshot needs no change to `ado-client.ts` at all: `get(path, params, 'vssps')` and
   `fanOut` were already there.
3. Per-keystroke requests spend the 200-TSTU budget on typing. 344 people is 457 KB *on the
   server*; only the six fields of `ReviewerCandidate` cross to the browser, about 150 bytes a
   person.

What the snapshot costs, said out loud rather than hidden: somebody who joined the org in the
last half hour is not in the list until it goes stale.

**The one-page question, which is the honest weakness.** T-030 read 344 users in one response
with no continuation token anywhere in the body — but the only signal that another page *exists*
is the `x-ms-continuationtoken` **header**, and `AdoClient.get` returns parsed JSON and exposes
no headers. So this route cannot follow the pages, and it does not pretend the count proves
anything: `Directory.complete` is `false` once the response reaches the documented graph page
size of 500, and the picker then prints *"Azure DevOps returned a full page of people, so this
list may be short."* under the list. The same admission covers the other gap — `total` counts
the people the directory listed and `people.length` counts the ones that got as far as an
identity GUID, so a failed crossing batch reads as *"50 of 344 people could not be looked up"*
rather than as fifty colleagues who quietly do not exist. Following the pages properly needs a
transport that can hand back a header; that is written down as note 12 in
[`docs/map.md`](../map.md), and it is a change to a shared file rather than something to smuggle
in here.

**The mention is stored exactly as ADO writes it**, `@<UPPERCASE-GUID>` — T-030's §7, 5 of 5
found live, upper case ×5 — and `insertMention` upper-cases the GUID it was handed, because the
`identities` endpoint answers ids in **lower** case and a lower-cased mention posts with a 200
and renders as literal text. That case is asserted from a deliberately lower-cased fixture in
`composer.test.tsx`. **Still unproven against ADO's own renderer:** no comment was posted from
this branch, and no request of any kind was sent to Azure DevOps for this ticket. The form is
known to be *accepted* because colleagues' comments contain it; that it renders when *we* write
it is the first thing to check the next time a comment is posted for real.

**The keyboard contract**, which is the half the ticket called larger. Keys are offered to
`MentionPickerHandle.keyDown` before the composer's own handler looks at them, and the picker
returns whether it consumed one: `ArrowUp`/`ArrowDown` move the highlight and wrap, without
moving the caret; `Enter` and `Tab` commit and are prevented, so neither inserts a newline nor
takes focus out of the composer; `Escape` closes the list and stops there, so the draft
survives — and it is remembered by the *offset* of the `@` it closed, since dismissing must not
touch the text and the text is what matches. `Ctrl`/`Cmd + Enter` is never consumed, so submit
still submits with the list open. The mouse path prevents its own `mousedown` rather than
handling it, because a blur would close the picker before the click that chose somebody arrived.

**ARIA:** the textarea keeps `role="textbox"` and grows `aria-autocomplete="list"`,
`aria-haspopup="listbox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant` while the
list is open, with a hand-written `role="listbox"`/`role="option"`/`aria-selected` panel beneath
it. Deliberately **not** RAC's `ListBox` or `ComboBox`: RAC's listbox takes DOM focus and moves
it through the options, and the whole point here is that focus never leaves the textarea. And
`role="combobox"` is not put on the field, because every reply box in the app is this component
and a textarea that announces itself as a combobox for the whole time nobody is typing a name is
worse than a textbox that carries `aria-activedescendant` for a moment.

**Handed to T-034**, which is the reason the search is a module and not a hook inside the picker:
`directoryOptions()`/`useDirectory()` own the one cache key (`['identity-directory']`), so a
second consumer pays no second fetch, and `filterPeople(people, query, limit)` is the matching,
with `limit` a parameter because a reviewer field and a mention list have different room.
`ReviewerCandidate` carries `descriptor` and `avatarHref` that this ticket does not need and
T-034 and T-036 do. What is *not* built for it: no debounce, no minimum query length, no
in-flight cancellation — there is nothing per keystroke to debounce or cancel. If T-034 needs
`isContainer`, the `kind` field is already `'user' | 'group'`.

Built ahead of T-034 rather than after it, which inverts the ticket's "reuse T-034's search":
both tickets were open, and the search had to exist before either could use it. **51 files / 930
tests**, up from 48 / 882; `tsc --noEmit` clean.

---

## T-036 — Avatars

**Type:** feature · **Status:** resolved · **Blocked by:** T-030

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

### Resolution

The cheap outcome was available, so the second shape of this ticket does not exist: **no proxy,
no server function, no migration, no cache table, no token anywhere near the feature.** T-030
measured `_apis/GraphProfile/MemberAvatars/{descriptor}` on `dev.azure.com` answering **200 with
the PNG and no auth header at all** — no cookie, no PAT — so the URL goes straight into an
`<img src>` and the browser fetches it unaided. The whole of the server-side change is one field
on two types.

What the ticket did not anticipate is that **`imageUrl` is not one URL shape**, and which shape
you get depends entirely on which object you read it off:

| read from | form | count |
| --- | --- | --- |
| a comment's `author.imageUrl` | `_apis/GraphProfile/MemberAvatars/{descriptor}` | 42 / 42 |
| a reviewer's `imageUrl` | `_api/_common/identityImage?id={guid}` | 30 / 30 |
| `createdBy.imageUrl` on a pull request | `_api/_common/identityImage?id={guid}` | 99 / 99 |

`identityImage` **302s to the sign-in page** without a credential, which in an `<img>` is a
broken glyph. So `imageUrl` rendered on trust works on every comment and breaks on every reviewer
and every author, and the field name tells you nothing — only the URL does. `avatarUrlForm()` in
`avatar.tsx` is therefore an **allowlist** matched on the parsed `URL.pathname`, not on the
string: a substring test accepts `identityImage?redirect=/_apis/GraphProfile/MemberAvatars/x` and
hands the browser the credentialed form anyway. Only `member-avatar` is rendered; `identity-image`,
the third form (`graph/Subjects/{d}/avatars`, which answers JSON with a base64 `value` rather than
image bytes), and anything unrecognised all fall to the monogram.

For a reviewer the loadable URL is recovered from `_links.avatar.href`, which is a
`MemberAvatars` URL and ends in a subject descriptor on **30 of 30** — `vssgp.` ×17, `aad.` ×13 —
where the `descriptor` field itself is present on **0 of 30**. `Reviewer.avatarHref` and
`Person.avatarHref` carry that href and deliberately do not carry `imageUrl`. The author's is read
the same way, optimistically: T-030 read `createdBy.imageUrl` on all 99 and never looked at
`createdBy._links`, so its absence is unmeasured and degrades to initials — the state the author
was already in.

No cache was built, and that is a decision rather than an omission. Sixty comments are sixty
`<img>` elements but not sixty requests: the same person is the same URL string, which the browser
coalesces and revalidates itself, and `loading="lazy"` means the ones below the fold are never
asked for. The payload is a median **522 bytes** on an endpoint that reported
`x-ratelimit-cost: 0`. Anything more would have to be a server function holding bytes — the
credential path this feature just removed. The measured wrinkle, which the ticket could not have
known: `MemberAvatars` answered **anonymously** sends `cache-control: no-cache, no-store,
must-revalidate` where the credentialed call sends `max-age=172800`, so `AVATAR_MAX_AGE_SECONDS`
does not actually apply to the way this loads. Reuse across a reload is not promised; reuse within
a page is, and sixty comments live within a page.

No layout shift, three ways at once: the monogram is *always* in the box and the `<img>` is laid
over it with `absolute inset-0`, size is set at the call site so the box exists before the image
does, and an `onError` that stores the **failed href** rather than a boolean — a boolean would
follow a recycled virtualized row onto the next person and blank out their face too. The element
is `aria-hidden` with `alt=""` at all three call sites, because every one of them writes the
person's name as text immediately beside it.

**896 tests over 49 files**, up from 882 over 48.

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

**Type:** feature · **Status:** resolved · **Blocked by:** —

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

**Parts 1 and 3 first; part 2 afterwards, on its own branch.** The line-level jump needs
`src/lib/diff-rows.ts` and `src/components/diff/diff-view.tsx`, and T-037 was rewriting both at
the same time in another worktree — two agents editing the row model of the same virtualized
list produces a merge, not a feature. So it was deferred rather than attempted, with its success
criteria unchanged, and done once T-037 had landed. Part 2 is below, between the other two.

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

**2. The jump. `scrollToIndex`, because the row is not in the DOM to be found.** A per-line
`getElementById` answers `null` for exactly the jumps that had somewhere to go — the row for line
214 exists only while 214 is one of the ~56 lines currently rendered — and a line inside
collapsed context has no row at all, so a scroll asked for before the reveal lands on the nearest
row that does exist and looks like a success. Recorded as note 13 in [the map](../map.md#the-notes).
`DiffView` therefore grew its first effect that drives the virtualizer, on a `jumped` prop and a
`landed` ref: the ref guards, rather than the effect's deps, because the thread poll reprojects the
rows every thirty seconds and an effect keyed on them would haul the reader back to the finding
every half minute — while a row that only appears later (revealed gap, late bytes) is still
followed. `align: 'center'`, since a finding is read with the lines around it.

What the ref holds is the *request* and not the line, and holding the line was wrong in a way worth
writing down: clicking the same occurrence a second time — ordinary, after reading away from it —
asks for a line that is already marked, and every layer beneath the click correctly answers that
with the object it already had. `jumpToLine` identity-returns, so `jumped` never changes, so an
effect comparing the line sat still. `ChangedFileDiff` counts the requests it answers instead and
passes the count down beside `jumped`; the count is the only thing a repeat click changes. Its
default is `0` rather than `undefined`, because an absent prop has to equal itself across renders or
every render reads as a new jump and the poll drags the reader back after all — which is the bug the
guard exists to prevent, reintroduced through its own default.

**A seventh row-model input, `jumped`, and state would have been wrong rather than merely
fragile.** Note 7's reason applies — the poll rebuilds the model from its inputs and erases
anything held beside them — but the deciding one is that `buildRows` has to *drop* it: new bytes
renumber the file, and a mark recorded against the iteration you were reading would then be drawn
on whatever moved into that line. It is also the only input no row is derived from, so
`jumpToLine` sets it with a spread and hands the view back the same `rows` array — the one place
in that module that does not reproject — because a new array costs a re-measure of the widest line
in a 5,000-line file. When the line is inside a `gap` row it reveals the whole gap first, through
the same `rebuild` the gutter expander uses, and that is one transition rather than two.
`rowIndexForLine` is a linear scan over `rows` for `kind === 'line'` with a matching
`right.newLine` — right side only, because Sonar's `textRange.startLine` is a right-side line and
old 50 is new 52 in any file with an insertion above it. Not an index: indices move under
`attach`, and the scan is nothing beside the render it is about to trigger.

**Both outcomes are said in words, above the panel and inside the anchor.** `ChangedFileDiff`
derives one sentence from the model — `Jumped to line 214.` or `Line 214 is not in this diff.`,
the second one decided by `rowIndexForLine` returning `-1` — into a `role="status"` paragraph that
is mounted empty from the start, because a live region inserted together with its own text is one
several screen readers never announce. Derived rather than remembered, so the poll cannot erase it
and new bytes drop it together with the mark it describes. The mark itself is an outline and not a
border: every code row is exactly 20px and `box-sizing: border-box`, so 1.5px of border would eat
3px of the one line you were sent to look at. Teal at pen weight, and never the only thing that
says so.

**The line has to wait for the bytes.** The page clears its jump as soon as the list has scrolled
to the file, and that scroll is what *starts* the fetch (`enabled: opened || near`), so the panel
latches the line in a `wanted` state and spends it on the first model it has. `pr-detail.tsx`
matches the path once and hands 293 of the 294 panels the `null` that means "not you". A finding
whose line is `null` still jumps to its file exactly as before, and the mark is never drawn.

**48 files / 901 tests**, up from 882, `tsc --noEmit` clean. Two things deliberately not done: a
file left marked read and shut is not forced open by a jump — the sentence sits above the panel,
inside the anchor, so it is still the first thing at the landing point — and focus is not moved,
because taking it off the finding you clicked would cost you the rest of the occurrence list.

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
