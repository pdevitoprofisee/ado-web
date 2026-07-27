# Findings — CORS, PR listing, identity, diffs

Source: background research agent. `[LIVE]` = verified against dev.azure.com by curl on 2026-07-24.
`[DOC]` = MS primary docs. `[UNCERTAIN]` = flagged, do not build on blind.

## 1. CORS — SUPPORTED. No proxy needed for CORS reasons.

MS documented it explicitly; the page was **deleted 2023-11-10** (commit `49b6ab0d`) and now 302s to
`call-rest-api`, which is why people wrongly conclude CORS is unsupported. Verbatim from the last live version:

> Azure DevOps supports cross-origin resource sharing (CORS). CORS enables JavaScript code served from a
> domain other than `dev.azure.com/*` to make Ajax requests to Azure DevOps Services REST APIs.
> **For this to work, each request must provide credentials (personal access tokens and OAuth access
> tokens are both supported options).**

…with a jQuery sample using `'Authorization': 'Basic ' + btoa("" + ":" + myPatToken)`.
Raw markdown at that commit:
`https://raw.githubusercontent.com/MicrosoftDocs/azure-devops-docs/5024732a0e35bca6e6582c0c56ffefb614c6d341/docs/integrate/concepts/cross-origin-resource-sharing.md`

`[LIVE]` preflight `OPTIONS https://dev.azure.com/{org}/_apis/projects` with `Origin: http://localhost:5173`:
```
HTTP 200
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: OPTIONS,GET,POST,PATCH,PUT,DELETE
Access-Control-Allow-Headers: authorization          ← echoes whatever you request
Access-Control-Max-Age: 3600
Access-Control-Expose-Headers: ActivityId,X-TFS-Session,X-MS-ContinuationToken,X-VSS-GlobalMessage,ETag,WWW-Authenticate
Access-Control-Expose-Headers: Request-Context
```
- `ACAO: *` — arbitrary origins, not an allowlist. Present on every ADO host we need
  (dev.azure.com, vssps.dev.azure.com, vsrm, extmgmt, almsearch, analytics), on real 200s, and on 401s.

### Four gotchas that make people misdiagnose CORS
1. `ACAO: *` with **no** `Access-Control-Allow-Credentials` → must use `credentials: 'omit'` (fetch default).
   `credentials: 'include'` makes the browser reject an otherwise-allowed response. A manually-set
   `Authorization` header is still sent under `omit`.
2. **On auth failure ADO returns `302` to a sign-in page, not `401`** `[LIVE]` → surfaces in-browser as an
   opaque CORS/redirect error. **Fix: send `X-TFS-FedAuthRedirect: Suppress`** → verified clean `401`
   with CORS headers and readable `WWW-Authenticate`. Caveat: Sprint 205 notes tightened this header
   w.r.t. Entra CAP policies — likely moot for PAT.
3. **`X-RateLimit-*` and `Retry-After` are NOT in `Access-Control-Expose-Headers`** `[LIVE]` → a browser
   SPA **cannot read them**. See §5. This is the ONLY strong technical argument for a thin proxy.
