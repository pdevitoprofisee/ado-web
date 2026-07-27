# PR detail — live API inventory

Supplementary probing for phase 2 (the PR detail page). Read `live-inventory.md` first;
this document only covers what that one did not: the per-PR detail endpoints.

Everything marked **[LIVE]** was measured against org `Profisee` with a real PAT over
read-only GETs (~1,300 calls across four throwaway probe scripts, zero writes). Where a
condition never occurred in the org during the probe window it is marked
**[COULD NOT MEASURE]** rather than answered from documentation — this project has been
bitten three times by a verdict that contradicted its own raw data.

Corpus at probe time **[LIVE]**: 164 active PRs (149 `succeeded`, 15 `conflicts`),
19,489 completed, 1,480 abandoned; 3,288 change entries enumerated across the 164 active PRs.

---

## Corrections to earlier documents — read these first

**T-008's rate-limit claim is wrong.** T-008 recorded that `x-ratelimit-cost` appears
"on `_apis/connectionData` and on nothing else". It appears on **seven** of the endpoints
this app calls, deterministically — 329/329 calls to `labels`, 275/275 to `changes`,
30/30 to `pullRequests/{id}`. See §6 for the full table. The header's presence is a
property of the endpoint, not of the moment.

**`mergeFailureMessage` is not a thing you can read.** The map's phase-2 sketch assumes a
conflicted PR explains itself through `mergeFailureMessage` / `mergeFailureType`. Live,
those keys are **absent entirely** from all 15 conflicted PRs — not empty, not null,
absent. The conflict detail lives behind a separate route the project had not inventoried
(`pullRequests/{id}/conflicts`). See §1.

**The T-001 short-page trap does *not* generalise to `changes`.** It was worth testing —
it does not apply. `iterations/{n}/changes` pages honestly. See §4.

---

## 1 · Merge status and conflicts

### What `mergeStatus` values actually occur **[LIVE]**

| PR status | n | `mergeStatus` observed |
| --- | --- | --- |
| active | 164 | `succeeded` 149, `conflicts` 15 |
| completed | 19,489 | `succeeded` 19,489 |
| abandoned | 1,480 | *key absent on every one* |

Draft has no bearing on it — conflicts occur on both (`draft=true conflicts` 9,
`draft=false conflicts` 6).

**[COULD NOT MEASURE]** `queued`, `rejectedByPolicy`, `failure`, `notSet`. Not one
occurrence across 21,133 PRs. `queued` in particular is a transient the service passes
through within seconds of a push, so a detail page polling a freshly-pushed PR will
plausibly see it — the UI must treat unknown `mergeStatus` strings as "unknown, show
neutral" rather than switch exhaustively. Note also that **`mergeStatus` is an absent key
on abandoned PRs**, so the field is `string | undefined`, not `string`.

### `mergeFailureMessage` / `mergeFailureType` do not exist on conflicted PRs **[LIVE]**

All 15 conflicted active PRs were fetched individually via `GET .../pullRequests/{id}`.
`hasMergeFailureMessage: false` and `hasMergeFailureType: false` on 15/15. The full key
set of a conflicted PR's detail response:

```
_links, artifactId, codeReviewId, createdBy, creationDate, description, isDraft,
lastMergeSourceCommit, lastMergeTargetCommit, mergeId, mergeStatus, pullRequestId,
repository, reviewers, sourceRefName, targetRefName, status, supportsIterations, title, url
```

`lastMergeCommit` is also absent (there is no merge commit to point at). A detail page
must not key off `lastMergeCommit` existing.

### The route that *does* answer it: `pullRequests/{id}/conflicts` **[LIVE]**

Plain `api-version=7.1`, no preview needed. Returns the conflicted files by name.

```
GET {project}/_apis/git/repositories/{repo}/pullRequests/{id}/conflicts?api-version=7.1
```

Census over all 15 conflicted PRs — 41 conflicts total:

| `conflictType` | count |
| --- | --- |
| `editEdit` | 36 |
| `deleteEdit` | 4 |
| `editDelete` | 1 |

Key union across all 41 entries:

```
baseBlob, sourceBlob, targetBlob, resolution, mergeOrigin, conflictId,
mergeBaseCommit, mergeSourceCommit, mergeTargetCommit, conflictType, conflictPath, url,
resolutionStatus, resolvedBy, resolvedDate
```

The last three appear only on conflicts someone already resolved in the web UI — a real one:

