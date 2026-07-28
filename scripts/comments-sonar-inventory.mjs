// Throwaway spike for T-022. Not application code — do not import from it.
//
// Round 4 needs two endpoint families settled before anything is built on them:
// ADO `pullRequests/{id}/threads` (comments) and the SonarCloud read surface
// (gate, issues, rules). This probes both against the live org and writes
// docs/research/comments-sonar-inventory.md with the raw shapes.
//
//   node scripts/comments-sonar-inventory.mjs
//
// Optional: ADO_PR_ID (skip auto-selection), ADO_ORG / ADO_PAT / SONAR_TOKEN
//           (skip the credential store).
//
// **Read-only by construction.** Every request below is a GET. Round 4 writes
// comments, and a write probe would post to a real colleague's pull request, so
// the write paths are proven against fixtures and left for the user to smoke
// test on a PR they own.

import { writeFile, mkdir } from 'node:fs/promises'

async function credentials() {
  const fromEnv = {
    org: process.env.ADO_ORG,
    pat: process.env.ADO_PAT,
    sonar: process.env.SONAR_TOKEN,
  }
  if (fromEnv.org && fromEnv.pat && fromEnv.sonar) return fromEnv

  try {
    const store = await import('../src/server/credentials.ts')
    const ado = store.readAdoCredential()
    const sonar = store.readSonarCredential()

    return {
      org: fromEnv.org ?? ado?.org,
      pat: fromEnv.pat ?? ado?.pat,
      sonar: fromEnv.sonar ?? sonar?.token,
      source: 'credential store',
    }
  } catch (err) {
    console.error(`(credential store unreadable: ${err?.message ?? err})`)

    return fromEnv
  }
}

const { org: ORG, pat: PAT, sonar: SONAR_TOKEN, source } = await credentials()

if (!ORG || !PAT) {
  console.error('No ADO credential. Either set ADO_ORG and ADO_PAT, or store one at /onboarding.')
  process.exit(1)
}
if (source) console.log(`Using credentials from the ${source}.`)

const ADO = `https://dev.azure.com/${ORG}`
const SONAR = 'https://sonarcloud.io'
const OUT = 'docs/research/comments-sonar-inventory.md'

const secrets = [PAT, SONAR_TOKEN].filter(Boolean)
const redact = (s) => secrets.reduce((acc, t) => acc.split(t).join('«redacted»'), String(s ?? ''))

const report = []
const say = (...lines) => report.push(...lines, '')
const log = (m) => console.log(m)

const RATE_HEADERS = [
  'x-ratelimit-cost',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-delay',
  'x-ratelimit-reset',
  'retry-after',
]

