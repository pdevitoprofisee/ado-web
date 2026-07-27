# Round 1 — foundations and the inbox spine

The route as a whole, then the tickets that are actually actionable now.

Each ticket states **success criteria**, not steps. Facts referenced by number come
from [the notes](../map.md#the-notes); don't re-derive them.

Every ticket carries a **Type · Status · Blocked by** line. The **frontier** — what a
session may pick up — is the tickets that are `open`, `unclaimed`, and whose blockers
are all `resolved`. Claim before working: set `Status: claimed` and save first, so a
concurrent session skips it.

---

## The route

| Phase | What lands | Status |
|---|---|---|
| **1** | Live API inventory · scaffold · hardening · secrets · ADO client · SQLite · inbox spine · command registry | **this round** |
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

**Type:** task (HITL — needs a real credential) · **Status:** claimed · **Blocked by:** —

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

### The script exists — it needs credentials

[`scripts/live-inventory.mjs`](../../scripts/live-inventory.mjs) is written and answers all
six unknowns plus the fan-out pricing, writing `docs/research/live-inventory.md` with the
raw response under every verdict. Secrets are redacted from the output; no token value is
written to disk.

To finish this ticket:

1. **ADO PAT** at `https://dev.azure.com/{org}/_usersSettings/tokens` with **Code (read &
   write)**, **Build (read & execute)**, and **Identity (read)**. Read-only would answer
   five of the six unknowns; `vso.code_write` is only needed for the `--allow-writes`
   probe in unknown #4.
2. **SonarCloud token** at `https://sonarcloud.io/account/security` — must be a *personal*
   token; only those can read issues.
3. Run it:

   ```powershell
   $env:ADO_ORG='<org>'; $env:ADO_PAT='<pat>'; $env:SONAR_TOKEN='<token>'
   node scripts/live-inventory.mjs
   ```

   Optional: `ADO_PR_ID=<id>` to point unknowns 3–5 at a specific Sonar-analysed PR
   (otherwise it auto-picks the first active PR carrying a Sonar status), `SONAR_ORG=<key>`
   to skip organization discovery.

4. **Unknown #4 needs one deliberate mutation.** The default run only probes route
   *existence* — whether `.../comments/{id}/likes` answers 404 (missing) or 401/405
   (exists). Proving it's *writable* means actually liking a real comment. Re-run with
   `--allow-writes` on a PR whose comment you don't mind liking and unliking; the script
   PUTs then DELETEs the same like.

**Baseline already captured:** [`docs/research/sonar-rules-show-unauthenticated.json`](../research/sonar-rules-show-unauthenticated.json)
is the *unauthenticated* `rules/show` for `java:S1541` — 1101 bytes, metadata only, no
`htmlDesc` / `mdDesc` / `descriptionSections`, and a `requiredEntitlements: []` field.
Unknown #2 is settled by whether a token changes that.

**On rate-limit pricing:** ADO does not emit `X-RateLimit-*` on every response — the
headers appear as you approach the limit. If the run reports no headers, that is a
"couldn't measure", not a "cost is zero", and T-004's concurrency default stays a guess
until it's measured under real fan-out.

---

## T-002 — Scaffold

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** —

TanStack Start + React + TypeScript + Tailwind 4, shadcn initialised with
`--base aria`, TanStack Query, pnpm, Vitest. SSR disabled for app routes.

**Success:** `pnpm dev` serves an app shell bound to `127.0.0.1`; `pnpm build && pnpm start`
serves the same shell from the Nitro build; one shadcn component renders; a trivial
server function returns a value to the client; `pnpm test` and `pnpm typecheck` pass in
CI-shaped scripts.

**Watch:** shadcn's base is **locked at init** — it's stored in `components.json` as
`<base>-<theme>` and cannot be changed later without redoing the components. Get
`--base aria` right the first time.

### Resolution

All five success criteria verified, twice over — once against `vite dev`, once against
the Nitro production build.

| Criterion | Evidence |
|---|---|
| `pnpm dev` bound to `127.0.0.1` | `netstat` → `TCP 127.0.0.1:3000 LISTENING`, not `0.0.0.0` |
| `pnpm build && pnpm start` serves the same shell | Nitro node-server preset, `Listening on: http://127.0.0.1:3000/`, `GET /` → 200 |
| one shadcn component renders | the aria `Button` paints with `data-rac` / `data-react-aria-pressable` |
| a server function returns a value | page shows `node v24.18.0, pid 24928` — the pid *is* the server process |
| `pnpm test` / `pnpm typecheck` pass | 1/1 passed; `tsr generate && tsc --noEmit` exits 0 |

**What got built.** `--base aria` is locked in `components.json` as `"style": "aria-nova"`.
SSR is off via `tanstackStart({ spa: { enabled: true } })` plus `ssr: false` on the root
route — the prerendered shell ships with an empty `<!--$--><!--/$-->` body, which is the
proof SSR is genuinely disabled rather than merely unused. Dark is the default
(`<html class="dark">`); light waits for a settings surface.

**Loopback binding needs two mechanisms, not one.** Vite's `server`/`preview` config
covers dev; Nitro reads its listen address from `HOST`/`PORT` **at runtime**, so
production goes through [`scripts/start.mjs`](../../scripts/start.mjs), which sets both
before importing `.output/server/index.mjs`. `pnpm start` runs that, not the output
bundle directly — bypassing it re-exposes every interface.

**The shadcn CLI cannot init here.** `init` needs raw TTY mode for its style select;
`-y`, `--defaults`, `CI=1`, and piped stdin all hang. `components.json` was hand-authored
against `https://ui.shadcn.com/schema.json` and the rest of `init` reproduced from the
registry — `/r/styles/aria-nova/{index,utils}.json` for deps and `src/lib/utils.ts`,
`/r/colors/neutral.json` → `cssVarsV4` for the oklch theme in `src/styles.css`. Note also
that `--preset` is theme-only: the invocation is `--base aria --preset nova`, and
`--preset aria-nova` is rejected.

[`src/components/ui/button.test.tsx`](../../src/components/ui/button.test.tsx) is the guard
on the irreversible bit: it asserts `onPress`/`isDisabled`, so a re-init on a different
base fails the suite instead of failing silently.

**Vitest runs from its own `vitest.config.ts`**, deliberately — the Start and Nitro
plugins have no business loading under jsdom.

**Surfaced, now ticketed:** Start already rejects server-function calls whose `Origin`
isn't the dev origin (403 with no `Origin`, 403 with a foreign one, 200 from
`http://127.0.0.1:3000`). That closes one third of the map's localhost-hardening note and
makes the remaining two thirds specifiable — see T-010.