```json
{
  "conflictId": 2,
  "conflictType": "editEdit",
  "conflictPath": "/Server/WebPortal.Infrastructure/Caches/CacheKey.cs",
  "resolutionStatus": "resolved",
  "resolvedBy": "Michael Peacock",
  "resolvedDate": "2026-01-23T20:06:48.1494747Z",
  "resolution": { "mergeType": "userMerged", "userMergedBlob": { "objectId": "b51ba3a…" } }
}
```

An unresolved conflict carries `"resolution": {}` — an empty object, not a missing key.

**Safe to call unconditionally.** On a merge-clean PR (!24794) the route returned
**200 with `count: 0`**, not 404. But it costs a call, so gate it on
`mergeStatus === 'conflicts'` anyway.

`conflictPath` is a repo-absolute path with a leading slash, matching `changeEntries[].item.path`
exactly — so the detail page can mark conflicted rows in the file tree by direct string match.

**What this changes:** the conflict banner cannot be a message echoed from the PR payload.
It has to be "N files conflict" built from `/conflicts`, listing `conflictPath` and
`conflictType`. That is strictly better than the string ADO's own UI shows.

---

## 2 · Reviewers and votes

Measured over all 357 reviewer entries on the 164 active PRs — 197 people, 160 containers.
45 PRs carried at least one non-zero vote.

### Vote distribution **[LIVE]**

| `vote` | meaning | count |
| --- | --- | --- |
| `10` | approved | 75 |
| `5` | approved with suggestions | 5 |
| `0` | no vote | 251 |
| `-5` | waiting for author | 13 |
| `-10` | rejected | 13 |

All five documented values occur live. Reviewer key union:

```
_links, displayName, hasDeclined, id, imageUrl, isContainer, isFlagged,
isRequired, reviewerUrl, uniqueName, url, vote, votedFor
```

### Flag frequencies **[LIVE]**

| field | true / present | notes |
| --- | --- | --- |
| `isContainer` | 160 / 357 | teams and groups; **45% of reviewer rows are not people** |
| `isRequired` | 150 / 357 | 127 on containers, only 23 on people |
| `hasDeclined` | 12 / 357 | always alongside `vote: 0` in every observed case |
| `votedFor` | 117 / 357 | **0 on containers, 117 on the 197 people** |
| `isFlagged` | 0 / 357 | **[COULD NOT MEASURE]** |

`votedFor` is an *absent key* on the other 240 rows, never `null` and never `[]`.

**`isRequired` mostly marks the team, not the person.** A page that renders "required
reviewers" by filtering `isRequired` on people will show almost nothing — the requirement
sits on `[Products]\Contributors`. Render containers as first-class reviewer rows.

### `votedFor[]` — direction is the opposite of the intuitive reading **[LIVE]**

`votedFor` hangs off the **person** and names the **container(s) their vote counted
toward**. It never appears on a container. Entry shape:

```json
{
  "reviewerUrl": "https://dev.azure.com/Profisee/{proj}/_apis/git/repositories/{repo}/pullRequests/24789/reviewers/cc86398c-…",
  "vote": 0,
  "displayName": "[Products]\\Contributors",
  "url": "https://spsprodcus2.vssps.visualstudio.com/…/_apis/Identities/cc86398c-…",
  "_links": { "avatar": { "href": "…" } },
  "id": "cc86398c-49fe-4239-9765-4a4da7535e01",
  "uniqueName": "vstfs:///Classification/TeamProject/{projectGuid}\\Contributors",
  "imageUrl": "…",
  "isContainer": true
}
```

**The nested `vote` inside a `votedFor` entry is always 0** — verified across all 117
entries (`votedForNestedVoteAlwaysZero: true`). It is *not* the container's vote and it is
*not* the person's vote. Read it and you render "no vote" for approved teams. Ignore it.

The container's real vote is its own top-level `vote`. Cross-checking 86 containers that
had at least one member vote for them, and 31 with multiple members: **0 disagreements** —
the container's vote always equalled at least one of its voters'. It is the max/most-recent,
not a consensus:

```json
{ "pr": 24735, "container": "[Products]\\Contributors", "containerVote": 10,
  "voters": [ {"name":"Dmitri Konradi","vote":0}, {"name":"Alex Jarvis","vote":0}, {"name":"Zane Johnston","vote":10} ] }
```

No container had a non-zero vote with no member accounting for it. So:
**to attribute a team approval to a human, scan people for `votedFor[].id === container.id`
and take the person whose own `vote` matches the container's.**

`hasDeclined` people can still carry `votedFor` (!23024, !23004) or not (!22782, !22781).
Do not couple the two.

---

## 3 · Labels and work items

### Labels — the per-PR call is redundant **[LIVE]**

