# Findings — shadcn/aria, TanStack versions, local git, runtime shape

Source: background research agent, verified against npm registry / primary docs, 2026-07-24.

## 1. shadcn/ui with React Aria — CONFIRMED, works

`pnpm dlx shadcn@latest init --base aria` exists. CLI `shadcn@4.14.1` (2026-07-23). Shipped July 2026.

```
-t, --template <template>  (next, vite, start, react-router, laravel, astro)
-b, --base <base>          (base, radix, aria)
-p, --preset [name]
```
- Valid bases: **`base`** (Base UI, now the default), **`radix`**, **`aria`**. Radix is NOT deprecated.
- `-t start` targets TanStack Start directly.
- **The base is stored in `style`, not a `base` field** — `components.json` `style` = `<base>-<theme>`,
  enum `{radix|base|aria}-{vega|nova|maia|lyra|mira|luma|sera|rhea}`. Docs say style *"cannot be changed
  after initialization"* → **the base is effectively locked at init** (it's just a string, so switching
  means editing `style` + re-adding components; there's an AI-skill migration path, no codemod).
- aria base installs: `class-variance-authority`, `lucide-react`, **`react-aria-components@1.19.0`**,
  + Tailwind **4.3.3** CSS-first (`@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`).
  Vite setup uses `@tailwindcss/vite`.

### Coverage — measured from the live registry (62 `registry:ui` items)
| base | components |
|---|---|
| **aria** | **57** ← most complete |
| base | 56 |
| radix | 55 |

**aria's 5 gaps:** `hover-card`, `menubar`, `navigation-menu` (React Aria has no primitive), `toast` (base only),
`form` (no base-specific links at all). Present and fine: `combobox`, `command`, `select`, `calendar`,
`sidebar`, `resizable`, `sonner`.
⚠️ Registry oddities: `radix-vega/combobox` pulls in `@base-ui/react` (looks like a bug);
the new AI-chat components carry aria-only doc links (probably metadata lag).

## 2. TanStack versions (npm `latest`, 2026-07-24)

| Package | Version | Published |
|---|---|---|
| `@tanstack/react-query` | **5.101.4** | 2026-07-21 |
| `@tanstack/react-router` | **1.170.18** | 2026-07-13 |
| `@tanstack/react-start` | **1.168.32** | 2026-07-19 |
| `@tanstack/react-virtual` | **3.14.8** | 2026-07-22 |
| `@tanstack/react-table` | 8.21.3 | 2025-04-14 (v9 in beta, v8 still `latest`) |
| `@tanstack/react-form` | 1.33.2 | 2026-07-13 |

**TanStack Start is NOT declared 1.0.** npm ships `1.168.32` as `latest` with no `rc` tag, but the live docs
still say verbatim *"TanStack Start is currently in the **Release Candidate** stage!"*; the only announcement
is the 2025-09-23 RC post; discussion #5999 asks for an ETA twice, unanswered by maintainers.
⚠️ Secondary blogs claiming "v1.0 launched March 2026" are unsupported by any primary source.
Start = Router + a server (Router is a hard dep). Vinxi dropped in v1.120; dev uses Vite directly,
prod builds a **Nitro** server. Peer `vite >=7`. Server functions can touch fs / spawn processes:
*"The build process replaces server function implementations with RPC stubs in client bundles."*

**Bonus, directly relevant:** TanStack Virtual perf release (2026-05-19) — measurements in a `Float64Array`,
lazy `VirtualItem` construction. 100k cold mount 6.1→4.5ms; **resize on 10k items 1.9s → 1.3ms**;
pixel-perfect `scrollToIndex` on dynamic lists; **direction-gated scroll adjustment that kills
"items jump while scrolling up" with dynamic heights** ← exactly our variable-height thread rows.
1M+ items still awaits a Fenwick-tree rewrite.

## 3. Local git from a web app

### (a) Browser-only (File System Access API) — REJECT
**Browser support is the disqualifier** (MDN browser-compat-data):

| API | Chrome | Firefox | Safari |
|---|---|---|---|
| `showDirectoryPicker` | 86 | **false** | **false** |
| OPFS (`getDirectory`) | 86 | 111 | 15.2 |