const adoHeaders = {
  Authorization: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`,
  'X-TFS-FedAuthRedirect': 'Suppress',
  Accept: 'application/json',
}

let adoCalls = 0
let sonarCalls = 0

async function ado(path, { raw = false } = {}) {
  adoCalls++
  const url = path.startsWith('http') ? path : `${ADO}/${path.replace(/^\//, '')}`
  const started = Date.now()
  const res = await fetch(url, {
    headers: adoHeaders,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const ms = Date.now() - started
  const text = await res.text()
  const rate = Object.fromEntries(
    RATE_HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null),
  )
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }

  return { status: res.status, ms, rate, body, text: raw ? text : text.slice(0, 400), url }
}

async function sonar(path) {
  sonarCalls++
  const url = `${SONAR}/${path.replace(/^\//, '')}`
  const started = Date.now()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SONAR_TOKEN}`, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const ms = Date.now() - started
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }

  return {
    status: res.status,
    ms,
    body,
    text: text.slice(0, 600),
    url,
    rate: Object.fromEntries(
      ['x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']
        .map((h) => [h, res.headers.get(h)])
        .filter(([, v]) => v !== null),
    ),
  }
}

/** Field census: which keys are present, and with what JSON type, across N objects. */
function census(objects) {
  const keys = new Map()
  for (const o of objects) {
    for (const [k, v] of Object.entries(o ?? {})) {
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

// ---------------------------------------------------------------------------
// §1  Find pull requests worth probing
// ---------------------------------------------------------------------------

log('§1 selecting pull requests…')
say('## 1 — Sample selection', '')

const list = await ado('_apis/git/pullrequests?searchCriteria.status=active&$top=100')
if (list.status !== 200) {
  console.error(`PR list answered ${list.status}: ${redact(list.text)}`)
  process.exit(1)
}
const prs = list.body.value ?? []
say(`Org-wide active pull requests fetched: **${prs.length}** (\`$top=100\`).`)

const refOf = (pr) => ({
  id: pr.pullRequestId,
  project: pr.repository.project.id,
  projectName: pr.repository.project.name,
  repo: pr.repository.id,
  repoName: pr.repository.name,
  title: pr.title,
})

const base = (r) => `${r.project}/_apis/git/repositories/${r.repo}/pullRequests/${r.id}`

/** Candidates: the forced id if given, else a spread over distinct repositories. */
let candidates
if (process.env.ADO_PR_ID) {
  const found = prs.find((p) => String(p.pullRequestId) === process.env.ADO_PR_ID)
  if (!found) {
    console.error(`ADO_PR_ID=${process.env.ADO_PR_ID} is not in the active list.`)
    process.exit(1)
  }
  candidates = [refOf(found)]
} else {
  const seen = new Set()
  candidates = []
  for (const pr of prs) {
    if (seen.has(pr.repository.id) && candidates.length >= 6) continue
    seen.add(pr.repository.id)
    candidates.push(refOf(pr))
    if (candidates.length >= 14) break
  }
}

// ---------------------------------------------------------------------------
// §2  threads — census across the candidates
// ---------------------------------------------------------------------------

log(`§2 threads on ${candidates.length} pull requests…`)
say('## 2 — `pullRequests/{id}/threads`', '')

const allThreads = []
const perPr = []

for (const ref of candidates) {
  const res = await ado(`${base(ref)}/threads`)
  const threads = res.body?.value ?? []
  perPr.push({ ref, status: res.status, ms: res.ms, rate: res.rate, count: threads.length })
  if (res.status === 200) allThreads.push(...threads.map((t) => ({ ...t, __pr: ref.id })))
  log(`  !${ref.id} ${res.status} ${threads.length} threads ${res.ms}ms`)
}

say('| PR | status | threads | ms | rate-limit headers |', '|---|---|---|---|---|')
report.pop()
for (const p of perPr) {
  report.push(
    `| !${p.ref.id} | ${p.status} | ${p.count} | ${p.ms} | ${
      Object.keys(p.rate).length === 0 ? '_none_' : JSON.stringify(p.rate)
    } |`,
  )
}
report.push('')

say(`Threads collected: **${allThreads.length}** across ${perPr.length} pull requests.`)

const comments = allThreads.flatMap((t) => t.comments ?? [])

say('### Thread field census', '', '| key | present | types |', '|---|---|---|')
report.pop()
report.push(...census(allThreads), '')

say('### Comment field census', '', '| key | present | types |', '|---|---|---|')
report.pop()
report.push(...census(comments), '')

say(
  '### Value tallies',
  '',
  `- thread \`status\`: ${tally(allThreads.map((t) => String(t.status))).map(([v, n]) => `\`${v}\` ×${n}`).join(' · ')}`,
  `- comment \`commentType\`: ${tally(comments.map((c) => String(c.commentType))).map(([v, n]) => `\`${v}\` ×${n}`).join(' · ')}`,
  `- \`isDeleted\` on comments: ${tally(comments.map((c) => String(c.isDeleted))).map(([v, n]) => `\`${v}\` ×${n}`).join(' · ')}`,
  `- threads with \`threadContext === null\`: **${allThreads.filter((t) => t.threadContext == null).length}** of ${allThreads.length}`,
  `- threads with \`isDeleted: true\`: **${allThreads.filter((t) => t.isDeleted === true).length}**`,
  `- threads with a non-empty \`properties\`: **${allThreads.filter((t) => t.properties && Object.keys(t.properties).length > 0).length}**`,
  `- comments with a non-empty \`usersLiked\`: **${comments.filter((c) => (c.usersLiked ?? []).length > 0).length}**`,
  `- threads with \`comments.length > 1\`: **${allThreads.filter((t) => (t.comments ?? []).length > 1).length}**`,
)

// properties keys — this is where ADO and Sonar both stash machine-readable state
const propertyKeys = new Map()
for (const t of allThreads) {
  for (const k of Object.keys(t.properties ?? {})) {
    propertyKeys.set(k, (propertyKeys.get(k) ?? 0) + 1)
  }
}
say(
  '### `properties` keys observed',
  '',
  propertyKeys.size === 0
    ? '_none_'
    : [...propertyKeys.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `- \`${k}\` ×${n}`)
        .join('\n'),
)

