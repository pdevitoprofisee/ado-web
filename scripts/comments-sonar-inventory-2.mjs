// Second pass for T-022, appended to docs/research/comments-sonar-inventory.md.
//
// The first pass picked a pull request whose quality gate had passed with zero
// new issues, so `issues/search` answered `total: 0` and the issue shape — the
// one thing the Sonar contract is built out of — was never seen. It also asked
// `measures/component` for MQR metric keys that do not exist on Cloud and read
// the resulting 404 as "the endpoint is gone".
//
// This pass targets a **failing** gate, a PR with Sonar-authored comment
// threads, and a valid metric set.
//
//   node scripts/comments-sonar-inventory-2.mjs
//
// Read-only. Every request is a GET.

import { appendFile } from 'node:fs/promises'

async function credentials() {
  const store = await import('../src/server/credentials.ts')
  const ado = store.readAdoCredential()
  const sonar = store.readSonarCredential()

  return {
    org: process.env.ADO_ORG ?? ado?.org,
    pat: process.env.ADO_PAT ?? ado?.pat,
    sonar: process.env.SONAR_TOKEN ?? sonar?.token,
  }
}

const { org: ORG, pat: PAT, sonar: SONAR_TOKEN } = await credentials()
const ADO = `https://dev.azure.com/${ORG}`
const SONAR = 'https://sonarcloud.io'
const OUT = 'docs/research/comments-sonar-inventory.md'

const secrets = [PAT, SONAR_TOKEN].filter(Boolean)
const redact = (s) => secrets.reduce((acc, t) => acc.split(t).join('«redacted»'), String(s ?? ''))

const report = []
const say = (...lines) => report.push(...lines, '')
const log = (m) => console.log(m)

const adoHeaders = {
  Authorization: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`,
  'X-TFS-FedAuthRedirect': 'Suppress',
  Accept: 'application/json',
}

let adoCalls = 0
let sonarCalls = 0

async function ado(path) {
  adoCalls++
  const started = Date.now()
  const res = await fetch(`${ADO}/${path.replace(/^\//, '')}`, {
    headers: adoHeaders,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const ms = Date.now() - started
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}

  return { status: res.status, ms, body, text: text.slice(0, 300) }
}

async function sonar(path) {
  sonarCalls++
  const started = Date.now()
  const res = await fetch(`${SONAR}/${path.replace(/^\//, '')}`, {
    headers: { Authorization: `Bearer ${SONAR_TOKEN}`, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const ms = Date.now() - started
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}

  return {
    status: res.status,
    ms,
    body,
    text: text.slice(0, 500),
    headers: Object.fromEntries([...res.headers.entries()]),
  }
}

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

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `\`${v}\`×${n}`)
    .join(' · ')
}

const table = (header, rows) => {
  report.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows, '')
}

/** The automation identity that posts both the Sonar status and its comments. */
const SONAR_AUTHOR = '27ec814b-a933-430b-85ff-75142b4aaf4f'

// ---------------------------------------------------------------------------
// §6  A Sonar-commented pull request: what a bot thread actually looks like
// ---------------------------------------------------------------------------

log('§6 hunting Sonar-authored threads across completed pull requests…')
say('## 6 — Sonar-authored threads, live')

const completed = await ado('_apis/git/pullrequests?searchCriteria.status=completed&$top=80')
const pool = (completed.body?.value ?? []).map((pr) => ({
  id: pr.pullRequestId,
  project: pr.repository.project.id,
  repo: pr.repository.id,
  repoName: pr.repository.name,
}))
const base = (r) => `${r.project}/_apis/git/repositories/${r.repo}/pullRequests/${r.id}`

const scanned = []
for (const ref of pool.slice(0, 24)) {
  const res = await ado(`${base(ref)}/threads`)
  const threads = res.body?.value ?? []
  const sonarThreads = threads.filter((t) => t.comments?.[0]?.author?.id === SONAR_AUTHOR)
  scanned.push({ ref, threads, sonarThreads })
  log(`  !${ref.id} ${threads.length} threads, ${sonarThreads.length} from the automation identity`)
  if (sonarThreads.some((t) => t.comments?.[0]?.content)) break
}

const withBot = scanned.filter((s) => s.sonarThreads.length > 0)
say(
  `Scanned **${scanned.length}** completed pull requests. ${withBot.length} carry threads whose first comment is authored by \`${SONAR_AUTHOR}\` (the identity that posts the SonarCloud status).`,
)