Firefox and Safari have **never** shipped any `show*Picker`; both vendors' standards positions are negative.
The pickers live only in the non-normative WICG draft, not the WHATWG File System Standard.

- **Chrome does NOT block `.git`** — verified in Chromium source: the only `.git` entry in `kBlockPaths[]` is
  Windows-only `.git/hooks` as `kBlockWrite`, and write-blocks are skipped unless `user_action == kSave`.
  `showDirectoryPicker` maps to `kOpen` → `.git` fully readable. But `~/.ssh`, `~/.config`, `~/Library`,
  `%APPDATA%`/`%LOCALAPPDATA%`, Program Files, `/etc` etc. are `kBlockAllChildren`.
- **Permission persistence is a per-session ritual** — handles are IndexedDB-storable, but a restored handle
  comes back as `kLoadFromStorage` → dormant-grant/re-prompt path, never auto-granted. Grants auto-revoke
  when the tab is backgrounded.
- OPFS is the *Origin Private* FS — sandboxed, invisible to git and your editor. Useless for an existing repo.
- There IS a maintained adapter — **`@jsonjoy.com/fs-fsa-to-node@4.64.0`** (memfs monorepo):
  `new FsaNodeFs(await showDirectoryPicker())` implements everything isomorphic-git needs. But:
  `symlink`/`link` throw; `FsaNodeStats` fabricates `ino/mode/dev/nlink=0` and **mtime is epoch 0**, so
  isomorphic-git's stat cache never matches → **re-hashes every file on `statusMatrix`** (correct, just slow);
  `lstat === stat`; sync API needs a worker + COOP/COEP for SharedArrayBuffer.
  ⚠️ isomorphic-git #1839 (open since 2023-11): `statusMatrix()` on memfs's own OPFS demo throws.
  The off-the-shelf combination is **not proven**.
- **The wall no adapter can fix:** every `readFile('/a/b/c/d')` is a chain of awaited `getDirectoryHandle`
  calls — one IPC round trip per path segment. A firsthand build measured **~100× slower than native fs**
  even after caching, and concluded it was *"impractical for large repositories."*
- Avoid `@isomorphic-git/lightning-fs` — IndexedDB-backed, not the real FS, and isomorphic-git's own docs
  warn it *"may apply file operations out of order, which can lead to repository corruption."*

