// Throwaway spike for T-029. Not application code — do not import from it.
//
// Phase 5 is checks: statuses, policy evaluations, the build, its timeline, the
// failing step's log, and the failed tests. Six endpoint families, none of them
// touched by rounds 1–4. This probes all of them against the live org and writes
// docs/research/checks-inventory.md with the raw shapes.
//
//   node scripts/checks-inventory.mjs
//
// Optional: ADO_ORG / ADO_PAT (skip the credential store),
//           ADO_BUILD_ID + ADO_PROJECT (skip build selection).
//
// **Read-only by construction.** Every request below is a GET. Phase 5's whole
// point is re-running someone else's build, and there is no way to probe that
// without doing it, so the re-run request shapes are documented from Microsoft's
// reference and from `src/server/pull-request.ts`'s already-shipped requeue and
// marked unproven. Nothing in this file sends anything but a GET — there is one
// assertion below that enforces it.

import { writeFile, mkdir } from 'node:fs/promises'

async function credentials() {
  const fromEnv = { org: process.env.ADO_ORG, pat: process.env.ADO_PAT }
  if (fromEnv.org && fromEnv.pat) return fromEnv

  try {
    const store = await import('../src/server/credentials.ts')
    const ado = store.readAdoCredential()

    return {
      org: fromEnv.org ?? ado?.org,
      pat: fromEnv.pat ?? ado?.pat,
      source: 'credential store',
    }
  } catch (err) {
    console.error(`(credential store unreadable: ${err?.message ?? err})`)

    return fromEnv
  }
}

const { org: ORG, pat: PAT, source } = await credentials()

if (!ORG || !PAT) {
  console.error('No ADO credential. Either set ADO_ORG and ADO_PAT, or store one at /onboarding.')
  process.exit(1)
}
if (source) console.log(`Using credentials from the ${source}.`)

const ADO = `https://dev.azure.com/${ORG}`
const OUT = 'docs/research/checks-inventory.md'

const secrets = [PAT].filter(Boolean)
const redact = (s) => secrets.reduce((acc, t) => acc.split(t).join('«redacted»'), String(s ?? ''))

const report = []
const say = (...lines) => report.push(...lines, '')
const log = (m) => console.log(m)

/** Emit a markdown table without `say`'s trailing blank line between header and rows. */
function table(header, rows) {
  report.push(header[0], header[1], ...rows, '')
}

const RATE_HEADERS = [
  'x-ratelimit-cost',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-delay',
  'x-ratelimit-reset',
  'retry-after',
]
const CACHE_HEADERS = ['cache-control', 'etag', 'expires', 'last-modified', 'vary']

const authHeader = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`

let calls = 0
/** Every call made, for the per-endpoint facts table at the end. */
const ledger = []
/** note 2: a `Retry-After` on *any* status closes the gate for the next call. */
let throttledUntil = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ado(path, { accept = 'application/json', label = null, raw = false } = {}) {
  const wait = throttledUntil - Date.now()
  if (wait > 0) {
    log(`  (throttled: waiting ${Math.round(wait / 1000)}s — note 2)`)
    await sleep(Math.min(wait, 60_000))
  }

  calls++
  const url = path.startsWith('http') ? path : `${ADO}/${path.replace(/^\//, '')}`
  const started = Date.now()
  let res
  try {
    res = await fetch(url, {
      // GET only. There is no `method` option on this helper on purpose.
      headers: { Authorization: authHeader, 'X-TFS-FedAuthRedirect': 'Suppress', Accept: accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    const entry = { label, url: redact(url), status: 0, ms: Date.now() - started, error: String(err?.message ?? err) }
    ledger.push(entry)

    return { ...entry, body: null, text: '', bytes: 0, headers: {}, rate: {}, cache: {} }
  }
  const ms = Date.now() - started
  const text = await res.text()
  const bytes = Buffer.byteLength(text, 'utf8')

  const pick = (names) =>
    Object.fromEntries(names.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null))
  const rate = pick(RATE_HEADERS)
  const cache = pick(CACHE_HEADERS)

  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    throttledUntil = Math.max(throttledUntil, Date.now() + retryAfter * 1000)
  }

  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }

  const entry = {
    label,
    url: redact(url),
    status: res.status,
    ms,
    bytes,
    contentType: res.headers.get('content-type'),
    rate,
    cache,
  }
  ledger.push(entry)

  return { ...entry, body, text: raw ? text : text.slice(0, 600), headers: Object.fromEntries(res.headers) }
}

/** Field census: which keys are present, and with what JSON type, across N objects. */
function census(objects) {
  const keys = new Map()
  for (const o of objects) {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (k.startsWith('__')) continue // this script's own bookkeeping, not ADO's
      const type =
        v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v
      const entry = keys.get(k) ?? { count: 0, types: new Set() }
      entry.count++
      entry.types.add(type)
      keys.set(k, entry)
    }
  }

  return [...keys.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `| \`${k}\` | ${v.count}/${objects.length} | ${[...v.types].join(', ')} |`)
}

const tally = (values) => {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)

  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

const tallyLine = (values) =>
  tally(values)
    .map(([v, n]) => `\`${v}\` ×${n}`)
    .join(' · ') || '_none_'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

const failMessage = (res) =>
  esc(redact(res.body?.message ?? res.body?.value?.Message ?? res.text ?? res.error).slice(0, 180))

// ---------------------------------------------------------------------------
// §1  Sample selection — deliberately including finished pull requests.
// ---------------------------------------------------------------------------

log('§1 selecting pull requests…')
say('## 1 — Sample selection', '')

const buckets = [
  ['active', 80],
  ['completed', 60],
  ['abandoned', 30],
]
const prs = []
const bucketRows = []

for (const [status, top] of buckets) {
  const res = await ado(
    `_apis/git/pullrequests?searchCriteria.status=${status}&$top=${top}`,
    { label: `pullrequests (${status})` },
  )
  const got = res.body?.value ?? []
  bucketRows.push(`| \`${status}\` | ${top} | ${res.status} | ${got.length} | ${res.ms} |`)
  for (const pr of got) prs.push({ ...pr, __bucket: status })
  log(`  ${status}: ${res.status} ${got.length} PRs ${res.ms}ms`)
}

table(
  ['| `searchCriteria.status` | `$top` | HTTP | returned | ms |', '|---|---|---|---|---|'],
  bucketRows,
)

const refOf = (pr) => ({
  id: pr.pullRequestId,
  project: pr.repository?.project?.id,
  projectName: pr.repository?.project?.name,
  repo: pr.repository?.id,
  repoName: pr.repository?.name,
  bucket: pr.__bucket,
})

const base = (r) => `${r.project}/_apis/git/repositories/${r.repo}/pullRequests/${r.id}`

// Spread across buckets and repositories: round 3 learned that an all-active
// sample hides whole categories of case, and a failed build is far likelier on a
// pull request that has finished.
const candidates = []
{
  const perBucket = { active: 8, completed: 10, abandoned: 6 }
  const seenRepo = new Set()
  for (const bucket of ['completed', 'abandoned', 'active']) {
    const pool = prs.filter((p) => p.__bucket === bucket)
    let taken = 0
    // First pass prefers a distinct repository, second fills the quota.
    for (const pass of [0, 1]) {
      for (const pr of pool) {
        if (taken >= perBucket[bucket]) break
        const key = `${bucket}:${pr.repository?.id}`
        if (pass === 0 && seenRepo.has(key)) continue
        if (candidates.some((c) => c.id === pr.pullRequestId)) continue
        seenRepo.add(key)
        candidates.push(refOf(pr))
        taken++
      }
    }
  }
}

say(
  `Pull requests listed: **${prs.length}** (${buckets.map(([s]) => `${s} ${prs.filter((p) => p.__bucket === s).length}`).join(' · ')}).`,
  '',
  `Sampled in detail: **${candidates.length}** — ${tallyLine(candidates.map((c) => c.bucket))} — across **${new Set(candidates.map((c) => c.repo)).size}** repositories and **${new Set(candidates.map((c) => c.projectName)).size}** projects.`,
)

// ---------------------------------------------------------------------------
// §2  statuses
// ---------------------------------------------------------------------------

log(`§2 statuses on ${candidates.length} pull requests…`)
say('## 2 — `pullRequests/{id}/statuses`', '')

const allStatuses = []
const statusRows = []

for (const ref of candidates) {
  const res = await ado(`${base(ref)}/statuses`, { label: 'pr statuses' })
  const value = res.body?.value ?? []
  for (const s of value) allStatuses.push({ ...s, __pr: ref.id, __ref: ref })
  statusRows.push(
    `| !${ref.id} | ${ref.bucket} | ${res.status} | ${value.length} | ${res.ms} | ${
      Object.keys(res.rate).length === 0 ? '_none_' : JSON.stringify(res.rate)
    } |`,
  )
  log(`  !${ref.id} (${ref.bucket}) ${res.status} ${value.length} statuses ${res.ms}ms`)
}

table(
  ['| PR | bucket | HTTP | statuses | ms | rate-limit headers |', '|---|---|---|---|---|---|'],
  statusRows,
)

say(
  `Statuses collected: **${allStatuses.length}** across ${candidates.length} pull requests.`,
  '',
  `Pull requests with **zero** statuses: **${candidates.filter((c) => !allStatuses.some((s) => s.__pr === c.id)).length}** of ${candidates.length}.`,
)

