# Round 3 — the diff

Phase 3 of [the route](./round-1.md#the-route). [Round 2](./round-2.md) ended with a list of
changed files and nothing behind them. This round puts the file contents there.

Same conventions: each ticket states **success criteria**, not steps; facts referenced by
number come from [the notes](../map.md#the-notes); every ticket carries a
**Type · Status · Blocked by** line.

**The one fact that shapes this whole round: Azure DevOps has no unified diff.** There is no
endpoint anywhere in the REST surface that returns `@@ -1,7 +1,9 @@` and a patch. The
changes endpoint gives you two blob shas per file; `blobs/{sha}?$format=text` gives you the
bytes; and the diff is ours to compute. That is not a limitation to route around — it is the
work.

**What this round is not.** No comments and no threads, so no anchoring a comment to a line —
phase 4. No checks, no Sonar. Nothing writes: no suggestion is applied, no thread resolved.
Still a `GET`-only reading surface.

**What it has to beat.** The PR this project exists for has 300 Sonar comments and a real
diff, and the ADO web UI renders it by putting every line of every file in the DOM at once.
[The research](../research/) measured the alternatives: react-diff-view's own benchmark is
**26,072 ms** to render a 375-file diff, and no React diff library on npm virtualizes. So the
row list is virtualized here, and the highlighter runs off the main thread, because the
target is a diff you can scroll — not a diff that eventually appears.

---

## T-015 — Blob and diff endpoint inventory

**Type:** task (HITL — needs a real credential) · **Status:** resolved · **Blocked by:** —

Every other ticket in this round reads a blob. Nothing else starts until it is known what a
blob response actually is: what `$format` does, whether the bytes are faithful, what a binary
file looks like coming back through a `text` endpoint, what a missing sha answers, and
whether any of it is cacheable.

**Success:** for each blob and change endpoint, the accepted `api-version`, the response
shape, the caching headers, and the failure statuses are recorded from live calls. Binary and
large files are sampled rather than reasoned about. Where the sample could not produce a
case, that is written down as *not measured* rather than filled in from documentation.

### Resolution

Three read-only probes against `Profisee`: a change-kind census over 15 active pull requests,
a blob-format matrix, and a binary/size/rare-change pass over 14 completed ones. Raw payloads
kept in the session scratchpad. No `POST`, no `PUT`, nothing written.

| Question | Measured |
|---|---|
| `$format` on a blob | `text`, `octetstream`, and **omitted entirely** returned byte-identical bodies (11309 b). Only `json` (607 b of metadata) and `zip` (2433 b, `PK` magic) differ. |
| `api-version` on a blob | **Optional.** Omitting it worked. First endpoint in the project that does not care. |
| `Content-Type` | `application/octet-stream; api-version=7.1` **whatever `$format` asked for** — it carries no text-versus-binary signal at all. |
| Byte fidelity | text body length === `$format=json`'s `size` exactly (11309). No BOM, bare `LF`, no NUL, file ends `";\n"`. |
| `Content-Length` | Present and exact (2464 for a 2464 b body), readable before the body. |
| `HEAD` | **405.** There is no cheap size probe — but the `GET` header above makes one unnecessary. |
| `ETag` | **None.** Irrelevant: a blob is addressed by the sha of its content, so a cache keyed on `objectId` never needs invalidating. |
| `X-RateLimit-Cost` | **Absent on blob text.** Only `$format=json` carried one (`0.01298`). [T-008](./round-1.md)'s cost figure is a floor, and blob traffic will make it a worse one. |
| Binary through `$format=text` | A `.png` came back as **intact bytes** — 588 b === `size`, magic `89 50 4e 47 0d 0a 1a 0a`, first NUL at index **8**. Decoding it as UTF-8 produced **204** U+FFFD. |
| Absent-but-valid sha | **400**, `TF401035: The object '000…' does not exist.` Not a 404. |
| Malformed sha | **400**, `An object ID must be 40 characters long and only have hex digits.` |
| Sha casing | **Uppercase** 40-hex, everywhere. |
| `$compareTo` | Works. !24798 (2 iterations): full diff 7 files, `$compareTo=1` → 1 file. |
| `nextTop` / `nextSkip` | **Absent** when the list is exhausted — not `0`, as the research doc says. |
| Change-entry ordering | Not by `changeId`. Observed `1, 2, 3, 4, 6, 5`. |
| Change-kind census | 14 completed PRs: `edit` 237, `add` 92, **`delete` 16**, `rename` 2, `edit, rename` 1. 15 active PRs: `add` 20, `edit` 109 — **no deletes and no renames at all**. |
| Largest blob sampled | 7164 b / 106 lines. |

**Where the two halves of a change live is a trap, and it cost us a shipped crash.**
`originalObjectId` sits on `entry.item`; `originalPath` sits on `entry`. So the before-sha and
the before-path are in different objects, and the first probe written against this endpoint
read `entry.originalObjectId`, got `undefined` for every entry, and crashed.

Worse, on a **delete** ADO sends `item.path` as literal **`null`** and puts the real path on
`entry.originalPath`. [T-012](./round-2.md#t-012--pr-detail-server-layer)'s `loadFiles`
guarded with `path === undefined`, and `null !== undefined`, so every deleted file was pushed
through with `path: null` — and
[T-013](./round-2.md#t-013--pr-detail-ui)'s `FileRow` calls `file.path.lastIndexOf('/')`.
Live !24766 has 294 changed files, 16 of them deletes, and the page threw
`TypeError: Cannot read properties of null` and rendered nothing.

**Four live smoke tests passed over that bug**, and the census above says why: they were all
run against *active* pull requests, and the active sample contains no deletes. The
completed-PR sample is the only place the case exists. Fixed in `83e2714`, with the payload
shape as a fixture; `ChangedFile` gained `originalPath` in the same change, which this round
needs anyway for a rename's old name.

**A pure rename has no content to diff.** `changeType: 'rename'` came back with
`objectId === originalObjectId` (both `21C62CD8…`) — the bytes did not move, only the name
did. `edit, rename` has two different shas. So sha equality is the correct test for "fetch no
blobs", and it is also the one case where "unchanged" is right about the content while being
wrong about the file, which the UI has to say out loud.

**`sourceServerItem` is absent** from live change entries, despite appearing in the API
reference as the rename source. `originalPath` is the real key.

**Not measured.** No blob over 7164 b was found in the sampled trees, so every large-file
number in [T-016](#t-016--blob-fetch-and-cache) is a policy choice rather than a fitted one,
and the ceiling should be revisited the first time a real minified bundle goes through it. No
throttling was observed during any probe, so the concurrency for blob fan-out is still
[T-001](./round-1.md)'s labelled guess.

**Deliberately not probed:** `POST .../pullRequests/{id}/iterations/{i}/FileDiffs`. It is a
`POST` against an org full of colleagues' pull requests, and [the map](../map.md) already
records it as optional — *"useful only to make our hunk boundaries match theirs"*. We compute
hunks locally and do not need to agree with ADO about where they start.

---

## T-016 — Blob fetch and cache

**Type:** feature · **Status:** open · **Blocked by:** T-015

Turning a `ChangedFile` into two sides of text, without fetching the same blob twice and
without pulling a 40 MB bundle into memory because someone opened the file list.

**Success:**

- A server function takes a PR ref and a file path and returns both sides of that file, with
  `add` (no before) and `delete` (no after) as first-class results rather than errors.
- A pure rename — `objectId === originalObjectId` — fetches **zero** blobs.
- Binary is detected from the bytes, not the extension and not `Content-Type`, and reported
  as binary rather than rendered as U+FFFD. The `.png` in T-015 is the fixture.
- A blob over a stated size ceiling is refused **without** its body being read, and the
  refusal is a result the UI can render, not a thrown error.
- Blobs are cached by `objectId` and survive a restart. The cache is never invalidated,
  because a sha cannot mean two things, and the ticket says so where the code says so.
- A second open of the same file makes **no** ADO calls, measured against the client's own
  call counter rather than asserted.
- Line splitting preserves what was in the file: `CRLF`, a missing final newline, and a BOM
  each survive a round trip or are recorded as deliberately normalised.

**Watch:** blob text carries no `X-RateLimit-Cost`, so a diff that fetches 200 blobs spends
budget this project cannot see. Whatever concurrency this uses, `calls` is the only honest
meter.

---

## T-017 — The diff itself

**Type:** feature · **Status:** open · **Blocked by:** T-015

Two arrays of lines in, hunks out. Pure, synchronous, no I/O, no React — the one piece of
this round that can be tested exhaustively.

**Success:**

- Line-level diff producing hunks with correct old/new line numbers on every line, verified
  against `git diff` output on real files from this repository rather than against
  hand-written expectations.
- Identical input produces zero hunks and does not walk the file.
- Context between hunks is bounded and adjacent hunks merge rather than abutting.
- Added and removed counts match the hunks.
- Intra-line changes are marked, so a one-character edit does not read as a whole line
  replaced.
- A pathological input — a 5,000-line file where every line changed, and a file that is one
  10 MB line — completes in a stated time on a stated machine, or the ticket records the
  fallback taken instead.

---

## T-018 — The row model

**Type:** feature · **Status:** open · **Blocked by:** T-017

Hunks are not what a virtualizer renders. A virtualizer renders a flat, indexable,
measurable list of rows, and unified and side-by-side are two projections of the same diff.

**Success:**

- A flat row array, addressable by index, covering hunk headers, lines, and the collapsed
  gaps between hunks.
- Unified and side-by-side are the same diff projected twice, not two code paths. Side-by-side
  pairs a delete with the add opposite it and leaves a blank where there is none.
- Expanding a collapsed gap is a row-array operation with a defined result, including the
  case where expanding two gaps makes them meet.
- Row identity is stable across an expansion, so a virtualizer does not remount everything
  above the click.

---

## T-019 — Syntax highlighting, off the main thread

**Type:** feature · **Status:** open · **Blocked by:** T-015

**Success:**

- Shiki via `shiki/core` + `createHighlighterCore` + `createJavaScriptRegexEngine()`, not the
  full bundle and not the Oniguruma WASM — the research measured ~70–78 KB gzip against
  ~200 KB, and the bundle cost is checked rather than assumed.
- Highlighting happens in a worker. The main thread never tokenises.
- Tokenising is batched **per file**, not per line, and the result is `ThemedToken[][]` whose
  first dimension is already lines.
- Grammars and themes load on demand; a file whose language is not bundled renders as plain
  text rather than failing.
- A tokenised file is cached by content hash, and the cache is bounded.
- The rendered per-line tree stays flat — GitHub measured an 8-to-2 element collapse as ~50%
  of the memory and 78% of the INP.
- The diff renders **before** highlighting arrives and is not blocked by it.

**Do not** use `createJavaScriptRawEngine()` or precompiled grammars. The research records
both as experimental and unsupported.

---

## T-020 — The virtualized diff view

**Type:** feature · **Status:** open · **Blocked by:** T-016, T-018, T-019

**Success:**

- Rows are virtualized with TanStack Virtual — what GitHub used, for a measured 10× reduction
  in JS heap and DOM nodes.
- A file with 5,000 changed lines scrolls without the row count showing up in the frame time,
  measured on the real page and not in a benchmark harness.
- Opening a file does not refetch a file already open, and closing one does not throw away
  what it cost to fetch.
- Every non-text outcome from T-016 renders as itself: binary, too large, added, deleted,
  renamed-without-changes.
- The page still answers the round-2 question — *what is stopping this from merging* — before
  the diff loads. The diff is added to that page, not put in front of it.
- Verified against a live pull request with a real spread of change kinds, including at least
  one delete and one rename, with what was actually looked at written down.

---

## T-021 — Viewed

**Type:** feature · **Status:** open · **Blocked by:** T-016

Reviewing 300 comments across 40 files means knowing which files you already read.

**Success:**

- A file can be marked viewed, and the mark persists across a restart.
- The mark is keyed to the **content**, not the path: a new push that changes the file
  un-views it, and a new push that does not, does not.
- Progress is visible from the file list without opening anything.