12 of 164 active PRs carry labels. `pullRequests/{id}/labels` was called for **all 164** and
compared field-by-field against the `labels` array already present on the PR *list* entry:
`listMatchesEndpoint: true`, `mismatches: []`. The only delta is that the endpoint adds a
`url` per label:

| source | keys |
| --- | --- |
| list entry `labels[]` | `id`, `name`, `active` |
| `/labels` endpoint | `id`, `name`, `active`, `url` |

10 distinct names in the org (`Playwright`, `Matching`, `Messaging`, `Monitor`, `Data`,
`Automation`, `SDK`, `Config/Setup`, `Monolith`, `FF ON  Match_Child_Attributes`),
`active: true` on all of them — 0 inactive seen.

**Skip the call.** The inbox list already has everything the detail page needs to render
label chips. Saves one round trip and 0.0034 TSTU per PR open.

### Work items — the call *is* needed, and it is two calls **[LIVE]**

92 of 164 active PRs have work items; max 17 on one PR; 128 distinct ids org-wide across
the active set. `labels` is on the list payload — **`workItemRefs` never is** (0/164).

`pullRequests/{id}/workitems` returns refs only, and **`id` is a string**:

```json
{ "id": "162828", "url": "https://dev.azure.com/Profisee/_apis/wit/workItems/162828" }
```

So titles need the batch call. Confirmed working **[LIVE]** on plain `api-version=7.1`,
both org-scoped and project-scoped (`{project}/_apis/wit/workitems`, both 200):

```
GET _apis/wit/workitems?ids=162828,162829
    &fields=System.Id,System.Title,System.State,System.WorkItemType
    &errorPolicy=omit&api-version=7.1
```

```json
{ "id": 162828, "rev": 4,
  "fields": { "System.Id": 162828, "System.WorkItemType": "Task",
              "System.State": "Active",
              "System.Title": "Update DBStrategyConverter to handle external systems PAC" },
  "multilineFieldsFormat": {},
  "url": "https://dev.azure.com/Profisee/_apis/wit/workItems/162828" }
```

Three limits measured:

- **200 ids max.** 210 ids → HTTP **500** `VS403474: You requested 210 work items which exceeds the limit of 200`. Chunk.
- **One bad id poisons the whole batch.** An id the caller can't see → HTTP **404** `TF401232: Work item 999999999 does not exist, or you do not have permissions to read it`, and the *good* ids in the same request are lost. Adding **`errorPolicy=omit`** → **200** with the survivors. Always send it; deleted work items are normal.
- **`fields` matters enormously.** All 128 ids without `fields`: **283,839 bytes**, 18 fields each. Same ids with the four fields above: **14,253 bytes**. A **20×** reduction for the same information.

All 128 ids in one call: 200, 37,304 bytes, 228 ms.

---

## 4 · Paging `iterations/{n}/changes` — it is honest

The largest active PR is **!23194** (`matching`), **1,096 changed files**, 5 iterations.
Three independent enumerations of its last iteration were compared as **sets of paths**,
not as lengths.

### `$top` behaviour sweep **[LIVE]**

| requested `$top` | returned | `nextTop` | `nextSkip` | ms | bytes |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1 | 1 | 161 | 198 |
| 5 | 5 | 5 | 5 | 137 | 924 |
| 100 | 100 | 100 | 100 | 150 | 25,013 |
| 1000 | 1000 | 96 | 1000 | 247 | 260,242 |
| 1095 | 1095 | 1 | 1095 | 267 | 287,661 |
| 1096 | 1096 | *absent* | *absent* | 233 | 287,912 |
| 1097 | 1096 | *absent* | *absent* | 235 | 287,912 |
| 2000 | 1096 | *absent* | *absent* | 226 | 287,912 |
| 5000 | 1096 | *absent* | *absent* | 228 | 287,912 |
| 100000 | 1096 | *absent* | *absent* | 228 | 287,912 |

Four things fall out of that table:

1. **`returned === min($top, remaining)` with no shortfall, ever.** Unlike the PR list, this endpoint does not filter after applying `$top`. A short page here really is the last page.
2. **`$top` does not clamp** — not at 1000, not at 100000. The whole 1,096-file PR came back in a single 288 KB / ~230 ms call.
3. **`nextTop` / `nextSkip` are absent on the last page**, present on every other. That is a clean termination signal.
4. **`nextTop` means `min(requested $top, remaining)`**, not "the page size to ask for next". This looked like a service bug in the first probe (a 6-file PR returned `nextTop: 1`). Hypothesis tested explicitly on !24698 (6 entries): asked 1→`nextTop 1`, 2→`2`, 5→`1`, 6→absent, 7→absent. `hypothesis: true`. **Do not feed `nextTop` back in as your page size** — you will crawl the tail one file at a time. Keep your own `$top` and only use `nextSkip` (or absence of it) as the cursor.

