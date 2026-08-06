# Round 8 — the review view catches up with the map

Five tickets, all against the one page this application exists for. Four of them are promises
[the destination](../map.md#the-pr-review-view) has made since round 1 and never kept; the fifth
is not on the map at all and is argued for here.

Same conventions: each ticket states **success criteria**, not steps; facts referenced by number
come from [the notes](../map.md#the-notes); every ticket carries a **Type · Status · Blocked by**
line, and a **Resolution** written after it lands.

**The fact that shapes this round: the diff is not one row list, it is a panel per file.** The
destination says "one virtualized row list across **all** files, hunks, comment threads, and
expand-context rows". What shipped is a `<ul>` in `pr-detail.tsx` with one `ChangedFileDiff` per
file, each holding its own `DiffView`, its own `useVirtualizer` and its own scroll container, each
fetching its own blobs when it comes near the viewport. That is a better build than the promise —
294 files do not want one 400,000-row virtualizer, and lazy blobs are why the page opens at all —
but it is not what the map says, and two tickets in this round run straight into the difference.
**T-057 cannot search a file whose bytes have never been fetched**, and **T-056's "next file"
moves the window between panels rather than an index inside one.** Neither is a defect to fix.
Both are a shape to build against, and to say out loud on the page rather than to paper over.

**The second fact: the range compare is already on the wire, and only the question is missing.**
`iterationChangesQuery` takes an arbitrary `(iterationId, compareTo)` pair and validates it —
`compareTo` must be an earlier iteration, because `$compareTo=999` answers **200 with the complete
combined diff** rather than an error (measured on !24766, and written at
`pull-request-fn.ts:114`). What `changes.ts` builds on top of that is two views and no third:
*combined*, and *update k* against `k-1`. There is no way to ask the question a reviewer coming
back to a 39-push pull request actually has, which spans a range and not a push. **The transport
has been able to answer it since round 5. Nothing asks.**

**The third: four of the five want a control in the same place**, the toolbar above the file list
where `LayoutToggle` sits. That is one region of one 2,470-line file, so the round is deliberately
sequenced rather than fanned out flat — see the resolutions for what actually collided.

**What this round is not.** **No write is bound to a key.** T-056 puts navigation and the *viewed*
mark on the keyboard and stops there: a vote is a `PUT` that note 10 already calls the one write
with no server-side guard behind it, and a stray keystroke that approves a colleague's pull
request is not a bug you can apologise your way out of. **No cross-file search over unfetched
bytes** — T-057 states its blind spot rather than fetching 294 files to close it. **No new differ**
— T-054 is a flag through the one that exists, not a second path. **No change to the jump
machinery** — note 13 says `scrollToIndex` after `expandGap` is the only thing that works, and
every ticket here that moves the viewport goes through the same code the Sonar jump does. And
**nothing in this round sends a request ADO has not already been sent**, so unlike round 7 there is
no HITL ticket in it.

---

## T-053 — Changes since my last review

**Type:** feature · **Status:** resolved · **Blocked by:** —

The map has promised this since round 1: "**Changes since my last review** via iteration
comparison (`$compareTo`)". What exists is `ChangeView` in `src/lib/changes.ts` — `combined`, or
`update k` compared against `k-1`.

On the pull request this app measures itself against, that is the wrong instrument. !24766 has 39
iterations. A reviewer who approved at iteration 12 and came back to find 27 more pushes wants the
27 as one diff. "Update 37" is a question nobody asked, and reading 27 updates in turn re-reads
every file that was touched twice.

The comparison itself is a solved problem — `iterationChangesQuery` already takes the pair and
already refuses a `compareTo` that is not earlier. **The unsolved part is which iteration "my last
review" names**, and it has to be derived, because ADO does not store it: `reviewers[].vote`
carries a vote and no timestamp.

The materials are already fetched. Iterations carry `createdAt` (`pull-request.ts:1194`). Threads
carry `publishedDate` and an author (`threads.ts:305`), and system threads — 32 of 56 in the live
sample — are ADO's own vote trail and are retained with `kind: 'system'` rather than dropped. So
"when did I last look at this" is answerable from data on the page, and the iteration is the newest
one created no later than that.

**Success:** a third view alongside combined and update, which compares the iteration that was head
when I last reviewed against the head iteration now, and reads as one diff.

- **The basis is stated on the page, not inferred silently.** "Since your approval on 3 August"
  and "Since your comment on 3 August" are different sentences and the reader is told which one
  applies. A derivation that cannot find a vote *or* a comment by me is not a wrong date — it is
  the option being **unavailable with a reason given**, and a reviewer who has never touched this
  pull request is the ordinary case for that.
- **Nothing new since I looked is its own answer.** If my last review is already at head, the view
  says so in words rather than rendering an empty file list, which reads as a failure.
- The range is a real `(iterationId, compareTo)` pair against the server function that exists. No
  second endpoint, no client-side subtraction of one update from another, and the existing
  validation is not loosened.
- The two facts `changes.ts` already documents survive: a combined diff and the union of the
  updates **do not agree** (294 files against 299 on !24766, six reverted and one from the target
  branch moving), and an iteration is immutable, so a range answer is cacheable the way an update
  answer is.
- The failure and pending arms are the ones already written — an empty list under a heading that
  names a range is the same wrong answer the update view exists to avoid, and is guarded the same
  way.

### Resolution

Built, on branch `t-053-last-review`. Changed: `src/lib/changes.ts`, `src/lib/comment-contract.ts`,
`src/lib/conversation.ts`, `src/server/threads.ts`, `src/components/pr-detail.tsx`. New:
`src/lib/changes.test.ts` with 20 tests. **1,433 tests across 74 files pass**, up from 1,401 across
73 — 20 new in `changes.test.ts`, 5 in `threads.test.ts`, 7 in `pr-detail.test.tsx`. `tsc --noEmit`
is clean.

**The ticket's premise about system threads is wrong, and the derivation nearly had no materials.**
It says the 32-of-56 vote trail is "retained with `kind: 'system'` rather than dropped".
`toThreadList` does the opposite: `if (thread.kind === 'system') { systemCount += 1; continue }` —
it counts them and drops them, and `Conversation.threads` documents itself as "Bot and system
threads are already out". So the only dated record of a vote in the whole payload was being parsed
and thrown away one line before it could be read. Un-dropping the threads would have put ADO's
activity trail into the conversation and into the diff, which is a regression against T-022's own
decision. Instead `voteEvent()` reads the two properties while the thread is being counted and
`ThreadList` gained `votes: readonly VoteEvent[]` — a list of dates, not threads. That is additive,
so nothing that reads `threads` changed.

**The vote trail does carry what was needed.** `CodeReviewThreadType === 'VoteUpdate'`, voter in
`comments[0].author.id`, value in `properties.CodeReviewVoteResult`, date on the thread's
`publishedDate`. A comment by me is the fallback and it is a real signal rather than a consolation:
on a pull request nobody has voted on there is no trail at all, and someone who left a remark has
read the code. Whichever of the two is later wins; a vote wins a tie, because ADO writes the vote
thread as the vote is cast, so the two coinciding means I voted on my own comment.

**A vote of `0` is discarded.** It is the *absence* of a vote — ADO writes one when a push resets an
approval — so keeping it would date "my last review" to the push that cancelled it, which is the
worst available answer: a range that starts after the change the reviewer most needs to see.

**Undated iterations are a refusal, not a fallback.** If no iteration has a parseable `createdAt`,
`compareTo` would fall out of the walk as `0`, and `0` against head is a *legal* pair that answers
the complete combined diff. Under a heading that says "since your approval" that is the same
undetectable wrong answer as `$compareTo=999`, arrived at from the other side, so it returns `none`
with a reason instead. A range that reviewed before the first push does legitimately compare against
`0`, and that case is kept.

**The tab is offered even when it has nothing to show.** `none` and `current` are each a sentence in
place of the file list — "You have not voted or commented here…", "Nothing has been pushed since
your approval on 20 July…" — and neither sends a request. A disabled tab is a reason nobody reads
and an absent tab is a reason nobody is given. It is hidden only on a single-update pull request,
where "By update" is hidden for the same reason.

**Two refactors the feature forced, both small.** `viewRange(view)` is now exported from
`changes.ts`: the `compareTo: id - 1` arithmetic and the pair the thread composer anchors against
were two copies of the same rule in two files, and a third view would have made them three.
`ChangedFiles` took a `scope: ChangeScope` in place of `update: ReactNode | null`, because the
pending, failed and empty sentences all had "this update's changes" hard-coded into them and a
range under an update's wording is exactly the mislabelling this view exists to prevent.

**Unverified.** Nothing here has been run against a live Azure DevOps instance. The vote-trail
shape is taken from T-022's census and from the two existing consumers that already read the same
two properties (`hydrate.ts` for the inbox's approval-reset mark, `notifications.ts` for the
timeline), not from a fresh capture. Every `CodeReviewVoteResult` in this repository — in
`hydrate.test.ts`, `notifications.test.ts` and now `threads.test.ts` — is a fixture somebody wrote,
including the vote integers here; the pre-existing `systemThread()` fixture carried the `VoteUpdate`
type and no vote result at all. Three consumers agreeing about a shape is not the same as having
seen it. The 39-iteration case on !24766 is reasoned about and not exercised. Date formatting is
`toLocaleDateString('en-GB', …)` in the browser's own zone, so a reviewer who voted late in the
evening may see the following day's date; the tests use midday UTC stamps to stay off that edge
rather than proving it right. And the derivation cannot see a review left in ADO's web UI that
produced neither a vote nor a comment — there is nothing in the payload that records one.

---

## T-054 — Ignore whitespace

**Type:** feature · **Status:** resolved · **Blocked by:** —

`src/lib/diff.ts:22` lists what the differ deliberately does not implement, and `-b`/`-w` is on
that list. The map lists an "ignore-whitespace toggle" as shipped behaviour of the review view. One
of the two is wrong, and it is the map.

This is the toggle that makes a re-indent reviewable. Without it a formatter run over a file is a
diff in which every line changed and no line changed, and the only way through is to trust the
commit message.

The differ is git's, ported: `intern` maps line text to a dense integer and every loop below it
compares integers (`diff.ts:134`). That is also exactly where git applies the flag — the
normalisation belongs in the key, not in a pass over the output.

**Success:** a toggle on the review view, and on the two local diff pages that hold the same
`LayoutToggle`, that re-renders the diff with whitespace ignored.

- **`-w` semantics — all whitespace ignored**, not `-b`. One flag, because two is a menu, and the
  re-indent case is the one being solved.
- The normalisation is in the interning key. The **rendered text is untouched**: a line that is
  context under `-w` still draws the bytes that are in the file, and which side those bytes come
  from is a decision the ticket makes explicitly and a test pins, because the two sides differ by
  definition on exactly these lines.
- The existing `identical` fast path, the discard heuristics, the indent-heuristic sliding and the
  intra-line marking all still run and still agree with git. `diff.test.ts` already cross-checks
  this differ against real `git` over this repository's own history; **the flag is checked the same
  way, against `git diff -w`, and not against a hand-written fixture** — note 14's lesson about
  fixtures that agree with your own misunderstanding.
- Flipping the toggle does not re-fetch a blob. The bytes are content-addressed and already in
  hand; this is a re-diff, and on a large file it is the only cost.
- The toggle reads as one control for the page, like `LayoutToggle`, and where it is drawn is the
  same place for all three pages that have one.

### Resolution

One commit on `t-054-ignore-whitespace`, not pushed. New: `src/components/diff/whitespace-toggle.tsx`
and `src/lib/diff-whitespace.test.ts`. Changed: `src/lib/diff.ts`, `src/components/diff/changed-file.tsx`,
`src/components/branch-diff.tsx`, `src/components/commit-diff.tsx`, `src/components/pr-detail.tsx`
and the five test files beside them. No new dependency.

`DiffOptions` gained `ignoreWhitespace`, and in the differ it reaches exactly two places. `intern`
takes a key function — `asWritten`, or `squeezed` under the flag — and everything below it goes on
comparing integers: the discard heuristics, `compact`'s sliding and its indent heuristic, and the
`identical` fast path were not touched and none of them needed to be. A pair that differs only in
whitespace falls through `identical`, interns to the same ids, and produces zero hunks, which is
what git prints for it.

**git prints the *after* side, and the premise this was started on said the opposite.** The ticket
asked for the decision to be made explicitly; the decision turned out to be a measurement. `git
diff -w` on a re-indented file was run in both directions and read through `cat -A` on
2.55.0.windows.3: a context line whose two sides differ only in whitespace draws the postimage
bytes. Coming in, the recollection was that xdiff's `xdl_emit_diff` walks `xdf1` and therefore
prints the preimage, and that recollection was carried far enough to be about to write `before[p1]`
into `emit`. Whatever that C does on the way, the bytes that come out are the after side's. There
is a second, independent reason to want the same answer, found afterwards rather than before:
`buildRows` is handed the **after** side's `lines` and reads them when the reader expands a
collapsed gap, so emitting from `before` would have made a revealed context line and a printed one
disagree on the same file.

**The intra-line marks were a bug the ticket did not name, and the first test written for them
asserted the wrong thing.** `markPair` interns raw tokens, so under `-w` the indent token is a
changed token like any other and got a highlight — the flag switched on to stop showing a re-indent
was handing the re-indent back, one word at a time, on every line that also held a real edit. It
was written as a test claiming the old behaviour was fine, and the test failed. `markPair` now
takes the flag and clears the change bit on tokens that are only whitespace, reusing `squeezed`
rather than `trim` so that one definition decides both what a changed line is and what a changed
word is. This has no analogue in `git diff` output, so the oracle cannot rule on it; it is pinned
by a pair of tests, one with the flag and one without.

**`\s` is not `isspace`.** xdiff's `XDL_ISSPACE` is C's, over bytes: space, tab, and the four
vertical ones. JavaScript's `\s` also matches the Unicode separators, so a key built on it would
call a line that gained a non-breaking space unchanged, where git calls it a change. The character
class is written out. A fixture pasted from a real `git diff -w` run pins it, spelling the
non-breaking space as an escape so a trim-on-save cannot silently delete the only thing it asks
about.

The proof is `diff-whitespace.test.ts`: four of this repository's own source files, five
formatter-shaped mutations each — re-indent, tabs, trailing whitespace, and two of those with three
real edits buried in them — diffed by git at test time and compared with ours, **with the flag and
without it**, twenty-one tests and about forty process starts for two seconds. It passed on its
first run, which is not evidence of anything, so `emit` was reverted to `before[p1]` on purpose to
watch it fail. It failed **4 of 21** — because two corpus files were short enough that fixed-index
edits fell off the end and `src/lib/utils.ts` was too small to re-indent interestingly. Placing the
edits by fraction and swapping in `changed-file.tsx` took the same deliberate break to **9 of 21**.
The difference between those two numbers is the whole value of breaking it.

`WhitespaceToggle` is one component and all three pages render it, each with its own test, because
the way "one control" stops being true is a page that never draws it. **The state is local to the
three page components and not owned by the routes, which is a reversal.** It was first written as
props threaded up to the routes beside `layout`; `pr-detail.tsx` already states the rule that says
not to — the route owns the layout because side-by-side widens the page, and `chosen` and `hideDone`
are local because they change nothing about the page's shape. `-w` changes nothing about its shape
either. No route file was touched.

Flipping it re-diffs and fetches nothing: `changed-file.tsx` tracks the flag beside the blobs and
rebuilds the model when either moves, and a test holds one `QueryClient` across a rerender, flips
the toggle both ways, and asserts the blob call stayed at one. It cannot be a reprojection the way
`setLayout` is, because the hunks themselves come out different — so a gap the reader had expanded
does not survive the flip. That is a real if small loss, and it is the honest one: those gaps were
about hunks that no longer exist.

32 new tests across 6 files, **1,433 in the suite over 74 files**, `tsc --noEmit` clean.

**Worth a note, if the map wants one.** When a flag makes two representations of the same thing
differ, *which one the tool prints* is a measurement and not something to be derived from having
read its source. The belief here came from the right file in xdiff and was still wrong, and it
would have produced a diff that renders, passes every count assertion, and quietly shows the wrong
bytes on exactly the lines the flag was turned on for. It is note 14's lesson one step further
along: a fixture confirms your misunderstanding, and so does a memory of the implementation.

Unproven: nobody has looked at the toggle in a browser — the pressed styling is `LayoutToggle`'s,
read rather than seen, and no one has checked the toolbar's three controls on a narrow window. The
corpus is four files of this repository under five mutations, all ASCII whitespace and all `\n`; no
file whose committed bytes contain CRLF went through the sweep, and the non-breaking-space case is
a pasted fixture from one git run rather than part of it. The intra-line behaviour under `-w` has
no oracle at all. `-b` is still on `diff.ts`'s list of what is not implemented, deliberately. And
the choice is per visit and remembered nowhere: a formatter run is a fact about the change in front
of you, but nobody has said whether they would rather it stuck.

---

## T-055 — Copy permalink, and open the line in ADO

**Type:** feature · **Status:** resolved · **Blocked by:** —

Two verbs the destination names — "copy-permalink, open-line-in-web" — and neither string appears
anywhere in `src/`. They are how a finding leaves this application: a reviewer reads a line here
and then has to put it in a message to somebody who is not running this application.

**Success:** from a line in the diff, a link to that line copied to the clipboard, and that line
opened in the Azure DevOps web UI.

- The in-app permalink resolves **to the line**, not to the file. It goes through the machinery
  that already exists — `fileAnchor` for the panel, and the `jumped`/`arrival` pair that the Sonar
  jump spends — and reopening one in a fresh tab lands on the row with the row marked. Note 13 is
  the whole reason this is a reuse and not a `getElementById`.
- **A jump into collapsed context expands it first.** A permalink to a line inside a gap that
  scrolls to the nearest rendered row is the failure mode note 13(b) names: it looks like it
  worked.
- The ADO URL is **verified against a real pull request before it is written down**, and the
  verification is a `GET` in a browser, not a guess from the shape of another URL. Where the app
  already builds a `webUrl` it reuses it rather than re-deriving the org and project.
- **On the local pages there is no web to open.** `/repos/$repo` and the commit pages have no ADO
  address and never will — the copy verb still works there because the app's own URL is real, and
  the open verb is **absent rather than present and dead**. A button that opens nothing is worse
  than no button.
- Copying reports that it copied. Clipboard writes fail — permissions, an insecure origin, a
  browser that will not — and a silent failure here is indistinguishable from success until the
  paste.

### Resolution

One commit on `t-055-permalink`, not pushed. New: `src/lib/line-link.ts` with `src/lib/line-link.test.ts`,
and `src/lib/ado-line-url.ts` with no test at all, deliberately — see the last paragraph. Changed:
`src/lib/file-anchor.ts`, `src/components/sonar/panel.tsx`, `src/components/diff/diff-view.tsx`,
`src/components/diff/file-diff.tsx`, `src/components/diff/changed-file.tsx`,
`src/components/pr-detail.tsx`, `src/components/branch-diff.tsx`, `src/components/commit-diff.tsx`,
`src/routes/pr.$projectId.$repositoryId.$prId.tsx`, and two test files beside them. No new
dependency; both icons are hugeicons the app already ships.

**The permalink is a fragment, `#path=%2Fsrc%2Flog.ts&line=214`, and the two names are ADO's own.**
Three routes show a diff, so a search param would have to be declared on three separate
`validateSearch`es to survive the router — three places to forget, and a fourth diff page later
would be a fifth. A fragment belongs to no route and the router never touches it. It is written and
read through `URLSearchParams` at both ends, which is the only reason a path with a space in it
survives: form encoding turns it into `+`, and anything that decoded the fragment by another rule
would hand back a filename nobody has. Everything before the `#` is kept, so a link copied on the
branch compare still carries the `?target=` that says which two commits are being read.

**This does not contradict `file-anchor.ts`'s refusal to be an `href="#…"`.** That refusal is about
the app writing hashes into its own URL while you scroll, which fills the back button with positions
nobody chose to keep. Nothing here navigates — the string is built for the clipboard and read back
on exactly one load, the one where a fresh tab was opened on somebody else's link.

**Arriving is the Sonar jump, seeded from the URL, and that is the whole of the wiring.** On the
pull request page `readLineTarget()` is the initial value of the existing `jump` state and of the
route's `tab`, so a permalink opens on the diff rather than on details. Everything under that is
untouched: the page scrolls to the panel, the panel holds the line until its bytes land, `jumpToLine`
opens the gap the line was hiding in, and `jumped`/`arrival` carry it to `scrollToIndex`. So
"expands collapsed context first" is not new code — it is the reason this was built as a reuse, and
`changed-file.test.tsx`'s existing test for it covers permalinks by construction. The two local
pages get the same shape packaged as `useLineTarget(ready)`, which waits for the file list to be on
screen before spending its one chance to scroll, and forgets the target the moment it has acted.

**`scrollToFile(path)` moved into `file-anchor.ts`** because it now has two callers. It was three
lines inside `scrollToFinding`, and a permalink arrives by the same route; both optional chains are
load-bearing and the doc comment says which.

**The open-in-ADO link is absent on the local pages by not being given anything to build from.**
`ChangedFileDiff` takes `webUrl`, and `branch-diff.tsx` and `commit-diff.tsx` simply do not pass it —
the same withholding that already takes the compose buttons off those rows. `adoLineUrl` is then
`undefined` and `LineActions` renders no anchor. There is nothing to disable and nothing to hide.
The copy verb is on every row on all three pages, because the app's own URL is real everywhere.

**Copying reports itself in words, in the live region the file already has.** Per file, not per row:
5,000 rows each holding their own `null` answer to a question one of them was ever asked is 5,000
copies of nothing. The sentence names the line — "Copied a link to line 214." — because "Copied"
over a file does not say which. It holds for two seconds and then hands the region back to whatever
the jump had said. Both failures say "Could not copy a link to line 214.": a missing
`navigator.clipboard`, which is what a plain-http LAN address gets because the API is gated on a
secure context, and a rejected `writeText`. Same check `CopyBranch` makes, for the same reason.

`pnpm test` is 1482 passing across 76 files, up from 1465 across 75, and `pnpm tsc --noEmit` is
clean. The new tests are the fragment round trip and everything malformed that has to answer `null`;
the four clipboard outcomes; the link being present with a `webUrl` and absent without one; and, in
`commit-diff.test.tsx`, that a page opened on a permalink scrolls to the panel the path names.

**What a reviewer should check by eye.** Three small buttons now sit in the gutter of every row, and
they only appear on hover — whether three is one too many at 16px each, on a row that already has a
line number, is a judgement no test makes. The live region is above the panel and inside the anchor,
so the copy sentence appears at the top of the file rather than beside the line that was copied; that
is where the jump sentence already was, and whether it is far enough from the pointer to go unread is
worth watching. Two seconds is a guess at how long it should stay.

**Unproven, and it is the ADO URL.** `src/lib/ado-line-url.ts` is one function and it is the only
guessed address in the application — every other link out is a field ADO handed us. Nobody has
opened one in a browser, and there is no test over its shape, on purpose: a test asserting the guess
against itself would pass and then read to the next person as evidence. For pull request 24698 in
`profisee/SaaS/_git/platform`, at line 214 of `/src/log.ts`, it produces:

```
https://dev.azure.com/profisee/SaaS/_git/platform/pullrequest/24698?_a=files&path=%2Fsrc%2Flog.ts&line=214&lineEnd=215&lineStartColumn=1&lineEndColumn=1&lineStyle=plain
```

Paste that into a browser signed in to the organisation. It should open the Files tab of that pull
request with line 214 of that file selected. If it opens the overview, `_a=files` is wrong; if it
opens the file at the top, the `line` family is wrong or is spelled differently. Either way that
function is the whole of what has to change. The rest of this ticket was verified: the tests above
ran, and `pnpm tsc --noEmit` is clean. Nothing on any of the three pages has been looked at in a
browser.

---

## T-056 — The review view on the keyboard

**Type:** feature · **Status:** open · **Blocked by:** —

The destination's first sentence is "a dense, **keyboard-driven** PR review client". T-009 built
the machinery for that in round 1 — one keydown listener, a declared registry, `useCommand` for a
surface to claim a key, a generated `?` sheet that dims what nothing is listening for, and a
text-entry guard that knows React Aria's widgets.

Eight commands are declared. The three list pages claim `j`/`k`/`Enter`. **The review view claims
exactly one — `nav.back`.** The page the application is for is the one page you cannot drive.

**Success:** reading a pull request end to end without the mouse.

- **Next and previous file**, which moves between panels and not within one. Per the round header
  the files are separate scroll containers, so this is a window move, and a file that has not
  fetched its bytes yet is a destination like any other — arriving is what makes it fetch.
- **Next and previous unresolved thread**, which is the reviewer's real traversal — `active` and
  `pending` are open (the map's word), everything else is done, and a `hideDone` page does not
  navigate to what it is not drawing.
- **Toggle viewed on the file in front of me.** This is the one state-changing key in the round and
  it is here because it is local, reversible, already keyed on a blob sha, and is pressed once per
  file on a 294-file review.
- **Next and previous Sonar finding**, using the jump the panel already exposes rather than a
  second path into the diff.
- Every one of these goes through `useCommand` and appears in the `?` sheet by construction. A key
  declared and not claimed dims — that is T-009's design and it is the acceptance test for
  "declared where it belongs".
- The text-entry guard holds. `j` inside the comment composer is the letter `j`, and the composer
  is a React Aria widget inside a virtualized row, which is the case the guard was written for.
- **No write is bound to a key.** No vote, no merge, no resolve, no abandon. Note 10: a vote is a
  `PUT` that ADO does not re-judge and that *adds a reviewer* when it is addressed to somebody who
  is not one, and `castVote`'s re-read is the only guard in the system. Nothing that costs that
  much goes behind a single keystroke.

---

## T-057 — Find in the diff

**Type:** feature · **Status:** resolved · **Blocked by:** —

Not on the map. The argument for it is note 13 wearing a different hat.

The diff is virtualized, so about 56 rows of a file are in the document at any moment. `Ctrl+F` —
the reflex, and the thing every reviewer will try first — searches those 56 and reports **"not
found"** for the other three thousand. It does not fail; it answers confidently and wrongly, which
is the failure mode this project's notes are almost entirely about. On a 294-file change it is the
gesture you reach for hourly.

**Success:** a search over the diff that finds matches the browser cannot, and is honest about the
ones it cannot reach either.

- Matches are found across **every row of every panel whose bytes are loaded** — both sides,
  context and changed lines alike — and stepping through them moves the viewport to each in turn
  through the existing jump machinery, expanding collapsed context on the way (note 13 again).
- **The blind spot is stated, not hidden.** A panel that has never come near the viewport has no
  bytes, and a search cannot see into it. The count says so in words — the number of files not
  searched, next to the number of matches — because "3 matches" over a 294-file change, when 280
  of those files were never read, is a lie the reader has no way to detect. Whether arriving at a
  file should fetch it is a design decision the ticket makes and records; silently reporting a
  partial count is not one of the options.
- A match is visible when you land on it — marked in the row, alongside whatever the intra-line
  edit marking and the Shiki tokens are already drawing on that line. Those three are the reason
  this is not a `String.indexOf` and a `<mark>`.
- It is on the keyboard, and it declares its key in the registry like everything else (T-056).
  Escape leaves, and leaving does not lose the reader's place.
- Searching does not re-tokenize, re-fetch or re-diff anything. The row model and the blobs are
  already in hand; a search that costs a worker round-trip per keystroke is a search nobody will
  leave open.

### Resolution

Built, on branch `t-057-find-in-diff`. New: `src/lib/diff-find.ts`,
`src/components/diff/find-bar.tsx`, `src/lib/diff-find.test.ts` (16 tests),
`src/components/diff/find-bar.test.tsx` (13). Changed: `src/components/diff/line-text.tsx`,
`diff-view.tsx`, `file-diff.tsx`, `changed-file.tsx`, `src/commands/registry.ts`,
`src/components/pr-detail.tsx`. **1,467 tests across 76 files pass**, up from 1,433 across 74 — 16
and 13 in the two new files, 4 in `line-text.test.tsx`, 1 in `pr-detail.test.tsx`. `tsc --noEmit` is
clean.

**The map's "one virtualized row list across all files" is not what is there, and that is what
shaped this.** `pr-detail.tsx` renders a `<ul>` of panels and each panel owns its own virtualizer,
its own scroll container and its own lazily-fetched blobs; nothing upstream holds a row. So the
search does not read rows at all. It reads the **query cache**, through
`diffSource.blobsOptions(file)` — the same object the panels fetch with, so the ADO key stays
spelled once in `blob-query.ts` — and takes `blobs.after.lines` per file. That is the only honest
register of what has been loaded: the DOM knows about 56 rows per open panel and panel state does
not report upwards.

**It counts and says; it does not fetch.** That is the design decision the ticket asked to be made
and recorded. Fetching on arrival would turn a keystroke into 294 requests against a service this
app is careful with, and fetching only the file being stepped into would make the *count* — the
number the reader is deciding on — still wrong, just wrong later. So the sentence beside the box is
always two halves from one function: `3 matching lines · 280 of 294 files not searched`, or `… · 14
files searched` when there is no blind spot. "No matching lines" keeps the second half, because that
is the answer most likely to be believed and least likely to be true.

**It searches the after side only, which is narrower than the ticket asked for.** The ticket says
both sides. Every piece of the jump machinery — `rowIndexForLine`, `jumpToLine`, `DiffView.jumped` —
addresses a right-hand line number and only a right-hand line number, and this round was told to
change none of it. A hit on a removed line would have nothing to scroll to. Removed lines are still
*marked* where the term appears on them, since `LineText` draws both columns, but they are not
counted and not steppable. The box's accessible name says so in words rather than leaving the reader
to infer it from a count that seems low.

**A hit is a line, not an occurrence**, so the total printed is exactly the number of stops the Next
button has. Three matches on one line is one stop; all three are marked when you get there.

**The term is a prop the whole way down, never state in the diff.** Note 7: the thread poll rebuilds
a panel's row model from its inputs every thirty seconds, and anything living inside would go with
it. `find` threads `ChangedFiles` → `ChangedFileDiff` → `FileDiffPanel` → `DiffView` → `Row` →
`Cell` → `LineText`, alongside `jumped`, which is there for the same reason.

**Marking it needed the third segmentation, not a `<mark>`.** `segment()` already cut a line on two
disagreeing boundary sets — Shiki's tokens and the intra-line edit ranges — and flattened them,
because neither nests inside the other. Search hits are a third set that agrees with neither, so
they join the same boundary union and each piece now carries `found` as well as `edited`. Where a
hit and an edit overlap the hit wins the background: the edit marking is on every changed line and
the match is on the few lines somebody asked about. The fast path that renders an unhighlighted,
unedited line as a bare text node — a span per line is a span per line times five thousand —
survives an open box for lines the term is not on.

**The key is `/`, not `Ctrl+F`.** The command layer ignores every key pressed with Ctrl, Meta or
Alt, on purpose, so `Ctrl+F` cannot be registered there. It should not be anyway: this search cannot
see into unfetched files, and taking the browser's own find away would be a promise it cannot keep —
a reviewer who wants the 56 rows in front of them searched exactly should still get them. `/` is
declared in the registry and appears in the `?` sheet like everything else. Escape is handled on the
input rather than as a command, because the command layer refuses keys typed into a text field:
first press clears, second gives the keyboard back, the order `InboxControls` settled on. The
reader's scroll position is untouched by either.

**Stepping reuses the jump machinery without changing it.** `ChangedFiles` holds a second transient
jump beside the Sonar one — set, acted on, cleared by an effect — and passes `sent ?? jump` down as
`jumpTo`. Separate from the Sonar jump because that one is cleared by an effect that only runs on
the combined tab, and because clearing on arrival is what lets the same match be stepped to twice.
`jumpToLine` already expands a collapsed gap containing the target line before `scrollToIndex` runs,
so the note-13 path is the existing one.

**The box is above the file tree and the panels, not in the toolbar.** It acts on all of them, the
argument `InboxControls` already makes for one search box over two sections — and it keeps this
ticket's diff out of the toolbar region T-054 is editing on another branch. The cost is
discoverability: there is no toolbar affordance, so it rests on the always-visible box and the `?`
sheet. Worth a second opinion once both branches have landed.

**Reactivity to bytes arriving mid-search** is a cache subscription that bumps a counter when a
watched key succeeds, live only while the term is non-empty — a subscription that ran all the time
would wake on every poll for the life of the page. Files are keyed by a `path@objectId` fingerprint
rather than by array identity, the same trick `useWarmDiff` plays on the same list, because the poll
hands down a fresh array for a diff that has not moved.

**A reviewer should check by eye:** the amber hit background against `diff-add` and `diff-delete`
rows, in both themes, and against the `bg-diff-word` it displaces — these are adjacent tints and the
contrast has only been reasoned about. That stepping into a file far down a 294-file list actually
lands on the line, since the panel may still be measuring when the jump arrives. And whether the
count updating as panels scroll into view reads as helpful or as jitter.

**Unverified.** Nothing here has been run in a browser. jsdom has no layout, so no real
`scrollToIndex` or gap expansion has been exercised end to end — the tests prove the hit list and
the callback, not the scroll. Nothing has been run against a live Azure DevOps instance or against a
change set anywhere near 294 files; the performance claim is that the search is `indexOf` over
arrays already in memory, not a measurement. **One known limitation:** a file marked viewed renders
its panel collapsed but can still have cached bytes, so a hit inside one is jumped to at the panel
level and the line itself is not revealed — `FileDiffPanel` owns its open state internally and
making it controlled was judged outside this ticket. And the `İ`-style case-folding fallback in
`matchRanges` is exercised by a unit test and has not been tried against real source in a non-Latin
script.
