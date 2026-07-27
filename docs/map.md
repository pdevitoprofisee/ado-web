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

Sectioned dense list: **Assigned to me** (including PRs where a *team you belong to*
is the reviewer) and **Mine**. Rows carry check state, unresolved *human* comment
count, staleness, conflict state, and whether a push reset your approval.

Rows hydrate lazily — visible rows first, the rest on idle — because check state and
comment counts for N PRs is irreducibly 1+N calls (see notes). Cache keyed on
`lastMergeSourceCommit.commitId`, so an unchanged PR costs nothing on re-poll.

Refresh: ~30 s for the open PR, ~2 min for the inbox, backing off when unfocused.

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

Alongside the diff: title/description (read-only), branches, conflict state stated
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
- `threads` **ignores `$top`** `[LIVE]` and has no pagination — you always get all.
- `GET _apis/git/pullrequests` truncates `description` to 400 chars.
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
- `api/qualitygates` was deprecated 2025-09-16 with no v2 replacement — prefer
  `measures/component` for the numbers we actually display.

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
  perfectly innocent `http://127.0.0.1:3000/…` URL.
- `simple-git` must be `>=3.36.0` (three 2026 option-injection RCEs) and request data
  must never reach its options array.
- `@napi-rs/keyring`, never `keytar` — archived and deprecated.

---

## Decisions so far

One line per resolved ticket — the gist, plus a link to the ticket that holds the
detail. Nothing is restated here; this is an index, not a store.

- [T-002 — Scaffold](./tickets/round-1.md#t-002--scaffold) — the shape above is real and
  running: Start with SSR off, shadcn locked to the aria base, loopback-bound in dev
  *and* in the Nitro build, a server function answering the client, tests and typecheck
  green.
- [T-005 — SQLite](./tickets/round-1.md#t-005--sqlite) — `node:sqlite` (no native addon,
  proven inside the Nitro build), a `schema_migrations` table applied transactionally at
  first use, and one round-1 table: a PR cache whose staleness check lives inside the
  read, so a caller cannot serve a row from before the last push.
- [T-009 — Command registry](./tickets/round-1.md#t-009--command-registry-and-shortcut-sheet) —
  one keydown listener for the app, keys declared in `src/commands/registry.ts` and claimed
  by surfaces with `useCommand`, the `?` sheet generated from that array and dimming what
  nothing is listening for, and a text-entry guard that knows React Aria's widgets.
- [T-010 — Localhost hardening](./tickets/round-1.md#t-010--localhost-hardening) — one
  request guard in `src/start.ts` that every handler sits behind: raw-header `Host`
  validation against DNS rebinding, a per-launch token on every server-function call,
  and Start's origin check re-declared because declaring a start instance would
  otherwise have removed it. The tokenless bootstrap is the stated, unclosable limit.

[T-001 — Live API inventory spike](./tickets/round-1.md#t-001--live-api-inventory-spike)
is claimed and waiting on a real PAT.

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

Creating PRs · editing title/description · work-item editing · batched
"start a review, submit all comments at once" · image and binary diffing · OS-level
notifications · running while the app is closed · multi-user or hosted deployment ·
bypassing branch policies.

### Unknowns that need a real credential

These are the first ticket, not assumptions. Two of them can change the architecture.

1. **Does org-wide `/{org}/_apis/git/pullrequests` return cross-project results?**
   The route exists `[LIVE]` (401, not 404) but the docs don't admit it. If it works,
   the entire per-project fan-out disappears.
2. **Does SonarCloud serve rule descriptions to an authenticated user,** or are they
   plan-gated? Load-bearing for the in-app Sonar detail view.
3. One live `statuses` response, to confirm the Sonar `genre` / `name` split.
4. **Does ADO expose a comment-*likes* write endpoint?** `usersLiked` is returned, but
   two research passes disagreed on whether a write endpoint is documented. If not,
   likes are read-only and that's fine — but the ticket needs to know.
5. Observed Sonar line drift on a PR pushed to after analysis.
6. The undocumented max `$top` on the PR list (400–500 observed).