---

## T-003 — Secrets and onboarding

**Type:** task (AFK) · **Status:** open · **Blocked by:** T-002, T-010

An onboarding route that captures the ADO org + PAT and the SonarCloud token, stores
them via `@napi-rs/keyring`, and tests each connection before accepting it. Tokens are
readable only inside server functions.

**Success:** on a fresh machine, entering credentials once is enough — restart the app
and it's still authenticated. A wrong PAT produces a clear "authentication failed",
**not** a redirect or an opaque network error (note 4). No token value ever appears in
a client bundle, a network response body, or a log line.

---

## T-004 — ADO HTTP client

**Type:** task (AFK) · **Status:** open · **Blocked by:** T-001, T-002, T-003

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

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-002

Server-side store plus migrations. Round-1 tables only: PR cache (keyed by PR id,
carrying `lastMergeSourceCommit.commitId` as the validity token) and the schema-version
row. Thread collapse state, viewed-file flags, and the notification log get added by
the phases that need them — don't build empty tables now.

**Success:** the file lives in a per-user app-data path, migrations run idempotently at
boot, and deleting the file is a clean recovery rather than a crash.

### Resolution

All three success criteria have a test that proves them.
[`src/server/db.ts`](../../src/server/db.ts) owns the path, the open, the migration
runner and the process handle; [`src/server/pr-cache.ts`](../../src/server/pr-cache.ts)
is round 1's only consumer.