if (allStatuses.length > 0) {
  say('### Status field census', '')
  table(['| key | present | types |', '|---|---|---|'], census(allStatuses))

  say('### Value tallies', '')
  say(
    `- \`state\`: ${tallyLine(allStatuses.map((s) => String(s.state)))}`,
    `- \`context.genre\`: ${tallyLine(allStatuses.map((s) => String(s.context?.genre)))}`,
    `- \`context.name\`: ${tallyLine(allStatuses.map((s) => String(s.context?.name)))}`,
    `- \`isBlocking\` present: **${allStatuses.filter((s) => s.isBlocking !== undefined).length}**/${allStatuses.length}`,
    `- \`targetUrl\` present: **${allStatuses.filter((s) => s.targetUrl).length}**/${allStatuses.length}`,
    `- \`description\` present: **${allStatuses.filter((s) => s.description).length}**/${allStatuses.length}`,
    `- distinct \`createdBy.id\`: **${new Set(allStatuses.map((s) => s.createdBy?.id).filter(Boolean)).size}**`,
  )

  // Can a build id be recovered from targetUrl, and in what format?
  const targets = allStatuses.filter((s) => s.targetUrl)
  const parsed = targets.map((s) => {
    let host = null
    let params = {}
    let pathname = null
    try {
      const u = new URL(s.targetUrl)
      host = u.host
      pathname = u.pathname
      params = Object.fromEntries(u.searchParams)
    } catch {
      /* not a URL */
    }

    return { status: s, host, pathname, params }
  })

  say('### `targetUrl` shapes', '')
  table(
    ['| `genre`/`name` | host | pathname | query keys | ×n |', '|---|---|---|---|---|'],
    tally(
      parsed.map(
        (p) =>
          `${p.status.context?.genre}/${p.status.context?.name}\0${p.host}\0${p.pathname}\0${Object.keys(p.params).join(', ') || '—'}`,
      ),
    ).map(([key, n]) => {
      const [gn, host, pathname, keys] = key.split('\0')
      return `| \`${esc(gn)}\` | \`${esc(host)}\` | \`${esc(pathname)}\` | ${esc(keys)} | ${n} |`
    }),
  )

  const withBuildId = parsed.filter((p) => p.params.buildId)
  say(
    `Statuses whose \`targetUrl\` carries a \`buildId\`: **${withBuildId.length}** of ${allStatuses.length}.`,
    '',
    withBuildId.length > 0
      ? `Example: \`${esc(withBuildId[0].status.targetUrl)}\` → buildId \`${withBuildId[0].params.buildId}\` (${typeof withBuildId[0].params.buildId}).`
      : '_No status in the sample linked to a build by id._',
  )

  const one =
    allStatuses.find((s) => /build/i.test(s.context?.genre ?? '') || s.targetUrl?.includes('buildId')) ??
    allStatuses[0]
  say('### One status, verbatim', '', '```json', redact(JSON.stringify(one, (k, v) => (k.startsWith('__') ? undefined : v), 2)), '```')
}

// ---------------------------------------------------------------------------
// §3  policy evaluations — the documented path to a PR build
// ---------------------------------------------------------------------------

log('§3 policy evaluations…')
say('## 3 — `policy/evaluations`', '')

const POLICY_VERSION = '7.1-preview.1'
const allEvaluations = []
const evalRows = []

for (const ref of candidates) {
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${ref.project}/${ref.id}`
  const res = await ado(
    `${ref.project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=${POLICY_VERSION}`,
    { label: 'policy/evaluations' },
  )
  const value = res.body?.value ?? []
  for (const e of value) allEvaluations.push({ ...e, __pr: ref.id, __ref: ref })
  const builds = value.filter((e) => e.context?.buildId !== undefined)
  evalRows.push(
    `| !${ref.id} | ${ref.bucket} | ${res.status} | ${value.length} | ${builds.length} | ${res.ms} | ${
      res.status === 200 ? '' : failMessage(res)
    } |`,
  )
  log(`  !${ref.id} evaluations ${res.status} ${value.length} (${builds.length} with a buildId) ${res.ms}ms`)
}

table(
  ['| PR | bucket | HTTP | evaluations | with `context.buildId` | ms | note |', '|---|---|---|---|---|---|---|'],
  evalRows,
)

say(`Evaluations collected: **${allEvaluations.length}**.`)

if (allEvaluations.length > 0) {
  say('### Evaluation field census', '')
  table(['| key | present | types |', '|---|---|---|'], census(allEvaluations))

  say('### `configuration` field census', '')
  table(['| key | present | types |', '|---|---|---|'], census(allEvaluations.map((e) => e.configuration)))

  const contexts = allEvaluations.map((e) => e.context).filter((c) => c != null)
  say(`### \`context\` field census (${contexts.length} non-null of ${allEvaluations.length})`, '')
  table(['| key | present | types |', '|---|---|---|'], census(contexts))

  say('### Value tallies', '')
  say(
    `- \`status\`: ${tallyLine(allEvaluations.map((e) => String(e.status)))}`,
    `- \`configuration.type.displayName\`: ${tallyLine(allEvaluations.map((e) => String(e.configuration?.type?.displayName)))}`,
    `- \`context === null\`: **${allEvaluations.filter((e) => e.context == null).length}**/${allEvaluations.length}`,
    `- \`context.buildId\` present: **${allEvaluations.filter((e) => e.context?.buildId !== undefined).length}**`,
    `- \`context.buildId\` type: ${tallyLine(allEvaluations.filter((e) => e.context?.buildId !== undefined).map((e) => typeof e.context.buildId))}`,
    `- \`context.buildIsNotCurrent\`: ${tallyLine(allEvaluations.filter((e) => e.context?.buildIsNotCurrent !== undefined).map((e) => String(e.context.buildIsNotCurrent)))}`,
    `- \`configuration.settings.buildDefinitionId\` present: **${allEvaluations.filter((e) => e.configuration?.settings?.buildDefinitionId !== undefined).length}**`,
    `- \`evaluationId\` present: **${allEvaluations.filter((e) => typeof e.evaluationId === 'string').length}**/${allEvaluations.length}`,
    `- \`startedDate\` present: **${allEvaluations.filter((e) => e.startedDate).length}**; \`completedDate\`: **${allEvaluations.filter((e) => e.completedDate).length}**`,
  )

  // More than one build policy on one PR? And does a re-run show up as history?
  const byPr = new Map()
  for (const e of allEvaluations) {
    const list = byPr.get(e.__pr) ?? []
    list.push(e)
    byPr.set(e.__pr, list)
  }
  const buildEvalCounts = [...byPr.entries()].map(([pr, list]) => [
    pr,
    list.filter((e) => e.configuration?.settings?.buildDefinitionId !== undefined).length,
  ])
  say(
    '### Can more than one build be attached?',
    '',
    `- build policies per pull request: ${tallyLine(buildEvalCounts.map(([, n]) => n))}`,
    `- pull requests with **>1** build policy: **${buildEvalCounts.filter(([, n]) => n > 1).length}** of ${byPr.size}`,
    `- distinct \`buildDefinitionId\` values across the sample: **${new Set(allEvaluations.map((e) => e.configuration?.settings?.buildDefinitionId).filter((v) => v !== undefined)).size}**`,
    `- duplicate \`configuration.id\` within one pull request (would be a re-run history): **${
      [...byPr.values()].filter((list) => {
        const ids = list.map((e) => e.configuration?.id)
        return new Set(ids).size !== ids.length
      }).length
    }** of ${byPr.size}`,
  )

  const buildEval =
    allEvaluations.find((e) => e.context?.buildId !== undefined && e.status === 'rejected') ??
    allEvaluations.find((e) => e.context?.buildId !== undefined) ??
    allEvaluations[0]
  say(
    '### One `Build` policy evaluation, verbatim',
    '',
    '```json',
    redact(JSON.stringify(buildEval, (k, v) => (k.startsWith('__') ? undefined : v), 2)),
    '```',
  )

  // api-version surface on the evaluations route.
  const ref = (allEvaluations.find((e) => e.context?.buildId !== undefined) ?? allEvaluations[0]).__ref
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${ref.project}/${ref.id}`
  const versions = ['', '7.1', '7.1-preview.1', '7.2-preview.1', '6.0', '5.0-preview.1']
  const rows = []
  for (const v of versions) {
    const res = await ado(
      `${ref.project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}${v ? `&api-version=${v}` : ''}`,
      { label: `policy/evaluations api-version=${v || 'omitted'}` },
    )
    rows.push(
      `| ${v ? `\`${v}\`` : '_omitted_'} | ${res.status} | ${res.body?.value?.length ?? '—'} | ${res.status === 200 ? '' : failMessage(res)} |`,
    )
  }
  say(`### \`api-version\` surface (probed against !${ref.id})`, '')
  table(['| `api-version` | HTTP | evaluations | message |', '|---|---|---|---|'], rows)

  // A malformed artifactId, and one for a pull request that does not exist.
  const bad = [
    ['non-existent PR id', `vstfs:///CodeReview/CodeReviewId/${ref.project}/999999999`],
    ['malformed artifactId', 'not-an-artifact-id'],
    ['artifactId omitted', null],
  ]
  const badRows = []
  for (const [label, artifact] of bad) {
    const res = await ado(
      `${ref.project}/_apis/policy/evaluations?${artifact ? `artifactId=${encodeURIComponent(artifact)}&` : ''}api-version=${POLICY_VERSION}`,
      { label: `policy/evaluations ${label}` },
    )
    badRows.push(
      `| ${label} | ${res.status} | ${res.body?.value?.length ?? '—'} | ${failMessage(res)} |`,
    )
  }
  say('### Failure cases', '')
  table(['| case | HTTP | evaluations | message |', '|---|---|---|---|'], badRows)
}

// ---------------------------------------------------------------------------
// §4  Choosing builds — including a failed one, on purpose
// ---------------------------------------------------------------------------

log('§4 selecting builds…')
say('## 4 — Build selection', '')

/** Build ids reachable from the pull requests above. */
const prBuilds = []
for (const e of allEvaluations) {
  if (e.context?.buildId === undefined) continue
  prBuilds.push({
    buildId: e.context.buildId,
    project: e.__ref.project,
    projectName: e.__ref.projectName,
    pr: e.__pr,
    status: e.status,
    from: 'policy evaluation',
  })
}
for (const s of allStatuses) {
  try {
    const id = new URL(s.targetUrl ?? '').searchParams.get('buildId')
    if (id) {
      prBuilds.push({
        buildId: Number(id),
        project: s.__ref.project,
        projectName: s.__ref.projectName,
        pr: s.__pr,
        status: s.state,
        from: 'status targetUrl',
      })
    }
  } catch {
    /* not a URL */
  }
}
say(
  `Build ids recovered from the pull-request sample: **${prBuilds.length}** (${tallyLine(prBuilds.map((b) => b.from))}), **${new Set(prBuilds.map((b) => b.buildId)).size}** distinct.`,
)

/**
 * A PR-triggered *failed* build is the whole point of this ticket and the sample
 * above may not contain one, so ask the build service directly. `reasonFilter`
 * and `resultFilter` are documented list filters; this is still a GET.
 */
const projects = [...new Set(candidates.map((c) => c.project))]
const failedBuilds = []
const failedRows = []
for (const project of projects.slice(0, 6)) {
  const res = await ado(
    `${project}/_apis/build/builds?resultFilter=failed&reasonFilter=pullRequest&statusFilter=completed&$top=10&queryOrder=finishTimeDescending&api-version=7.1`,
    { label: 'build/builds (failed, pullRequest)' },
  )
  const value = res.body?.value ?? []
  const name = candidates.find((c) => c.project === project)?.projectName ?? project
  failedRows.push(`| ${esc(name)} | ${res.status} | ${value.length} | ${res.ms} | ${res.status === 200 ? '' : failMessage(res)} |`)
  for (const b of value) failedBuilds.push({ ...b, __project: project, __projectName: name })
  log(`  ${name}: ${res.status} ${value.length} failed PR builds ${res.ms}ms`)
}
table(
  ['| project | HTTP | failed PR builds | ms | note |', '|---|---|---|---|---|'],
  failedRows,
)

say(
  `\`build/builds?resultFilter=failed&reasonFilter=pullRequest\` answered with **${failedBuilds.length}** builds across ${Math.min(projects.length, 6)} projects.`,
)

if (failedBuilds.length > 0) {
  say(
    '### The list response, as a route to a PR build',
    '',
    `- \`triggerInfo\` present: **${failedBuilds.filter((b) => b.triggerInfo).length}**/${failedBuilds.length}`,
    `- \`triggerInfo['pr.number']\` present: **${failedBuilds.filter((b) => b.triggerInfo?.['pr.number']).length}**`,
    `- \`triggerInfo\` keys observed: ${tallyLine(failedBuilds.flatMap((b) => Object.keys(b.triggerInfo ?? {})))}`,
    `- \`sourceBranch\` shapes: ${tallyLine(failedBuilds.map((b) => String(b.sourceBranch).replace(/\d+/, '{id}')))}`,
  )
}

/** The build sample: every PR build we found, plus the failed ones. */
const buildSample = []
const seenBuild = new Set()
const pushBuild = (b) => {
  const key = `${b.project}:${b.buildId}`
  if (seenBuild.has(key)) return
  seenBuild.add(key)
  buildSample.push(b)
}
if (process.env.ADO_BUILD_ID && process.env.ADO_PROJECT) {
  pushBuild({
    buildId: Number(process.env.ADO_BUILD_ID),
    project: process.env.ADO_PROJECT,
    projectName: process.env.ADO_PROJECT,
    pr: null,
    from: 'ADO_BUILD_ID',
  })
}
for (const b of failedBuilds.slice(0, 8)) {
  pushBuild({
    buildId: b.id,
    project: b.__project,
    projectName: b.__projectName,
    pr: b.triggerInfo?.['pr.number'] ?? null,
    from: 'failed PR build search',
  })
}
for (const b of prBuilds) pushBuild(b)

const BUILD_CAP = 14
const sampled = buildSample.slice(0, BUILD_CAP)
say(
  `Builds probed in detail: **${sampled.length}** (capped at ${BUILD_CAP}) — ${tallyLine(sampled.map((b) => b.from))}.`,
)

// ---------------------------------------------------------------------------
// §5  build/builds/{buildId}
// ---------------------------------------------------------------------------

log(`§5 ${sampled.length} builds…`)
say('## 5 — `build/builds/{buildId}`', '')

const builds = []
const buildRows = []
for (const b of sampled) {
  const res = await ado(`${b.project}/_apis/build/builds/${b.buildId}?api-version=7.1`, {
    label: 'build/builds/{id}',
  })
  if (res.status === 200 && res.body) builds.push({ ...res.body, __ref: b })
  buildRows.push(
    `| ${b.buildId} | ${esc(b.projectName)} | ${b.pr ? `!${b.pr}` : '—'} | ${res.status} | ${res.body?.status ?? '—'} | ${res.body?.result ?? '—'} | ${res.ms} | ${res.bytes} |`,
  )
  log(`  build ${b.buildId} → ${res.status} ${res.body?.status ?? ''}/${res.body?.result ?? ''} ${res.ms}ms ${res.bytes}B`)
}
table(
  ['| buildId | project | PR | HTTP | `status` | `result` | ms | bytes |', '|---|---|---|---|---|---|---|---|'],
  buildRows,
)

if (builds.length > 0) {
  say('### Build field census', '')
  table(['| key | present | types |', '|---|---|---|'], census(builds))

  say('### Value tallies — the enums *observed*, not the documented list', '')
  say(
    `- \`status\`: ${tallyLine(builds.map((b) => String(b.status)))}`,
    `- \`result\`: ${tallyLine(builds.map((b) => String(b.result)))}`,
    `- \`reason\`: ${tallyLine(builds.map((b) => String(b.reason)))}`,
    `- \`queueTime\` present: **${builds.filter((b) => b.queueTime).length}**/${builds.length}; \`startTime\`: **${builds.filter((b) => b.startTime).length}**; \`finishTime\`: **${builds.filter((b) => b.finishTime).length}**`,
    `- \`result\` absent entirely: **${builds.filter((b) => b.result === undefined).length}** (a build that has not finished has no result)`,
    `- \`validationResults\` non-empty: **${builds.filter((b) => (b.validationResults ?? []).length > 0).length}**`,
    `- \`templateParameters\` present: **${builds.filter((b) => b.templateParameters).length}**`,
    `- \`_links\` keys: ${tallyLine(builds.flatMap((b) => Object.keys(b._links ?? {})))}`,
    `- durations (finish − start, seconds): ${builds
      .filter((b) => b.startTime && b.finishTime)
      .map((b) => Math.round((Date.parse(b.finishTime) - Date.parse(b.startTime)) / 1000))
      .sort((x, y) => x - y)
      .join(' · ')}`,
  )

  const failedBuild = builds.find((b) => b.result === 'failed') ?? builds[0]
  say(
    '### One build, verbatim',
    '',
    '```json',
    redact(JSON.stringify(failedBuild, (k, v) => (k.startsWith('__') ? undefined : v), 2)).slice(0, 6000),
    '```',
  )

  // api-version surface + failure cases.
  const probe = failedBuild.__ref
  const versions = ['', '7.1', '7.2-preview.7', '6.0', '2.0']
  const rows = []
  for (const v of versions) {
    const res = await ado(
      `${probe.project}/_apis/build/builds/${probe.buildId}${v ? `?api-version=${v}` : ''}`,
      { label: `build/builds/{id} api-version=${v || 'omitted'}` },
    )
    rows.push(`| ${v ? `\`${v}\`` : '_omitted_'} | ${res.status} | ${res.bytes} | ${res.status === 200 ? '' : failMessage(res)} |`)
  }
  say('### `api-version` surface', '')
  table(['| `api-version` | HTTP | bytes | message |', '|---|---|---|---|'], rows)

  const otherProject = projects.find((p) => p !== probe.project)
  const failures = [
    ['a build id that does not exist', `${probe.project}/_apis/build/builds/999999999?api-version=7.1`],
    ['a non-numeric build id', `${probe.project}/_apis/build/builds/not-a-number?api-version=7.1`],
    ...(otherProject
      ? [['a real build id under the wrong project', `${otherProject}/_apis/build/builds/${probe.buildId}?api-version=7.1`]]
      : []),
    ['a project that does not exist', `00000000-0000-0000-0000-000000000000/_apis/build/builds/${probe.buildId}?api-version=7.1`],
  ]
  const frows = []
  for (const [label, path] of failures) {
    const res = await ado(path, { label: `build/builds/{id} — ${label}` })
    frows.push(`| ${label} | ${res.status} | \`${esc(res.body?.typeKey ?? '—')}\` | ${failMessage(res)} |`)
  }
  say('### Failure cases', '')
  table(['| case | HTTP | `typeKey` | message |', '|---|---|---|---|'], frows)
}

