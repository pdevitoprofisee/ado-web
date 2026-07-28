// Third pass for T-022, appended to docs/research/comments-sonar-inventory.md.
//
// Two things the second pass left wrong or unmeasured:
//
//   1. Every `rules/*` request answered **400** — including `rules/show`, which
//      docs/map.md records as `[LIVE]` working. Something about the call changed
//      or was never true. The error body was thrown away, so this pass prints it.
//   2. On the pull-request issues, `line` was absent on 3/3 and `textRange`
//      present on 3/3 — but all three were `issueStatus: FIXED`. On the main
//      branch, `line` was present on 5/5 `OPEN` issues. So it is unknown whether
//      the missing `line` is a property of PR issues or of closed ones, and the
//      anchoring code depends on the answer.
//
// Read-only. Every request is a GET.

import { appendFile } from 'node:fs/promises'

const store = await import('../src/server/credentials.ts')
const SONAR_TOKEN = process.env.SONAR_TOKEN ?? store.readSonarCredential()?.token
const SONAR = 'https://sonarcloud.io'
const ORGANIZATION = process.env.SONAR_ORG ?? 'profisee'
const OUT = 'docs/research/comments-sonar-inventory.md'

const report = []
const say = (...lines) => report.push(...lines, '')
const log = (m) => console.log(m)
let calls = 0

async function sonar(path) {
  calls++
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

  return { status: res.status, ms, body, text, error: body?.errors?.[0]?.msg ?? null }
}

const table = (header, rows) => {
  report.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows, '')
}

const tally = (values) => {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `\`${v}\`×${n}`)
    .join(' · ')
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

// ---------------------------------------------------------------------------
// §9  Why `rules` answered 400
// ---------------------------------------------------------------------------

log('§9 rules…')
say('## 9 — `rules`: the `organization` parameter')

const KEY = 'javascript:S4036'
const KEYS = ['javascript:S4036', 'csharpsquid:S107', 'csharpsquid:S2583', 'external_roslyn:CA1861']
const f = 'name,htmlDesc,mdDesc,severity,type,cleanCodeAttribute,impacts,descriptionSections,educationPrinciples,lang,langName'

const variants = [
  ['`rules/show?key=`', `api/rules/show?key=${encodeURIComponent(KEY)}`],
  [
    '`rules/show?key=` + `organization`',
    `api/rules/show?key=${encodeURIComponent(KEY)}&organization=${ORGANIZATION}`,
  ],
  ['`rules/search?rule_keys=`', `api/rules/search?rule_keys=${encodeURIComponent(KEYS.join(','))}&ps=100`],
  [
    '`rules/search?rule_keys=` + `organization`',
    `api/rules/search?rule_keys=${encodeURIComponent(KEYS.join(','))}&organization=${ORGANIZATION}&ps=100`,
  ],
  [
    '`rules/search?rule_keys=` + `organization` + `f=`',
    `api/rules/search?rule_keys=${encodeURIComponent(KEYS.join(','))}&organization=${ORGANIZATION}&f=${f}&ps=100`,
  ],
  [
    '`rules/search?rule_key=` (singular) + `organization`',
    `api/rules/search?rule_key=${encodeURIComponent(KEYS.join(','))}&organization=${ORGANIZATION}&ps=100`,
  ],
  [
    '`rules/search?q=` free text + `organization`',
    `api/rules/search?q=${encodeURIComponent('params parameters')}&organization=${ORGANIZATION}&ps=3`,
  ],
]

const results = {}
const rows = []
for (const [label, path] of variants) {
  const res = await sonar(path)
  results[label] = res
  rows.push(
    `| ${label} | ${res.status} | ${res.body?.total ?? (res.body?.rule ? 1 : '—')} | ${res.ms} | ${
      (res.error ?? '').slice(0, 110).replace(/\|/g, '\\|')
    } |`,
  )
  log(`  ${label} → ${res.status}${res.error ? ` (${res.error})` : ''}`)
}
table(['request', 'status', 'rules', 'ms', 'error'], rows)

const batched = results['`rules/search?rule_keys=` + `organization` + `f=`']
const shown = results['`rules/show?key=` + `organization`']

if (batched?.body?.rules?.length) {
  const list = batched.body.rules
  say(`Batched lookup returned **${list.length}** of ${KEYS.length} requested keys.`)
  table(['key', 'present', 'types'], census(list))
  say(
    ...list.map(
      (r) =>
        `- \`${r.key}\` (${r.langName ?? r.lang ?? '—'}) — htmlDesc **${((r.htmlDesc ?? '').length / 1024).toFixed(1)} KB** · mdDesc **${((r.mdDesc ?? '').length / 1024).toFixed(1)} KB** · sections \`${(r.descriptionSections ?? []).map((s) => s.key).join(', ') || '—'}\``,
    ),
  )
  const bytes = list.reduce((n, r) => n + (r.htmlDesc ?? '').length + (r.mdDesc ?? '').length, 0)
  say(
    `- all ${list.length} descriptions in one response: **${(bytes / 1024).toFixed(1)} KB** in ${batched.ms}ms`,
    `- \`impacts\` on the rule object: **${list.filter((r) => r.impacts).length}**/${list.length}`,
    `- \`educationPrinciples\`: **${list.filter((r) => (r.educationPrinciples ?? []).length > 0).length}**/${list.length}`,
    `- keys requested but **not returned**: ${KEYS.filter((k) => !list.some((r) => r.key === k)).map((k) => `\`${k}\``).join(', ') || '_none_'}`,
  )
  const sample = list.find((r) => (r.descriptionSections ?? []).length > 0) ?? list[0]
  say(
    `One rule's \`descriptionSections\`, first section only (\`${sample.key}\`):`,
    '```json',
    JSON.stringify((sample.descriptionSections ?? [])[0] ?? null, null, 2).slice(0, 1400),
    '```',
  )
}