| Criterion | Evidence |
|---|---|
| per-user app-data path | `databasePath()` → `%LOCALAPPDATA%\ado-web\ado-web.db`; test asserts it is outside `cwd()` |
| migrations idempotent | opening twice, plus a third explicit `migrate()`, leaves one `schema_migrations` row and the data intact |
| deleting the file recovers | `unlink` then reopen yields an empty, fully-migrated schema; a missing directory tree is recreated, not required |

**Driver: `node:sqlite`, not better-sqlite3.** Node 24.18 ships it (SQLite 3.53.1) with
no experimental warning. The deciding factor is the Nitro build: a native addon has to
be externalised from the bundle and carries per-platform prebuilds, and buys nothing at
this scale. **Verified against the production build, not just `vite dev`** — a temporary
server function touching the store was built and run, and the Nitro server process
created and migrated its own database file (`pr_cache` + `schema_migrations`, migration 1
recorded). `node:sqlite` is emitted as a real external `import` in the server bundle and
appears **nowhere** in the client bundle. The probe wiring was then reverted; nothing
imports the store yet, so that check has to be re-run by the first ticket that does.

**`schema_migrations` table, not `pragma user_version`.** `user_version` is one integer
and would have worked, but later phases add tables (thread collapse, viewed flags, the
notification log) and a row per migration with its `applied_at` is the difference
between a debuggable schema and an opaque one. Each migration's DDL and its bookkeeping
row commit in **one transaction** — SQLite DDL is transactional — so the schema and the
version record cannot diverge, which is the only thing `user_version` was buying.

**Cache tables get truncated by migrations, not migrated.** Recorded next to
`MIGRATIONS`: when a cached payload's shape changes, the migration `DELETE`s rather than
transforms. Re-fetchable data doesn't earn a data migration.

**The validity token is why there is no organization column.** `readPrCache(prId,
commitId)` compares `commit_id` *inside* the read, so a caller cannot forget the check
and serve a stale row — T-007's "zero calls on an unchanged inbox" is only sound if that
half is exact. It also settles cross-org contamination without a column: a PR id is
org-scoped in ADO, so serving a wrong row would need a collision on both the id and a
40-hex commit sha, i.e. the same commit.

**Deliberately not done.** No WAL journal mode — access is single-process and
synchronous via `DatabaseSync`, so there is no reader/writer contention to relieve, and
it keeps "delete the database" to exactly one file instead of three. No eviction: the
cache grows one row per PR ever seen, which is megabytes over years for one user;
`fetched_at` is stored so a prune is possible when that stops being true. No tables for
later phases — empty tables are guesses.

