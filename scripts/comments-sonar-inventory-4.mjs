// Fourth pass for T-022. §9 established that `organization` is the missing
// parameter, but its `f=` field list contained `type`, which SonarCloud has
// removed — so the whole request 400'd and the rule descriptions were never
// measured. The in-app rule renderer needs to know what it is rendering and how
// big it is. Read-only.

import { appendFile } from 'node:fs/promises'

const store = await import('../src/server/credentials.ts')
const SONAR_TOKEN = process.env.SONAR_TOKEN ?? store.readSonarCredential()?.token
const SONAR = 'https://sonarcloud.io'
const ORG = process.env.SONAR_ORG ?? 'profisee'
const OUT = 'docs/research/comments-sonar-inventory.md'

const report = []
const say = (...lines) => report.push(...lines, '')
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

  return { status: res.status, ms, bytes: text.length, body, error: body?.errors?.[0]?.msg ?? null }
}

const table = (header, rows) => {
  report.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows, '')
}
const kb = (s) => `${((s ?? '').length / 1024).toFixed(1)} KB`

say('## 11 — Rule descriptions, measured')

// Four rules from four different analysers, including the external Roslyn
// import, which is the one likeliest not to carry a description.
const KEYS = ['javascript:S4036', 'csharpsquid:S107', 'csharpsquid:S2583', 'external_roslyn:CA1861']
const F = 'name,htmlDesc,mdDesc,severity,cleanCodeAttribute,impacts,descriptionSections,educationPrinciples,lang,langName,sysTags,remFn'

const batched = await sonar(
  `api/rules/search?rule_keys=${encodeURIComponent(KEYS.join(','))}&organization=${ORG}&f=${F}&ps=100`,
)
console.log(`batched → ${batched.status} ${batched.error ?? ''}`)

say(
  `\`rules/search?rule_keys=\` + \`organization\` + a legal \`f=\` → **${batched.status}**, ${
    batched.body?.total ?? '—'
  } of ${KEYS.length} keys, **${(batched.bytes / 1024).toFixed(1)} KB** in ${batched.ms}ms.`,
  '',
  'Dropping `type` from `f=` is what fixed it. The rejection message names the whole legal set, and `type` is not in it — the field is gone from SonarCloud, so a hard-coded `f=` list written against the old API breaks the request outright rather than degrading.',
)

const list = batched.body?.rules ?? []
if (list.length) {
  table(
    ['rule', 'lang', 'htmlDesc', 'mdDesc', 'descriptionSections', 'impacts'],
    list.map(
      (r) =>
        `| \`${r.key}\` | ${r.langName ?? r.lang ?? '—'} | ${kb(r.htmlDesc)} | ${kb(r.mdDesc)} | ${
          (r.descriptionSections ?? []).map((s) => s.key).join(', ') || '_none_'
        } | ${(r.impacts ?? []).map((i) => `${i.softwareQuality}/${i.severity}`).join(' ') || '—'} |`,
    ),
  )
  say(
    `- keys requested but **not returned**: ${
      KEYS.filter((k) => !list.some((r) => r.key === k)).map((k) => `\`${k}\``).join(', ') || '_none_'
    }`,
    `- fields on every rule: ${Object.keys(list[0]).map((k) => `\`${k}\``).join(' ')}`,
    `- \`htmlDesc\` present: **${list.filter((r) => r.htmlDesc).length}**/${list.length} · \`mdDesc\`: **${list.filter((r) => r.mdDesc).length}**/${list.length} · \`descriptionSections\`: **${list.filter((r) => (r.descriptionSections ?? []).length).length}**/${list.length}`,
    `- \`educationPrinciples\`: **${list.filter((r) => (r.educationPrinciples ?? []).length).length}**/${list.length}`,
  )

  const sectioned = list.find((r) => (r.descriptionSections ?? []).length > 1)
  if (sectioned) {
    say(
      `\`descriptionSections\` on \`${sectioned.key}\` — key and size of each, in response order:`,
      ...sectioned.descriptionSections.map(
        (s) =>
          `- \`${s.key}\` — ${kb(s.content)}${s.context ? ` · context \`${s.context.key}\` (${s.context.displayName})` : ''}`,
      ),
    )
    const first = sectioned.descriptionSections[0]
    say(
      `The first section's content, truncated (it is **HTML**, not markdown):`,
      '```html',
      (first.content ?? '').slice(0, 700),
      '```',
    )
  }

  const md = list.find((r) => r.mdDesc && r.mdDesc !== r.htmlDesc)
  say(
    md
      ? `\`mdDesc\` differs from \`htmlDesc\` on \`${md.key}\`, so it is a real markdown rendering and not a copy.`
      : '`mdDesc` was byte-identical to `htmlDesc` on every rule returned — SonarCloud sends HTML under both names, so the in-app renderer has to sanitise HTML either way.',
  )
}

// Is `rules/show` any richer than the batched form? If not, one call per PR beats
// one call per rule.
const single = await sonar(`api/rules/show?key=${encodeURIComponent(KEYS[1])}&organization=${ORG}`)
console.log(`show → ${single.status}`)
if (single.body?.rule) {
  const r = single.body.rule
  const b = list.find((x) => x.key === r.key)
  const only = Object.keys(r).filter((k) => !b || !(k in b))
  say(
    `\`rules/show?key=${r.key}\` → **${single.status}**, ${(single.bytes / 1024).toFixed(1)} KB in ${single.ms}ms.`,
    `- fields \`show\` returns that the batched \`search\` did not: ${only.map((k) => `\`${k}\``).join(' ') || '_none_ — the batched form is a superset, so fetch every rule in a pull request in one call'}`,
    `- \`htmlDesc\` ${kb(r.htmlDesc)}, sections \`${(r.descriptionSections ?? []).map((s) => s.key).join(', ') || '—'}\``,
    `- \`params\`: ${(r.params ?? []).length} · \`sysTags\`: ${(r.sysTags ?? []).join(', ') || '—'}`,
  )
}

// How many keys can one batched call carry? A pull request touching many
// analysers could ask for dozens.
say('### How many rule keys fit in one call')
const many = [...list.map((r) => r.key), ...Array.from({ length: 46 }, (_, i) => `csharpsquid:S${1000 + i}`)]
const rows = []
for (const n of [10, 50, 100]) {
  const probe = await sonar(
    `api/rules/search?rule_keys=${encodeURIComponent(many.slice(0, n).join(','))}&organization=${ORG}&ps=500`,
  )
  rows.push(`| ${n} keys | ${probe.status} | ${probe.body?.total ?? '—'} | ${(probe.bytes / 1024).toFixed(1)} KB | ${probe.ms} | ${(probe.error ?? '').slice(0, 80)} |`)
  console.log(`  ${n} keys → ${probe.status} total=${probe.body?.total}`)
}
table(['request', 'status', 'rules returned', 'size', 'ms', 'error'], rows)
say(
  '_Unknown keys are silently skipped rather than erroring, so `total` is the count that existed, not the count asked for. A rule the analyser reports but the API will not describe therefore looks identical to a typo — the panel must fall back to showing the bare rule key._',
)

say('## Call cost, fourth pass', `- SonarCloud requests: **${calls}**`)

await appendFile(OUT, ['', '---', '', ...report].join('\n'), 'utf8')
console.log(`\nAppended to ${OUT} (${calls} Sonar calls).`)