**Default page size with no `$top` is 100** — `{"entries":100,"nextTop":100,"nextSkip":100}`.
Omitting `$top` on a big PR silently truncates to 100 files with no error.

### The set comparison **[LIVE]**

```json
{ "baselineTop2000": 1096, "baselineUnique": 1096,
  "pagedMatchesBaseline": true, "followedMatchesBaseline": true,
  "shortPageBeforeEnd": false }
```

45 blind `$skip`-25 pages, the service-directed `nextTop`/`nextSkip` walk, and the single
`$top=2000` call all produced the **identical set of 1,096 paths**, with no duplicates and
no short page before the end.

**What this changes:** for change enumeration, ask for `$top=2000` once and be done.
Paging code is only needed as a safety net for a PR larger than any that exists in this org
today, and when written it should terminate on *absence of `nextSkip`*, advance by its own
`$top`, and ignore `nextTop`.

---

## 5 · Change entries

Census over 3,288 entries across all 164 active PRs.

### `changeType` values seen live **[LIVE]**

| value | count |
| --- | --- |
| `edit` | 2,578 |
| `add` | 588 |
| `delete` | 77 |
| `edit, rename` | 40 |
| `rename` | 5 |

**[COULD NOT MEASURE]** `sourceRename`, `undelete`, `branch`, `merge`, `property`,
`targetRename`, `encoding`, and any three-flag combination. None occurred. The map's note
that `changeType` is a `[Flags]` enum parsed as a comma-separated set is **confirmed live**
by `"edit, rename"` — split on `/,\s*/` and treat it as a set; do not `switch` on the
whole string.

### `isFolder` never appears **[LIVE]**

**0 folder entries in 3,288.** The `item.isFolder` key was not present on a single entry.
Folder-filtering logic in the file tree is dead code against this org — but the key is
genuinely optional in the schema, so read it as `item.isFolder === true`, never
`!item.isFolder` as a proof of file-ness.

### Entry shape **[LIVE]**

Key union over all entries — entry level: `changeId`, `changeTrackingId`, `changeType`,
`item`, and `originalPath` on renames. Item level: `path`, `objectId`, `originalObjectId`.

```json
{ "changeTrackingId": 1, "changeId": 1,
  "item": { "objectId": "CFD51864A9B135C07DB55523540AD2662598582D", "path": "/.config/dotnet-tools.json" },
  "changeType": "add" }
```

Two traps in renames:

```json
{ "changeTrackingId": 2, "changeId": 2, "changeType": "edit, rename",
  "originalPath": "/Utilities.Healthchecks/Constants.cs",
  "item": { "path": "/Utilities.Healthchecks/Utilities.HealthChecks/Constants.cs",
            "objectId": "FE4808C464A13F2CE1DF931206752E3C925A38E6",
            "originalObjectId": "CEB53156C0900469DECDB10E52D6DD8420E9EB8A" } }
```

- **`originalPath` sits at the *entry* level, `originalObjectId` at the *item* level.** They are siblings in meaning but not in the payload.
- **A pure `rename` has `objectId === originalObjectId`.** Verified on all 5. So a pure rename needs no blob fetch and no diff — render it as a move. Only `edit, rename` needs both blobs.

**`changeId` is not returned in sorted order** (`changeIdMonotonic: false`). Sort client-side
by `item.path` for a stable file tree; do not assume service ordering.

`objectId` is upper-case hex in `changes`, lower-case in the blob response — the blob route
accepts either (map note confirmed):

```json
{ "objectId": "cfd51864a9b135c07db55523540ad2662598582d", "size": 414,
  "url": "…/blobs/cfd51864a9b135c07db55523540ad2662598582d",
  "_links": { "self": {…}, "repository": {…} } }
```

---

## 6 · `x-ratelimit-cost` per endpoint

Header presence is **deterministic per endpoint** — every endpoint was either 100% or 0%,
never mixed, at sample sizes up to n=329. T-008's "connectionData and nothing else" is
disproved.