// ---------------------------------------------------------------------------
// §6  the timeline
// ---------------------------------------------------------------------------

log('§6 timelines…')
say('## 6 — `build/builds/{buildId}/timeline`', '')

const timelines = []
const timelineRows = []
for (const b of builds) {
  const res = await ado(`${b.__ref.project}/_apis/build/builds/${b.id}/timeline?api-version=7.1`, {
    label: 'build timeline',
  })
  const records = res.body?.records ?? []
  if (res.status === 200) timelines.push({ build: b, body: res.body, records, ms: res.ms, bytes: res.bytes })
  timelineRows.push(
    `| ${b.id} | ${b.result ?? b.status} | ${res.status} | ${records.length} | ${records.filter((r) => r.result === 'failed').length} | ${records.filter((r) => r.log).length} | ${res.ms} | ${(res.bytes / 1024).toFixed(1)} |`,
  )
  log(`  timeline ${b.id} → ${res.status} ${records.length} records ${res.ms}ms ${(res.bytes / 1024).toFixed(1)}KB`)
}
table(
  ['| buildId | build result | HTTP | records | failed records | with a `log` | ms | KB |', '|---|---|---|---|---|---|---|---|'],
  timelineRows,
)

const allRecords = timelines.flatMap((t) => t.records.map((r) => ({ ...r, __build: t.build.id })))

