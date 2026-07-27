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

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

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

### Resolution

Run against the live `Profisee` org; raw responses in
[`docs/research/live-inventory.md`](../research/live-inventory.md). The map is edited in
this same commit — two answers deleted planned work.

| Unknown | Answer | What it changes |
|---|---|---|
| 1 · org-wide cross-project PR list | **YES** — 164 active PRs over 2 projects, matching per-project enumeration across all 6 exactly | **The per-project fan-out is deleted.** One call covers the org |
| 2 · Sonar rule descriptions to a token | **YES** — `htmlDesc` + `mdDesc` + sections, 3.0–12.8 KB vs the [1101 metadata-only bytes](../research/sonar-rules-show-unauthenticated.json) anonymous, `requiredEntitlements: []` | **Rule detail renders in-app.** The `rules.sonarsource.com` scrape is deleted |
| 3 · Sonar `genre`/`name` | genre `SonarCloud`, name `quality gate` | Confirms the status filter T-006 keys on |
| 4 · comment-likes write endpoint | Route **exists and reads** — 401 anon, 200 authed, 404 for an invented sibling. Write **unproven** | Likes render; no toggle until a write is proven |
| 5 · Sonar line drift | **Not reproduced** — analysis post-dated the last push by 8 min | One negative sample. Note 6 stands: anchor defensively |
| 6 · max `$top` | **Clamps at 1000**, and short pages are not last pages | Rewrites T-004's paging loop — see below |
| — · fan-out rate cost | **Could not measure** | T-004's concurrency cap stays an explicit guess |

**The credential came from the OS store, not the command line.** T-003 landed between this
ticket being written and being run, so `scripts/live-inventory.mjs` now falls back to
`readAdoCredential()` / `readSonarCredential()` when the env vars are absent. That is not
just convenience: the documented `$env:ADO_PAT='…'` invocation puts a PAT in shell history
and in the process table, which is a worse home for it than the Credential Manager. The
env-var path still works, and the store import is dynamic and guarded so a machine that
can't load the native addon degrades to it.

**The script's raw responses were sound; three of its verdicts were not.** Worth recording
because the failure mode generalises — an automated verdict is a hypothesis, and this one
was checked against its own evidence rather than read off the top line.

*Unknown 6 was the dangerous one.* The script announced "capped at 991 returned items" and
advised paging until `count < $top`. Both wrong: `$skip=1000` returned **another 985**, so
991 was neither a ceiling nor a total, and the shortfall repeats at every size (500→497,
100→100 but `$skip=100`→98). The endpoint filters *after* applying `$top`, so **a short
page is not the last page** — the precise assumption the generated advice enshrined, and
one that would have silently truncated the inbox at 497 of ~2,000 PRs. `$top` does clamp
at 1000; 2000 and 5000 return the identical 991 without an error.

*Unknown 4 measured note 4 by accident.* The anonymous route-existence probe omitted
`X-TFS-FedAuthRedirect: Suppress`, so it captured a 302 to the sign-in page instead of the
401-vs-404 the discriminator is built on. The verdict happened to be right for the wrong
reason. Re-probed with the header — and with an invented sibling path as a control — it is
clean: 401 anonymous, 200 authenticated, 404 for the fake route.

*Unknown 2 blamed the service for a typo.* "Batched `rules/search` returned descriptions:
false" was the singular `rule_key`; the parameter is **`rule_keys`**. SonarCloud doesn't
reject the wrong name, it returns `total: 0` — so a parameter mistake is indistinguishable
from "those rules don't exist" unless you check. With `rule_keys`, all three come back with
descriptions and the one-request-per-PR warming plan survives.

All three are fixed in the script, along with pinning `api-version` on every ADO call —
including `connectionData`, which needs `7.1-preview.1`.