table(
  ['PR', 'threads', 'from the automation identity', 'with content'],
  scanned.map(
    (s) =>
      `| !${s.ref.id} | ${s.threads.length} | ${s.sonarThreads.length} | ${
        s.sonarThreads.filter((t) => t.comments?.[0]?.content).length
      } |`,
  ),
)

const botComments = withBot
  .flatMap((s) => s.sonarThreads)
  .map((t) => t.comments?.[0])
  .filter((c) => c?.content)

say(
  `Bot comments with readable content: **${botComments.length}**.`,
  '',
  botComments.length === 0
    ? '_Every bot thread in the sample had its first comment soft-deleted (`isDeleted: true`, `content` absent), which is what ADO does when the Sonar integration retracts a resolved finding. **The content-based half of the detection is therefore still unmeasured** — the author-id match is the only tested signal._'
    : botComments
        .slice(0, 6)
        .map((c) => `- \`${redact(c.content).replace(/\n/g, ' ⏎ ').slice(0, 300)}\``)
        .join('\n'),
)

const botThreads = withBot.flatMap((s) => s.sonarThreads)
if (botThreads.length > 0) {
  say('Bot thread `properties` keys:')
  const keys = new Map()
  for (const t of botThreads) {
    for (const k of Object.keys(t.properties ?? {})) keys.set(k, (keys.get(k) ?? 0) + 1)
  }
  say(
    keys.size === 0
      ? '_none_'
      : [...keys.entries()].map(([k, n]) => `- \`${k}\` ×${n}`).join('\n'),
    `Bot threads with \`isDeleted: true\`: **${botThreads.filter((t) => t.isDeleted).length}** of ${botThreads.length}. Statuses: ${tally(botThreads.map((t) => String(t.status)))}`,
  )
}

// A thread whose comments carry markdown, so the renderer has a real fixture.
const markdownThread = scanned
  .flatMap((s) => s.threads)
  .find((t) => t.properties?.['Microsoft.TeamFoundation.Discussion.SupportsMarkdown'])
if (markdownThread) {
  say(
    '### `SupportsMarkdown`',
    `Present on human threads as \`${JSON.stringify(markdownThread.properties['Microsoft.TeamFoundation.Discussion.SupportsMarkdown'])}\` — a \`$type\`/\`$value\` wrapper, like every other property. Value type is \`System.Int32\`, not a boolean.`,
  )
}

// ---------------------------------------------------------------------------
// §7  Sonar on a failing gate
// ---------------------------------------------------------------------------

say('## 7 — SonarCloud on a **failing** gate')

// !24798 answered `SonarCloud/quality gate` → failed, projectKey profisee_rest-api.
const TARGETS = [
  { projectKey: 'profisee_rest-api', pr: 24798, note: 'gate failed' },
  { projectKey: 'profisee_platform', pr: 24809, note: 'gate passed (first pass)' },
]