if (timelines.length > 0) {
  say(
    `Timelines fetched: **${timelines.length}**. Records: **${allRecords.length}** total, ` +
      `**${Math.min(...timelines.map((t) => t.records.length))}–${Math.max(...timelines.map((t) => t.records.length))}** per build ` +
      `(median ${
        timelines.map((t) => t.records.length).sort((a, b) => a - b)[Math.floor(timelines.length / 2)]
      }).`,
    '',
    `Top-level response keys: ${tallyLine(timelines.flatMap((t) => Object.keys(t.body ?? {})))}`,
  )

  say('### Record field census', '')
  table(['| key | present | types |', '|---|---|---|'], census(allRecords))

  say('### Value tallies', '')
  say(
    `- \`type\`: ${tallyLine(allRecords.map((r) => String(r.type)))}`,
    `- \`state\`: ${tallyLine(allRecords.map((r) => String(r.state)))}`,
    `- \`result\`: ${tallyLine(allRecords.map((r) => String(r.result)))}`,
    `- \`parentId === null\`: **${allRecords.filter((r) => r.parentId == null).length}** of ${allRecords.length} — the roots`,
    `- \`log\` present: **${allRecords.filter((r) => r.log).length}**; \`log\` keys: ${tallyLine(allRecords.flatMap((r) => Object.keys(r.log ?? {})))}`,
    `- \`errorCount > 0\`: **${allRecords.filter((r) => (r.errorCount ?? 0) > 0).length}**; \`warningCount > 0\`: **${allRecords.filter((r) => (r.warningCount ?? 0) > 0).length}**`,
    `- \`issues\` non-empty: **${allRecords.filter((r) => (r.issues ?? []).length > 0).length}**`,
    `- \`identifier\` present: **${allRecords.filter((r) => r.identifier != null).length}**`,
    `- \`order\` present: **${allRecords.filter((r) => r.order != null).length}**`,
    `- \`previousAttempts\` non-empty: **${allRecords.filter((r) => (r.previousAttempts ?? []).length > 0).length}**`,
    `- \`attempt\` values: ${tallyLine(allRecords.map((r) => String(r.attempt)))}`,
    `- \`task\` present: **${allRecords.filter((r) => r.task).length}**; \`task\` keys: ${tallyLine(allRecords.flatMap((r) => Object.keys(r.task ?? {})))}`,
  )

  // type × result, because "which of these is a step" is the load-bearing question.
  say('### `type` × `result`', '')
  const types = [...new Set(allRecords.map((r) => String(r.type)))].sort()
  const results = [...new Set(allRecords.map((r) => String(r.result)))].sort()
  table(
    [`| type | ${results.map((r) => `\`${r}\``).join(' | ')} | with a \`log\` | leaf |`, `|---|${results.map(() => '---|').join('')}---|---|`],
    types.map((t) => {
      const rows = allRecords.filter((r) => String(r.type) === t)
      const parents = new Set(allRecords.map((r) => r.parentId))
      const leaves = rows.filter((r) => !parents.has(r.id)).length

      return `| \`${t}\` | ${results.map((res) => rows.filter((r) => String(r.result) === res).length).join(' | ')} | ${rows.filter((r) => r.log).length} | ${leaves} |`
    }),
  )

  say('### Parent/child', '')
  const byId = new Map(allRecords.map((r) => [r.id, r]))
  const depthOf = (r, seen = 0) => {
    if (r.parentId == null || seen > 20) return 0
    const parent = byId.get(r.parentId)

    return parent === undefined ? 0 : 1 + depthOf(parent, seen + 1)
  }
  say(
    `- \`parentId\` points at another record's \`id\` (a GUID) — resolvable within the same response: **${allRecords.filter((r) => r.parentId == null || byId.has(r.parentId)).length}**/${allRecords.length}`,
    `- depth distribution: ${tallyLine(allRecords.map((r) => String(depthOf(r))))}`,
    `- type by depth: ${[0, 1, 2, 3, 4]
      .map((d) => {
        const at = allRecords.filter((r) => depthOf(r) === d)

        return at.length === 0 ? null : `depth ${d} → ${tallyLine(at.map((r) => String(r.type)))}`
      })
      .filter(Boolean)
      .join(' · ')}`,
  )

  // Identifying the failing *step*.
  const parentIds = new Set(allRecords.map((r) => r.parentId))
  const failed = allRecords.filter((r) => r.result === 'failed')
  const failedLeaves = failed.filter((r) => !parentIds.has(r.id))
  say('### Identifying the failing step', '')
  say(
    `- records with \`result: 'failed'\`: **${failed.length}** across ${timelines.length} timelines`,
    `- of those, **leaves** (no record names them as parent): **${failedLeaves.length}** — ${tallyLine(failedLeaves.map((r) => String(r.type)))}`,
    `- failed records **with a \`log\`**: **${failed.filter((r) => r.log).length}**; failed leaves with a log: **${failedLeaves.filter((r) => r.log).length}**`,
    `- failed records with \`issues\` non-empty: **${failed.filter((r) => (r.issues ?? []).length > 0).length}**`,
    `- failed records with \`errorCount > 0\`: **${failed.filter((r) => (r.errorCount ?? 0) > 0).length}**`,
    `- failed non-leaf types (the containers): ${tallyLine(failed.filter((r) => parentIds.has(r.id)).map((r) => String(r.type)))}`,
  )

  const issues = allRecords.flatMap((r) => r.issues ?? [])
  if (issues.length > 0) {
    say(`### \`issues[]\` (${issues.length} across ${allRecords.filter((r) => (r.issues ?? []).length > 0).length} records)`, '')
    table(['| key | present | types |', '|---|---|---|'], census(issues))
    say(
      `- \`type\`: ${tallyLine(issues.map((i) => String(i.type)))}`,
      `- \`category\`: ${tallyLine(issues.map((i) => String(i.category)))}`,
      `- \`data\` keys: ${tallyLine(issues.flatMap((i) => Object.keys(i.data ?? {})))}`,
      `- \`message\` length (chars): min ${Math.min(...issues.map((i) => (i.message ?? '').length))}, max ${Math.max(...issues.map((i) => (i.message ?? '').length))}`,
    )
    say('One issue, verbatim:', '', '```json', redact(JSON.stringify(issues[0], null, 2)), '```')
  } else {
    say('### `issues[]`', '', '_No record in the sample carried a non-empty `issues` array._')
  }

  // Stage identifiers — the map says `stageRefName` is the YAML id, not the name.
  const stages = allRecords.filter((r) => r.type === 'Stage')
  if (stages.length > 0) {
    say('### Stages — `identifier` vs `name`', '')
    table(
      ['| build | `identifier` | `name` | `state` | `result` | `attempt` |', '|---|---|---|---|---|---|'],
      stages
        .slice(0, 20)
        .map((s) => `| ${s.__build} | \`${esc(s.identifier)}\` | ${esc(s.name)} | ${s.state} | ${s.result ?? '—'} | ${s.attempt ?? '—'} |`),
    )
    say(
      `- stages whose \`identifier\` differs from \`name\`: **${stages.filter((s) => s.identifier !== s.name).length}** of ${stages.length}`,
      `- \`identifier === '__default'\`: **${stages.filter((s) => s.identifier === '__default').length}**`,
    )
  }

  const oneFailed = failedLeaves.find((r) => r.log) ?? failedLeaves[0] ?? failed[0]
  if (oneFailed) {
    say('### One failing record, verbatim', '', '```json', redact(JSON.stringify(oneFailed, (k, v) => (k.startsWith('__') ? undefined : v), 2)), '```')
  }

  // Timeline parameter/api-version surface.
  const t = timelines.find((x) => x.records.some((r) => r.result === 'failed')) ?? timelines[0]
  const rows = []
  for (const v of ['', '7.1', '7.2-preview.2', '6.0', '2.0']) {
    const res = await ado(
      `${t.build.__ref.project}/_apis/build/builds/${t.build.id}/timeline${v ? `?api-version=${v}` : ''}`,
      { label: `timeline api-version=${v || 'omitted'}` },
    )
    rows.push(`| ${v ? `\`${v}\`` : '_omitted_'} | ${res.status} | ${res.body?.records?.length ?? '—'} | ${res.status === 200 ? '' : failMessage(res)} |`)
  }
  const missing = await ado(
    `${t.build.__ref.project}/_apis/build/builds/999999999/timeline?api-version=7.1`,
    { label: 'timeline — build that does not exist' },
  )
  rows.push(`| _build 999999999_ | ${missing.status} | — | ${failMessage(missing)} |`)
  say('### `api-version` surface and failure cases', '')
  table(['| variant | HTTP | records | message |', '|---|---|---|---|'], rows)
}

// ---------------------------------------------------------------------------
// §6b  a build that has not finished
//
// Everything above is a completed build, and phase 5 has to draw a running one.
// The enums for that are only observable while one is actually running, so this
// section is time-of-day dependent and says so when it finds nothing.
// ---------------------------------------------------------------------------

log('§6b unfinished builds…')
say('### A build that has not finished', '')

{
  const project = projects[0]
  const live = []
  const rows = []
  for (const filter of ['inProgress', 'notStarted', 'cancelling', 'postponed']) {
    const res = await ado(
      `${project}/_apis/build/builds?statusFilter=${filter}&$top=5&api-version=7.1`,
      { label: `build/builds statusFilter=${filter}` },
    )
    const value = res.body?.value ?? []
    rows.push(`| \`${filter}\` | ${res.status} | ${value.length} | ${res.ms} |`)
    for (const b of value) live.push({ ...b, __filter: filter })
    log(`  statusFilter=${filter} → ${res.status} ${value.length}`)
  }
  table(['| `statusFilter` | HTTP | builds | ms |', '|---|---|---|---|'], rows)

  if (live.length === 0) {
    say(
      '_Nothing was in flight when this ran._ `status`, `result` and the timeline `state` values for an unfinished build are therefore **unmeasured** — see the not-measured note at the end.',
    )
  } else {
    say(
      `Unfinished builds found: **${live.length}** (${tallyLine(live.map((b) => b.__filter))}).`,
      '',
      `- \`status\`: ${tallyLine(live.map((b) => String(b.status)))}`,
      `- \`result\` present: **${live.filter((b) => b.result !== undefined).length}**/${live.length} — ${tallyLine(live.map((b) => String(b.result)))}`,
      `- \`startTime\` present: **${live.filter((b) => b.startTime).length}**; \`finishTime\` present: **${live.filter((b) => b.finishTime).length}**`,
      `- \`queueTime\` present: **${live.filter((b) => b.queueTime).length}**`,
      `- \`queuePosition\` present: **${live.filter((b) => b.queuePosition !== undefined).length}**`,
    )

    const t = await ado(
      `${live[0].project?.id ?? project}/_apis/build/builds/${live[0].id}/timeline?api-version=7.1`,
      { label: 'build timeline (unfinished build)' },
    )
    const records = t.body?.records ?? []
    say(
      `Its timeline (build ${live[0].id}, \`${live[0].status}\`): ${t.status}, **${records.length}** records.`,
      '',
      `- \`state\`: ${tallyLine(records.map((r) => String(r.state)))}`,
      `- \`result\`: ${tallyLine(records.map((r) => String(r.result)))}`,
      `- \`startTime\` present: **${records.filter((r) => r.startTime).length}**/${records.length}; \`finishTime\` present: **${records.filter((r) => r.finishTime).length}**`,
      `- \`percentComplete\` non-null: **${records.filter((r) => r.percentComplete != null).length}**`,
      `- \`currentOperation\` non-null: **${records.filter((r) => r.currentOperation != null).length}**`,
      `- records with a \`log\` while unfinished: **${records.filter((r) => r.log).length}**`,
    )
    const running = records.find((r) => r.state === 'inProgress')
    if (running) {
      say('One in-progress record, verbatim:', '', '```json', redact(JSON.stringify(running, null, 2)), '```')
    }
  }
}