**Not verified: that likes are writable.** Proving it means PUTting a like onto a real
colleague's comment on a real PR and deleting it again, which may notify them. That is not
mine to authorise, so `--allow-writes` was not used. Until someone runs it, the map says
likes are read-only, which is the safe direction: the UI renders `usersLiked` and offers no
toggle. T-007 can revisit.

**Deliberately not done.** No re-run under load to force `X-RateLimit-*` out of ADO —
generating enough traffic to approach a shared team limit is not a thing to do casually,
and the honest answer ("unmeasured") is more useful to T-004 than a number pulled from a
run that annoyed the org. No PR-detail or diff endpoint inventory; those belong to the
phases that use them.

**Surfaced for T-004:** the paging loop is now specified by measurement, not idiom — page
on `$skip`, advance by the *requested* `$top`, terminate only on an **empty** page, and
dedupe by `pullRequestId` because whether `$skip` applies before or after the server's
filter is unresolved. And 164 active PRs across the org is the real inbox size to design
the fan-out against.

### Re-running it

`node scripts/live-inventory.mjs` — credentials come from the store written by T-003, or
from `ADO_ORG` / `ADO_PAT` / `SONAR_TOKEN` if all three are set. `ADO_PR_ID=<id>` pins
unknowns 3–5 to a specific Sonar-analysed PR instead of auto-picking; `SONAR_ORG=<key>`
skips organization discovery. It rewrites `docs/research/live-inventory.md` — the
hand-written corrections at the top of that file do not survive a re-run.

The PAT needs **Code (read & write)**, **Build (read & execute)** and **Identity (read)**;
`vso.code_write` matters only for `--allow-writes`, which is the deliberate mutation
described above and is off by default. The Sonar token must be a *personal* one.

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
| `pnpm dev` bound to `127.0.0.1` | `netstat` → `TCP 127.0.0.1:7331 LISTENING`, not `0.0.0.0` |
| `pnpm build && pnpm start` serves the same shell | Nitro node-server preset, `Listening on: http://127.0.0.1:7331/`, `GET /` → 200 |
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
`http://127.0.0.1:7331`). That closes one third of the map's localhost-hardening note and
makes the remaining two thirds specifiable — see T-010.

---

## T-003 — Secrets and onboarding

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-002, T-010

An onboarding route that captures the ADO org + PAT and the SonarCloud token, stores
them via `@napi-rs/keyring`, and tests each connection before accepting it. Tokens are
readable only inside server functions.

**Success:** on a fresh machine, entering credentials once is enough — restart the app
and it's still authenticated. A wrong PAT produces a clear "authentication failed",
**not** a redirect or an opaque network error (note 4). No token value ever appears in
a client bundle, a network response body, or a log line.

### Resolution

Four modules, split by what each is allowed to see.
[`src/server/credentials.ts`](../../src/server/credentials.ts) is the only one that can
read a token back out of the OS; [`connection-test.ts`](../../src/server/connection-test.ts)
is the only one that spends a token on a network call;
[`credentials-fn.ts`](../../src/server/credentials-fn.ts) is the boundary the client can
reach, and returns nothing but booleans, an org name, and messages we wrote ourselves;
[`src/routes/onboarding.tsx`](../../src/routes/onboarding.tsx) is the form.

| Criterion | Evidence |
|---|---|
| enter once, survives restart | a credential written by one process is reported as configured by a **freshly launched server** — `/onboarding` renders "Azure DevOps · Contoso", `/` renders "Connections: Azure DevOps (Contoso), SonarCloud"; in both `pnpm dev` and `pnpm start`, plus a unit test that re-imports the module after `vi.resetModules()` |
| wrong PAT ⇒ "authentication failed" | real browser, real server, real `dev.azure.com`: a 52-char junk PAT produced the destructive alert **"Authentication failed — Azure DevOps rejected the token…"**, not a redirect and not "fetch failed" |
| never in the client bundle | `.output/public` (9 files) contains no match for `napi-rs`, `keyring`, `getPassword`, `connectionData`, `X-TFS-FedAuthRedirect`, `dev.azure.com` or `sonarcloud.io`; the server bundle keeps `import { Entry } from "@napi-rs/keyring"` |
| never in a response body | CDP captured every response of the failing-save run — 12 in production, 180 in dev — and the PAT appears in none. The `/_serverFn/*` bodies carry only `configured`/`org` and `ok`/`reason`/`message` |
| never in a log line | nothing in these modules logs; `unreachable()` returns fixed text and never `cause.message` |