4. Old GitHub reports of missing ACAO (azure-devops-extension-api#100, #39) are stale/misdiagnosed — most
   likely hit gotcha #2.

Security tradeoff (not technical): a PAT in browser storage is XSS-exfiltratable, bearer-equivalent, and
cannot be scoped per-origin. MS actively steers away from PATs. Use narrowest scopes + shortest expiry.

## 2. Listing PRs

| Scope | Route | `project` |
|---|---|---|
| Per-repo | `GET /{org}/{project}/_apis/git/repositories/{repoId}/pullrequests` | optional |
| Per-project | `GET /{org}/{project}/_apis/git/pullrequests` | **required** |
| Single PR | `GET /{org}/_apis/git/pullrequests/{prId}` | optional |

### Org-wide PR route — docs say no, but the route EXISTS `[LIVE]`
Discriminator found: ADO **routes before it authenticates**, so a nonexistent controller returns 404
"controller for path not found" even unauthenticated, while a real route returns 401.
```
/_apis/git/notarealcontroller  → 404   (route missing)
/_apis/git/pullrequests        → 401   ← route EXISTS at org scope
/_apis/policy/evaluations      → 404   ← genuinely requires {project}
```
`[UNCERTAIN]` whether it *returns cross-project results* — one authenticated curl settles it.
**Test this first: if it works, the entire project fan-out disappears.**
Documented fallback: org-level `GET /{org}/_apis/git/repositories` DOES span projects → 1+N (repos, then
per-repo PRs by GUID) beats the projects→repos→PRs walk.

### searchCriteria
`creatorId`, `reviewerId`, `status` (`notSet|active|abandoned|completed|all`, default active), `sourceRefName`,
`targetRefName`, `repositoryId`, `includeLinks`, `minTime`, `maxTime`, `queryTimeRangeType`, `$top`/`$skip`.
`maxCommentLength` documented verbatim as "Not used." `7.2-preview.2` adds `labels`, `tagsFilterOperator`, `title`.
No continuation token — page until `count < $top`. `[UNCERTAIN]` max `$top` undocumented; 400–500 observed.

### ⚠️ DANGEROUS FAIL-OPEN — validate the GUID client-side `[LIVE]`
On a repo with 2 PRs:

| `searchCriteria.creatorId` | result |
|---|---|
| omitted | 2 |
| correct GUID | 1 ✅ |
| different valid GUID | 0 ✅ |
| `someone@example.com` | **2** ⚠️ |
| `zzzzz` | **2** ⚠️ |

**A non-GUID is silently ignored — you get UNFILTERED results, not a 400.** "My PRs" would silently render
as "everyone's PRs". Validate GUID shape before sending. Query param names are case-insensitive `[LIVE]`.

### Getting your own identity GUID
`creatorId` wants the **IMS Identity id** (= Graph storage key = VSID), org-scoped, same value as `createdBy.id`.
**Use `GET https://dev.azure.com/{org}/_apis/connectionData` → `authenticatedUser.id`** `[LIVE]` (200, org-scoped
by construction; omit api-version as MS's own libraries do).
Traps: `profiles/me.id` equals the VSID **only** if signed into the home tenant / no tenants — guests and
multi-tenant diverge. Graph `originId` is the Entra object id — wrong identifier. Don't base64-decode descriptors.

### Reviewer votes
`10` approved · `5` approved with suggestions · `0` no vote · `−5` waiting for author · `−10` rejected.
Plus `isRequired`, `hasDeclined`, `isFlagged`, **`isContainer`** (team/group reviewer) and **`votedFor[]`**
(group votes roll up) → needed to catch PRs assigned to a group you belong to.

## 3. Diffs — the client MUST diff blobs itself

### Iterations
`GET .../pullRequests/{id}/iterations?includeCommits=` → `id`, `sourceRefCommit`, `targetRefCommit`,
**`commonRefCommit`** (merge base), `push`, `author`, `reason`, `commits`, `hasMoreCommits`,
`newTargetRefName`/`oldTargetRefName` (on retarget).
`IterationReason`: push|forcePush|create|rebase|unknown|retarget|resolveConflicts.

### Iteration changes — `$compareTo` IS the "since my last review" lever
`GET .../iterations/{iterationId}/changes?$top=&$skip=&$compareTo=`
- `$compareTo` = *"ID of the pull request iteration to compare against. Default zero = compare against the
  common commit."*
- `$top` default 100, **max 2000** (documented here, unlike the PR list).
- Response carries **`nextTop`/`nextSkip`** — real server-driven paging; both 0 when exhausted.
- `[LIVE]` shape: `{"changeEntries":[{"changeTrackingId":1,"changeId":1,"item":{"objectId":"2E53…","path":"/es-metadata.yml"},"changeType":"add"}]}`
  `originalObjectId` appears only when a prior version exists.
- `changeType` is a `[Flags]` enum — **parse as a comma-separated set** (`"edit, rename"`). `[UNCERTAIN]` exact serialization.

### Fetching before/after content `[LIVE]` — all variants tested
| Call | Result |
|---|---|
| `blobs/{sha}?$format=text` | **raw text** (Content-Type: application/octet-stream) |
| `blobs/{sha}?$format=octetstream` | raw bytes (only form compatible with `resolveLfs`) |
| `blobs/{sha}?$format=json` | **metadata ONLY** — `{objectId,size,url,_links}`, no content |
| `items?path=…&versionDescriptor.version={sha}&versionDescriptor.versionType=commit&includeContent=true&$format=json` | JSON with `content` as **plain unescaped text** (not base64) |

**Confirmed live:** `changeEntries[].item.objectId` works directly as the blob sha →
`objectId` = "after", `originalObjectId` = "before". No path/commit resolution needed, **rename-proof**.
Use `$format=json` first to read `size` and skip huge/binary files cheaply.
Casing trap: `items` uses the `versionDescriptor.` prefix; `diffs/commits` uses bare `baseVersion`/`targetVersion`.

### There is NO unified diff text anywhere `[LIVE]`+`[DOC]`
`diffs/commits` returns file metadata only — no lines, no hunks. It also returns **`tree` entries** for touched
directories, so filter `gitObjectType == "blob"` or counts and `$top` paging skew.
`GitChange.newContent` is never populated on read (azure-devops-node-api#571). No `.diff`/`.patch` media type exists.

**One useful preview API:** `POST /{org}/{project}/_apis/git/repositories/{repoId}/FileDiffs?api-version=7.2-preview.1`
body `{baseVersionCommit, targetVersionCommit, fileDiffParams:[{path, originalPath}]}` → `FileDiff[]` with
`lineDiffBlocks[{changeType, originalLineNumberStart, originalLinesCount, modifiedLineNumberStart, modifiedLinesCount}]`
(changeType 0 None, 1 Add, 2 Delete, 3 Edit). Verified in `azure-devops-extension-api/src/Git/GitClient.ts` + 4 Learn
type pages. `[LIVE]` route exists on the normal PAT `_apis/` surface (GET→405, POST→401 authz not auth-scheme).
Returns **hunk geometry with no line text** — not a unified diff, but gives ADO's own hunk boundaries and rename
detection so our rendering matches the ADO UI. Preview; guard it.
Avoid `_api/_versioncontrol/fileDiff` (legacy web-UI surface, session auth).

**Diff pipeline:** iterations → `changes` (+`$compareTo`) → two `blobs/{sha}?$format=text` per file →
diff locally (jsdiff / diff-match-patch) → optionally `FileDiffs` for hunk geometry.

## 4. Builds / checks (corroborates the earlier findings file)

- Requeue policy evaluation is the documented, policy-linkage-preserving way to re-run a PR build:
  *"only build policies perform any action in response. Requeueing a build policy will queue a new build to
  run (cancelling any existing build which is running)."*
- `[LIVE]` **`stageRefName` is the Stage timeline record's `refName`/`identifier` = the YAML stage id**, not the
  display name. Proven: `{"name":"Evaluate Paths","refName":"EvaluatePaths","identifier":"EvaluatePaths"}`.
  For a pipeline with no explicit stages the ref name is **`__default`**.
  `forceRetryAllJobs: false` retries only failed jobs; `true` retries all.
- `[LIVE]` Timeline `TimelineRecord.type` values observed: `Stage`, `Phase`, `Job`, `Task`, `Checkpoint`, `Container`.
  Records carry `state`, `result`, `startTime`/`finishTime`, `errorCount`/`warningCount`, `issues[]`,
  `log{id,url}`, `attempt`, `previousAttempts`. Step log: `GET _apis/build/builds/{buildId}/logs/{logId}`.
- `GitStatusState` at 7.2 adds `partiallySucceeded`.
- `[LIVE]` **`threads` ignores `$top`** — returned all 7 threads with `$top=1`. No pagination.

## 5. 🚩 The browser-specific rate-limit catch `[LIVE]`

`X-RateLimit-Cost: 0.01317` is on the wire but **not exposed to cross-origin JS**, and neither is `Retry-After`.
So a pure browser SPA **cannot** implement MS's documented best practice (watch `X-RateLimit-Remaining`,
honor `Retry-After`) — and remember throttling manifests as **slow HTTP 200s** long before any 429.
Mitigation without a proxy: budget requests client-side, serialise fan-out at concurrency 3–5, cache
aggressively, treat latency spikes as the throttling signal.
**This — not CORS — is the real argument for a thin local proxy.**

## 6. Batching — none for PRs `[LIVE]`

`_apis/$batch` → 404 route-missing. `_apis/git/pullrequestsbatch` → 404 route-missing.
`wit/workitemsbatch`, `.../pullrequestquery`, `graph/subjectlookup`, `graph/subjectquery` → 405 (exist, POST-only).
**N+1 is unavoidable for PR threads/statuses/iterations.** `pullrequestquery` only maps commit IDs → PRs
(`GitPullRequestQueryType`: notSet|lastMergeCommit|commit) — no creator/reviewer dimension, won't help.
**`graph/subjectlookup` IS a real win** — batch-resolve many identities in one POST for avatars/names.
`[LIVE]` no `ETag` on `items`. Analytics OData returned 401 for every entity set incl. `$metadata`, so this
agent could not confirm the absence of a PullRequests entity set — but a separate agent confirmed from the
documented data model that **no PullRequests entity set exists in any Analytics version.** Treat as closed.

## Two things to verify in five minutes with a real PAT (→ the inventory Task ticket)

1. Does org-wide `/{org}/_apis/git/pullrequests` return cross-project results?
2. One live `statuses` response, to confirm the Sonar `genre`/`name` split.
