# Findings — Sonar on ADO PRs, ADO rate limits, batching

Source: background research agent. Primary sources = learn.microsoft.com, docs.sonarsource.com,
SonarSource community, sonarqube-community-branch-plugin source, azure-devops-cli-extension source.

## Sonar on ADO: what actually gets posted

**Both** a quality-gate PR *status* AND **one comment thread per issue** (inline annotations).

- ADO is the one platform that has **never** had a Sonar summary comment (GitHub has it; ADO ask is
  open with no ETA as of 2025-12). Users report **200+ individual Sonar comments per PR**.
  → DESIGN IMPLICATION: Sonar threads will swamp a naive thread list. Must be grouped/folded
    separately from human threads.
- Inline annotations are opt-out server-side ("Enable Inline Pull Request Annotations"); turning it
  off keeps QG status and suppresses new issue comments but does not delete existing ones.
- Architectural correction: the ADO *pipeline extension* (`SonarQubePublish@6`) does NOT post to the PR.
  It writes the QG result to the **build** summary. The PR status + threads are written **server-side by
  SonarCloud** using a configured ADO PAT. So "extension version" is the wrong axis for this behaviour.

### Identifying Sonar threads (no documented marker)

No well-known `thread.properties` key — the OSS decorator sets no properties at all. Identify by, in order:
1. `comments[0].author.id` == the identity that owns Sonar's configured ADO PAT.
   **Discover that id from `createdBy.id` on the Sonar QG status itself** — no manual config needed. ← best
2. Comment body links to the Sonar host / matches `^\[See in SonarQube\]\((.*?)\)$`
3. `commentType == "text"` + `threadContext.filePath` present

## Reading the QG from ADO alone

- `GET .../pullRequests/{id}/statuses?api-version=7.1` — filter `context.genre` ∈ {`SonarQube`,`SonarCloud`}
  (match case-insensitively; both appear in the wild, plus lowercase) and `context.name == "quality gate"`.
  Take newest by `creationDate`. `state` = `succeeded` (QG OK) / `failed` (QG ERROR).
  `GitStatusState` enum: notSet, pending, succeeded, failed, error, notApplicable.
  Only the *latest* status per unique `context` is displayed by ADO.
- **`targetUrl` already encodes projectKey + prId** (`{sonarBase}/dashboard?id={projectKey}&pullRequest={prId}`)
  → Sonar API params are derivable from the ADO status with zero extra configuration. ← load-bearing for auto-discovery
- Policy evaluations tell you whether it *blocks*. Read genre/name from `configuration.settings`,
  **not** from `context` (undocumented, schema-unstable).
- ADO cannot give you: metrics, new-code coverage, issue counts, duplication, per-condition results, hotspots.
  Those need the Sonar Web API.
- Status policy type GUID = `cbdc66da-9728-4af8-aada-9a5a32e4a226`, but MS does not officially publish these
  → enumerate `GET _apis/policy/types` and match `displayName == "Status"`.

## Sonar Web API (PR-scoped)

- `GET /api/qualitygates/project_status?projectKey={key}&pullRequest={prId}` — statuses OK|WARN|ERROR|NONE
- `GET /api/issues/search?componentKeys={key}&pullRequest={prId}&ps=500&p=N`
  - `pullRequest` param is **not available in Community edition** (irrelevant for SonarCloud)
- `GET /api/measures/component?component={key}&pullRequest={prId}&metricKeys=new_coverage,new_violations,…`
- Auth: user token as Basic username, empty password — `Authorization: Basic base64(token + ":")`.
  Bearer also accepted on modern versions. Needs `Browse` on the project.

## ADO rate limits — the real constraints

- TSTU = blended load unit. 1 TSTU ≈ average load of a typical user over 5 min.
  Normal spikes ≤10 TSTU/5min; large spikes up to 100; **global limit 200 TSTU per sliding 5-min window**.
- **THE BIG GOTCHA:** *"Honor the Retry-After header… The response still returns HTTP 200, so retry logic
  isn't required."* A client that only branches on 429 will silently eat stalls of **up to 30 seconds**.
- Blocking → HTTP 429 with `TF400733`.
- Useful response headers: `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix epoch),
  **`X-RateLimit-Cost`** (TSTUs consumed by this request — the lever for empirically pricing PR fan-out).
- **`azure-devops-node-api` does not surface response headers at all** (issue #661) → argues for a
  hand-rolled fetch client over the official SDK.

## Batching — what exists and what doesn't

**No general `$batch` envelope.** Empirically confirmed: no `pullrequestsbatch` route (404).

- Best fan-out reducer: `GET {org}/{project}/_apis/git/pullrequests?$top=&$skip=` returns
  `GitPullRequest[]` **across all repos in a project in one call**, filterable by
  `searchCriteria.{status,creatorId,reviewerId,repositoryId,sourceRefName,targetRefName,minTime,maxTime}`.
- `POST vssps.dev.azure.com/{org}/_apis/graph/subjectlookup` — batch identity resolution
  (avoids N lookups hydrating createdBy/reviewers).
- **NOT batchable — `pullRequestId` is a mandatory path segment:** PR statuses, PR threads,
  policy evaluations, PR iterations/commits/reviewers.
- `GitPullRequest` (list response) contains **no statuses and no threads**.
  → **Reading check state + comment counts for N PRs is irreducibly 1 + N calls.**
  (Near-miss trap: nested `GitCommitRef`/`GitForkRef` *do* have `statuses[]`, but those are
   *commit* statuses, a different namespace, unpopulated in list responses.)
- OData Analytics has **zero Azure Repos data** — no PullRequests entity set in any version. Not an escape hatch.
- **No ETag / If-None-Match / 304 on any PR endpoint.** Don't design around it.
  Cheap-invalidation lever instead: cache per-PR data keyed on `lastMergeSourceCommit.commitId`
  from the single project-wide list call; skip per-PR calls when it hasn't moved.
- MS best practice explicitly recommends **service hooks (`ms.vss-code.git-pullrequest-*`) over polling**
  → relevant to the notification decision, but service hooks need a reachable HTTP endpoint.
- `GET _apis/git/pullrequests` truncates `description` to 400 chars.
- PRs with >100,000 modified files don't support iterations.