for (const target of TARGETS) {
  log(`§7 ${target.projectKey} pr=${target.pr}…`)
  const q = `componentKeys=${encodeURIComponent(target.projectKey)}&pullRequest=${target.pr}`

  const issues = await sonar(
    `api/issues/search?${q}&ps=500&additionalFields=_all&facets=rules,impactSeverities,impactSoftwareQualities,cleanCodeAttributeCategories,severities,types`,
  )
  const gate = await sonar(
    `api/qualitygates/project_status?projectKey=${encodeURIComponent(target.projectKey)}&pullRequest=${target.pr}`,
  )
  const measures = await sonar(
    `api/measures/component?component=${encodeURIComponent(target.projectKey)}&pullRequest=${target.pr}&metricKeys=alert_status,quality_gate_details,new_violations,new_blocker_violations,new_critical_violations,new_coverage,new_lines,new_duplicated_lines_density,new_security_hotspots,new_technical_debt`,
  )
  const hotspots = await sonar(
    `api/hotspots/search?projectKey=${encodeURIComponent(target.projectKey)}&pullRequest=${target.pr}&ps=100`,
  )

  say(
    `### \`${target.projectKey}\` / PR ${target.pr} — ${target.note}`,
    `- \`issues/search\` → ${issues.status}, \`total: ${issues.body?.total}\`, returned ${issues.body?.issues?.length ?? '—'}, ${issues.ms}ms`,
    `- \`qualitygates/project_status\` → ${gate.status}, \`status: ${gate.body?.projectStatus?.status}\`, ${gate.body?.projectStatus?.conditions?.length ?? 0} conditions`,
    `- \`measures/component\` (valid keys) → ${measures.status}, ${measures.body?.component?.measures?.length ?? '—'} measures, ${measures.ms}ms`,
    `- \`hotspots/search\` → ${hotspots.status}, ${hotspots.body?.hotspots?.length ?? '—'} hotspots (\`total: ${hotspots.body?.paging?.total}\`)`,
  )

  const list = issues.body?.issues ?? []
  if (list.length > 0) {
    say('Issue field census:')
    table(['key', 'present', 'types'], census(list))
    say(
      `- distinct rules: **${new Set(list.map((i) => i.rule)).size}**`,
      `- \`issueStatus\`: ${tally(list.map((i) => String(i.issueStatus)))}`,
      `- legacy \`status\`: ${tally(list.map((i) => String(i.status)))}`,
      `- \`cleanCodeAttributeCategory\`: ${tally(list.map((i) => String(i.cleanCodeAttributeCategory)))}`,
      `- \`cleanCodeAttribute\`: ${tally(list.map((i) => String(i.cleanCodeAttribute)))}`,
      `- impacts: ${tally(list.flatMap((i) => (i.impacts ?? []).map((x) => `${x.softwareQuality}/${x.severity}`)))}`,
      `- legacy \`type\`: ${tally(list.map((i) => String(i.type)))} · legacy \`severity\`: ${tally(list.map((i) => String(i.severity)))}`,
      `- \`textRange\` present on **${list.filter((i) => i.textRange).length}**/${list.length}; \`line\` on **${list.filter((i) => i.line != null).length}**`,
      `- \`flows\` non-empty on **${list.filter((i) => (i.flows ?? []).length > 0).length}**`,
      `- \`component\` shape: \`${list[0].component}\``,
      `- \`impacts\` count per issue: ${tally(list.map((i) => String((i.impacts ?? []).length)))}`,
    )
    say('One issue, verbatim:', '```json', JSON.stringify(list[0], null, 2), '```')
    if (issues.body.facets) {
      say(
        'Facets (`rules` truncated to 8):',
        '```json',
        JSON.stringify(
          issues.body.facets.map((f) =>
            f.property === 'rules' ? { ...f, values: f.values.slice(0, 8) } : f,
          ),
          null,
          2,
        ).slice(0, 2600),
        '```',
      )
    }
    say(
      '`components` block (how a file path is recovered from a component key):',
      '```json',
      JSON.stringify((issues.body.components ?? []).slice(0, 3), null, 2),
      '```',
    )
    if (issues.body.rules) {
      say(
        '`rules` block already inlined by `additionalFields=_all`:',
        '```json',
        JSON.stringify((issues.body.rules ?? []).slice(0, 3), null, 2),
        '```',
      )
    }
  }

  if (gate.body?.projectStatus) {
    say('Gate, verbatim:', '```json', JSON.stringify(gate.body.projectStatus, null, 2).slice(0, 2600), '```')
  }
  if (measures.body?.component) {
    say('Measures, verbatim:', '```json', JSON.stringify(measures.body.component, null, 2).slice(0, 2600), '```')
  } else if (measures.status !== 200) {
    say(`Measures failed: \`${redact(measures.text).slice(0, 300)}\``)
  }
}

// ---------------------------------------------------------------------------
// §8  Paging, batching and rate limits
// ---------------------------------------------------------------------------

log('§8 paging, rules batching, rate-limit headers…')
say('## 8 — Paging, rule batching, rate limits')

const anyProject = 'profisee_platform'

// Page-size ceiling on issues/search, and what asking past it does.
const sizes = [500, 501, 1000]
const rows = []
for (const ps of sizes) {
  const res = await sonar(`api/issues/search?componentKeys=${anyProject}&ps=${ps}&p=1`)
  rows.push(
    `| \`ps=${ps}\` | ${res.status} | ${res.body?.paging?.pageSize ?? '—'} | ${
      res.status === 200 ? '' : redact(res.body?.errors?.[0]?.msg ?? res.text).slice(0, 120).replace(/\|/g, '\\|')
    } |`,
  )
}
// Branch issues, so the shape is guaranteed to be measured even when every PR is clean.
const branch = await sonar(`api/issues/search?componentKeys=${anyProject}&ps=5&additionalFields=_all`)
rows.push(
  `| main branch, \`ps=5\` | ${branch.status} | ${branch.body?.paging?.pageSize ?? '—'} | \`total: ${branch.body?.total}\` |`,
)
table(['request', 'status', '`paging.pageSize`', 'note'], rows)