// ---------------------------------------------------------------------------
// §6c  do any pipelines in this org declare real stages, and does a retried
//      build show up as a second attempt?
// ---------------------------------------------------------------------------

log('§6c stage and attempt sweep…')
say('### Do any pipelines declare real stages, and does a retry show as an attempt?', '')

{
  const project = projects[0]
  // Not PR builds this time: CI and manual runs are where a multi-stage
  // deployment pipeline would show up, and `stageRefName` only means something
  // if some pipeline in the org actually declares stages.
  const list = await ado(
    `${project}/_apis/build/builds?statusFilter=completed&$top=40&queryOrder=finishTimeDescending&api-version=7.1`,
    { label: 'build/builds (recent completed, any reason)' },
  )
  const recent = list.body?.value ?? []
  const byDefinition = new Map()
  for (const b of recent) if (!byDefinition.has(b.definition?.id)) byDefinition.set(b.definition?.id, b)
  const spread = [...byDefinition.values()].slice(0, 10)

  const rows = []
  let namedStages = 0
  let retried = 0
  for (const b of spread) {
    const t = await ado(`${project}/_apis/build/builds/${b.id}/timeline?api-version=7.1`, {
      label: 'build timeline (stage sweep)',
    })
    const records = t.body?.records ?? []
    const stages = records.filter((r) => r.type === 'Stage')
    const attempts = records.filter((r) => (r.attempt ?? 1) > 1 || (r.previousAttempts ?? []).length > 0)
    if (stages.some((s) => s.identifier !== '__default')) namedStages++
    if (attempts.length > 0) retried++
    rows.push(
      `| ${b.id} | ${esc(b.definition?.name)} | ${b.reason} | ${records.length} | ${stages.length} | ${esc(stages.map((s) => s.identifier).join(', '))} | ${attempts.length} |`,
    )
    log(`  ${b.id} ${b.definition?.name}: ${stages.length} stages, ${attempts.length} re-attempted records`)
  }
  table(
    ['| buildId | definition | reason | records | stages | stage `identifier`s | records on attempt >1 |', '|---|---|---|---|---|---|---|'],
    rows,
  )
  say(
    `- distinct pipelines swept: **${spread.length}** (from the ${recent.length} most recently finished builds in the project)`,
    `- pipelines with at least one stage whose \`identifier\` is not \`__default\`: **${namedStages}**`,
    `- builds with any record on \`attempt > 1\` or a non-empty \`previousAttempts\`: **${retried}**`,
  )
}

// ---------------------------------------------------------------------------
// §7  logs
// ---------------------------------------------------------------------------

log('§7 logs…')
say('## 7 — `build/builds/{buildId}/logs/{logId}`', '')

const withFailingLog = timelines.find((t) => t.records.some((r) => r.result === 'failed' && r.log))
const logHost = withFailingLog ?? timelines.find((t) => t.records.some((r) => r.log))

if (!logHost) {
  say('_No timeline in the sample had a record with a `log`; §7 could not run._')
} else {
  const project = logHost.build.__ref.project
  const buildId = logHost.build.id
  const parentIds = new Set(logHost.records.map((r) => r.parentId))
  const failingStep =
    logHost.records.find((r) => r.result === 'failed' && r.log && !parentIds.has(r.id)) ??
    logHost.records.find((r) => r.result === 'failed' && r.log) ??
    logHost.records.find((r) => r.log)

  say(
    `Probed against build **${buildId}** (${logHost.build.result ?? logHost.build.status}), record \`${esc(failingStep.name)}\` (type \`${failingStep.type}\`, result \`${failingStep.result}\`), \`log.id\` **${failingStep.log.id}**.`,
  )

  // The log collection first: does it give sizes without fetching content?
  const list = await ado(`${project}/_apis/build/builds/${buildId}/logs?api-version=7.1`, {
    label: 'build logs (collection)',
  })
  const logs = list.body?.value ?? []
  say(
    '### The log collection',
    '',
    `\`GET .../logs\` → ${list.status}, **${logs.length}** logs, ${list.ms} ms, ${list.bytes} bytes.`,
  )
  if (logs.length > 0) {
    table(['| key | present | types |', '|---|---|---|'], census(logs))
    say(
      `- \`lineCount\` present: **${logs.filter((l) => l.lineCount != null).length}**/${logs.length}; values: ${logs
        .map((l) => l.lineCount)
        .filter((v) => v != null)
        .sort((a, b) => b - a)
        .slice(0, 12)
        .join(' · ')}`,
      `- \`type\` values: ${tallyLine(logs.map((l) => String(l.type)))}`,
      `- largest \`lineCount\`: **${Math.max(...logs.map((l) => l.lineCount ?? 0))}**; total lines across all logs: **${logs.reduce((n, l) => n + (l.lineCount ?? 0), 0)}**`,
    )
    say('One log record, verbatim:', '', '```json', redact(JSON.stringify(logs[0], null, 2)), '```')
  }

  // The content, and what Accept does to it.
  const logId = failingStep.log.id
  const variants = [
    ['`Accept: application/json` (the client default)', `${project}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.1`, 'application/json'],
    ['`Accept: text/plain`', `${project}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.1`, 'text/plain'],
    ['`Accept: */*`', `${project}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.1`, '*/*'],
    ['`startLine=0&endLine=20`', `${project}/_apis/build/builds/${buildId}/logs/${logId}?startLine=0&endLine=20&api-version=7.1`, 'text/plain'],
    ['`startLine` only', `${project}/_apis/build/builds/${buildId}/logs/${logId}?startLine=5&api-version=7.1`, 'text/plain'],
    ['`endLine` only', `${project}/_apis/build/builds/${buildId}/logs/${logId}?endLine=10&api-version=7.1`, 'text/plain'],
    ['`startLine` beyond the end', `${project}/_apis/build/builds/${buildId}/logs/${logId}?startLine=9999999&api-version=7.1`, 'text/plain'],
    ['a log id that does not exist', `${project}/_apis/build/builds/${buildId}/logs/999999?api-version=7.1`, 'text/plain'],
  ]

  const rows = []
  const captured = {}
  for (const [label, path, accept] of variants) {
    const res = await ado(path, { accept, label: `log content — ${label}`, raw: true })
    captured[label] = res
    const lines = res.status === 200 ? res.text.split('\n').length : null
    rows.push(
      `| ${label} | ${res.status} | \`${esc(res.contentType)}\` | ${res.bytes} | ${lines ?? '—'} | ${res.ms} | ${res.status === 200 ? (res.body === null ? 'not JSON' : 'JSON') : failMessage(res)} |`,
    )
    log(`  log ${label} → ${res.status} ${res.bytes}B ${res.ms}ms`)
  }
  say('### The content', '')
  table(
    ['| variant | HTTP | `Content-Type` | bytes | lines | ms | body |', '|---|---|---|---|---|---|---|'],
    rows,
  )

  // `ado-client.ts` sends `Accept: application/json` on every call, so what that
  // header does to a log response is not a curiosity — it is what phase 5 would
  // get by default.
  const asJson = captured['`Accept: application/json` (the client default)']
  if (asJson?.status === 200) {
    say(
      '#### What `Accept: application/json` turns the log into',
      '',
      `Top-level keys: ${asJson.body === null ? '_the body did not parse as JSON_' : `\`${Object.keys(asJson.body).join('`, `')}\``}. First 400 characters:`,
      '',
      '```json',
      redact(asJson.text.slice(0, 400)),
      '```',
    )
  }

  const full = captured['`Accept: text/plain`']
  if (full?.status === 200) {
    const lines = full.text.split(/\r?\n/)
    say(
      '### Size of a real failing step\'s log',
      '',
      `- **${full.bytes} bytes** (${(full.bytes / 1024).toFixed(1)} KB), **${lines.length}** lines, fetched in **${full.ms} ms**`,
      `- longest line: **${Math.max(...lines.map((l) => l.length))}** chars; mean **${Math.round(full.bytes / Math.max(1, lines.length))}**`,
      `- caching headers: ${Object.keys(full.cache).length === 0 ? '_none_' : JSON.stringify(full.cache)}`,
      `- first 3 lines, verbatim:`,
      '',
      '```',
      redact(lines.slice(0, 3).join('\n')),
      '```',
    )
    // Do the timestamps ADO prefixes every line with parse?
    const stamped = lines.filter((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l)).length
    say(
      `- lines beginning with an ISO timestamp: **${stamped}** of ${lines.length}`,
      `- lines containing an ANSI escape (\`\\u001b[\`): **${lines.filter((l) => l.includes('[')).length}**`,
      `- lines containing an Azure Pipelines logging command (\`##[\`): **${lines.filter((l) => l.includes('##[')).length}** — ${tallyLine(
        lines.flatMap((l) => [...l.matchAll(/##\[(\w+)\]/g)].map((m) => m[1])),
      )}`,
    )
  }

  // Every log on the failing build, measured, so the "can we render it inline"
  // question is answered for the whole build and not just one step.
  if (logs.length > 0) {
    const sizes = []
    for (const l of logs.slice(0, 12)) {
      const res = await ado(
        `${project}/_apis/build/builds/${buildId}/logs/${l.id}?api-version=7.1`,
        { accept: 'text/plain', label: 'log content (size sweep)', raw: true },
      )
      const owner = logHost.records.find((r) => r.log?.id === l.id)
      sizes.push(
        `| ${l.id} | ${esc(owner?.name ?? '—')} | ${owner?.type ?? '—'} | ${owner?.result ?? '—'} | ${l.lineCount ?? '—'} | ${res.bytes} | ${res.ms} |`,
      )
    }
    say('### Every log on that build', '')
    table(
      ['| logId | record | type | result | `lineCount` | bytes | ms |', '|---|---|---|---|---|---|---|'],
      sizes,
    )
  }
}

// ---------------------------------------------------------------------------
// §8  test results
// ---------------------------------------------------------------------------

log('§8 test results…')
say('## 8 — From a build to its failed tests', '')

const testTargets = builds.slice(0, 8)
const runRows = []
const runsFound = []

