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

**Not verified:** the work item and label payload shapes (both empty on the sampled PR); the
`votedFor[]` shape on a person who voted for a container (no non-zero votes on this PR);
whether `changeEntries` paging suffers the same *short-page-is-not-the-last-page* trap as
the PR list (note 6 of round 1); the full `changeType` value set beyond `add`/`edit`.
A supplementary probe against a conflicted PR, a voted-on PR, and the largest PR in the org
is recorded in [`docs/research/pr-detail-inventory.md`](../research/pr-detail-inventory.md).

**Surfaced for T-012:** four calls cover this page — detail, evaluations, commits, changes —
and `iterations` is a fifth only because `changes` needs an iteration id.

---

## T-012 — PR detail server layer

**Type:** feature · **Status:** open · **Blocked by:** T-011 (resolved)

Assemble one pull request into [`PullRequestDetail`](../../src/server/pull-request.ts). The
type contract is already committed; this ticket fills in the function behind it and the
server function that exposes it.

**Success:**

- `loadPullRequest(client, ref)` returns a fully populated `PullRequestDetail` against the
  live org, and the page's whole data need is met in **five ADO calls or fewer**.
- The calls that do not depend on each other are issued through `client.fanOut`, not
  awaited in sequence.
- A failure in any *one* of commits, evaluations, or changes degrades that section rather
  than emptying the page. The header and conflict state come from the detail call and are
  the only hard dependency.
- `changeType` is parsed as the comma-separated `[Flags]` set it is, never string-compared.
- The file list either is complete or reports itself `truncated`. It does not silently stop
  at one page, and it does not trust `nextTop`.
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

---

## T-013 — PR detail UI

**Type:** feature · **Status:** open · **Blocked by:** T-012

The reading surface. Presentational only — it takes a `PullRequestDetail` and renders it.

**Success:**

- Header: title, `!id`, author, age, draft state, and `source → target` branches.
- The description renders in full, and is visibly the full text rather than the inbox's
  400-character truncation.
- **Conflict state is stated loudly** when it exists — the map's word. A conflicted PR
  should be unmissable above the fold, and a PR that merely has not been merge-tested yet
  must not be dressed up as one.
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

**Deliberately not in scope:** labels, work items, and the activity trail. The map lists
them alongside the diff, but T-011 could not verify either payload's shape on live data, and
this round does not guess at a shape it has never seen.

---

## T-014 — Open the detail page from the inbox

**Type:** feature · **Status:** open · **Blocked by:** T-013

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
