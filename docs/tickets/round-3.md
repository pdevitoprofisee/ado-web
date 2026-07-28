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

**Type:** feature · **Status:** done · **Blocked by:** T-015

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

### Resolution

`src/server/blob.ts` fetches, sniffs and decodes; `src/server/blob-fn.ts` is the server
function; migration 2 (`blob-cache`) in `src/server/db.ts` is the store. Measured against 60
completed pull requests in `Profisee` — **705 distinct blobs over 195 calls, 1.01 TSTU
billed**.

| Criterion | Evidence |
|---|---|
| Both sides, add and delete as results | `loadFileBlobs` returns `FileBlobs { path, before, after, renamedOnly }`; a null sha becomes `{ kind: 'absent' }` without a fetch. On !24766: an edit costs **+2** calls, an add **+1**, a delete **+1**. |
| Pure rename fetches zero blobs | !24766's rename entry: **+0** calls, `renamedOnly: true`. Sha equality is the test, not `changeType`. |
| Binary from the bytes | `/Common/Common/Resources/group24.png` → `kind: 'binary'`, 750 b, first NUL at index **8**, and **263** U+FFFD had it been decoded. The window is the first 8 KiB. |
| Size ceiling | `MAX_BLOB_BYTES = 1 MiB`. 8 of 705 refused, every one a generated `.resx` or `.Designer.cs`. Largest live blob **4,238,334 b**; largest hand-written **635,664 b**. Refusal is `{ kind: 'too-large' }`, not a throw. |
| Cached by `objectId`, survives a restart | Second open of the same file: **0** calls. **0** again after the database was closed and reopened. |
| Round trip | `/Api/web.config` — UTF-8 BOM, **27 of 27** line endings CRLF, no final newline — came back out at exactly **1011 b**, the byte count it went in at. |

**The refusal happens on bytes already in hand, not on `Content-Length`, and
[`diff-contract.ts`](../../src/lib/diff-contract.ts) said otherwise.** Its original wording for
`too-large` — refuse *before the body is read, on the declared length* — is not achievable
against this server. ADO declares a length only below about 256 KiB and switches to
`Transfer-Encoding: chunked` above it: present on **690 of 705** blobs, largest declared
**251,913 b**; absent on **15**, smallest **263,283 b**. **The two ranges do not overlap.** So
every blob big enough to refuse is exactly the blob that arrives with no declared size, and
`getBytes`' `maxBytes` check — which is correct, and free — has an empty live domain. The
count on bytes in hand is the one that refuses. Refusing unread would mean reading
`Transfer-Encoding` or aborting the stream from inside `ado-client.ts`, which is that file's
decision and was not taken here. What it costs is measured: the 4,238,334 b
`Strings.Designer.cs` takes **609 ms** to download and throw away — once per sha, because the
refusal is cached too. The contract now records the correction where the claim stood.

