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

**Type:** task (HITL — needs a real credential) · **Status:** open · **Blocked by:** —

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

---

## T-030 — Identity search and avatar inventory

**Type:** task (HITL — needs a real credential) · **Status:** open · **Blocked by:** —

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

**Type:** feature · **Status:** open · **Blocked by:** —

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

**Type:** feature · **Status:** open · **Blocked by:** —

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

---

## T-038 — The three Sonar shortfalls

**Type:** feature · **Status:** open · **Blocked by:** —

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

---

## T-039 — Notifications

**Type:** feature · **Status:** open · **Blocked by:** T-031, T-033

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