**One entry per kind, whole record as JSON in the password field.** The obvious
alternative — username = the ADO org, password = the PAT — can be written but never
read: `Entry` needs *both* halves to address an entry, so we would have to already know
the org in order to look up the credential that tells us the org.

**Test before accepting.** `saveAdoCredential` writes only when `testAdoConnection`
returns `ok`, so a credential that has never worked cannot displace one that does —
retyping a PAT with a typo leaves the app exactly as authenticated as it was. Confirmed
live in both directions: from empty, the junk-PAT rejection left the status at "Not
configured"; from a stored credential, it left "Contoso" standing.

**Auth failure is decided by the body, not the status.** Note 4 is only half the trap.
With `X-TFS-FedAuthRedirect: Suppress` sent and `redirect: 'manual'` set — following one
would forward the `Authorization` header to whatever sign-in host ADO nominates — a 3xx
is reported as an auth failure whose message says "sign-in". But ADO will also answer a
browser-shaped request with the sign-in page itself, **status 200 and all**, so a 200
whose body has no `authenticatedUser.id` is rejected too. 404 is `not-found` and names
the org, because a typo'd organization and a dead token are different repairs.
SonarCloud has the mirror-image problem: `api/authentication/validate` answers 200 either
way with the verdict in the body, so `valid !== true` is an auth failure.

**Two bugs that only a real PAT could reach.** The first live attempt with a valid token
answered `400`, and the diagnosis found two defects stacked on each other.

*`connectionData` is a preview-only resource.* `api-version=7.1` earns
`400 VssInvalidPreviewVersionException` — "the -preview flag must be supplied"; the
working value is `7.1-preview.1`. What made this invisible is the ordering: **ADO
validates the credential before the api-version**, so every wrong-token test 401s and
never reaches the version check. A whole suite of failure-branch tests can pass against a
URL that no authenticated request can use. Anonymous probing is what separated the two —
the same URL with no credential at all returns the 400 directly.

*A public organization authenticates nobody and still answers 200.* `Profisee` serves
`connectionData` anonymously, and the body is not malformed — it is a real GUID
(`aaaaaaaa-…`), `isActive: true`, `providerDisplayName: "Anonymous"`. The success check
was `typeof user.id === 'string'`, which that satisfies, so fixing the version alone would
have made an unsent or ignored token report **"Connected as Anonymous"** and store itself:
test-before-accept defeated by a response that passes every shape check. Identities in the
`System:` descriptor namespace (and the well-known anonymous GUID) are now rejected. The
lesson generalises past this ticket — on a public org, *no* ADO endpoint's 200 is evidence
that a credential was accepted.

Both bugs cost a round trip through the user because `unexpected()` threw the service's
own explanation away and said "answered 400, which we don't know how to read". It now
repeats the `message` from the error body, dropped whole if it contains the credential so
the no-token-in-a-response-body guarantee stays mechanical rather than a bet on what a
server might echo.

**A present-but-unusable entry reads as "not configured", never throws.** Corrupt JSON,
JSON of the wrong shape, a half-written record, a blank PAT — all return `null`. Throwing
would turn a mangled credential entry into an app that cannot boot and gives you no
screen from which to fix it. The onboarding route can always overwrite; it can't rescue
a crash loop.

**The credential tests run against the real Windows credential store**, under
`ado-web-test-<pid>` via `ADO_WEB_KEYRING_SERVICE`, with cleanup in `afterEach`. A mock
would have proved the JSON encoding and nothing about the thing the ticket is about.