// threadContext geometry
const anchored = allThreads.filter((t) => t.threadContext?.filePath)
say(
  '### `threadContext`',
  '',
  `Anchored threads: **${anchored.length}** of ${allThreads.length}.`,
  '',
  '| key | present | types |',
  '|---|---|---|',
)
report.pop()
report.push(...census(anchored.map((t) => t.threadContext)), '')

const positions = anchored.flatMap((t) =>
  [
    t.threadContext.rightFileStart,
    t.threadContext.rightFileEnd,
    t.threadContext.leftFileStart,
    t.threadContext.leftFileEnd,
  ].filter(Boolean),
)
say('Position objects (`{line, offset}`) census:', '', '| key | present | types |', '|---|---|---|')
report.pop()
report.push(...census(positions), '')

say(
  `- \`filePath\` values starting with \`/\`: **${anchored.filter((t) => t.threadContext.filePath.startsWith('/')).length}** of ${anchored.length}`,
  `- right-side only (no \`leftFileStart\`): **${anchored.filter((t) => t.threadContext.rightFileStart && !t.threadContext.leftFileStart).length}**`,
  `- left-side only: **${anchored.filter((t) => t.threadContext.leftFileStart && !t.threadContext.rightFileStart).length}**`,
  `- both sides: **${anchored.filter((t) => t.threadContext.leftFileStart && t.threadContext.rightFileStart).length}**`,
  `- multi-line (start.line !== end.line): **${anchored.filter((t) => (t.threadContext.rightFileStart?.line ?? 0) !== (t.threadContext.rightFileEnd?.line ?? 0)).length}**`,
  `- \`offset\` of 1 on every start: **${positions.every((p) => p.offset === 1)}**`,
)

const iterCtx = allThreads.filter((t) => t.pullRequestThreadContext)
say(
  '### `pullRequestThreadContext` (which iteration the anchor was written against)',
  '',
  `Present on **${iterCtx.length}** of ${allThreads.length} threads.`,
)
if (iterCtx.length > 0) {
  say('```json', JSON.stringify(iterCtx[0].pullRequestThreadContext, null, 2), '```')
  say(
    '| key | present | types |',
    '|---|---|---|',
  )
  report.pop()
  report.push(...census(iterCtx.map((t) => t.pullRequestThreadContext)), '')
}

// One whole thread, verbatim, as the fixture the round is built against.
const fixture =
  allThreads.find((t) => t.threadContext?.filePath && (t.comments ?? []).length > 1) ??
  allThreads.find((t) => t.threadContext?.filePath) ??
  allThreads[0]
if (fixture) {
  const scrubbed = JSON.parse(redact(JSON.stringify(fixture)))
  say('### One anchored thread, verbatim', '', '```json', JSON.stringify(scrubbed, null, 2), '```')
}

// ---------------------------------------------------------------------------
// §3  threads — parameter behaviour on the busiest PR
// ---------------------------------------------------------------------------

const busiest = perPr.filter((p) => p.status === 200).sort((a, b) => b.count - a.count)[0]

say('## 3 — `threads` parameter behaviour', '')

if (!busiest || busiest.count === 0) {
  say('_No pull request in the sample had a single thread; nothing to vary parameters against._')
} else {
  const ref = busiest.ref
  say(`Probed against !${ref.id} (${busiest.count} threads).`)

  const variants = [
    ['default (7.1)', `${base(ref)}/threads`],
    ['`$top=1`', `${base(ref)}/threads?$top=1`],
    ['`$skip=1`', `${base(ref)}/threads?$skip=1`],
    ['`api-version=7.1`', `${base(ref)}/threads?api-version=7.1`],
    ['`api-version=7.2-preview.1`', `${base(ref)}/threads?api-version=7.2-preview.1`],
    ['`api-version` omitted', `${base(ref)}/threads?api-version=`],
    ['`$expand=none`', `${base(ref)}/threads?$expand=none`],
    ['`iteration=1&baseIteration=0`', `${base(ref)}/threads?iteration=1&baseIteration=0`],
    ['one thread by id', null],
  ]

  say('| variant | status | threads returned | note |', '|---|---|---|---|')
  report.pop()
  for (const [label, path] of variants) {
    if (path === null) continue
    const res = await ado(path)
    const n = res.body?.value?.length ?? (res.body?.id ? 1 : null)
    report.push(
      `| ${label} | ${res.status} | ${n ?? '—'} | ${
        res.status === 200 ? '' : redact(res.body?.message ?? res.text).slice(0, 160).replace(/\|/g, '\\|')
      } |`,
    )
    log(`  ${label} → ${res.status} ${n}`)
  }

  // A single thread by id: does it answer, and does it carry the same shape?
  const someThread = allThreads.find((t) => t.__pr === ref.id)
  if (someThread) {
    const one = await ado(`${base(ref)}/threads/${someThread.id}`)
    report.push(
      `| \`threads/${someThread.id}\` | ${one.status} | ${one.body?.id ? 1 : '—'} | ${
        one.status === 200 ? 'single thread, not wrapped in `value`' : redact(one.text).slice(0, 120)
      } |`,
    )
    const oneComment = await ado(`${base(ref)}/threads/${someThread.id}/comments`)
    report.push(
      `| \`threads/${someThread.id}/comments\` | ${oneComment.status} | ${
        oneComment.body?.value?.length ?? '—'
      } | separate comment collection |`,
    )
  }
  report.push('')
}

