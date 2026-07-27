# Findings — SonarCloud Web API for the ADO PR client

Source: background research agent. Live probes against `sonarcloud.io` on 2026-07-24 (`Sonar-Version: 13.7.0.4381`).
Best machine-readable source: `GET https://sonarcloud.io/api/webservices/list?include_internals=true`
and `GET /api/webservices/response_example?controller=api/issues&action=search`.

## 1. Auth

**Use `Authorization: Bearer <token>`.** Documented verbatim; it's also what SonarSource's own ADO extension
uses for Cloud (Basic is the SonarQube *Server* convention, which Cloud still tolerates but doesn't document).

Token types — **only a personal access token can read issues**:
| Token | Reads issues? | Minted at |
|---|---|---|
| **Personal access token** | ✅ the only one | My account → Access Tokens → Personal Tokens. Expiry 7/30/60/90d or custom (1d–1y). Tokens with no expiry auto-removed after 60d inactivity. ⚠️ tab only available to users signed in with GitHub. |
| Scoped Organization Token (`sqco_`) | ❌ | *"can only be granted the Execute analysis permission"*. Team/Enterprise only. |
| Agent app token | n/a | For SonarQube MCP Server; ≤1 hour. |

Extension source confirms analysis tokens can't read: *"It is expected if you are not using a user token but
instead a global or project analysis token."*
Bonus: responses carry **`SonarQube-Authentication-Token-Expiration`** — surface it as a rotation warning so
token expiry doesn't look like an outage.

## 2. CORS — REJECTED. A server-side proxy is mandatory.

SonarSource staff, 2022-02-14: *"We don't have any plans to enable CORS on SonarCloud… you will want to make
sure the SonarCloud API is called on the **server-side and not on the client-side**."*

Live probe:
```
GET     /api/issues/search  (Origin: localhost:5173) → 400, Access-Control-Allow-Origin: *
OPTIONS /api/issues/search  (+ Access-Control-Request-Headers: authorization) → 405, NO CORS headers
```
`Authorization` is not CORS-safelisted → an authenticated call **mandates** a preflight → preflight 405s with no
CORS headers → the browser blocks before sending. The `ACAO: *` on GETs appears to be injected by CloudFront,
is undocumented, and contradicts stated policy — do not build on it.
**Independently confirms the decision to route all Sonar calls through our own server.**

## 3. Quality gate for a PR

`GET /api/qualitygates/project_status?projectKey=<key>&pullRequest=<adoPrId>`

⚠️ **The entire `api/qualitygates` v1 controller is deprecated as of 2025-09-16, and there is NO v2 replacement.**
SonarSource's answer in the deprecation thread (2026-04) was "use the pipeline task or webhooks" — no v2 endpoint,
no removal timeline. It still works and is still the only source of the per-condition breakdown.
**Isolate it behind one function in the proxy.**

Response: `projectStatus.status` ∈ **OK | WARN | ERROR | NONE** (NONE = no gate associated; WARN is legacy but
still declared — handle all four). Conditions carry `status`, `metricKey`, `comparator` (LT/GT), `errorThreshold`,
`actualValue` (**all strings**), `periodIndex`. ⚠️ `errorThreshold` is **absent** on some conditions — guard for it.
`projectId` param *"Doesn't work with branches or pull requests"* — use `projectKey`.

**Two better-supported alternatives:**
- **`GET /api/project_pull_requests/list?project=<key>`** — *not deprecated*. One call gets every PR with
  `status.qualityGateStatus`, `analysisDate`, `commit.sha`, and `url` back to the DevOps PR.
  **Recommended as the primary gate source**, with `project_status` only for the condition breakdown.
- `GET /api/measures/component?component=<key>&pullRequest=<id>&metricKeys=…` — not deprecated. The metric set
  the official extension uses: `new_violations`, `pull_request_fixed_issues`, `new_accepted_issues`,
  `new_security_hotspots`, `new_coverage`, `new_duplicated_lines_density`.

## 4. Issues for a PR

`GET /api/issues/search?componentKeys=<key>&pullRequest=<adoPrId>&ps=500&additionalFields=rules,_all`

- **`componentKeys` is current on SonarCloud** — there is NO `projects`, `projectKeys`, or `components` param, and
  `componentKeys` carries no `deprecatedSince`. (SonarQube **Server** 10.x renamed it to `components`; that has
  NOT landed on Cloud. **Don't copy Server examples.**)
- Paging: `p` 1-based, `ps` default 50, **max 500**. PR-scoped sets are small — one page almost always suffices.
- Per-issue fields: `key`, `rule`, `message`, `line`, `hash`, `textRange{startLine,endLine,startOffset,endOffset}`,
  `component`, `project`, `issueStatus`, `severity`(legacy), `type`(legacy), `effort`, `author`, `creationDate`,
  `tags`, `flows[].locations[]`, `ruleDescriptionContextKey`, `cleanCodeAttribute(Category)`,
  **`impacts[{softwareQuality, severity}]`**.
- Sibling arrays in the same response: **`components[]`** (key, **path**, name, qualifier), **`rules[]`**
  (key, name, lang), `users[]`, `paging`.

### Anchoring onto diff lines
- **`component` is a component key, not a path** (`<projectKey>:<relative/path.ext>`). **Do not string-split it** —
  join against `components[]` and read **`path`**, which is repo-root-relative and matches ADO's `item.path`
  minus the leading `/`.
- `textRange` offsets are 0-based characters, lines 1-based → precise inline highlighting, not just a gutter marker.
- `line` may be **absent** for file/project-level issues → fall back to a file-level annotation.
- ⚠️ **Line drift:** Sonar's `line` is relative to the **head commit it analyzed**. If the PR has been pushed to
  since, line numbers drift. Cross-check `analysisDate` against the PR's latest commit and degrade to a file-level
  annotation when stale. `hash` (line hash) exists to help re-locate a moved line.
- `flows[].locations[]` can live in other files; treat cross-file flows as best-effort.

### Clean Code (MQR) taxonomy is authoritative — legacy fields are actively unreliable
| Legacy (deprecated) | Since | Current |
|---|---|---|
| `severities` | 2023-08-25 | **`impactSeverities`** (INFO/LOW/MEDIUM/HIGH/BLOCKER) |
| `types` | 2023-08-25 | **`impactSoftwareQualities`** (MAINTAINABILITY/RELIABILITY/SECURITY) |
| `statuses`, `resolutions` | 2024-07-03 | **`issueStatuses`** (OPEN/CONFIRMED/FALSE_POSITIVE/ACCEPTED/FIXED) |

**Drive the UI off `impacts[]`, `cleanCodeAttribute(Category)`, and `issueStatus`.** The response still emits legacy
`severity`/`type`/`status`/`resolution`, but the official example shows `"type":"RELIABILITY"` — i.e. legacy `type`
is now being filled with software-quality values, so **branching on it is unreliable. Ignore it.**
(`type` is also not accepted in the `f` field list — more evidence it's being retired.)
Facets available for a summary bar: `impactSoftwareQualities`, `impactSeverities`, `cleanCodeAttributeCategories`.

## 5. Rule detail

`GET /api/rules/show?key=<ruleKey>&organization=<orgKey>` — **`organization` is REQUIRED on SonarCloud**
(it isn't a param at all on Server — another Server-example trap). Not deprecated.

Returns `htmlDesc`, `mdDesc`, and **`descriptionSections[{key, content}]`** where key ∈
`introduction`, `root_cause` ("Why is this an issue?"), `how_to_fix`, `assess_the_problem`, `resources`.
Pair with the issue's **`ruleDescriptionContextKey`** (e.g. `"spring"`) to pick the framework-specific
`how_to_fix` variant. Also `params[]`, `cleanCodeAttribute`, `impacts[]`, `sysTags`, `remFn*`.

🚩 **HIGHEST-PRIORITY THING TO VERIFY WITH A REAL TOKEN:** live *unauthenticated* `rules/show` returned metadata
but **no `htmlDesc`, no `mdDesc`, no `descriptionSections`** (1066 bytes) on multiple rules; `rules/search` with
`f=htmlDesc,descriptionSections` likewise omitted them. The new **`requiredEntitlements`** field hints they may be
plan-gated. If they stay withheld with a token, fall back to the public rule site
`https://rules.sonarsource.com/<lang>/RSPEC-<n>/` or link out. **This is load-bearing for the in-app detail view.**

**Batch + cache:** rule content is static per `(ruleKey, organization)`. Use
`GET /api/rules/search?rule_key=a,b,c&organization=<org>&f=name,htmlDesc,descriptionSections,cleanCodeAttribute,impacts&ps=500`
to warm **every rule in a PR in ONE call** instead of N. Cache ~forever with a manual bust.

## 6. ADO → Sonar mapping (the load-bearing one)

### The `pullRequest` key IS the ADO PR id — confirmed in extension source
`SonarSource/sonar-scanner-azdo` (renamed from `sonar-scanner-vsts`), `prepare-task.ts`:
```ts
props["sonar.pullrequest.key"] = tl.getVariable("System.PullRequest.PullRequestId");  // for TfsGit
props["sonar.pullrequest.provider"] = "vsts";
```
So for Azure Repos: **Sonar `pullRequest` == ADO `pullRequestId`. Zero transformation.**
Caveats: a GitHub-hosted repo built by ADO pipelines uses `PullRequestNumber` instead; and a team-set
`sonar.pullrequest.key` in `extraProperties` **wins** over the auto-populated value. Handle a miss gracefully.

### 🚩 The extension does NOT decorate the PR — and there's a 50-comment cap
`publish-task.ts` only writes a **build property** (`sonarglobalqualitygate`) and a **build summary attachment**.
No `createPullRequestStatus`, no `createThread` anywhere in the extension.
**SonarCloud itself** decorates the PR server-side over a configured ADO PAT, triggered by webhook after analysis.

SonarCloud creates **both**:
- PR status check → `context.genre = "SonarCloud"`, `context.name = "quality gate"`
- **One comment thread per issue** — *"each SonarQube issue is displayed as a comment"*, and status changes in
  SonarCloud reflect back into ADO.

⚠️ **BUT: *"The number of comments posted in the timeline of a pull request is limited to 50. If this limit has
been reached, a message will be displayed as a comment, with a link to the rest of the issues on SonarQube Cloud."***

→ **DESIGN CONSEQUENCE: read Sonar findings from the Sonar API, not from ADO comment threads.** Past 50 issues the
ADO threads are literally incomplete. This also hands us `rule` keys, `impacts`, and `textRange` directly — which
is exactly what rule-grouping needs. It is *why* this feature is worth building.

### Discovering the `projectKey` — cheapest → most reliable
1. **ADO PR statuses** → `context.genre === "SonarCloud"` → parse `id=` out of `targetUrl`
   (`https://sonarcloud.io/dashboard?id=<projectKey>&pullRequest=<prId>`). **One call, no Sonar auth, and it gives
   the gate state for free. Do this first.**
2. **ADO PR threads** → regex `sonarcloud\.io/project/issues\?id=([^&]+)` over comment bodies. Fallback when no
   status policy is configured.
3. Build properties (`sonarglobalqualitygate`) confirm a run happened but carry **no projectKey**. Weak.
4. **Validate (not discover) via `GET /api/project_pull_requests/list?project=<key>`** — `key` = the ADO PR id,
   `url` points back at the DevOps PR. ⚠️ the response's own `pullRequestId` is a **Sonar UUID, not the ADO id** —
   the ADO id is `key`. Don't mix them up.
5. Brute force: `GET /api/projects/search?organization=<org>&q=<repoName>` and fuzzy-match. Heuristic.

⚠️ **No ALM/binding endpoint exists on v1** — all 33 controllers enumerated with `include_internals=true`;
there is no `api/alm_settings` on Cloud (unlike Server). So no supported v1 call answers "which projectKey is
bound to ADO repo X". v2 (`api.sonarcloud.io`) may; spec not fetchable unauthenticated (403).
⚠️ The `targetUrl`/comment-link shapes come from community logs, not a normative spec page — **parse defensively
and ship a manual override** (needed anyway for monorepos, which Sonar doesn't support for branch policies).
Cache the `repo → projectKey` mapping once discovered; it's stable.

## 7. New-code scoping — nothing to do

*"Pull request analysis **only reports issues that were introduced by the pull request itself**."*
So every issue from `issues/search?pullRequest=…` is already new-code, and every PR gate condition is a `new_*`
metric. No filter needed.
- ⚠️ **`inNewCodePeriod` does NOT exist on SonarCloud** (0 occurrences in the live descriptor) — Server-only
  param, will 400.
- `sinceLeakPeriod` exists but is a branch/main-line concept; redundant under PR scope.
- Documented caveat to surface in the UI: if the **target branch is stale**, issues added to it since its last scan
  *"will appear as part of the pull request analysis, even though they were not introduced by the pull request."*
- "Fixed by this PR" signal: metric `pull_request_fixed_issues` via `api/measures/component`.

## 8. Rate limits

*"Your API calls will fail with a **429**… wait a few minutes before retrying."* No documented numbers; the only
figure SonarSource has given is informal: **"under 1k requests per minute, you should be good."**
**No `Retry-After` or `X-RateLimit-*` headers** — assume a bare 429 and exponential backoff with a floor of minutes.

Budget per PR view is tiny — ~4 calls:
```
1 × project_pull_requests/list  +  1 × issues/search?ps=500
1 × qualitygates/project_status  +  1 × rules/search?rule_key=… (batched)
```
Real risks are re-fetching on every render and an N+1 `rules/show` loop. Batch rules; cache rule content ~forever,
issues/gate 30–60s per (project, PR). **Don't poll** — SonarSource recommends webhooks into a backend
(also the deprecation-proof path for the gate).

## Verify with a real token before committing

1. **Whether rule descriptions are auth-gated** (§5) — highest priority; load-bearing for the detail view.
2. Exact `targetUrl` / comment-link format (§6) — parse defensively regardless.
3. Whether v2 (`api.sonarcloud.io`) exposes a PR quality gate or an ADO project binding — would remove our only
   deprecated dependency.
4. Line drift on a PR with post-analysis pushes (§4).