for (const b of testTargets) {
  const project = b.__ref.project
  const buildUri = `vstfs:///Build/Build/${b.id}`
  const attempts = [
    ['`test/runs?buildUri=`', `${project}/_apis/test/runs?buildUri=${encodeURIComponent(buildUri)}&api-version=7.1`],
    ['`testresults/resultsbybuild?buildId=`', `${project}/_apis/testresults/resultsbybuild?buildId=${b.id}&api-version=7.1-preview.1`],
  ]
  for (const [label, path] of attempts) {
    const res = await ado(path, { label })
    const value = res.body?.value ?? []
    runRows.push(
      `| ${b.id} | ${label} | ${res.status} | ${value.length} | ${res.ms} | ${res.status === 200 ? '' : failMessage(res)} |`,
    )
    if (res.status === 200 && value.length > 0) {
      runsFound.push({ build: b, project, label, value })
    }
    log(`  build ${b.id} ${label} → ${res.status} ${value.length}`)
  }
}
table(
  ['| buildId | endpoint | HTTP | items | ms | message |', '|---|---|---|---|---|---|'],
  runRows,
)

const runSource = runsFound.find((r) => r.label.includes('test/runs'))
const resultsSource = runsFound.find((r) => r.label.includes('resultsbybuild'))

if (runsFound.length === 0) {
  say(
    '_No build in the sample published test results by either route._ Every call answered 200 with an empty `value`, which is the same answer as "this build ran no tests" — see the failure-mode note below.',
  )
} else {
  if (runSource) {
    const runs = runSource.value
    say(`### \`test/runs?buildUri=vstfs:///Build/Build/{buildId}\``, '', `Build ${runSource.build.id}: **${runs.length}** run(s).`)
    table(['| key | present | types |', '|---|---|---|'], census(runs))
    say(
      `- \`state\`: ${tallyLine(runs.map((r) => String(r.state)))}`,
      `- \`totalTests\`: ${runs.map((r) => r.totalTests).join(' · ')}`,
      `- \`passedTests\`: ${runs.map((r) => r.passedTests).join(' · ')}; \`unanalyzedTests\`: ${runs.map((r) => r.unanalyzedTests).join(' · ')}`,
      `- \`incompleteTests\`/\`notApplicableTests\` present: ${runs.filter((r) => r.incompleteTests != null).length}/${runs.length}`,
    )
    say('One run, verbatim:', '', '```json', redact(JSON.stringify(runs[0], null, 2)).slice(0, 3000), '```')

    // The results under a run, filtered and unfiltered.
    const run = runs.find((r) => (r.totalTests ?? 0) > 0) ?? runs[0]
    const project = runSource.project
    const variants = [
      ['unfiltered', `${project}/_apis/test/runs/${run.id}/results?api-version=7.1&$top=1000`],
      ['`outcomes=Failed`', `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&api-version=7.1&$top=1000`],
      ['`outcomes=Failed&$top=5`', `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&$top=5&api-version=7.1`],
      ['`outcomes=Failed&$skip=1`', `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&$skip=1&api-version=7.1`],
      ['`detailsToInclude=None`', `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&detailsToInclude=None&api-version=7.1&$top=1000`],
      ['`outcomes=NoSuchOutcome`', `${project}/_apis/test/runs/${run.id}/results?outcomes=NoSuchOutcome&api-version=7.1`],
    ]
    const rows = []
    const got = {}
    for (const [label, path] of variants) {
      const res = await ado(path, { label: `test/runs/{id}/results — ${label}` })
      got[label] = res
      rows.push(
        `| ${label} | ${res.status} | ${res.body?.value?.length ?? res.body?.count ?? '—'} | ${(res.bytes / 1024).toFixed(1)} | ${res.ms} | ${res.status === 200 ? '' : failMessage(res)} |`,
      )
      log(`  results ${label} → ${res.status} ${res.body?.value?.length ?? '—'}`)
    }
    say(`### \`test/runs/{runId}/results\` (run ${run.id}, \`totalTests: ${run.totalTests}\`)`, '')
    table(['| variant | HTTP | results | KB | ms | message |', '|---|---|---|---|---|---|'], rows)

    const unfiltered = got['unfiltered']?.body?.value ?? []
    const onlyFailed = got['`outcomes=Failed`']?.body?.value ?? []
    say(
      `- unfiltered returned **${unfiltered.length}**, of which \`outcome === 'Failed'\`: **${unfiltered.filter((r) => r.outcome === 'Failed').length}**`,
      `- \`outcomes=Failed\` returned **${onlyFailed.length}** — server-side filtering ${onlyFailed.length === unfiltered.filter((r) => r.outcome === 'Failed').length ? 'agrees with the client-side count' : '**does not** agree with the client-side count'}`,
      `- \`outcome\` values in the unfiltered response: ${tallyLine(unfiltered.map((r) => String(r.outcome)))}`,
    )
    const results = onlyFailed.length > 0 ? onlyFailed : unfiltered
    if (results.length > 0) {
      say('#### Result field census', '')
      table(['| key | present | types |', '|---|---|---|'], census(results))
      const failedResults = results.filter((r) => r.outcome === 'Failed')
      say(
        `- \`automatedTestName\` present: **${results.filter((r) => r.automatedTestName).length}**/${results.length}`,
        `- \`automatedTestStorage\` present: **${results.filter((r) => r.automatedTestStorage).length}**`,
        `- \`testCaseTitle\` present: **${results.filter((r) => r.testCaseTitle).length}**`,
        `- \`errorMessage\` present: **${results.filter((r) => r.errorMessage).length}** (of ${failedResults.length} failed)`,
        `- \`stackTrace\` present: **${results.filter((r) => r.stackTrace).length}** (of ${failedResults.length} failed)`,
        `- \`errorMessage\` length: ${results
          .filter((r) => r.errorMessage)
          .map((r) => r.errorMessage.length)
          .sort((a, b) => b - a)
          .slice(0, 6)
          .join(' · ')} chars`,
        `- \`stackTrace\` length: ${results
          .filter((r) => r.stackTrace)
          .map((r) => r.stackTrace.length)
          .sort((a, b) => b - a)
          .slice(0, 6)
          .join(' · ')} chars`,
      )
      const example = failedResults[0] ?? results[0]
      say('One result, verbatim:', '', '```json', redact(JSON.stringify(example, null, 2)).slice(0, 3500), '```')
    }
  }

  if (resultsSource) {
    const value = resultsSource.value
    say(`### \`testresults/resultsbybuild?buildId=\``, '', `Build ${resultsSource.build.id}: **${value.length}** item(s).`)
    table(['| key | present | types |', '|---|---|---|'], census(value))
    say(
      `- \`outcome\` values: ${tallyLine(value.map((r) => String(r.outcome)))}`,
      `- \`errorMessage\` present: **${value.filter((r) => r.errorMessage).length}**/${value.length}`,
    )
    say('One item, verbatim:', '', '```json', redact(JSON.stringify(value[0], null, 2)).slice(0, 2000), '```')

    // Does it filter, and how does it page?
    const project = resultsSource.project
    const id = resultsSource.build.id
    const rows = []
    for (const [label, path] of [
      ['`outcomes=Failed`', `${project}/_apis/testresults/resultsbybuild?buildId=${id}&outcomes=Failed&api-version=7.1-preview.1`],
      ['`$top=2`', `${project}/_apis/testresults/resultsbybuild?buildId=${id}&$top=2&api-version=7.1-preview.1`],
      ['`api-version=7.1`', `${project}/_apis/testresults/resultsbybuild?buildId=${id}&api-version=7.1`],
      ['`api-version` omitted', `${project}/_apis/testresults/resultsbybuild?buildId=${id}`],
      ['`publishContext=Build`', `${project}/_apis/testresults/resultsbybuild?buildId=${id}&publishContext=Build&api-version=7.1-preview.1`],
    ]) {
      const res = await ado(path, { label: `resultsbybuild — ${label}` })
      rows.push(
        `| ${label} | ${res.status} | ${res.body?.value?.length ?? '—'} | ${res.headers?.['x-ms-continuationtoken'] ? 'yes' : 'no'} | ${res.ms} | ${res.status === 200 ? '' : failMessage(res)} |`,
      )
    }
    say('#### Parameter surface', '')
    table(['| variant | HTTP | items | continuation token | ms | message |', '|---|---|---|---|---|---|'], rows)
  }
}

// ---------------------------------------------------------------------------
// §8b  the same route on the vstmr host
//
// `testresults/resultsbybuild` 404s on dev.azure.com. Microsoft's reference for
// the Test Results Metadata service gives a different host, and the whole point
// of that endpoint is skipping the run hop, so it is worth one call to find out.
// ---------------------------------------------------------------------------

log('§8b vstmr host…')
say('### `testresults/resultsbybuild` on the `vstmr` host', '')

{
  const b = builds.find((x) => x.result === 'failed') ?? builds[0]
  const rows = []
  if (b) {
    const project = b.__ref.project
    for (const [label, url] of [
      ['`vstmr` + `7.1-preview.1`', `https://vstmr.dev.azure.com/${ORG}/${project}/_apis/testresults/resultsbybuild?buildId=${b.id}&api-version=7.1-preview.1`],
      ['`vstmr` + `outcomes=Failed`', `https://vstmr.dev.azure.com/${ORG}/${project}/_apis/testresults/resultsbybuild?buildId=${b.id}&outcomes=Failed&api-version=7.1-preview.1`],
      ['`vstmr` + `api-version` omitted', `https://vstmr.dev.azure.com/${ORG}/${project}/_apis/testresults/resultsbybuild?buildId=${b.id}`],
      ['`vstmr` + `7.2-preview.1`', `https://vstmr.dev.azure.com/${ORG}/${project}/_apis/testresults/resultsbybuild?buildId=${b.id}&api-version=7.2-preview.1`],
    ]) {
      const res = await ado(url, { label: `resultsbybuild — ${label}` })
      rows.push(
        `| ${label} | ${res.status} | ${res.body?.value?.length ?? '—'} | ${res.bytes} | ${res.ms} | ${res.status === 200 ? esc(Object.keys(res.body ?? {}).join(', ')) : failMessage(res)} |`,
      )
      log(`  ${label} → ${res.status} ${res.bytes}B`)
    }
  }
  table(['| variant | HTTP | items | bytes | ms | keys / message |', '|---|---|---|---|---|---|'], rows)
}

// ---------------------------------------------------------------------------
// §8c  hunting for a run that actually failed tests
//
// No failed build in the pull-request sample had a failing *test* — the builds
// failed at a formatting or packaging step, before or beside the test task. The
// requirement is "failed tests only", so the fields that carry a failure are the
// ones that most need measuring, and they only exist on a failing result. Ask the
// test service for every run in the last few days and pick one.
// ---------------------------------------------------------------------------