if ((branch.body?.issues ?? []).length > 0) {
  const list = branch.body.issues
  say(
    `The project's own (non-PR) issues, as the shape of last resort — **${branch.body.total}** on the main branch.`,
  )
  table(['key', 'present', 'types'], census(list))
  say(
    `- \`issueStatus\`: ${tally(list.map((i) => String(i.issueStatus)))}`,
    `- impacts: ${tally(list.flatMap((i) => (i.impacts ?? []).map((x) => `${x.softwareQuality}/${x.severity}`)))}`,
    `- legacy \`type\`: ${tally(list.map((i) => String(i.type)))}`,
    `- \`cleanCodeAttributeCategory\`: ${tally(list.map((i) => String(i.cleanCodeAttributeCategory)))}`,
  )
  say('One issue, verbatim:', '```json', JSON.stringify(list[0], null, 2), '```')
  say(
    '`components` block:',
    '```json',
    JSON.stringify((branch.body.components ?? []).slice(0, 3), null, 2),
    '```',
  )

  // Rule batching, on keys that certainly exist.
  const ruleKeys = [...new Set(list.map((i) => i.rule))].slice(0, 12)
  const plural = await sonar(
    `api/rules/search?rule_keys=${encodeURIComponent(ruleKeys.join(','))}&f=name,htmlDesc,mdDesc,severity,type,cleanCodeAttribute,impacts,descriptionSections,educationPrinciples,lang,langName&ps=100`,
  )
  const singular = await sonar(`api/rules/search?rule_key=${encodeURIComponent(ruleKeys.join(','))}&ps=100`)
  const show = await sonar(`api/rules/show?key=${encodeURIComponent(ruleKeys[0])}`)

  say(
    '### `rules`',
    `- \`rules/search?rule_keys=\` with ${ruleKeys.length} keys → ${plural.status}, \`total: ${plural.body?.total}\`, returned ${plural.body?.rules?.length ?? '—'} in ${plural.ms}ms`,
    `- the same keys as \`rule_key=\` (singular) → ${singular.status}, \`total: ${singular.body?.total}\``,
    `- \`rules/show?key=${ruleKeys[0]}\` → ${show.status}, ${show.ms}ms`,
  )
  const rules = plural.body?.rules ?? []
  if (rules.length > 0) {
    table(['key', 'present', 'types'], census(rules))
    say(
      ...rules
        .slice(0, 6)
        .map(
          (r) =>
            `- \`${r.key}\` — htmlDesc ${((r.htmlDesc ?? '').length / 1024).toFixed(1)} KB · mdDesc ${((r.mdDesc ?? '').length / 1024).toFixed(1)} KB · sections ${(r.descriptionSections ?? []).map((s) => s.key).join(',') || '—'}`,
        ),
    )
    const total = rules.reduce((n, r) => n + (r.htmlDesc ?? '').length + (r.mdDesc ?? '').length, 0)
    say(
      `- all ${rules.length} descriptions in one response: **${(total / 1024).toFixed(1)} KB**`,
      `- \`descriptionSections\` present on **${rules.filter((r) => r.descriptionSections).length}**/${rules.length}`,
      `- \`impacts\` on the rule: **${rules.filter((r) => r.impacts).length}**/${rules.length}`,
    )
    if (show.body?.rule) {
      say(
        `- \`rules/show\` extra keys over \`rules/search\`: ${Object.keys(show.body.rule)
          .filter((k) => !(k in rules[0]))
          .map((k) => `\`${k}\``)
          .join(' ') || '_none_'}`,
      )
    }
  }
}

const rateHeaders = Object.entries(branch.headers ?? {}).filter(
  ([k]) => /rate|retry|throttl|quota/i.test(k),
)
say(
  '### Rate-limit headers on SonarCloud',
  rateHeaders.length === 0
    ? `_None._ Of ${Object.keys(branch.headers ?? {}).length} response headers, not one mentions a rate limit, a retry or a quota. So a Sonar budget cannot be read from a response either — the research note stands: a bare 429 with no \`Retry-After\` is the only signal, and it has to be handled by backing off in minutes.`
    : rateHeaders.map(([k, v]) => `- \`${k}\`: ${v}`).join('\n'),
)
say(`Headers actually returned: ${Object.keys(branch.headers ?? {}).map((k) => `\`${k}\``).join(' ')}`)

// ---------------------------------------------------------------------------

say('## Call cost, second pass', `- ADO requests: **${adoCalls}**`, `- SonarCloud requests: **${sonarCalls}**`)

await appendFile(OUT, ['', '---', '', ...report].join('\n'), 'utf8')
log(`\nAppended to ${OUT} (${adoCalls} ADO + ${sonarCalls} Sonar calls).`)
