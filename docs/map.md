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

### Notifications

In-app only, while the app is open. Events: build failed · new comment on my PR ·
someone voted on my PR · a PR I'm reviewing got new commits.

A global slide-over panel backed by SQLite with per-item read state and an unread
badge, plus **sounds differentiated per event type** and a mute toggle.

### Repositories

Deliberately minimal: a searchable flat list across the org — name, project, default
branch, last updated — with copy-clone-URL and open-in-web. No in-app file browser.

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
- **Comment likes are a real route** `[LIVE]`: `.../threads/{t}/comments/{c}/likes`
  answers 200 authenticated, 401 anonymously, against 404 for an invented sibling path.
  Reading is proven; *writing* is not — see the unknowns below.
- `changeType` is a `[Flags]` enum — parse as a comma-separated *set* (`"edit, rename"`).
- Requeuing the **policy evaluation** is the documented way to re-run a PR build; it
  preserves the policy linkage. `stageRefName` is the YAML stage *id*, not the display
  name — `__default` when the pipeline declares no stages.
- Prefer a hand-rolled fetch client over `azure-devops-node-api`, which does not
  surface response headers at all (issue #661) — that would blind us to note 2 and 3.

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
- `simple-git` must be `>=3.36.0` (three 2026 option-injection RCEs) and request data
  must never reach its options array.
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

### Phase 2: local repositories

Browse local branches and commits, per-commit diffs, and the thing you actually can't
get today: **the whole-branch squashed diff without opening a PR.**

It shapes exactly one decision now — **the diff renderer takes an abstract diff
source, not an ADO-shaped one** — so local git can feed the same view later. Nothing
else about it is designed.

Known: browser-only local git is dead (File System Access is Chromium-only and ~100×
slower than native), so this shells out to real `git` server-side. isomorphic-git has
no diff command.

### Deferred, not refused

**Auto-complete** on merge. The user's words: "we may want to bring it in at some
point. I just don't need it for the initial setup."

### Out of scope

Creating PRs · editing the description · work-item editing · batched
"start a review, submit all comments at once" · image and binary diffing · OS-level
notifications · running while the app is closed · multi-user or hosted deployment ·
bypassing branch policies.

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
   for an invented path). **Writability is still unproven** — the only proof is a real
   PUT against a real person's comment, which nobody has authorised. Until then treat
   likes as read-only: `usersLiked` renders, the UI offers no toggle.
5. **Line drift — not reproduced,** on a PR whose analysis post-dated its last push by
   eight minutes. That is one negative sample, not a guarantee. Note 6 stands unchanged:
   anchor defensively.
6. **`$top` clamps at 1000, and short pages are not last pages.** See the paging rule in
   *Structural facts* — this one bit the spike's own conclusions before it was measured.

**Still unmeasured: the rate-limit cost of the inbox fan-out.** Not one `X-RateLimit-*`
header came back across ~30 calls — ADO emits them only near the limit, so this is a
*couldn't measure*, not a *costs nothing*. T-004's concurrency cap is therefore still a
guess and must be labelled one, with the 200-TSTU/5-minute budget as the only anchor.