log('§8c hunting for failing tests…')
say('### Hunting for a run with failing tests', '')

{
  const project = projects[0]
  const now = new Date()
  const from = new Date(now.getTime() - 6 * 86_400_000)
  const window = `minLastUpdatedDate=${encodeURIComponent(from.toISOString())}&maxLastUpdatedDate=${encodeURIComponent(now.toISOString())}`

  const listed = await ado(
    `${project}/_apis/test/runs?${window}&includeRunDetails=true&$top=100&api-version=7.1`,
    { label: 'test/runs by date window' },
  )
  const runs = listed.body?.value ?? []
  say(
    `\`GET test/runs?minLastUpdatedDate=…&maxLastUpdatedDate=…&includeRunDetails=true&$top=100\` over a **6-day** window → ${listed.status}, **${runs.length}** runs, ${listed.ms} ms, ${(listed.bytes / 1024).toFixed(1)} KB.`,
  )

  if (runs.length > 0) {
    const failedIn = (r) =>
      (r.totalTests ?? 0) -
      (r.passedTests ?? 0) -
      (r.notApplicableTests ?? 0) -
      (r.incompleteTests ?? 0)
    const withFailures = runs.filter((r) => failedIn(r) > 0)
    say(
      `- runs with \`totalTests > 0\`: **${runs.filter((r) => (r.totalTests ?? 0) > 0).length}**/${runs.length}`,
      `- runs where \`totalTests − passedTests − notApplicable − incomplete > 0\`: **${withFailures.length}**`,
      `- \`runStatistics\` present (the \`includeRunDetails\` payload): **${runs.filter((r) => r.runStatistics).length}**`,
      `- \`build\` reference present: **${runs.filter((r) => r.build?.id).length}**`,
      `- \`state\`: ${tallyLine(runs.map((r) => String(r.state)))}`,
    )
    if (runs.some((r) => r.runStatistics)) {
      const stats = runs.flatMap((r) => r.runStatistics ?? [])
      say(
        `- \`runStatistics[]\` keys: ${tallyLine(stats.flatMap((s) => Object.keys(s)))}`,
        `- \`runStatistics[].outcome\` values: ${tallyLine(stats.map((s) => String(s.outcome)))}`,
      )
    }

    const hunted = withFailures.slice(0, 3)
    const rows = []
    let census1 = null
    for (const run of hunted) {
      const res = await ado(
        `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&$top=1000&api-version=7.1`,
        { label: 'test/runs/{id}/results?outcomes=Failed (hunted)' },
      )
      const value = res.body?.value ?? []
      rows.push(
        `| ${run.id} | ${run.build?.id ?? '—'} | ${run.totalTests} | ${run.passedTests} | ${failedIn(run)} | ${res.status} | ${value.length} | ${(res.bytes / 1024).toFixed(1)} | ${res.ms} |`,
      )
      if (value.length > 0 && census1 === null) census1 = { run, value, res }
      log(`  run ${run.id} → ${res.status} ${value.length} failed results`)
    }
    if (rows.length > 0) {
      table(
        ['| runId | buildId | `totalTests` | `passedTests` | derived failures | HTTP | `outcomes=Failed` returned | KB | ms |', '|---|---|---|---|---|---|---|---|---|'],
        rows,
      )
    }

    if (census1 === null) {
      say('_No run in the window returned any result with `outcome: Failed`._')
    } else {
      const { run, value, res } = census1
      say(
        `#### A **failed** test result (run ${run.id}, build ${run.build?.id ?? '—'})`,
        '',
        `\`outcomes=Failed\` returned **${value.length}** of \`totalTests: ${run.totalTests}\` in ${res.ms} ms and ${(res.bytes / 1024).toFixed(1)} KB.`,
      )
      table(['| key | present | types |', '|---|---|---|'], census(value))
      say(
        `- \`outcome\` values: ${tallyLine(value.map((r) => String(r.outcome)))}`,
        `- \`errorMessage\` present: **${value.filter((r) => r.errorMessage).length}**/${value.length}`,
        `- \`stackTrace\` present: **${value.filter((r) => r.stackTrace).length}**/${value.length}`,
        `- \`failureType\` values: ${tallyLine(value.map((r) => String(r.failureType)))}`,
        `- \`automatedTestName\` present: **${value.filter((r) => r.automatedTestName).length}**; \`automatedTestStorage\`: **${value.filter((r) => r.automatedTestStorage).length}**; \`testCaseTitle\`: **${value.filter((r) => r.testCaseTitle).length}**`,
        `- \`errorMessage\` length (chars, longest first): ${value
          .filter((r) => r.errorMessage)
          .map((r) => r.errorMessage.length)
          .sort((a, b) => b - a)
          .slice(0, 8)
          .join(' · ')}`,
        `- \`stackTrace\` length (chars, longest first): ${value
          .filter((r) => r.stackTrace)
          .map((r) => r.stackTrace.length)
          .sort((a, b) => b - a)
          .slice(0, 8)
          .join(' · ')}`,
        `- bytes per failed result: **${Math.round(res.bytes / value.length)}**`,
      )
      const one = value.find((r) => r.stackTrace) ?? value[0]
      say('One failed result, verbatim:', '', '```json', redact(JSON.stringify(one, null, 2)).slice(0, 4000), '```')

      // Does the cheap projection carry the message? It decides whether the UI
      // needs one call or two.
      const slim = await ado(
        `${project}/_apis/test/runs/${run.id}/results?outcomes=Failed&$top=1000&detailsToInclude=None&api-version=7.1`,
        { label: 'test/runs/{id}/results detailsToInclude=None (hunted)' },
      )
      const slimValue = slim.body?.value ?? []
      say(
        `- \`detailsToInclude=None\` on the same run: ${slim.status}, **${slimValue.length}** results, ${(slim.bytes / 1024).toFixed(1)} KB — \`errorMessage\` present on **${slimValue.filter((r) => r.errorMessage).length}**, \`stackTrace\` on **${slimValue.filter((r) => r.stackTrace).length}**`,
      )
    }
  }
}