### (b) Node side — the pragmatic choice
| Option | Verdict |
|---|---|
| **`child_process` + real `git`** | ✅ Zero deps. `git log --format=… -z`, `git diff --numstat`, `git status --porcelain=v2 -z`, `git cat-file --batch` are built for machine parsing. |
| **`simple-git@3.36.0`** | ✅ Best wrapper. **⚠️ THREE 2026 CVEs, all option-injection → RCE: CVE-2026-28292 (critical, <3.32.3), CVE-2026-28291 (<3.32.0), CVE-2026-6951 (<3.36.0). Pin ≥3.36.0; never let request data into the options array.** |
| `@napi-rs/simple-git@1.1.0` | ✅ Best no-binary option (Rust/libgit2, prebuilt, no node-gyp). ⚠️ only `diffTreeToWorkdir*` found in the API — **no `diffTreeToTree`**, which a PR diff needs. Verify first. No rename detection. |
| `nodegit` | ❌ **Dead.** `latest` = 0.27.0 from **2020-07-28**. README claims a 0.28.3 that doesn't exist on npm. |
| `wasm-git` | ❌ It's libgit2's `lg2` CLI in wasm — you parse stdout. If parsing text, use real git. |
| `isomorphic-git@1.40.0` in Node | ✅ Fine fallback with real `node:fs`. **But has NO diff command** — closed as out-of-scope (#1144). |

**isomorphic-git capability notes (for the phase-2 local-repo work):** reads packed objects (delta resolution,
`.idx` parsing) ✅, `packed-refs` ✅, branches/tags ✅, `log({ref,depth,since,filepath,follow,includeChanges})`
— **`includeChanges` is new in 1.40.0** and yields per-commit `[newOid, oldOid, filepath]`, genuinely useful.
No diff, no reflog, no submodules, no worktree API. `statusMatrix({refresh})` **defaults true and writes
`.git/index`** → needs `readwrite` or `refresh: false`. Pass `cache` — docs report a large repo going from
*">2 minutes" to "<8 seconds"*.

### The three app shapes
1. **Vite plugin `configureServer`** — one process, one `npm run dev`, same-origin, full Node.
   ❌ *"`configureServer` is not called when running the production build"*; preview needs `configurePreviewServer`.
   ⚠️ Vite's `server.fs.deny` already includes `'**/.git/**'` → don't plan on serving `.git` statically.
2. **TanStack Start server function** — works, survives production via Nitro. ❌ adopting SSR + Nitro to expose
   three endpoints, while its docs still say RC.
3. **Separate Hono 4.12.x (zero runtime deps) + `@hono/node-server`** — identical in dev and prod, fronted by
   Vite `server.proxy` so the browser only ever talks to :5173. `preview.proxy` defaults to `server.proxy`.
   ❌ two processes in dev. ⚠️ Hono's `next`/`v4` dist-tags are stale — pin `^4.12`.

**Recommended:** start as a Vite `configureServer` plugin with the handler in a **framework-free module**
you can lift into Hono the day you need a production build.

**⚠️ Localhost hardening nobody's docs cover:** a localhost server that shells out to `git` is reachable by
**any web page the user has open** — `fetch('http://localhost:3001/api/git/log')` from a random site succeeds,
and DNS rebinding defeats naive IP checks. Copy Vite's defaults: bind `127.0.0.1` (not `0.0.0.0`), validate
`Origin`/`Host`, require a per-launch random token header.

## 4. Runtime shape: localhost web app vs Tauri v2 vs Electron

**The Node sidecar collapses three problems into one thing we were already going to build:**
1. terminates CORS concerns (server-to-server has no same-origin policy; Vite `server.proxy` keeps browser same-origin)
2. reads local git natively via `child_process`
3. puts the PAT in the **real OS keychain** via `@napi-rs/keyring@1.3.0` (prebuilt, no node-gyp).
   `keytar@7.9.0` is archived/deprecated — do not use.
   **It also makes `Retry-After`/`X-RateLimit-*` readable**, which a browser SPA cannot do (see CORS findings).

- **Tauri v2 (2.11.5)** — better *shipping* answer; `@tauri-apps/plugin-http` requests from Rust outside the
  WebView, scoped by capability allowlists; keychain access; ~3–10 MB binary. Costs: Rust toolchain,
  capabilities/permissions model, WebView2 (preinstalled on Win11). Secret story is weaker than Electron's —
  Stronghold is a password-derived vault, not the OS keychain; `keyring` bindings are community-maintained.
- **Electron (43.2.0)** — least attractive: ~150 MB Chromium, solves CORS by rewriting headers. Its one real
  edge is **`safeStorage`**, a first-party OS-keychain API (DPAPI/Keychain/libsecret).
- **Browser-only storage — reject on the secret question:** `localStorage`/IndexedDB are plaintext and fully
  readable by any XSS. The non-extractable `CryptoKey`-in-IndexedDB trick only stops exfiltrating the raw key;
  injected script can still *use* it. Buys nothing against the threat that matters.

**Net: localhost + Node sidecar now; Tauri v2 if it ever needs to be double-clickable; Electron only for `safeStorage`.**

## ⚠️ Conflict resolved: ADO CORS

This agent flagged ADO CORS as uncertain ("community reports say preflights fail; no definitive MS doc").
**Superseded** — the dedicated ADO agent ran a live preflight against `dev.azure.com` and got
`HTTP 200` + `Access-Control-Allow-Origin: *`, and recovered the deleted MS doc page stating CORS is supported.
Live evidence beats absence of a doc. See `ado-cors-listing-diffs.md`.
Note this does NOT undercut the sidecar — the sidecar's value is rate-limit headers, the keychain, and local git.

## Other uncertainty flags
- TanStack Start 1.0 status (npm vs docs banner)
- `@napi-rs/simple-git` commit↔commit diff support
- isomorphic-git worktree support (assume no)
- Chromium's FSA blocklist is implementation policy, not spec
- libgit2-based JS options pin libgit2 1.9.4, predating the 2026-07-18 security releases (1.9.5/1.9.6);
  the high-severity CVE is smart-transport-only, unreachable for local reads