**The two shas travel with the request, which departs from this ticket's wording above**
("takes a PR ref and a file path"). Re-deriving them server-side costs an iterations call plus
a changes call on every file opened, and it means re-implementing `loadFiles`' parsing — the
parsing that already cost this project a shipped crash over `item.path` being `null` on a
delete ([T-015](#t-015--blob-and-diff-endpoint-inventory)). The caller already holds the
`ChangedFile` from the list it is rendering. The shas are shape-validated as hard as the GUIDs
are (`/^[0-9a-f]{40}$/i`), and a PAT holder can read any blob in the org through the browser
regardless, so nothing widens. `blob-fn.ts` records this where the code is.

**The cache is never invalidated, and that is the safety property rather than the
optimisation.** `object_id` is the sha of the content, so a row cannot come to mean something
else — no validity token as `pr_cache` has, no TTL, and no `ETag` to compare, which T-015
measured as absent anyway. `bytes` is NULL for a refused blob, so a refusal is cached at the
same price as a hit; `size` is kept beside it so that raising the ceiling makes the row stop
being an answer rather than keep refusing a file we would now render.

**One failing blob costs one side of one file.** A sha that does not exist answers HTTP 400
`TF401035`, not 404 — that side becomes `{ kind: 'failed' }` and the other side is unaffected.
Failures are not written to the cache; the good side is, so the retry costs one call rather
than two. The `catch` is not narrowed to `AdoError`: a 30-second timeout arrives as a
`DOMException` and is no better a reason to lose the file list behind it.

**Keeping the `\r` was right and it broke something else.** CRLF survives the split because the
diff has to compare it — see [T-019](#t-019--syntax-highlighting-off-the-main-thread) for what
that did to the highlighter, and how it was found.

**Deliberately not done.** Nothing prefetches: blobs are fetched when a file is opened, not
when the file list renders, so opening the 294-file !24766 still costs the file list and
nothing more. No eviction — the cache grows without bound and there is no measurement of how
fast.

**Not measured:** `fileBlobsQuery` itself was never invoked in a test. It needs a request
context to call, and `blob-fn.test.ts` was outside the implementing agent's file set;
`loadFileBlobs` beneath it is covered, the validator and the two error branches are not.

**Watch:** the ceiling should still move the first time a minified bundle goes through it. The
8 refusals in the sample are all machine-generated resources, which is the comfortable case;
nothing in the sample is a file a person wanted to read and could not.

---

## T-017 — The diff itself

**Type:** feature · **Status:** done · **Blocked by:** T-015

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

### Resolution

`src/lib/diff.ts` — a port of git's `xdiff`, not an approximation of it: `xdl_recs_cmp` and
the linear-space middle snake in `xdl_split`, end trimming, record classification,
`xdl_clean_mmatch`, `xdl_change_compact` with the indent heuristic that has been on by default
since git 2.14, and `xdl_emit_diff`. Pure, synchronous, no I/O.

| Criterion | Evidence |
|---|---|
| Against real `git diff` | **81 of 81** real blob pairs byte-exact against `git diff` at `-U0`, `-U1`, `-U3`, `-U5` and `-U10` — **81,510** lines compared. Not hand-written expectations: the oracle is the binary. |
| Against random input | **2,000 of 2,000** fuzz cases — 4 seeds × 500 mutated pairs — byte-exact at the same five context widths. |
| Indent heuristic | **40 of 40** constructed cases. |
| Identical input | 50,000 identical lines in **0.9 ms**, zero hunks. Common head and tail are trimmed before anything is searched. |
| Context and merging | `DIFF_CONTEXT = 3`; hunks that would abut are emitted as one. Byte-exactness at five context widths is what checks this — a merge boundary off by a line is a different `@@` header. |
| Counts | `added`/`removed` come off the same change script the hunks do, so they cannot disagree with them. |
| Intra-line | Word / whitespace-run / single-punctuation tokens, paired positionally, skipped above `MAX_INTRALINE_CHARS = 1000`. |
| Pathological | 5,000 lines all changed **27.1 ms**. 5,000 lines drawn from an 8-word vocabulary **255 ms**. 5,000 shuffled distinct lines — the true worst case — **264 ms** at 4.7e7 steps. One 10 MB single line **0.1 ms**. |
| The fallback | `MAX_DIFF_STEPS = 5e8`, ten times the worst case measured, throws `TooExpensive` and surfaces as `gaveUp: true` rather than a silent fallback to a worse algorithm. First trips at 20,000 shuffled lines / **2,516 ms**. |

Timings are Node 24.18 on an Intel Core Ultra 9 185H.

**Porting is not translating, and the one place that was translated instead of ported was
wrong.** `xdl_clean_mmatch` seeds both of its run counters to `1` — each run counts the line
itself, so the line is weighed twice in the ratio that follows. That reads like an off-by-one
and it is not. Seeding the second counter to `0` discarded a lone blank line sitting between
two runs of rewritten lines: the blank was real context, and the diff reported it as changed.
Found by the 81-pair cross-check, fixed back to xdiff's arithmetic, and kept as a regression
test with the reason written next to it.

**The worst case is not the one the ticket named.** 5,000 lines where every line changed is
the cheap pathology — 27.1 ms — because nothing matches and the search is shallow. 5,000
*shuffled distinct* lines is the expensive one at 264 ms, and 5,000 lines from an 8-word
vocabulary is close behind at 255 ms, because near-misses everywhere are what makes the
snake search deep. The 10 MB single line is 0.1 ms for the same reason it is uninteresting:
one line against one line, with the token diff declining to look inside it.

**None of the 81 real pairs exercise the indent heuristic.** The cross-check that carries the
most weight here has a hole in exactly the part of `xdl_change_compact` that is hardest to get
right, and the hole is covered by 40 cases written to hit it rather than by anything live. Said
plainly because the 81/81 number would otherwise read as covering more than it does.

**Deliberately not done.** xdiff's `XDL_MAX_COST_MIN` snake-sampling cutoffs are not ported —
they trade exactness for speed on huge inputs, and the step budget above is the honest version
of the same concern. Neither are `-b`/`-w` whitespace modes or the ` @@ funcname` trailer;
nothing in this round reads them.

**Not carried: `noFinalNewline`.** `BlobSide` records it per side, `git diff` prints
`\ No newline at end of file` per side, and the two sides can genuinely differ — but there is
nowhere on `FileDiff`, `DiffHunk` or `DiffLine` to put it, so it stops at the contract boundary
and the rendered diff cannot say it. The cross-check compares hunk text, which is why this did
not show up as a failure.

**Not carried: why it gave up.** `FileDiff.gaveUp` is a boolean with no reason field, so the
view can say a file was too expensive but not whether that was the line count, the step budget,
or something added later.

**Not measured:** any of this in a browser. Every number above is Node on one machine.

---

## T-018 — The row model

**Type:** feature · **Status:** done · **Blocked by:** T-017

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

### Resolution

`src/lib/diff-rows.ts`. A `RowModel { rows, layout, diff, lines, revealed }` where `rows` is a
flat `DiffRow[]` of `hunk`, `line` and `gap`, and everything else is what it takes to rebuild
that array.

| Criterion | Evidence |
|---|---|
| Flat and indexable | One `DiffRow[]`, three variants, no nesting. The virtualizer sees a length and an index and nothing else. |
| One diff, two projections | `unified` and `split` both consume the same projected line stream; the split layout pairs deletes with adds by the same positional pairing the intra-line token diff uses, and leaves the opposite cell blank where there is no partner. Switching layout is `setLayout`, which rebuilds from `diff` — there is no second diff. |
| Expansion is a defined operation | Expanding is adding a `Span` to `revealed` and rebuilding. `GAP_EXPAND_LINES = 20`, from either `'top'`, `'bottom'`, or `'all'` at once. |
| Two gaps meeting | `union` keeps the span set sorted, disjoint **and non-touching**, so two expansions that meet merge into one span and the gap row between them disappears rather than surviving as a zero-line gap. |
| Row identity | Keys are derived from line numbers, never from array index: `` `@${oldStart},${newStart}` `` for a hunk, `` `~${oldStart},${newStart}` `` for a gap, `` `${left?.oldLine ?? '-'}/${right?.newLine ?? '-'}` `` for a line. Inserting 20 rows in the middle renames nothing above or below them. |

**The evidence here is structural, not timed.** Nothing in this file was measured; the
argument for it is that the operations are total and the keys are derived from content. That
is worth stating rather than leaving the reader to infer it from an absence of numbers.

**Nothing ties a `FileDiff` to the `FileBlobs` it came from.** `buildRows(diff, lines, layout)`
takes the lines as a separate parameter because the diff has no reference back to the text it
diffed, so every caller has to carry the pair by hand and nothing catches a caller that pairs
the wrong two. It works, and it is one refactor away from being a bug that renders one file's
diff over another file's text.

**Not measured: gap expansion has no external oracle.** The diff itself is checked against
`git diff`, which is the point of [T-017](#t-017--the-diff-itself)'s 81/81. Expansion is not —
git has no equivalent of "reveal 20 more lines above this hunk", so the tests compare the row
model against the row model's own idea of what should be there. A wrong-but-consistent
expansion would pass.

**Surfaced for [T-020](#t-020--the-virtualized-diff-view):** row identity is stable, but
nothing here measures whether the virtualizer actually reuses the elements — that needs the
real page.

---

## T-019 — Syntax highlighting, off the main thread

**Type:** feature · **Status:** done · **Blocked by:** T-015

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

### Resolution

`src/lib/highlight/` — `highlighter.ts` on the main thread, `worker.ts` as the whole of the
worker, `tokenise.ts` and `bundle.ts` behind it, `plain.ts` for every path that answers plain
text. Shiki 4.3.1 through `shiki/core` with `createJavaScriptRegexEngine()`; no Oniguruma WASM,
no precompiled grammars.

| Criterion | Evidence |
|---|---|
| Bundle cost, eager | Client bundle **90.9 → 91.3 kB gzip**, +0.4. The highlighter is not in the eager graph; what it costs is what the worker costs. |
| Bundle cost, worker | Unsplit: one chunk, 1245.4 kB raw / **176.6 kB gzip**. Split: **70.2 kB gzip** to open a TypeScript file — worker 52.4, theme 2.5, typescript 15.3. |
| Off the main thread | `highlighter.ts` does not import `tokenise.ts` at all; the only path to Shiki is `new Worker(new URL('./worker.ts', …), { type: 'module' })`. |
| Batched per file | The request carries the file's whole `lines` array; the reply is `HighlightedLines`, first dimension already lines. |
| On demand | 15 grammars behind dynamic imports — typescript, tsx, javascript, jsx, json, jsonc, css, html, markdown, yaml, csharp, sql, xml, powershell, shellscript. **One** theme, `github-dark`, because `src/routes/__root.tsx:51` renders `className="dark"` unconditionally; a second theme is dead weight until that stops being true. |
| Unknown language | `languageFor` returns null and the file renders as plain lines. No extension means plain, so `Dockerfile` and `.gitignore` are plain. |
| Cache bounded | Bounded in **lines, not entries**: `MAX_CACHED_LINES = 20_000` ≈ 24 MB. A file larger than the whole cache is not cached at all rather than evicting everything. Keys are cyrb53 over the content plus the line count plus the byte length. |
| Flat per-line tree | `LineText` returns a bare string, not an element, for a line that is neither styled nor marked. |
| Not blocking the diff | `LineText` takes `tokens: null` before highlighting arrives and renders the raw text; nothing on the render path awaits the worker. `bury()` settles everything still pending as plain lines, so an unawaited `highlight()` cannot become an unhandled rejection, and `typeof Worker === 'undefined'` (prerender, jsdom) answers plain rather than failing. |
| Timings | 500 lines **124–165 ms**, 2,000 lines **438–572 ms**, 5,000 lines **980–1,321 ms**. Intel Core Ultra 9 185H, Node 24.18. |

**A CRLF file rendered with no colour at all, and the bug was in already-committed render
code.** [T-016](#t-016--blob-fetch-and-cache) keeps the `\r` on the end of the line because the
diff has to compare it. Shiki splits on `/\r?\n/` and therefore never sees it, so its tokens
for that line are one character shorter than the line. `src/components/diff/line-text.tsx`
guards against stale tokens by comparing the summed token length to the line length, that guard
failed on every CRLF line, and the fallback is plain text — so every line of every CRLF file
lost its colour. That is most files in the repositories this reviews. Fixed by accepting a
result exactly one character short when the line ends in `\r`. Neither ticket predicted this:
the two decisions are individually right and only wrong together.

**`createHighlighterCoreSync`, not `createHighlighterCore` as the Success criterion above
says.** Grammars and the theme are awaited in the worker before the highlighter is
constructed, so the async constructor buys nothing and the sync one keeps `tokenise` from
being a promise chain around a promise chain. The criterion's intent — `shiki/core`, not the
full bundle — is met; its literal wording is not, and the wording was left as it stood.

**The code split is in the build config and unverified in this build.**
`vite.config.ts:43` sets `worker: { format: 'es' }`, without which Vite's default `iife` cannot
split and the dynamic imports in `bundle.ts` mean nothing. But nothing imported the highlighter
when the bundle above was measured, so the whole module was tree-shaken out and the 70.2 kB
figure is what the same code measured elsewhere, not what this build emits. It has to be
re-measured when [T-020](#t-020--the-virtualized-diff-view) wires the worker into the view. If
it comes back at 176.6, the `format` setting is not doing what it is there for.

**Watch:** `src/lib/highlight/bundle.ts`'s header comment still describes the default `iife`,
one-lump build as the current state and says `vite.config.ts` is not that ticket's to edit.
`vite.config.ts` has since been edited. The comment is stale and will read as authoritative to
the next person.

**Watch:** the pathological case is far worse than the ordinary one. TypeScript's own
`typescript.js` — 8.7 MB, 201,040 lines — took **53.7 s** to tokenise. The worker handles one
message at a time, so a file like that blocks every request queued behind it, and at 201,040
lines it is far past the 20,000-line cache bound, so nothing about it is kept. There is no
cancellation and no size refusal on the way in.

**Not measured:** the worker has never been run in a browser. Every number here is Node.
`worker.ts` casts `globalThis` because tsconfig's `lib` is DOM rather than webworker, module
workers are not supported everywhere, and none of that has been exercised outside a test
runner.

**Not measured:** `MAX_LINE_LENGTH = 4_000`, passed to Shiki as `tokenizeMaxLineLength`, is a
number with no measurement behind it. A line longer than that renders plain, and nothing checks
how often that happens live.

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