// ---------------------------------------------------------------------------
// §4  statuses → the Sonar link
// ---------------------------------------------------------------------------

log('§4 statuses and the Sonar link…')
say('## 4 — `statuses` and the ADO→Sonar bridge', '')

const sonarLinks = []
say('| PR | statuses | genres | Sonar status | projectKey from `targetUrl` | `createdBy.id` |', '|---|---|---|---|---|---|')
report.pop()

for (const ref of candidates) {
  const res = await ado(`${base(ref)}/statuses`)
  const statuses = res.body?.value ?? []
  const genres = tally(statuses.map((s) => String(s.context?.genre))).map(([v, n]) => `${v}×${n}`)
  const sq = statuses.find(
    (s) => (s.context?.genre ?? '').toLowerCase() === 'sonarcloud' || /sonar/i.test(s.context?.name ?? ''),
  )
  let projectKey = null
  if (sq?.targetUrl) {
    try {
      projectKey = new URL(sq.targetUrl).searchParams.get('id')
    } catch {
      projectKey = null
    }
  }
  if (sq) sonarLinks.push({ ref, status: sq, projectKey })
  report.push(
    `| !${ref.id} | ${statuses.length} | ${genres.join(' ') || '—'} | ${
      sq ? `\`${sq.context.genre}/${sq.context.name}\` → ${sq.state}` : '—'
    } | ${projectKey ? `\`${projectKey}\`` : '—'} | ${sq?.createdBy?.id ?? '—'} |`,
  )
  log(`  !${ref.id} statuses ${statuses.length}${sq ? ' (sonar)' : ''}`)
}
report.push('')

if (sonarLinks.length > 0) {
  const scrubbed = JSON.parse(redact(JSON.stringify(sonarLinks[0].status)))
  say('### The SonarCloud status, verbatim', '', '```json', JSON.stringify(scrubbed, null, 2), '```')
}

// Sonar-authored threads: does comments[0].author.id match the status createdBy.id?
say('### Sonar-authored thread detection', '')
if (sonarLinks.length === 0) {
  say('_No SonarCloud status found on any sampled pull request — detection is unverified._')
} else {
  const authorIds = new Map()
  for (const t of allThreads) {
    const id = t.comments?.[0]?.author?.id
    if (id) authorIds.set(id, (authorIds.get(id) ?? 0) + 1)
  }
  const statusAuthors = new Set(sonarLinks.map((l) => l.status.createdBy?.id).filter(Boolean))
  say(
    `Distinct first-comment authors across ${allThreads.length} threads: **${authorIds.size}**.`,
    '',
    `Status \`createdBy.id\` values: ${[...statusAuthors].map((i) => `\`${i}\``).join(', ')}`,
    '',
    [...authorIds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(
        ([id, n]) =>
          `- \`${id}\` — ${n} thread(s)${statusAuthors.has(id) ? ' ← **matches the Sonar status author**' : ''}`,
      )
      .join('\n'),
  )
  const matched = allThreads.filter((t) => statusAuthors.has(t.comments?.[0]?.author?.id))
  say(
    `Threads whose first comment matches a Sonar status author: **${matched.length}**.`,
  )
  if (matched.length > 0) {
    const scrubbed = JSON.parse(redact(JSON.stringify(matched[0])))
    say('```json', JSON.stringify(scrubbed, null, 2), '```')
  }
}

// ---------------------------------------------------------------------------
// §5  SonarCloud read surface
// ---------------------------------------------------------------------------

say('## 5 — SonarCloud read surface', '')