if (shown?.body?.rule) {
  const r = shown.body.rule
  say(
    `\`rules/show\` on \`${r.key}\`: keys ${Object.keys(r).map((k) => `\`${k}\``).join(' ')}`,
    `- htmlDesc ${((r.htmlDesc ?? '').length / 1024).toFixed(1)} KB · sections ${(r.descriptionSections ?? []).map((s) => s.key).join(', ') || '—'}`,
    `- \`requiredEntitlements\`: \`${JSON.stringify(r.requiredEntitlements ?? null)}\``,
  )
}

// ---------------------------------------------------------------------------
// §10  Open issues on a pull request — is `line` there or not?
// ---------------------------------------------------------------------------

log('§10 open PR issues…')
say('## 10 — Open issues on a pull request')

// Every (projectKey, prId) pair §4 recovered from an ADO SonarCloud status,
// plus the project the bot comments in §6 linked to.
const PAIRS = [
  ['profisee_platform', 24809],
  ['profisee_platform_reactlibrary', 24804],
  ['profisee_platform_reactwebportal', 24802],
  ['profisee_rest-api', 24798],
  ['profisee_connex', 24794],
  ['profisee_Cdp', 24762],
  ['profisee_Data', 24742],
  ['profisee_matching', 24795],
]

const found = []
const pairRows = []
for (const [projectKey, pr] of PAIRS) {
  const all = await sonar(
    `api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&pullRequest=${pr}&ps=500&additionalFields=_all`,
  )
  const open = await sonar(
    `api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&pullRequest=${pr}&ps=500&additionalFields=_all&issueStatuses=OPEN,CONFIRMED,ACCEPTED`,
  )
  const unresolved = await sonar(
    `api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&pullRequest=${pr}&ps=1&resolved=false`,
  )
  pairRows.push(
    `| \`${projectKey}\` / ${pr} | ${all.status} ${all.body?.total ?? '—'} | ${open.status} ${open.body?.total ?? '—'} | ${unresolved.status} ${unresolved.body?.total ?? '—'} |`,
  )
  log(`  ${projectKey}/${pr}: all=${all.body?.total} open=${open.body?.total}`)
  if ((open.body?.issues ?? []).length > 0) found.push({ projectKey, pr, body: open.body })
}
table(
  ['project / PR', 'default (no filter)', '`issueStatuses=OPEN,CONFIRMED,ACCEPTED`', '`resolved=false`'],
  pairRows,
)

say(
  '**The default is not "open".** `issues/search` with no status filter returns closed and fixed issues alongside live ones — the first pass read `total: 0` as "a clean pull request" when it was really "no issues at all, of any status". A findings panel must ask for the statuses it means.',
)

if (found.length === 0) {
  say(
    '_No sampled pull request had a single open issue, so whether a PR issue carries `line` is still unmeasured. Anchor from `textRange.startLine` and treat `line` as optional._',
  )
} else {
  const all = found.flatMap((f) => f.body.issues)
  say(
    `Open pull-request issues collected: **${all.length}** across ${found.length} pull request(s).`,
  )
  table(['key', 'present', 'types'], census(all))
  say(
    `- \`line\` present: **${all.filter((i) => i.line != null).length}**/${all.length}`,
    `- \`textRange\` present: **${all.filter((i) => i.textRange).length}**/${all.length}`,
    `- \`line\` === \`textRange.startLine\` where both exist: **${all.filter((i) => i.line != null && i.textRange && i.line === i.textRange.startLine).length}**/${all.filter((i) => i.line != null && i.textRange).length}`,
    `- \`issueStatus\`: ${tally(all.map((i) => String(i.issueStatus)))}`,
    `- impacts: ${tally(all.flatMap((i) => (i.impacts ?? []).map((x) => `${x.softwareQuality}/${x.severity}`)))}`,
    `- distinct rules: **${new Set(all.map((i) => i.rule)).size}** over ${all.length} issues`,
    `- issues on a file component (\`project:path\`): **${all.filter((i) => i.component.includes(':')).length}**/${all.length}`,
    `- project-level issues (no \`:\`, so no file to anchor to): **${all.filter((i) => !i.component.includes(':')).length}**`,
  )
  const one = all.find((i) => i.line != null) ?? all[0]
  say('One open pull-request issue, verbatim:', '```json', JSON.stringify(one, null, 2), '```')
}

say('## Call cost, third pass', `- SonarCloud requests: **${calls}**`)

await appendFile(OUT, ['', '---', '', ...report].join('\n'), 'utf8')
log(`\nAppended to ${OUT} (${calls} Sonar calls).`)