**Watch:** every `node:sqlite` call is synchronous and blocks the Nitro event loop.
Irrelevant for small cache rows; it becomes a real consideration if a later phase stores
anything large (phase 3's blob or token caches).

**Surfaced for T-010:** a server function cannot be driven by curling
`/_serverFn/<id>`. The id in the server bundle comes from `createSsrRpc` and is not the
client's RPC id; the same hand-rolled call returns 500 on a build containing no store
code at all. T-010 must prove its `Host` and token guards at the request-guard level or
through a real client, not by curling a guessed URL — otherwise it will read a 403 as a
pass when the call was never well-formed.

---

## T-006 — Identity and PR listing

**Type:** task (AFK) · **Status:** open · **Blocked by:** T-001, T-004

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

**Type:** task (AFK) · **Status:** open · **Blocked by:** T-005, T-006

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

**Type:** task (AFK) · **Status:** open · **Blocked by:** T-007

Tiered polling: ~30 s for an open PR, ~2 min for the inbox, backing off when the window
is unfocused, resuming on focus.

**Success:** an inbox left open overnight has not exhausted the rate budget — verify
against the `X-RateLimit` accounting from T-004, not by feel.

---

## T-009 — Command registry and shortcut sheet

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-002

One registry that owns every keyboard shortcut, plus the `?` sheet rendered *from* the
registry so it can't drift.

Round-1 bindings: `j`/`k` navigate, `Enter` open, `Esc` back, `?` sheet. Register the
rest as later phases add their surfaces — `[`/`]` between files, `n`/`p` next/previous
unresolved thread, `r` reply, `e` edit a comment I own.

**Success:** the sheet is generated, not hand-written. Shortcuts don't fire while focus
is in a text input. A new shortcut is one registry entry with no changes to the sheet.

**Why now, not later:** every subsequent phase would otherwise add ad-hoc key handlers
that have to be unpicked.

### Resolution

Four files under [`src/commands/`](../../src/commands/):
[`registry.ts`](../../src/commands/registry.ts) is the declaration,
[`command-provider.tsx`](../../src/commands/command-provider.tsx) is the app's one
`keydown` listener plus the `useCommand` hook surfaces bind with,
[`text-entry.ts`](../../src/commands/text-entry.ts) is the "is the user typing" rule, and
[`shortcut-sheet.tsx`](../../src/commands/shortcut-sheet.tsx) renders the registry.
`__root.tsx` gains one wrapper around `{children}`.

| Criterion | Evidence |
|---|---|
| the sheet is generated | `shortcut-sheet.test.tsx` renders it against a **fabricated** registry (`vi.mock('./registry')` — labels "Fabricated first/second/third", groups reversed) and asserts the rows equal that array; a hand-written sheet fails it outright |
| no firing from a text input | `does not fire while focus is in a text input` and `… in a React Aria TextField` — the handler is never called and the input ends up holding `jk` / `j`; 16 more cases in `text-entry.test.ts` |
| a new shortcut is one entry | the sheet names no key and no label; the row assertion is `COMMANDS.map(...)`, so an added entry needs no edit to either the sheet or its test |

**Observed, not inferred.** Headless Chrome over CDP, against `pnpm dev` and again against
`pnpm start`: pressing `?` produced rows
`[["Next item","j","false"],["Previous item","k","false"],["Open","Enter","false"],["Back","Esc","true"],["Keyboard shortcuts","?","true"]]`
in groups `["Navigation","Help"]`; `Esc` closed the sheet and left `location.pathname` at
`/`; with focus in an `<input>`, `?` opened nothing and the character landed in the field;
after `blur()` the same key opened the sheet again.

**The registry holds no handlers.** `j` is "next inbox row" now and "next diff row" in
phase 3, so the entry owns the key, the wording and the sheet order, and a surface claims
it with `useCommand('nav.next', fn)`. Bindings are a **stack per id, not a slot**: two
surfaces can own the same key across a route transition, so the most recent one wins and
hands the key back when it unmounts, rather than clobbering its predecessor permanently
(`gives the key to the most recent binding and hands it back`). They live in a ref, not
state — phase 3's virtualized rows will bind and unbind as they scroll, and that must not
re-render anything.

**The sheet dims what nothing is listening for.** `j`/`k`/`Enter` are registered per the
ticket but no surface exists to bind them, and a sheet that lists a dead key is a lie. The
`data-bound` attribute is also the only reason the sheet needs anything from the provider;
it reads a snapshot at open time, which cannot go stale because the dispatcher stands down
while the sheet is up.

**The text-input rule has to know React Aria, not just `<input>`.** React Aria's date and
time segments are `contenteditable` `role="spinbutton"` divs, so tag-name matching alone
would let `j` fire mid-edit; conversely a Select's trigger is a plain button and a checkbox
is an `<input>`, and shortcuts must keep working from both. The rule is "does this widget
consume characters" — a deny-list of non-text `input` types, plus `textbox` / `searchbox` /
`combobox` / `spinbutton` roles, plus `contenteditable` walked as an *attribute* as well as
via `isContentEditable`, because jsdom doesn't implement the latter and the test would have
passed vacuously.

**While the sheet is open the dispatcher does nothing at all.** That is the guard, rather
than reasoning about whether React Aria's `Escape` handling stops propagation before a
window listener sees it: `Esc` in an open dialog must close the dialog, never also run
`nav.back`. Only `?` is still honoured, to toggle the sheet shut.

**`Esc` calls `window.history.back()`, not `router.history.back()`.** TanStack Router
drives the browser history and listens to popstate, so it lands in the router either way,
and the command layer needs no router — which is what lets the whole provider be tested
without one (`binds Esc to history without needing a router`). Overrule this if a later
phase wants `Esc` to mean something router-specific.

**`shadcn add` works here even though `init` doesn't.** T-002 recorded that `init` needs
raw TTY mode; `pnpm exec shadcn add dialog kbd --yes` ran clean against the locked
`aria-nova` base and wrote `src/components/ui/{dialog,kbd}.tsx`. It also rewrote
`button.tsx` to add a `"use client"` banner, which was reverted — the CLI touches
dependencies of what you ask for.

**Deliberately not done.** No `[`/`]`, `n`/`p`, `r` or `e` entries: they are one line each
and belong with the surface that gives them meaning, and per T-005's "empty tables are
guesses" a registry entry with no wording behind it is the same mistake. No chords, no
sequences (`g i`), no per-scope registries, no user rebinding — five bindings and a stated
growth path don't pay for any of it. No command palette; the registry would feed one, but
nothing asked for it. Modifier combinations are ignored outright rather than modelled,
since every binding in the map is a bare key.

**Surfaced for T-006 and phase 3:** `nav.next` / `nav.previous` / `nav.open` render dimmed
until something binds them, so the inbox ticket's visible acceptance check is that those
three go solid in the `?` sheet. `Enter` is the one round-1 key with a native meaning —
binding `nav.open` will fire alongside a focused button's own activation, and the surface
that binds it has to decide whether the row list takes focus off buttons or the handler
checks the target.

---

## T-010 — Localhost hardening

**Type:** task (AFK) · **Status:** claimed · **Blocked by:** T-002

The map's security note in full, minus the third that T-002 already proved is handled.
**Origin validation ships with Start** — a server-function call with no `Origin`, or a
foreign one, is rejected 403 before the handler runs. What's missing is the other two:

- **`Host` validation.** Origin checks don't stop DNS rebinding — the attacker's page
  resolves its own hostname to `127.0.0.1` and the `Origin` it sends is genuinely its
  own. Reject any request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`.
- **A per-launch random token header.** Generated at boot, handed to the shell, sent on
  every server-function call. This is what stops *non-browser* local processes, which
  send no `Origin` at all and are unaffected by any browser-enforced check.

Both belong in one place — a single request guard the server functions sit behind —
because "some endpoints are hardened" is the same as none once phase 2 shells out to
`git`.

**Success:** a request from a foreign `Host` is rejected, and a request with no token or
a stale one is rejected, each with a test that proves it. Prove them at the request-guard
level or through a real client — **not** by curling `/_serverFn/<id>` with an id scraped
from the bundle, which fails for reasons of its own and would read as a pass (T-005). The app itself still works
end-to-end in dev and from `pnpm start`. The token never lands in a log line or in the
prerendered shell's static HTML — it reaches the client the same way the shell's other
boot state does, at runtime.

**Why before T-003:** T-003 is the first ticket to put a real PAT behind a server
function. Hardening after that point means shipping a window where a rebinding page can
drive the credential endpoints.