if (!SONAR_TOKEN) {
  say('_No SonarCloud token available; §5 skipped._')
} else {
  const link = sonarLinks[0]
  const projectKey = process.env.SONAR_PROJECT ?? link?.projectKey
  const prId = link?.ref.id

  log(`§5 sonar (projectKey=${projectKey ?? 'unknown'}, pr=${prId ?? 'unknown'})…`)

  const validate = await sonar('api/authentication/validate')
  say(
    `- \`api/authentication/validate\` → ${validate.status}, \`valid: ${validate.body?.valid}\``,
  )

  if (!projectKey) {
    say('_No projectKey recoverable from any ADO status; the project-scoped probes are skipped._')
  } else {
    say(`Probing \`${projectKey}\`${prId ? ` on pull request ${prId}` : ''}.`, '')

    const probes = [
      ['`api/project_pull_requests/list`', `api/project_pull_requests/list?project=${encodeURIComponent(projectKey)}`],
      [
        '`api/qualitygates/project_status` (deprecated)',
        `api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}${prId ? `&pullRequest=${prId}` : ''}`,
      ],
      [
        '`api/measures/component`',
        `api/measures/component?component=${encodeURIComponent(projectKey)}${
          prId ? `&pullRequest=${prId}` : ''
        }&metricKeys=alert_status,quality_gate_details,new_violations,new_blocker_violations,new_security_hotspots,new_coverage,new_duplicated_lines_density,new_software_quality_maintainability_issues,new_software_quality_reliability_issues,new_software_quality_security_issues`,
      ],
      [
        '`api/issues/search` (MQR fields)',
        `api/issues/search?componentKeys=${encodeURIComponent(projectKey)}${
          prId ? `&pullRequest=${prId}` : ''
        }&ps=500&additionalFields=_all&facets=rules,impactSeverities,impactSoftwareQualities,cleanCodeAttributeCategories`,
      ],
      [
        '`api/issues/search` with `components` (the wrong param)',
        `api/issues/search?components=${encodeURIComponent(projectKey)}${prId ? `&pullRequest=${prId}` : ''}&ps=1`,
      ],
      [
        '`api/hotspots/search`',
        `api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}${prId ? `&pullRequest=${prId}` : ''}&ps=100`,
      ],
    ]

    const results = {}
    say('| endpoint | status | ms | shape |', '|---|---|---|---|')
    report.pop()
    for (const [label, path] of probes) {
      const res = await sonar(path)
      results[label] = res
      const shape =
        res.status === 200 && res.body
          ? Object.keys(res.body).map((k) => `\`${k}\``).join(' ')
          : redact(res.body?.errors?.[0]?.msg ?? res.text).slice(0, 140).replace(/\|/g, '\\|')
      report.push(`| ${label} | ${res.status} | ${res.ms} | ${shape} |`)
      log(`  ${label} → ${res.status}`)
    }
    report.push('')

    const issuesRes = results['`api/issues/search` (MQR fields)']
    const issues = issuesRes?.body?.issues ?? []
    say(
      '### `issues/search`',
      '',
      `- \`total\`: **${issuesRes?.body?.total ?? issuesRes?.body?.paging?.total ?? '—'}**, returned **${issues.length}** at \`ps=500\``,
      `- \`paging\`: \`${JSON.stringify(issuesRes?.body?.paging ?? null)}\``,
    )
    if (issues.length > 0) {
      say('| key | present | types |', '|---|---|---|')
      report.pop()
      report.push(...census(issues), '')
      say(
        `- \`impacts\` present: **${issues.filter((i) => Array.isArray(i.impacts)).length}**/${issues.length}`,
        `- legacy \`type\`/\`severity\` present: **${issues.filter((i) => i.type).length}**/**${issues.filter((i) => i.severity).length}**`,
        `- \`issueStatus\` values: ${tally(issues.map((i) => String(i.issueStatus))).map(([v, n]) => `\`${v}\`×${n}`).join(' · ')}`,
        `- legacy \`status\` values: ${tally(issues.map((i) => String(i.status))).map(([v, n]) => `\`${v}\`×${n}`).join(' · ')}`,
        `- \`cleanCodeAttributeCategory\` values: ${tally(issues.map((i) => String(i.cleanCodeAttributeCategory))).map(([v, n]) => `\`${v}\`×${n}`).join(' · ')}`,
        `- impact severities: ${tally(issues.flatMap((i) => (i.impacts ?? []).map((x) => `${x.softwareQuality}:${x.severity}`))).map(([v, n]) => `\`${v}\`×${n}`).join(' · ')}`,
        `- distinct rules: **${new Set(issues.map((i) => i.rule)).size}**`,
        `- \`textRange\` present: **${issues.filter((i) => i.textRange).length}**/${issues.length}; \`line\` present: **${issues.filter((i) => i.line != null).length}**`,
        `- issues with \`flows\` non-empty: **${issues.filter((i) => (i.flows ?? []).length > 0).length}**`,
        `- \`component\` example: \`${issues[0].component}\` (project prefix is \`${projectKey}:\`)`,
      )
      const scrubbed = JSON.parse(redact(JSON.stringify(issues[0])))
      say('One issue, verbatim:', '', '```json', JSON.stringify(scrubbed, null, 2), '```')

      if (issuesRes.body.facets) {
        say(
          'Facets returned:',
          '',
          '```json',
          JSON.stringify(issuesRes.body.facets, null, 2).slice(0, 3000),
          '```',
        )
      }

      // rules: plural batching, and what a description costs
      const ruleKeys = [...new Set(issues.map((i) => i.rule))].slice(0, 15)
      const plural = await sonar(
        `api/rules/search?rule_keys=${encodeURIComponent(ruleKeys.join(','))}&f=name,htmlDesc,mdDesc,severity,type,cleanCodeAttribute,impacts,descriptionSections,educationPrinciples&ps=100`,
      )
      const singular = await sonar(
        `api/rules/search?rule_key=${encodeURIComponent(ruleKeys.join(','))}&ps=100`,
      )
      const show = await sonar(`api/rules/show?key=${encodeURIComponent(ruleKeys[0])}`)
      say(
        '### `rules`',
        '',
        `- \`rules/search?rule_keys=\` (${ruleKeys.length} keys) → ${plural.status}, \`total: ${plural.body?.total}\`, returned ${plural.body?.rules?.length ?? '—'} in ${plural.ms}ms`,
        `- \`rules/search?rule_key=\` (same keys, singular) → ${singular.status}, \`total: ${singular.body?.total}\``,
        `- \`rules/show?key=${ruleKeys[0]}\` → ${show.status}, keys: ${Object.keys(show.body?.rule ?? {}).map((k) => `\`${k}\``).join(' ')}`,
      )
      if (plural.body?.rules?.[0]) {
        const r = plural.body.rules[0]
        say(
          `- first rule: \`${r.key}\` — htmlDesc ${((r.htmlDesc ?? '').length / 1024).toFixed(1)} KB, mdDesc ${((r.mdDesc ?? '').length / 1024).toFixed(1)} KB, descriptionSections ${(r.descriptionSections ?? []).length}`,
          `- \`descriptionSections\` keys: ${(r.descriptionSections ?? []).map((s) => `\`${s.key}\``).join(' ')}`,
          `- rule field census across ${plural.body.rules.length} rules:`,
        )
        say('| key | present | types |', '|---|---|---|')
        report.pop()
        report.push(...census(plural.body.rules), '')
      }
    }

    const measures = results['`api/measures/component`']
    if (measures?.body?.component) {
      say(
        '### `measures/component`',
        '',
        '```json',
        JSON.stringify(measures.body.component, null, 2).slice(0, 2500),
        '```',
      )
    }
    const gate = results['`api/qualitygates/project_status` (deprecated)']
    if (gate?.body) {
      say(
        '### `qualitygates/project_status`',
        '',
        '```json',
        JSON.stringify(gate.body, null, 2).slice(0, 3000),
        '```',
      )
    }
  }
}

// ---------------------------------------------------------------------------

say('## Call cost', '', `- ADO requests: **${adoCalls}**`, `- SonarCloud requests: **${sonarCalls}**`)

await mkdir('docs/research', { recursive: true })
await writeFile(
  OUT,
  [
    '# Comments and Sonar endpoint inventory (T-022)',
    '',
    `Read-only probe of \`pullRequests/{id}/threads\`, \`statuses\`, and the SonarCloud read surface against the live \`${ORG}\` org. Every request was a GET.`,
    '',
    'Generated by `scripts/comments-sonar-inventory.mjs`. Secrets redacted; identity GUIDs are left in because the app matches on them.',
    '',
    '---',
    '',
    ...report,
  ].join('\n'),
  'utf8',
)

log(`\nWrote ${OUT} (${adoCalls} ADO + ${sonarCalls} Sonar calls).`)