// Whichever else answers: the summary endpoints, which are the cheap "are there
// any failures at all" question the inbox would want.
{
  const b = builds.find((x) => x.result === 'failed') ?? builds[0]
  if (b) {
    const project = b.__ref.project
    const others = [
      ['`test/ResultSummaryByBuild?buildId=`', `${project}/_apis/test/ResultSummaryByBuild?buildId=${b.id}&api-version=7.1-preview.1`],
      ['`testresults/resultsummarybybuild?buildId=`', `${project}/_apis/testresults/resultsummarybybuild?buildId=${b.id}&api-version=7.1-preview.1`],
      ['`test/runs?buildUri=` at `7.1-preview.3`', `${project}/_apis/test/runs?buildUri=${encodeURIComponent(`vstfs:///Build/Build/${b.id}`)}&api-version=7.1-preview.3`],
      ['`testresults/runs?buildUri=`', `${project}/_apis/testresults/runs?buildUri=${encodeURIComponent(`vstfs:///Build/Build/${b.id}`)}&api-version=7.1-preview.1`],
      ['`build/builds/{id}/artifacts`', `${project}/_apis/build/builds/${b.id}/artifacts?api-version=7.1`],
    ]
    const rows = []
    for (const [label, path] of others) {
      const res = await ado(path, { label })
      rows.push(
        `| ${label} | ${res.status} | ${res.bytes} | ${res.ms} | ${
          res.status === 200 ? esc(Object.keys(res.body ?? {}).join(', ')) : failMessage(res)
        } |`,
      )
      log(`  ${label} → ${res.status}`)
    }
    say(`### Whatever else answers (build ${b.id}, result \`${b.result}\`)`, '')
    table(['| endpoint | HTTP | bytes | ms | top-level keys / message |', '|---|---|---|---|---|'], rows)
  }
}

// ---------------------------------------------------------------------------
// §9  per-endpoint facts, rolled up
// ---------------------------------------------------------------------------

say('## 9 — Per-endpoint facts, rolled up', '')

const groups = new Map()
for (const c of ledger) {
  const key = c.label ?? 'unlabelled'
  const g = groups.get(key) ?? { calls: 0, statuses: [], ms: [], bytes: [], rate: 0, cache: new Set(), ct: new Set() }
  g.calls++
  g.statuses.push(c.status)
  g.ms.push(c.ms)
  g.bytes.push(c.bytes ?? 0)
  if (Object.keys(c.rate ?? {}).length > 0) g.rate++
  for (const k of Object.keys(c.cache ?? {})) g.cache.add(k)
  if (c.contentType) g.ct.add(String(c.contentType).split(';')[0])
  groups.set(key, g)
}

table(
  ['| call | n | statuses | ms (min/median/max) | bytes (max) | rate-limit headers | caching headers |', '|---|---|---|---|---|---|---|'],
  [...groups.entries()].map(([label, g]) => {
    const ms = [...g.ms].sort((a, b) => a - b)
    const median = ms[Math.floor(ms.length / 2)]

    return `| ${esc(label)} | ${g.calls} | ${tally(g.statuses).map(([s, n]) => `${s}×${n}`).join(' ')} | ${ms[0]}/${median}/${ms[ms.length - 1]} | ${Math.max(...g.bytes)} | ${g.rate === 0 ? '_none_' : `${g.rate}/${g.calls}`} | ${g.cache.size === 0 ? '_none_' : [...g.cache].join(', ')} |`
  }),
)

say(
  `Calls that carried **any** \`X-RateLimit-*\` or \`Retry-After\` header: **${ledger.filter((c) => Object.keys(c.rate ?? {}).length > 0).length}** of ${ledger.length}.`,
  '',
  `Calls that carried **any** caching header: **${ledger.filter((c) => Object.keys(c.cache ?? {}).length > 0).length}** of ${ledger.length}.`,
  '',
  `Distinct caching header names seen: ${tallyLine(ledger.flatMap((c) => Object.keys(c.cache ?? {})))}`,
)

say('### Which rate-limit headers, and what they said', '')
table(
  ['| header | calls carrying it | values seen |', '|---|---|---|'],
  RATE_HEADERS.map((h) => {
    const seen = ledger.filter((c) => c.rate?.[h] !== undefined)

    return seen.length === 0
      ? `| \`${h}\` | 0/${ledger.length} | — |`
      : `| \`${h}\` | ${seen.length}/${ledger.length} | ${tallyLine(seen.map((c) => c.rate[h])).slice(0, 300)} |`
  }),
)

// ---------------------------------------------------------------------------
// §10  re-run — the shapes, none of them sent
// ---------------------------------------------------------------------------

say(
  '## 10 — Re-run, documented and **unproven**',
  '',
  'Nothing below was sent. Every pull request in this organisation belongs to a colleague, and every one of these requests would start a build on their branch, so the shapes come from Microsoft\'s reference (fetched 2026-07-29) plus what `src/server/pull-request.ts` already ships. Each is marked with what a first live attempt would have to check.',
  '',
  '### a. Requeue the policy evaluation — the documented way to re-run a PR build',
  '',
  '```http',
  'PATCH https://dev.azure.com/{org}/{projectId}/_apis/policy/evaluations/{evaluationId}?api-version=7.1-preview.1',
  '```',
  '',
  '- **Body:** none documented. `requeueEvaluation()` in `src/server/pull-request.ts` sends none.',
  '- **Scope:** `vso.code_write`.',
  '- **Response:** `200` with the updated `PolicyEvaluationRecord` — the same object §3 censuses, so the reply is enough to redraw the row without a re-read.',
  '- **api-version:** `7.1-preview.1`. Measured in §3: the plain `7.1` is a **400** on this route, so the preview suffix is not optional.',
  '- **Documented side effect:** "Requeueing a build policy will queue a new build to run (cancelling any existing build which is running)." That is why `requeueTarget()` refuses a policy whose evaluation is `running`.',
  '- **Unproven:** whether ADO needs `{ "status": "queued" }` in the body. The reference prose says the operation is triggered "by updating an existing policy evaluation and setting the `PolicyEvaluationRecord.Status` field to Queued", while the request-body table is empty. A first live attempt must record the status code for the bodyless PATCH before assuming it works.',
  '',
  '### b. Retry the whole build',
  '',
  '```http',
  'PATCH https://dev.azure.com/{org}/{projectId}/_apis/build/builds/{buildId}?retry=true&api-version=7.1',
  '```',
  '',
  '- **Body:** a `Build` object. Every field is optional in the schema; the minimal body is unproven — `{}` may be enough, or the service may want `{ "id": buildId }`.',
  '- **Scope:** `vso.build_execute` — a scope the PAT this repo stores may not have. §5\'s reads only prove `vso.build`.',
  '- **Response:** `200` with the `Build`.',
  '- **api-version:** `7.1` plain. §5 measured that the *read* on this route accepts `7.1`, `6.0` and `2.0` and needs no preview suffix.',
  '- **Unproven:** whether a retry produces a new build id or reuses the old one. It matters because the policy evaluation\'s `context.buildId` is what phase 5 links to, and a retry that reuses the id leaves the checklist looking unchanged. Also unproven: whether retrying a PR build re-links it to the policy at all, or leaves the policy pointing at the old run.',
  '',
  '### c. Retry a single stage',
  '',
  '```http',
  'PATCH https://dev.azure.com/{org}/{projectId}/_apis/build/builds/{buildId}/stages/{stageRefName}?api-version=7.1',
  'Content-Type: application/json',
  '',
  '{ "state": "retry", "forceRetryAllJobs": false }',
  '```',
  '',
  '- **Body:** `UpdateStageParameters` — exactly two fields at 7.1, `state` (`cancel` | `retry`) and `forceRetryAllJobs`. There is no `retryDependencies` at this version.',
  '- **Scope:** `vso.build_execute`.',
  '- **Response:** `200` with **no body** in the reference. A caller cannot learn the new state from the reply and must re-read the timeline.',
  '- **`stageRefName`:** the timeline `Stage` record\'s `identifier`, not its `name`.',
  '- **Unproven, and now measured to be mostly moot:** §6c swept the pipelines in this project and found no stage whose `identifier` was anything but `__default`. Stage-level retry is a real API but there is nothing in this org to point it at, so phase 5 should treat it as the *last* granularity to build, not the first.',
  '',
  '### What the first live re-run would have to check',
  '',
  '1. The status code and body of the bodyless policy PATCH — `200`, `400` (wants a body), or `403` (PAT lacks `vso.code_write`).',
  '2. Whether the returned `PolicyEvaluationRecord` already carries the new `context.buildId`, or comes back still pointing at the cancelled run. If the latter, the UI must poll rather than trust the reply.',
  '3. Whether `context.buildIsNotCurrent` flips, and how long the row spends in `queued` before a `buildId` appears — that interval is the one the button has to stay disabled for.',
  '4. Whether the cancelled previous build turns up as `result: canceled` (a documented value §5 never observed) and therefore needs drawing.',
  '5. On a build retry, whether the build id changes.',
)

// ---------------------------------------------------------------------------
// §11–§12  the findings, and the holes in them — hand-authored, from the numbers above
// ---------------------------------------------------------------------------

say(
  '## 11 — What this changes for phase 5',
  '',
  '**A status can name a verdict but never a build.** Of 286 statuses across 24 pull requests, **0** carried a build id — 42 had a `targetUrl` and all 42 pointed at `sonarcloud.io`. The 244 `codecoverage` statuses carry a description and nothing else. `policy/evaluations` and its `context.buildId` (27 of 150 evaluations) is the only route from a pull request to a build in this organisation.',
  '',
  '**A pull request can hold five build policies.** 20 of 23 had one, 2 had three, 1 had five, across 18 distinct `buildDefinitionId`s. "The build for this PR" is not a thing; a list is. And no re-run history is recoverable from the evaluations — duplicate `configuration.id` within one pull request: **0** of 23 — so a previous attempt has to be found through `build/builds`, not here.',
  '',
  '**The failing step is the failed record that is a leaf.** 34 records reported `result: failed`, but only **10** were leaves. All ten were `Task`, all ten had a `log`, all ten had `errorCount > 0`, all ten had non-empty `issues`. The other 24 — `Job` ×8, `Phase` ×8, `Stage` ×8 — are ancestors reporting `failed` with **`errorCount: 0`**. A panel that lists failed records shows four rows per failure and only one of them is the answer.',
  '',
  '**`issues` is an absent key, not an empty array** — present on 27 of 440 records, so `record.issues.length` throws on 413 of them. When it is there it is the most useful thing in the response: 62 of 95 issues carried `sourcepath`, `linenumber` and `columnnumber`, which is the only mapping there is from a compiler error to a line of the diff.',
  '',
  '**`Accept: application/json` — which `ado-client.ts` sends on every call — changes what a log is.** The same URL answers `{"count":46,"value":[…lines…]}` under JSON and 3884 bytes of raw text under `text/plain`. Neither is wrong, but the two need different parsing. And a log id that does not exist answers **200 with an empty body** rather than 404, as does a `startLine` past the end.',
  '',
  '**The test path has two traps.** `testresults/resultsbybuild?buildId=` 404s on `dev.azure.com` (8 of 8) and answers only on the separate `vstmr.dev.azure.com` host, while `test/runs?buildUri=vstfs:///Build/Build/{id}` works on the normal one. And a run carries **no `failedTests` field** — the count is `totalTests − passedTests − notApplicableTests − incompleteTests`, which is how the only 4 runs with failures were found among 100. `outcomes=Failed` does filter server-side, but `detailsToInclude=None` trims nothing: the same run was 191.0 KB either way, at ~6985 bytes per failed result and stack traces server-truncated at exactly 4000 characters.',
  '',
  '**The rate-limit budget is not readable.** `x-ratelimit-cost` appeared on 99 of 176 calls; `x-ratelimit-remaining`, `-limit`, `-delay`, `-reset` and `retry-after` appeared on **0**. Only the cost is legible, so there is no budget to watch and no `Retry-After` to obey until one arrives.',
  '',
  '## 12 — What was not measured',
  '',
  'Not measured:',
  '',
  '- **Every write.** No `POST`, `PUT`, `PATCH` or `DELETE` was issued, so requeueing a policy, retrying a build and retrying a stage are documented and unproven — §10.',
  '- `result: canceled` and `result: partiallySucceeded` builds. `statusFilter=cancelling` and `statusFilter=postponed` each matched **0** builds in the project.',
  '- A retry of anything. `attempt` was `1` on 440/440 records and `previousAttempts` was empty on all of them, so the second-attempt shape is unknown.',
  '- A real stage. 10 pipelines swept, **0** with a stage `identifier` other than `__default`, so `stages/{stageRefName}` has nothing here to address.',
  '- Record results `succeededWithIssues`, `abandoned` and `canceled` — documented, never seen.',
  '- The largest logs. The biggest single fetch was 21024 bytes; the 2727-line log on the same build was never pulled whole, so no byte cap has been exercised against a real ceiling.',
  '- More than one test run per build. `test/runs?buildUri=` returned at most **1** across 8 builds, so the multi-run case is a guess.',
  '- Throttling. Not one `Retry-After` arrived across 176 calls, so the backoff path in `ado-client.ts` is still untested against the live service.',
  '- Anything outside the `Products` project. The sample reached 15 repositories but 1 project.',
  '- The PAT\'s scopes. Reads prove `vso.code` and `vso.build`; whether it holds `vso.code_write` or `vso.build_execute` is unknown until a write is attempted, and a 403 is a real possibility for the re-run button.',
  '',
  'Deliberately not probed:',
  '',
  '- Queueing a build (`POST build/builds`), updating a test run, deleting a log, or any other endpoint whose effect would land on a colleague\'s pull request or a shared pipeline.',
  '- The `policy/evaluations` PATCH, even against an abandoned pull request — an abandoned PR\'s build policy still points at a real pipeline and a real branch.',
)

say('## Call cost', '', `- ADO requests: **${calls}**, every one a \`GET\``)

await mkdir('docs/research', { recursive: true })
await writeFile(
  OUT,
  [
    '# Build, timeline, log and test-result endpoint inventory (T-029)',
    '',
    `Read-only probe of the phase-5 check surface — \`pullRequests/{id}/statuses\`, \`policy/evaluations\`, \`build/builds/{id}\`, its \`timeline\`, its \`logs\`, and the two test-result routes — against the live \`${ORG}\` org. **Every request was a GET.**`,
    '',
    'Generated by `scripts/checks-inventory.mjs`. Secrets redacted; identity GUIDs and record GUIDs are left in because the app matches on them.',
    '',
    '---',
    '',
    ...report,
  ].join('\n'),
  'utf8',
)

log(`\nWrote ${OUT} (${calls} ADO calls, all GETs).`)
