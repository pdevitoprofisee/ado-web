# Round 1 — foundations and the inbox spine

The route as a whole, then the tickets that are actually actionable now.

Each ticket states **success criteria**, not steps. Facts referenced by number come
from [the notes](../map.md#the-notes); don't re-derive them.

---

## The route

| Phase | What lands | Status |
|---|---|---|
| **1** | Live API inventory · scaffold · secrets · ADO client · SQLite · inbox spine · command registry | **this round** |
| 2 | PR detail shell: header, conflicts, policy checklist, votes, commits, file list | next |
| 3 | The diff: blob fetch, local diff, virtualized rows, Shiki workers, viewed flags, side-by-side | next |
| 4 | Comments: inline threads, collapse-when-done, composer, mentions, likes, status setters | after 3 |
| 5 | Checks: statuses, build timeline, failed step logs, failed tests, re-run actions | after 2 |
| 6 | Sonar: findings from the Sonar API, grouped by rule, gate panel, rule detail | after 5 |
| 7 | Write actions: vote, add reviewers w/ autocomplete, squash merge, abandon/reactivate | after 2 |
| 8 | Notifications: event detection, activity centre, per-type sounds | after 5 |
| 9 | Repository list | any time after 3 |
| — | Local repositories (phase 2 proper) | [fog](../map.md#the-fog) |

Phases 3 and 4 are the reason this project exists; phase 1 exists to make them cheap.

---

## T-001 — Live API inventory spike

**Do this first.** Two of its answers can delete work from the route, and it costs an
afternoon with a real PAT.

Answer, with the raw responses committed to `docs/research/live-inventory.md`, every
question in [Unknowns that need a real credential](../map.md#unknowns-that-need-a-real-credential).

Also empirically price the fan-out: record `X-RateLimit-Cost` for the PR list call and
for one per-PR `statuses` + `threads` pair, so the inbox's concurrency cap is chosen
from a measurement rather than a guess.

**Success:** each of the six unknowns is answered yes/no with the response that proves
it. Where the answer changes the plan (notably #1, cross-project PR listing), the map
is edited in the same commit.

**Explicitly not in scope:** any application code. This is a throwaway script.

---

## T-002 — Scaffold

TanStack Start + React + TypeScript + Tailwind 4, shadcn initialised with
`--base aria`, TanStack Query, pnpm, Vitest. SSR disabled for app routes.

**Success:** `pnpm dev` serves an app shell bound to `127.0.0.1`; `pnpm build && pnpm start`
serves the same shell from the Nitro build; one shadcn component renders; a trivial
server function returns a value to the client; `pnpm test` and `pnpm typecheck` pass in
CI-shaped scripts.

**Watch:** shadcn's base is **locked at init** — it's stored in `components.json` as
`<base>-<theme>` and cannot be changed later without redoing the components. Get
`--base aria` right the first time.

---

## T-003 — Secrets and onboarding

An onboarding route that captures the ADO org + PAT and the SonarCloud token, stores
them via `@napi-rs/keyring`, and tests each connection before accepting it. Tokens are
readable only inside server functions.

**Success:** on a fresh machine, entering credentials once is enough — restart the app
and it's still authenticated. A wrong PAT produces a clear "authentication failed",
**not** a redirect or an opaque network error (note 4). No token value ever appears in
a client bundle, a network response body, or a log line.

---

## T-004 — ADO HTTP client

The single server-side chokepoint for every ADO call.

**Success:**
- Sends `Authorization: Basic base64(":" + pat)` and
  `X-TFS-FedAuthRedirect: Suppress` on every request (note 4).
- **Treats a 200 carrying `Retry-After` as throttling** — waits and retries, and
  surfaces "ADO is throttling" to the UI. This is the client's whole reason for
  existing; a client that only handles 429 is wrong (note 2).
- Tracks `X-RateLimit-Remaining` / `-Cost` / `-Reset` and exposes them for the banner.
- Refuses to send a `creatorId` or `reviewerId` that isn't GUID-shaped, and fails loud
  rather than returning unfiltered results (note 1).
- Configurable concurrency cap for fan-out, defaulting to the value T-001 measured.
- A test proves the 200-with-`Retry-After` path retries, and a test proves a non-GUID
  identity filter throws.

**Deliberately not `azure-devops-node-api`** — it doesn't surface response headers,
which makes the two bullets above impossible.

---

## T-005 — SQLite

Server-side store plus migrations. Round-1 tables only: PR cache (keyed by PR id,
carrying `lastMergeSourceCommit.commitId` as the validity token) and the schema-version
row. Thread collapse state, viewed-file flags, and the notification log get added by
the phases that need them — don't build empty tables now.

**Success:** the file lives in a per-user app-data path, migrations run idempotently at
boot, and deleting the file is a clean recovery rather than a crash.

---

## T-006 — Identity and PR listing

Resolve the authenticated user's GUID from `connectionData`, then list PRs into the two
sections — **Assigned to me** and **Mine** — as plain rows: title, repo, author, target
branch, age.

Assigned-to-me must include PRs where a **team you belong to** is the reviewer, via
`isContainer` / `votedFor[]`.

Routing depends on T-001 #1: one org-wide call if it returns cross-project results,
otherwise org-level `repositories` → per-repo PRs, which still beats walking projects.

**Success:** the list matches what the ADO web UI shows for the same account, including
at least one team-assigned PR. Paging works past a single page (page until
`count < $top`; there is no continuation token). "Mine" is genuinely only mine — prove
the GUID guard by pointing a test at a non-GUID filter.

---

## T-007 — Lazy row hydration

Rich row data — check state, unresolved *human* comment count, conflict state,
whether a push reset your approval — fetched per PR at 1+N (note: irreducible), for
**visible rows first**, the remainder on idle.

**Success:** rows visibly upgrade from plain to rich without layout shift. A second
visit to an unchanged inbox issues **zero** per-PR calls, because every
`commitId` matched the cache. A PR whose per-PR calls fail still renders its plain row
with an inline error, never an empty inbox.

**Note:** unresolved count is *human* threads only — Sonar threads must not inflate it.
Sonar-thread detection (map: Sonar notes) is needed here, one phase earlier than the
Sonar feature itself.

---

## T-008 — Refresh cadence

Tiered polling: ~30 s for an open PR, ~2 min for the inbox, backing off when the window
is unfocused, resuming on focus.

**Success:** an inbox left open overnight has not exhausted the rate budget — verify
against the `X-RateLimit` accounting from T-004, not by feel.

---

## T-009 — Command registry and shortcut sheet

One registry that owns every keyboard shortcut, plus the `?` sheet rendered *from* the
registry so it can't drift.

Round-1 bindings: `j`/`k` navigate, `Enter` open, `Esc` back, `?` sheet. Register the
rest as later phases add their surfaces — `[`/`]` between files, `n`/`p` next/previous
unresolved thread, `r` reply, `e` edit a comment I own.

**Success:** the sheet is generated, not hand-written. Shortcuts don't fire while focus
is in a text input. A new shortcut is one registry entry with no changes to the sheet.

**Why now, not later:** every subsequent phase would otherwise add ad-hoc key handlers
that have to be unpicked.