| endpoint | header / calls | min | max | mean (TSTU) |
| --- | --- | --- | --- | --- |
| `_apis/connectionData` | 7/7 | 0.00038 | 0.00064 | 0.00049 |
| `_apis/git/pullrequests` (list) | **0/33** | — | — | — |
| `_apis/identities` (vssps) | **0/1** | — | — | — |
| `_apis/teams` | **0/7** | — | — | — |
| `_apis/wit/workitems` (batch) | 8/8 | 0.00093 | 0.14876 | 0.03854 |
| `git/repositories/{r}/blobs/{sha}` `$format=json` | 6/6 | 0.00484 | 0.01207 | 0.00680 |
| `git/repositories/{r}/blobs/{sha}` `$format=text` | **0/6** | — | — | — |
| `pullRequests/{id}` | 30/30 | 0.00544 | 0.01783 | 0.00904 |
| `pullRequests/{id}/commits` | 12/12 | 0.00550 | 0.07219 | 0.03044 |
| `pullRequests/{id}/conflicts` | 16/16 | 0.00165 | 0.00818 | 0.00377 |
| `pullRequests/{id}/iterations` | **0/178** | — | — | — |
| `pullRequests/{id}/iterations/{n}/changes` | 275/275 | 0.00493 | 0.14762 | 0.01282 |
| `pullRequests/{id}/labels` | 329/329 | 0.00240 | 0.03810 | 0.00336 |
| `pullRequests/{id}/statuses` | **0/11** | — | — | — |
| `pullRequests/{id}/threads` | **0/11** | — | — | — |
| `pullRequests/{id}/workitems` | 329/329 | 0.00258 | 0.01050 | 0.00490 |
| `policy/evaluations` | **0/12** | — | — | — |

Notes that matter more than the numbers:

- **The same route can bill differently by format.** The blob route emits a cost on `$format=json` and *nothing* on `$format=text` — the diff pipeline's actual read path is the unmeasured one.
- **Absence is not free.** Nine endpoints report nothing, including the two the app hits hardest (the PR list, and `threads` in phase 4). Any budget built from this header is a **floor**, not a total. Do not build the throttle model on it.
- **Cost tracks payload size, not call count.** `changes` spans 0.005→0.148 (30×) and the work-item batch 0.0009→0.149 (160×), both driven by row count. `fields=` on the work-item batch is a rate-limit optimisation as much as a bandwidth one.

### Budget for one PR detail page open **[LIVE, floor]**

`pullRequests/{id}` 0.009 + `commits` 0.030 + `changes` 0.013 + `workitems` 0.005 +
`wit/workitems` batch ~0.001 (typical 1–2 items) + `conflicts` 0.004 when conflicted
≈ **0.06 TSTU billed**, plus the unbilled `iterations`, `threads`, `statuses`,
`policy/evaluations`. Against the 200-TSTU / 5-minute window that is ~0.03% per open —
a 30-second poll of an open detail page spends ~0.6 TSTU per window. Not a constraint.
The constraint remains what T-008 found: throttling arrives as a slow HTTP 200 with
`Retry-After`, so measure latency, not this header.

---

## Summary of what changes for the detail page

1. **Call `/conflicts` when `mergeStatus === 'conflicts'`.** There is no merge failure message on the PR object to render. Plain `7.1`; returns `conflictPath` + `conflictType`; `conflictPath` matches `changeEntries[].item.path`.
2. **Drop the `/labels` call.** The inbox list payload already carries identical label data.
3. **Keep the `/workitems` call, and always chase it with `_apis/wit/workitems?…&fields=…&errorPolicy=omit`** — chunked at 200. Without `errorPolicy=omit` a single deleted work item 404s the whole batch.
4. **`changes` with `$top=2000` in one call**; ignore `nextTop`; terminate on missing `nextSkip`. Never omit `$top` (silent 100-file truncation).
5. **Reviewers: containers are 45% of rows and hold most of the `isRequired` flags.** Render them. Read a container's vote from its own top-level `vote`; the `vote` nested inside `votedFor[]` is always 0 and is a trap.
6. **Treat `mergeStatus` as `string | undefined`** and unknown values as neutral — `queued` and friends were never observed but are reachable, and abandoned PRs omit the key.
7. **Parse `changeType` as a comma-separated flag set**; a pure `rename` (`objectId === originalObjectId`) needs no diff; `originalPath` is on the entry, `originalObjectId` on the item.
8. **The single-PR detail fetch earns its place only for the description.** Its key delta over a list entry is `_links` + `artifactId`, but the list truncates `description` at 400 characters: 59 of 165 active PRs sit at exactly 400 and the detail values for six of them ran 436–3,024 characters, with the list value a byte-exact prefix in every case **[LIVE]**. (Two PRs measured 401–402 in the list, so treat 400 as approximate, not a contract.)