**`@napi-rs/keyring` had to be externalised — in three places.** `pnpm build` failed with
`UNLOADABLE_DEPENDENCY … stream did not contain valid UTF-8`: the bundler followed
`require('@napi-rs/keyring-win32-x64-msvc')` and tried to read a `.node` binary as
source. A native addon cannot be bundled at all, so `vite.config.ts` leaves the import
standing and lets Node resolve it at runtime — safe precisely because the server half
never ships anywhere; `.output/` runs from this checkout, next to the `node_modules`
holding the binary. **Three separate passes reach for the package and each needs its own
opt-out**: `optimizeDeps.exclude` (the dev prebundler), `resolve.external` (dev SSR
resolution) and `build.rollupOptions.external` (the production build). Fixing only the
last one made `pnpm build` and `pnpm start` pass while `pnpm dev` still died in
dependency optimization — a mode-specific failure that a build-only check reads straight
past. Both modes are now driven through a real browser, not just started. This is the
second instance of the cost T-005 priced in when it chose `node:sqlite`.

**Deliberately not done.** No encryption on top of the OS store — the Windows Credential
Manager is already scoped to the logged-in user, and a second key would have to live
somewhere this app can read unattended, i.e. nowhere better. No PAT-scope introspection:
`connectionData` proves the token authenticates, not that it carries Code (read); the
message names the scopes so a half-scoped token fails legibly at the call that needs it.
No expiry countdown for ADO (the API doesn't return one); SonarCloud's
`SonarQube-Authentication-Token-Expiration` header *is* surfaced, so a dying token
doesn't read as an outage. No "no credentials yet" redirect from the inbox — T-006 owns
the empty state.

**Still not verified: the ADO success path against a live token.** SonarCloud's *is*
verified — a real personal token returned "Connected" and stored. ADO's cannot be, from
here: it means typing a PAT that belongs to the user and must not reach this transcript.
The first attempt is what surfaced the two bugs above; the retry is still owed. Open
`http://127.0.0.1:7331/onboarding` and enter it there; "Connected as \<name\>" is the
expected result, after which the org appears on the home page and survives a restart.
Anything else — including "Connected as Anonymous", which is now impossible by
construction — means this section is wrong again.

**Surfaced for T-004:** `adoAuthHeaders(pat)` is exported from `connection-test.ts` and
already encodes `Basic base64(":" + pat)` plus the `Suppress` header. T-004's first
bullet is that pair — import it rather than re-deriving note 4, and keep the one
regression test that pins the Basic encoding. Two more inheritances from the bugs above:
check every endpoint's api-version against a *preview* suffix before assuming the plain
number works, and never treat a 200 as proof of authentication on a public org — assert
the identity is not `System:`-descriptored, exactly as `testAdoConnection` does.

---

## T-004 — ADO HTTP client

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-001, T-002, T-003

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

### Resolution

[`src/server/ado-client.ts`](../../src/server/ado-client.ts) — `createAdoClient(credential)`
returning `get` / `fanOut` / `rateLimit`.

| Criterion | Where |
|---|---|
| Basic + `Suppress` on every request | `send` calls `adoAuthHeaders` from T-003; `redirect: 'manual'` is not a caller's choice |
| 200 carrying `Retry-After` treated as throttling | `absorb` → the gate. **Waits, does not re-request — see below** |
| `X-RateLimit-*` tracked and exposed | `rateLimit()`, plus `X-RateLimit-Delay`, which is the header ADO actually documents |
| Non-GUID identity filter fails loud | `assertIdentity` throws a `TypeError` in `buildUrl`, before any request exists |
| Configurable concurrency cap | `DEFAULT_CONCURRENCY = 4`, overridable per client |
| Tests for both | `ado-client.test.ts`, 14 tests |

**The 200-with-`Retry-After` bullet is implemented as a gate, not a retry, and that is a
deliberate departure from this ticket's wording.** Note 2's own quote is Microsoft saying
"the response still returns HTTP 200, so retry logic isn't required" — the delayed
response is complete and correct. Re-requesting it would discard good data and add load
to a service that has just asked us to slow down. What the note is actually about is the
*next* call: a client that only branches on 429 keeps firing into a throttle and looks
broken. So any `Retry-After`, on any status, closes a gate that every subsequent request
waits behind, and 429/503 retry *through* that same gate. One mechanism, both behaviours,
and the observable outcome the ticket wanted — the client slows down and the UI can say
so. The test asserts the 200 is **not** re-requested and that the following call is
delayed by the advertised interval.

**The concurrency cap is a guess and is commented as one.** T-001 was meant to measure it
and couldn't: no `X-RateLimit-*` header appeared on any call, in that run or in this
ticket's live smoke test. 4 is low on purpose — the gate absorbs the cost of being too
conservative, and there is no way to be conservative about being too aggressive. The
banner will show when there's headroom.

**Verified against the live org, not only against stubs.** T-003's lesson was that a
bad-token test never reaches api-version validation, so a whole green suite can sit on a
URL no authenticated request can use. A throwaway script drove the real module against
`Profisee`: identity resolved, a 5-row page came back, `searchCriteria.creatorId` with a
real GUID narrowed 164 active PRs to 4, the guard threw on `paul@example.com` without
sending, a bad route surfaced as `AdoError` 404, and `fanOut` ran 8 concurrent calls.
That run also settled a smaller worry — `URLSearchParams` percent-encodes `$`, and ADO
decodes `%24top=3` exactly like `$top=3` (both 200, both 3 rows). No encoding hack.

**Deliberately not done.** No paging helper — T-006 owns the PR list, and its ticket now
carries the measured rule rather than the `count < $top` idiom T-001 disproved. No
non-JSON `get`; the diff phases can add one when they have a body to shape it. No POST or
PATCH — nothing writes yet, and the first writer should pick the idempotency story. No
request-level cache: T-005's `pr_cache` is keyed on a commit id the transport can't see.

**Watch:** `AdoError` carries ADO's own explanation, run through T-003's `serviceDetail`,
which drops the text whole if it contains the PAT. That redaction is now shared by two
call sites and must stay the only path from a response body to a message.

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

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-001, T-004

Resolve the authenticated user's GUID from `connectionData`, then list PRs into the two
sections — **Assigned to me** and **Mine** — as plain rows: title, repo, author, target
branch, age.

Assigned-to-me must include PRs where a **team you belong to** is the reviewer, via
`isContainer` / `votedFor[]`.

Routing depends on T-001 #1: one org-wide call if it returns cross-project results,
otherwise org-level `repositories` → per-repo PRs, which still beats walking projects.

**Success:** the list matches what the ADO web UI shows for the same account, including
at least one team-assigned PR. Paging works past a single page — page on `$skip`,
advancing by the *requested* `$top`, and stop only on an **empty** page. (T-001 measured
this: `$top` clamps at 1000 and the service filters *after* applying it, so a short page
is **not** the last page. There is no continuation token. Dedupe by `pullRequestId`.)
"Mine" is genuinely only mine — prove
the GUID guard by pointing a test at a non-GUID filter.

### Resolution

[`src/server/inbox.ts`](../../src/server/inbox.ts) resolves the identity, resolves the
teams, lists every active PR in the org, and partitions the result locally.
[`inbox-fn.ts`](../../src/server/inbox-fn.ts) is the client boundary,
[`src/components/pr-list.tsx`](../../src/components/pr-list.tsx) the two sections, and
[`src/routes/index.tsx`](../../src/routes/index.tsx) — which was still the T-002 scaffold
demo — is now the inbox.

| Criterion | Evidence |
|---|---|
| identity from `connectionData` | live: `ba11ca22-…-70ab29e1a5e2` / Paul DeVito, and the same GUID matches 4 PRs' `createdBy.id` |
| both sections, live | **Assigned to me** 3302 3135 2974 2906 · **Mine** 24698 24696 24587 24586 · disjoint, unique, 164 active PRs scanned in **716 ms** |
| ≥1 team-assigned PR | all four of "Assigned to me" arrive via `[SaaS]\DevOps Team`; **zero** are direct — across all 164 PRs this account has **no** direct reviewer assignment at all |
| paging past one page | forced live at `$top=50`: `50 + 49 + 43 + 23 + 0 = 165`, identical id set to the single 1000-row page |
| stop only on empty | three of those pages were short **and not last**; a `count < $top` stop would have quit at page 2 and lost 66 of 165 |
| dedupe by `pullRequestId` | unit test pages an id across two pages; live sets compared by id, not length |
| "Mine" is only mine | unit tests: a `${me}x` author, an unrelated author, and a same-id-but-`isContainer:false` reviewer are all excluded |
| the GUID guard | three tests in `ado-client.test.ts` — a non-GUID `creatorId` and a non-GUID `reviewerId` both throw before a request is sent, a real GUID passes through |
| nothing leaks | rebuilt: `.output/public` (9 files) still has no `napi-rs`, `keyring`, `getPassword`, `connectionData`, `X-TFS-FedAuthRedirect`, `dev.azure.com` or `searchCriteria`; the prerendered shell contains no PR id |

**Azure DevOps cannot answer "what is in my inbox", and the filter that looks like it can
is the trap.** `searchCriteria.reviewerId=<my GUID>` does not expand team membership:
live it returned **0** while 4 PRs had my team sitting on them as a reviewer, and I was a
direct reviewer on **none**. It fails as a *silent* empty inbox — the same failure mode as
note 1, one layer up. So the listing is unfiltered and the partition is local: one org-wide
call, `createdBy.id` for "Mine", `reviewers[].id` plus `isContainer` for "Assigned to me".

**`_apis/teams?$mine=true` is not membership, and it produced the right answer here by
luck.** This section originally shipped on that filter. Paul questioned the result — "I
don't believe I'm a member of the SaaS DevOps team" — and the doubt was well founded even
though the four PRs were right. Measured against the live org:

- the roster of `SaaS \ DevOps Team` is three entries — Manju Thomas, Yonko Ganchev, and
  the group `[TEAM FOUNDATION]\Solliance - SaaS`. **This account is not on it.**
- checking all 43 rosters in the org: **direct member of 0 of 43 teams**.
- the account's real transitive closure is **28 containers**. `$mine=true` reported **1**.

So the filter under-reports by 27 and reports one thing it should not. Membership here is
real but indirect: the account is in `Solliance - SaaS`, which is on the team's roster, so
ADO expands it in. What matters is the failure mode — a filter that returns 1 of 28 can
drop a genuine team assignment with nothing to see, which is the silent-empty-inbox trap
this ticket exists to avoid.

**The replacement is the transitive closure intersected with the org's team list.**
`identities?identityIds=<me>&queryMembership=Expanded` on `vssps.dev.azure.com` returns all
28 containers in **one call, no walk**, then one batched call resolves the descriptors to
ids (chunked at 100 — a 250-group account would otherwise build a 15 KB query string), and
`_apis/teams` supplies the intersection.

**The intersection is the load-bearing half, not a tidying step.** The raw closure is
mostly security groups, and branch policy staples those to PRs wholesale:
`[Products]\Contributors` is a container reviewer on **119 of 163** active PRs and this
account belongs to it. Matching the closure directly yields **120** "assigned" PRs —
defensible on the data, useless as an inbox. Intersecting with `_apis/teams` drops all 27
non-teams and leaves the ticket's own wording: *a team you belong to*. A unit test pins
this, because the correct-looking simplification is to skip it.

**Correction to an earlier claim in this document: the Graph API did not "miss the actual
team."** The five-level `graph/memberships?direction=up` walk that returned only
`Contributors`, `Project Valid Users` and `Project Collection Valid Users` was my walk
being wrong, not the API. `queryMembership=Expanded` finds the team on the same host in one
request. The original text blamed the API for an error in the code that called it.

`_apis/teams` needs `7.1-preview.3`; plain `7.1` is a 400 — the third endpoint in this
project whose version could only be learned from a real credential. `identities` is fine on
plain `7.1`, but it 404s on `dev.azure.com`, which reads as a bad path rather than a wrong
host; [`ado-client.ts`](../../src/server/ado-client.ts) now takes a `host` argument so both
share one credential, one throttle gate and note 4's redirect handling.

**One client per credential, for the life of the process**
([`src/server/ado.ts`](../../src/server/ado.ts)). The rate-limit gate is state *inside* the
T-004 client, so building a new one per request would discard the fact that ADO just asked
us to back off. Keyed on a hash of org+PAT, so re-entering a token or switching orgs
replaces it and the process never holds a second plaintext copy.

**Identity comparisons are case-folded.** ADO is not consistent about GUID casing between
endpoints and every decision here is a string compare; a mismatch would not throw, it would
render an empty inbox, which reads as "nothing to review".

Authoring wins over reviewing: a PR you wrote never appears under "Assigned to me" even
when your team is on it, because it is a review request you cannot act on.

**Not verified: that the list matches the ADO web UI.** Everything above is measured
against the API, which is the same source the web UI reads, but nobody has put the two
side by side. That is a browser check and it is the one criterion still owed. The
`$mine=true` episode is the argument for actually doing it: the section was populated,
plausible, and internally consistent while resting on a filter that did not mean what the
name said.

**Surfaced for a later ticket: "Assigned to me" is technically correct and practically
empty.** All four rows are from January–March **2022**, all authored by one person, all in
`SaaS/PC.IAC.*`, and they reach this account only through a contractor group nested in a
team it is not on. The container's vote on 3302 is `-10` (rejected). Meanwhile the account
has **zero** direct reviewer assignments org-wide. So the honest reading is that there is
nothing to review, and the section is showing four abandoned PRs rather than a queue. The
levers, if that is unwanted, are an age cut-off or dropping indirect (nested-group)
membership — both are product calls, not bugs, and neither is taken here.

**Watch:** `X-RateLimit-*` still never appeared — a 4-call inbox is far too cheap to
provoke it, so `DEFAULT_CONCURRENCY = 4` remains an unmeasured guess (T-004).

**Deliberately not done.** No virtualisation: 8 rows, and T-007 owns the row work. No
per-PR calls, no vote state, no filtering or sorting controls. The reviewer's own
`votedFor[]` — which is how you would know you already voted *on behalf of* the team — is
read only far enough to identify the container; **surfaced for T-007**, which owns rich row
data. Nothing writes.

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

**Type:** task (AFK) · **Status:** resolved · **Blocked by:** T-002

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

### Resolution

One guard, one place. [`src/start.ts`](../../src/start.ts) declares the chain every
request runs before any handler; [`src/server/request-guard.ts`](../../src/server/request-guard.ts)
is the rule, and [`src/lib/launch-token.ts`](../../src/lib/launch-token.ts) is the wire
contract its client half shares.

| Criterion | Evidence |
|---|---|
| foreign `Host` rejected | `rejects a rebound host whose Origin is genuinely its own` — a request that is *same-origin for the attacker* (`Sec-Fetch-Site: same-origin`, request URL `http://attacker.example/…`) still 403s. Confirmed against both running servers: `curl -H 'Host: attacker.example'` → **403** in dev and from `pnpm start` |
| no token / stale token rejected | `rejects a server function call with no token` and `rejects a stale token from a previous launch` (right shape, right length, different boot) |
| proven at the guard level, not by curling `/_serverFn/<id>` | the tests drive `startInstance.getOptions().requestMiddleware` — the *real* chain — the way `createStartHandler` does. The real-server probes use the bootstrap path, which has a stable URL and needs no scraped id |
| works in dev **and** from `pnpm start` | headless Chrome over CDP against both: the page renders `node v24.18.0, pid 34852`, i.e. the server function completed through the new middleware |
| token not in a log line or the prerendered shell | the only 64-hex string in `.output/public` is `bcc06e11…` in `routes-*.js`, which is the `createServerFn` **RPC id**, not a secret. `tokenInDom: false` in the live DOM; the guard logs nothing |
| genuinely per-launch | two real launches handed out `bc66126c…` and `bc743a13…` |

**The bootstrap is the honest limit, and it does not close.** SSR is off and the shell is
prerendered at build time, so there is nowhere to inline a per-launch value — anything in
that HTML is baked once, shipped identically to every launch, and sits on disk. The token
must be fetched at runtime, which means exactly one request that cannot itself carry a
token. `/__launch-token` is answered by the guard before the router is consulted, and what
stands in front of it is the `Host` check plus a **widened** origin check. That makes it a
browser-only, same-origin surface — verified: a tokenless, origin-less `curl` gets **403**,
which is precisely the non-browser local process the token exists to stop.

But a local process running as this user can *forge* `Sec-Fetch-Site: same-origin` and
collect a token. **The token stops processes that don't know the protocol, not one written
against this app.** Nothing at this layer can fix that; only the OS keychain that T-003 is
about keeps a secret from a process running as its owner. Stated here rather than papered
over.

**The origin check has to be re-declared, or it silently disappears.** With no start
instance, `createStartHandler` installs a default CSRF middleware; with one, it uses
`requestMiddleware` verbatim. Adding `src/start.ts` for the `Host` guard would therefore
have *removed* what T-002 established, leaving only a dev-time warning. `the chain is
wired › still rejects a foreign origin — T-002 must not have been undone` is the regression
test for exactly that. Its filter is also widened past Start's default
(`handlerType === 'serverFn'`) to cover the bootstrap — the one page request that answers
with a secret.

**`Host` is read from the raw header, never from `request.url`.** srvx's node adapter falls
back to the socket's local address when `Host` is absent, so a request with no `Host` at
all arrives with a request URL of `http://127.0.0.1:7331/…` and sails through any
URL-based check. `rejects a request with no Host header` asserts
`request.headers.get('host') === null` first, so it cannot pass vacuously.

**Hostname only, not the ticket's literal `127.0.0.1:<port>`.** The port in a `Host` header
is client-supplied and grants nothing by itself — every rebinding case is decided by the
hostname — while pinning it would break `pnpm build`, whose prerender step drives the app
through a Vite preview server on a random port. `localhost:52341` is in
`accepts every loopback spelling, on any port` for that reason, and the passing build is
the proof it was needed.

**Forwarded headers are refused, not parsed.** A loopback-bound single-user app is never
legitimately behind a proxy. srvx only honours `X-Forwarded-Host` when `trustProxy` is on
and it defaults off — but if that ever flipped, the header would rewrite `request.url`, and
the origin check compares `Origin` against exactly that URL. Refusing them means the switch
cannot quietly become a bypass.

**Deliberately not done.** The token is not persisted — a token that outlives its launch is
one that anything which read it once can still use. No rotation within a launch: the window
is a single app run, and rotation would need a re-bootstrap path that is a second copy of
the hole above. No rate limiting or lockout on the bootstrap; it hands out a value that a
same-origin page is entitled to anyway. The guard returns a bare `Forbidden` and logs
nothing — the only interesting thing it holds is the token.

**Surfaced for T-003.** The chain is now the place a PAT-bearing server function sits
behind, and T-003 needs no hardening work of its own. Two things it inherits: server
functions reach the handler only with a current token, so any new endpoint is covered by
construction rather than by remembering; and the guard is deliberately silent, so T-003's
"no token value in a log line" requirement must be met by *its* own code — nothing here
scrubs logs.
