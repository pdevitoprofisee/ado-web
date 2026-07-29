// Throwaway spike for T-030. Not application code — do not import from it.
//
// Two deferred features want the same measurement: @mentions in the composer
// (T-026 declined to probe `graph/subjectquery`) and "add reviewers with
// org-wide autocomplete" (phase 7). Avatars want a third. This probes the
// identity-search, identity-resolution, reviewer-read and avatar surfaces
// against the live org and writes docs/research/identity-inventory.md.
//
//   node scripts/identity-inventory.mjs
//
// Optional: ADO_ORG / ADO_PAT (skip the credential store), ADO_PR_SAMPLE
//           (how many pull requests to walk for reviewers and mentions).
//
// **Read-only, with one authorised exception.** Every pull request in this org
// belongs to a colleague, so nothing here mutates anything. The exception is
// `POST graph/subjectquery` and `POST graph/subjectlookup`: both are *searches*
// that use POST only because the query travels in a body. There is no PUT, no
// PATCH, no DELETE, and no POST to any other path — in particular nothing under
// `pullRequests/`.

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

const CORE = `https://dev.azure.com/${ORG}`
const VSSPS = `https://vssps.dev.azure.com/${ORG}`
const OUT = 'docs/research/identity-inventory.md'
const PR_SAMPLE = Number(process.env.ADO_PR_SAMPLE ?? 12)

const redact = (s) => String(s ?? '').split(PAT).join('«redacted»')

const report = []
const say = (...lines) => report.push(...lines, '')
/** Append rows to a table without `say`'s trailing blank line getting in the way. */
const table = (header, rows) => {
  report.push(header[0], header[1], ...rows, '')
}
const log = (m) => console.log(m)
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

const RATE_HEADERS = [
  'x-ratelimit-cost',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-delay',
  'x-ratelimit-reset',
  'retry-after',
]

const CACHE_HEADERS = ['etag', 'cache-control', 'expires', 'last-modified', 'vary']

const authHeaders = {
  Authorization: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`,
  'X-TFS-FedAuthRedirect': 'Suppress',
  Accept: 'application/json',
}

let calls = 0
const rateSeen = []

/**
 * One request. `method` defaults to GET; the only other value used in this file
 * is POST, and only against `graph/subjectquery` / `graph/subjectlookup`.
 */
async function req(url, { method = 'GET', body, anon = false, bytes = false, accept } = {}) {
  if (method !== 'GET' && !/\/graph\/subject(query|lookup)/i.test(url)) {
    throw new Error(`Refusing ${method} ${url} — only the graph search endpoints may be POSTed.`)
  }
  calls++
  const headers = anon ? { Accept: accept ?? '*/*' } : { ...authHeaders }
  if (accept !== undefined) headers.Accept = accept
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const started = Date.now()
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: String(err?.message ?? err), url }
  }
  const ms = Date.now() - started

  const rate = Object.fromEntries(
    RATE_HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null),
  )
  if (Object.keys(rate).length > 0) rateSeen.push({ url, rate })
  const cache = Object.fromEntries(
    CACHE_HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null),
  )

  const meta = {
    status: res.status,
    ms,
    rate,
    cache,
    url,
    contentType: res.headers.get('content-type'),
    contentLength: res.headers.get('content-length'),
    location: res.headers.get('location'),
    continuation: res.headers.get('x-ms-continuationtoken'),
    headerCount: [...res.headers.keys()].length,
  }

  if (bytes) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return { ...meta, bytes: buf.byteLength, head: [...buf.slice(0, 8)] }
  }

  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  return { ...meta, body: parsed, text: text.slice(0, 500) }
}

const core = (path, opts) => req(`${CORE}/${path.replace(/^\//, '')}`, opts)
const vssps = (path, opts) => req(`${VSSPS}/${path.replace(/^\//, '')}`, opts)

const SQ = '_apis/graph/subjectquery'
const sq = (body, version = '7.1-preview.1') =>
  vssps(`${SQ}?api-version=${version}`, { method: 'POST', body })

/** Field census: which keys are present, and with what JSON type, across N objects. */
function census(objects) {
  const keys = new Map()
  for (const o of objects) {
    for (const [k, v] of Object.entries(o ?? {})) {
      const type =
        v === null
          ? 'null'
          : Array.isArray(v)
            ? 'array'
            : typeof v === 'object'
              ? 'object'
              : typeof v
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
    .map(([v, n]) => `\`${v}\`×${n}`)
    .join(' · ')

const stats = (samples) => {
  if (samples.length === 0) return '—'
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)]
  const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)

  return `min ${sorted[0]} · median ${mid} · mean ${mean} · max ${sorted[sorted.length - 1]}`
}

// ---------------------------------------------------------------------------
// §1  Who am I, and which host answers what
// ---------------------------------------------------------------------------

log('§1 identity and host…')
say('## 1 — Identity, and which host answers')

const conn = await core('_apis/connectionData?api-version=7.1-preview.1')
const me = conn.body?.authenticatedUser ?? {}
const myId = me.id ?? null
const myDescriptor = me.descriptor ?? null
const myName = me.providerDisplayName ?? null
const myMail =
  me.properties?.Account?.$value ??
  (typeof me.properties?.Account === 'string' ? me.properties.Account : null)

say(
  `\`GET _apis/connectionData\` (\`7.1-preview.1\`) → ${conn.status} in ${conn.ms} ms.`,
  '',
  `- \`authenticatedUser.id\`: \`${myId}\``,
  `- \`authenticatedUser.descriptor\`: \`${myDescriptor}\``,
  `- \`providerDisplayName\`: \`${myName}\``,
  `- \`properties.Account\`: \`${myMail ?? '—'}\``,
  `- keys on \`authenticatedUser\`: ${Object.keys(me).map((k) => `\`${k}\``).join(' ')}`,
)

// Host confirmation. The ticket says confirm rather than assume.
const hostProbe = [
  ['`dev.azure.com`', `${CORE}/_apis/graph/subjectquery?api-version=7.1-preview.1`],
  ['`vssps.dev.azure.com`', `${VSSPS}/_apis/graph/subjectquery?api-version=7.1-preview.1`],
]
const hostRows = []
for (const [label, url] of hostProbe) {
  const res = await req(url, { method: 'POST', body: { query: 'a', subjectKind: ['User'] } })
  hostRows.push(
    `| \`POST graph/subjectquery\` | ${label} | ${res.status} | ${res.ms} | ${
      res.status === 200
        ? `\`count: ${res.body?.count ?? res.body?.value?.length ?? '—'}\``
        : esc(redact(res.body?.message ?? res.location ?? res.text).slice(0, 120))
    } |`,
  )
  log(`  subjectquery on ${label} → ${res.status}`)
}
for (const [label, base] of [
  ['`dev.azure.com`', CORE],
  ['`vssps.dev.azure.com`', VSSPS],
]) {
  const res = await req(`${base}/_apis/graph/users?api-version=7.1-preview.1&$top=1`)
  hostRows.push(
    `| \`GET graph/users\` | ${label} | ${res.status} | ${res.ms} | ${
      res.status === 200
        ? `\`count: ${res.body?.count ?? '—'}\``
        : esc(redact(res.body?.message ?? res.location ?? res.text).slice(0, 120))
    } |`,
  )
}

table(['| endpoint | host | status | ms | note |', '|---|---|---|---|---|'], hostRows)

// ---------------------------------------------------------------------------
// §2  Sample selection — real pull requests, real people
// ---------------------------------------------------------------------------

log('§2 sample selection…')
say('## 2 — Sample selection')

const list = await core('_apis/git/pullrequests?searchCriteria.status=active&$top=100')
if (list.status !== 200) {
  console.error(`PR list answered ${list.status}: ${redact(list.text)}`)
  process.exit(1)
}
const prs = list.body.value ?? []

const refOf = (pr) => ({
  id: pr.pullRequestId,
  project: pr.repository.project.id,
  repo: pr.repository.id,
  repoName: pr.repository.name,
})
const base = (r) => `${r.project}/_apis/git/repositories/${r.repo}/pullRequests/${r.id}`

const candidates = []
const seenRepo = new Set()
for (const pr of prs) {
  if (seenRepo.has(pr.repository.id) && candidates.length >= PR_SAMPLE / 2) continue
  seenRepo.add(pr.repository.id)
  candidates.push(refOf(pr))
  if (candidates.length >= PR_SAMPLE) break
}

/** Search terms taken from real identities in this org, not invented. */
const people = []
for (const pr of prs) {
  const who = pr.createdBy
  if (!who?.displayName || people.some((p) => p.id === who.id)) continue
  people.push({ id: who.id, displayName: who.displayName, uniqueName: who.uniqueName ?? null })
}

const subject =
  people.find((p) => (p.uniqueName ?? '').includes('@') && /\s/.test(p.displayName)) ?? people[0]
const words = subject.displayName.split(/\s+/).filter(Boolean)
const surname = words[words.length - 1]
const first = words[0]
const mailPrefix = (subject.uniqueName ?? '').split('@')[0]

// `subjectquery` turns out to be a **prefix** match (§3), so the term the shape
// and gap probes lean on has to be a real prefix of somebody, not just a
// substring of a name. Pick the first candidate that comes back non-empty rather
// than assuming — pass 1 of this script assumed a surname would match, got 0
// subjects, and skipped the whole descriptor↔GUID section as a result.
let probeTerm = null
const termTried = []
for (const cand of [first, subject.displayName, mailPrefix, first.slice(0, 3), 'a']) {
  const res = await sq({ query: cand, subjectKind: ['User', 'Group'] })
  termTried.push(`\`${esc(cand)}\` → ${res.body?.count ?? res.status}`)
  if ((res.body?.value ?? []).length > 0) {
    probeTerm = cand
    break
  }
}

say(
  `Org-wide active pull requests fetched: **${prs.length}** (\`$top=100\`) in ${list.ms} ms.`,
  '',
  `Pull requests walked for reviewers: **${candidates.length}**.`,
  '',
  `Distinct PR authors in the listing: **${people.length}**. The search terms below come from one of them — display name \`${subject.displayName}\`, unique name \`${subject.uniqueName}\` — so every query is a query that ought to match something.`,
  '',
  `Term used for the shape and gap probes: **\`${esc(probeTerm ?? '(none matched)')}\`**, chosen by trying ${termTried.join(', ')}.`,
)

// ---------------------------------------------------------------------------
// §3  subjectquery — the search surface
// ---------------------------------------------------------------------------

log('§3 subjectquery…')
say('## 3 — `POST graph/subjectquery`')

// The term the tables below vary *other* things against. It has to be a term
// that matches, or every row reads as an empty result and proves nothing —
// pass 1 of this script used the surname, which `subjectquery` matches 0 of.
const probeQuery = probeTerm ?? first

// 3a — api-version
say('### `api-version`')
const versionRows = []
for (const v of ['7.1-preview.1', '7.2-preview.1', '7.1', '7.0-preview.1', '6.0-preview.1', '']) {
  const url = v === '' ? `${VSSPS}/${SQ}` : `${VSSPS}/${SQ}?api-version=${v}`
  const res = await req(url, { method: 'POST', body: { query: probeQuery, subjectKind: ['User'] } })
  versionRows.push(
    `| ${v === '' ? '_omitted_' : `\`${v}\``} | ${res.status} | ${res.ms} | ${
      res.status === 200
        ? `${res.body?.count ?? res.body?.value?.length ?? '—'} subjects`
        : esc(redact(res.body?.message ?? res.text).slice(0, 150))
    } |`,
  )
  log(`  api-version ${v || '(omitted)'} → ${res.status}`)
}
table(['| `api-version` | status | ms | result |', '|---|---|---|---|'], versionRows)

// 3b — subjectKind
say('### `subjectKind`')
const kindRows = []
const kindProbes = [
  ['`["User"]`', { query: probeQuery, subjectKind: ['User'] }],
  ['`["Group"]`', { query: 'contrib', subjectKind: ['Group'] }],
  ['`["User","Group"]`', { query: probeQuery, subjectKind: ['User', 'Group'] }],
  ['`["Scope"]`', { query: probeQuery, subjectKind: ['Scope'] }],
  ['`"User"` (string, not array)', { query: probeQuery, subjectKind: 'User' }],
  ['omitted entirely', { query: probeQuery }],
  ['`["Nonsense"]`', { query: probeQuery, subjectKind: ['Nonsense'] }],
  ['`[]`', { query: probeQuery, subjectKind: [] }],
]
const kindResults = {}
for (const [label, body] of kindProbes) {
  const res = await sq(body)
  kindResults[label] = res
  const kinds =
    res.status === 200 ? tallyLine((res.body?.value ?? []).map((s) => String(s.subjectKind))) : ''
  kindRows.push(
    `| ${label} | ${res.status} | ${res.ms} | ${
      res.status === 200 ? (res.body?.count ?? res.body?.value?.length ?? '—') : '—'
    } | ${res.status === 200 ? kinds || '_empty_' : esc(redact(res.body?.message ?? res.text).slice(0, 130))} |`,
  )
  log(`  subjectKind ${label} → ${res.status}`)
}
table(
  ['| body | status | ms | subjects | `subjectKind` values back |', '|---|---|---|---|---|'],
  kindRows,
)

// 3c — query length
say('### How short a query can be')
const lengthRows = []
const byLength = {}
for (const n of [1, 2, 3, 4, first.length]) {
  const q = first.slice(0, n)
  const res = await sq({ query: q, subjectKind: ['User'] })
  byLength[n] = res
  lengthRows.push(
    `| ${n} (\`${q}\`) | ${res.status} | ${res.ms} | ${
      res.status === 200 ? (res.body?.count ?? res.body?.value?.length ?? '—') : '—'
    } | ${res.status === 200 ? '' : esc(redact(res.body?.message ?? res.text).slice(0, 130))} |`,
  )
  log(`  query length ${n} (${q}) → ${res.status} ${res.body?.count ?? '—'}`)
}
const empty = await sq({ query: '', subjectKind: ['User'] })
lengthRows.push(
  `| 0 (\`""\`) | ${empty.status} | ${empty.ms} | ${
    empty.status === 200 ? (empty.body?.count ?? '—') : '—'
  } | ${empty.status === 200 ? '' : esc(redact(empty.body?.message ?? empty.text).slice(0, 130))} |`,
)
const noQuery = await sq({ subjectKind: ['User'] })
lengthRows.push(
  `| _no \`query\` key_ | ${noQuery.status} | ${noQuery.ms} | ${
    noQuery.status === 200 ? (noQuery.body?.count ?? '—') : '—'
  } | ${noQuery.status === 200 ? '' : esc(redact(noQuery.body?.message ?? noQuery.text).slice(0, 130))} |`,
)
table(
  ['| query length | status | ms | subjects | note |', '|---|---|---|---|---|'],
  lengthRows,
)

// 3d — what it matches on
say('### What the query matches')
const matchRows = []
const matchProbes = [
  ['first name (a prefix of the display name)', first],
  ['first name, lower case', first.toLowerCase()],
  ['first name, upper case', first.toUpperCase()],
  ['**surname** (a word in the name, not a prefix)', surname],
  ['surname, lower case', surname.toLowerCase()],
  ['whole display name', subject.displayName],
  ['display name without the space', subject.displayName.replace(/\s+/g, '')],
  ['email local part', mailPrefix],
  ['whole email', subject.uniqueName ?? mailPrefix],
  ['email domain only', (subject.uniqueName ?? '').split('@')[1] ?? 'example.com'],
  ['a middle substring of the first name', first.slice(1, Math.max(2, first.length - 1))],
  ['first name with the last letter dropped', first.slice(0, -1)],
  ['nonsense', 'zzqqxx-not-a-person'],
]
for (const [label, q] of matchProbes) {
  const res = await sq({ query: q, subjectKind: ['User', 'Group'] })
  const value = res.body?.value ?? []
  const hit = value.some(
    (s) =>
      (s.displayName ?? '').toLowerCase() === subject.displayName.toLowerCase() ||
      (s.mailAddress ?? '').toLowerCase() === (subject.uniqueName ?? '').toLowerCase(),
  )
  matchRows.push(
    `| ${label} | \`${esc(q)}\` | ${res.status} | ${res.ms} | ${value.length} | ${hit ? '**yes**' : 'no'} |`,
  )
  log(`  match ${label} "${q}" → ${res.status} ${value.length}${hit ? ' (hit)' : ''}`)
}
table(
  ['| kind of term | query | status | ms | subjects | target found |', '|---|---|---|---|---|---|'],
  matchRows,
)

// 3e — is there a cap?
say('### Result cap')
const capRows = []
for (const [label, body] of [
  ['`query: "a"`, User', { query: 'a', subjectKind: ['User'] }],
  ['`query: "a"`, User+Group', { query: 'a', subjectKind: ['User', 'Group'] }],
  ['`query: "e"`, User', { query: 'e', subjectKind: ['User'] }],
  ['`query: "a"` + `$top=500`', { query: 'a', subjectKind: ['User'] }],
]) {
  const url = label.includes('$top')
    ? `${VSSPS}/${SQ}?api-version=7.1-preview.1&$top=500`
    : `${VSSPS}/${SQ}?api-version=7.1-preview.1`
  const res = await req(url, { method: 'POST', body })
  capRows.push(
    `| ${label} | ${res.status} | ${res.ms} | ${res.body?.count ?? '—'} | ${
      res.body?.value?.length ?? '—'
    } | ${res.continuation ?? '_none_'} | ${Object.keys(res.body ?? {}).map((k) => `\`${k}\``).join(' ')} |`,
  )
  log(`  cap ${label} → ${res.status} ${res.body?.count ?? '—'}`)
}
table(
  [
    '| probe | status | ms | `count` | `value.length` | `x-ms-continuationtoken` | response keys |',
    '|---|---|---|---|---|---|---|',
  ],
  capRows,
)

// 3f — latency, repeated
say('### Latency')
const latency = []
const latencyCold = []
for (let i = 0; i < 6; i++) {
  const res = await sq({ query: first.slice(0, 3), subjectKind: ['User', 'Group'] })
  latency.push(res.ms)
}
for (const q of ['ba', 'de', 'ma', 'ka', 'jo', 'ni']) {
  const res = await sq({ query: q, subjectKind: ['User', 'Group'] })
  latencyCold.push(res.ms)
}
say(
  `- the **same** 3-character query, 6 times: ${latency.join(', ')} ms — ${stats(latency)}`,
  `- six **different** 2-character queries: ${latencyCold.join(', ')} ms — ${stats(latencyCold)}`,
)

// 3g — the subject shape
const shapeRes = await sq({ query: probeTerm ?? 'a', subjectKind: ['User', 'Group'] })
const subjects = shapeRes.body?.value ?? []
say('### The subject shape')
if (subjects.length === 0) {
  say('_No subjects returned; nothing to census._')
} else {
  table(['| key | present | types |', '|---|---|---|'], census(subjects))
  say(
    `- \`_links\` keys: ${Object.keys(subjects[0]._links ?? {}).map((k) => `\`${k}\``).join(' ')}`,
    `- \`origin\` values: ${tallyLine(subjects.map((s) => String(s.origin)))}`,
    `- \`descriptor\` prefixes: ${tallyLine(subjects.map((s) => String(s.descriptor).split('.')[0]))}`,
    `- an \`id\` key anywhere on a subject: **${subjects.some((s) => 'id' in s) ? 'yes' : 'no'}**`,
    `- \`originId\` looks like a GUID: ${
      subjects.filter((s) => /^[0-9a-f]{8}-/i.test(String(s.originId))).length
    }/${subjects.length}`,
  )
  const one = JSON.parse(redact(JSON.stringify(subjects[0])))
  say('One subject, verbatim:', '', '```json', JSON.stringify(one, null, 2), '```')
}

// ---------------------------------------------------------------------------
// §4  The descriptor ↔ GUID gap
// ---------------------------------------------------------------------------

log('§4 descriptor ↔ GUID…')
say('## 4 — The descriptor ↔ GUID gap')

const userSubjects = subjects.filter((s) => s.subjectKind === 'user' || s.subjectKind === 'User')
const probeSubject = userSubjects[0] ?? subjects[0] ?? null
const descriptors = subjects.map((s) => s.descriptor).filter(Boolean)

say(
  'The PR API is GUID-based (`reviewers/{id}`, `createdBy.id`, and the `@<GUID>` a mention stores). The graph API is descriptor-based. These are the ways across, measured.',
)

const gapRows = []

if (probeSubject) {
  // storagekeys — the documented descriptor → local id call
  const keyRes = await vssps(
    `_apis/graph/storagekeys/${encodeURIComponent(probeSubject.descriptor)}?api-version=7.1-preview.1`,
  )
  gapRows.push(
    `| \`GET graph/storagekeys/{descriptor}\` | vssps | ${keyRes.status} | ${keyRes.ms} | 1 | ${
      keyRes.status === 200
        ? `\`value: ${keyRes.body?.value}\``
        : esc(redact(keyRes.body?.message ?? keyRes.text).slice(0, 110))
    } |`,
  )

  // identities?subjectDescriptors= — the batched crossing. Note the parameter
  // name: `descriptors=` takes the *legacy* IMS descriptor
  // (`Microsoft.IdentityModel.Claims.ClaimsIdentity;…`), not a graph subject
  // descriptor, and answers 200 with a null in the array rather than an error.
  const idsRes = await vssps(
    `_apis/identities?subjectDescriptors=${encodeURIComponent(
      descriptors.join(','),
    )}&queryMembership=None&api-version=7.1`,
  )
  const resolved = idsRes.body?.value ?? []
  gapRows.push(
    `| \`GET _apis/identities?subjectDescriptors=a,b,c\` | vssps | ${idsRes.status} | ${idsRes.ms} | ${descriptors.length} | ${
      idsRes.status === 200
        ? `${resolved.filter(Boolean).length} identities, \`id\` on ${resolved.filter((i) => i?.id).length}`
        : esc(redact(idsRes.body?.message ?? idsRes.text).slice(0, 110))
    } |`,
  )

  // The same call with the wrong parameter name, so the trap is on the record.
  const wrongParam = await vssps(
    `_apis/identities?descriptors=${encodeURIComponent(descriptors.join(','))}&api-version=7.1`,
  )
  gapRows.push(
    `| \`GET _apis/identities?descriptors=\` (**wrong param**) | vssps | ${wrongParam.status} | ${wrongParam.ms} | ${descriptors.length} | ${
      wrongParam.status === 200
        ? `\`${esc(JSON.stringify(wrongParam.body).slice(0, 60))}\` — ${
            (wrongParam.body?.value ?? []).filter(Boolean).length
          } non-null`
        : esc(redact(wrongParam.body?.message ?? wrongParam.text).slice(0, 110))
    } |`,
  )

  // The reverse direction, one at a time and batched.
  const revOne = await vssps(
    `_apis/graph/descriptors/${encodeURIComponent(
      resolved.find((i) => i?.id)?.id ?? myId,
    )}?api-version=7.1-preview.1`,
  )
  gapRows.push(
    `| \`GET graph/descriptors/{guid}\` (**reverse**) | vssps | ${revOne.status} | ${revOne.ms} | 1 | ${
      revOne.status === 200
        ? `\`value: ${String(revOne.body?.value).slice(0, 40)}…\``
        : esc(redact(revOne.body?.message ?? revOne.text).slice(0, 110))
    } |`,
  )
  const revBatch = await vssps(
    `_apis/identities?identityIds=${encodeURIComponent(
      resolved
        .filter((i) => i?.id)
        .map((i) => i.id)
        .join(','),
    )}&queryMembership=None&api-version=7.1`,
  )
  gapRows.push(
    `| \`GET _apis/identities?identityIds=a,b,c\` (**reverse, batched**) | vssps | ${revBatch.status} | ${revBatch.ms} | ${
      resolved.filter((i) => i?.id).length
    } | ${
      revBatch.status === 200
        ? `\`subjectDescriptor\` on ${(revBatch.body?.value ?? []).filter((i) => i?.subjectDescriptor).length}/${
            (revBatch.body?.value ?? []).length
          }`
        : esc(redact(revBatch.body?.message ?? revBatch.text).slice(0, 110))
    } |`,
  )

  // subjectlookup — descriptors in, subjects out. Does it carry an id?
  const lookupRes = await vssps('_apis/graph/subjectlookup?api-version=7.1-preview.1', {
    method: 'POST',
    body: { lookupKeys: descriptors.slice(0, 20).map((d) => ({ descriptor: d })) },
  })
  gapRows.push(
    `| \`POST graph/subjectlookup\` | vssps | ${lookupRes.status} | ${lookupRes.ms} | ${Math.min(
      20,
      descriptors.length,
    )} | ${
      lookupRes.status === 200
        ? `${Object.keys(lookupRes.body?.value ?? lookupRes.body ?? {}).length} entries; \`id\` present: ${Object.values(
            lookupRes.body?.value ?? {},
          ).some((s) => 'id' in (s ?? {}))}`
        : esc(redact(lookupRes.body?.message ?? lookupRes.text).slice(0, 110))
    } |`,
  )

  // graph/users/{descriptor} — one subject, fully expanded
  const userRes = await vssps(
    `_apis/graph/users/${encodeURIComponent(probeSubject.descriptor)}?api-version=7.1-preview.1`,
  )
  gapRows.push(
    `| \`GET graph/users/{descriptor}\` | vssps | ${userRes.status} | ${userRes.ms} | 1 | ${
      userRes.status === 200
        ? `keys: ${Object.keys(userRes.body ?? {}).map((k) => `\`${k}\``).join(' ')}`
        : esc(redact(userRes.body?.message ?? userRes.text).slice(0, 110))
    } |`,
  )

  // identities?searchFilter=General — the *other* search, which answers with GUIDs
  // directly. `api-version=7.1` is required; without it this is a 400.
  const searchRes = await vssps(
    `_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(
      subject.displayName,
    )}&queryMembership=None&api-version=7.1`,
  )
  gapRows.push(
    `| \`GET _apis/identities?searchFilter=General&filterValue=…\` | vssps | ${searchRes.status} | ${searchRes.ms} | — | ${
      searchRes.status === 200
        ? `${(searchRes.body?.value ?? []).length} identities, \`id\` present on ${
            (searchRes.body?.value ?? []).filter((i) => typeof i.id === 'string').length
          }`
        : esc(redact(searchRes.body?.message ?? searchRes.text).slice(0, 110))
    } |`,
  )

  table(
    ['| call | host | status | ms | inputs | result |', '|---|---|---|---|---|---|'],
    gapRows,
  )

  // Does the crossing agree with itself? storagekeys vs identities vs originId.
  // The array comes back in the order the descriptors were sent, and each entry
  // carries `subjectDescriptor` (the graph descriptor) *next to* a legacy
  // `descriptor` of a completely different form. Key off `subjectDescriptor`;
  // keying off `descriptor` matches nothing.
  const byDescriptor = new Map(
    resolved
      .map((i, k) => [String(i?.subjectDescriptor ?? descriptors[k] ?? ''), i])
      .filter(([k, v]) => k !== '' && v),
  )
  const agree = []
  for (const s of subjects.slice(0, 8)) {
    const identity = byDescriptor.get(String(s.descriptor))
    agree.push(
      `| \`${esc(s.displayName)}\` | \`${String(s.descriptor).slice(0, 34)}…\` | \`${
        s.originId ?? '—'
      }\` | \`${identity?.id ?? '—'}\` | ${
        identity && String(identity.id).toLowerCase() === String(s.originId).toLowerCase()
          ? '**equal**'
          : 'different'
      } |`,
    )
  }
  say('### Does `originId` equal the identity `id`?')
  table(
    [
      '| subject | descriptor | `originId` (graph) | `identities.id` | same? |',
      '|---|---|---|---|---|',
    ],
    agree,
  )

  say(
    `\`storagekeys\` for the first subject answered \`${keyRes.body?.value ?? '—'}\`; \`identities?subjectDescriptors=\` answered \`${
      byDescriptor.get(String(probeSubject.descriptor))?.id ?? '—'
    }\` for the same descriptor — ${
      String(keyRes.body?.value ?? '').toLowerCase() ===
      String(byDescriptor.get(String(probeSubject.descriptor))?.id ?? 'x').toLowerCase()
        ? '**the same value**. The storage key *is* the identity id.'
        : '**different values**.'
    }`,
  )

  // A descriptor is `<kind>.<base64url payload>`. For `aad.` subjects the payload
  // decodes to something GUID-shaped. Is it the identity id? Measure, do not guess.
  const decode = (d) => {
    const suffix = String(d).slice(String(d).indexOf('.') + 1)
    try {
      return Buffer.from(suffix.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  const diffIndices = (a, b) =>
    [...String(a).toLowerCase()]
      .map((c, i) => (c === String(b).toLowerCase()[i] ? null : i))
      .filter((i) => i !== null)
  const decodeRows = []
  for (const s of subjects.slice(0, 8)) {
    const identity = byDescriptor.get(String(s.descriptor))
    const decoded = decode(s.descriptor)
    const diff = decoded && identity?.id ? diffIndices(decoded, identity.id) : null
    decodeRows.push(
      `| \`${String(s.descriptor).split('.')[0]}\` | \`${esc(decoded ?? '—')}\` | \`${
        identity?.id ?? '—'
      }\` | ${
        !diff
          ? '—'
          : diff.length === 0
            ? '**identical**'
            : diff.length === 1 && diff[0] === 14
              ? 'differ **only at index 14** (the UUID version nibble)'
              : `differ at ${diff.length} character(s)`
      } |`,
    )
  }
  say('### What is inside a descriptor')
  table(
    [
      '| kind | base64 payload, decoded | `identities.id` | relationship |',
      '|---|---|---|---|',
    ],
    decodeRows,
  )

  // The tempting shortcut is to skip the network entirely and decode the
  // descriptor locally. Census it across the whole directory before believing it.
  const allUsers = await vssps('_apis/graph/users?api-version=7.1-preview.1')
  const allDescriptors = (allUsers.body?.value ?? []).map((u) => u.descriptor).filter(Boolean)
  let dIdentical = 0
  let dNibble = 0
  let dOther = 0
  let dNull = 0
  const otherExamples = []
  const CHUNK = 50
  const scanned = allDescriptors.slice(0, 300)
  const chunkTimes = []
  const originById = new Map(
    (allUsers.body?.value ?? []).map((u) => [String(u.descriptor), String(u.originId ?? '')]),
  )
  let originMatches = 0
  let originSeen = 0
  for (let i = 0; i < scanned.length; i += CHUNK) {
    const chunk = scanned.slice(i, i + CHUNK)
    const res = await vssps(
      `_apis/identities?subjectDescriptors=${encodeURIComponent(
        chunk.join(','),
      )}&queryMembership=None&api-version=7.1`,
    )
    if (res.status !== 200) break
    chunkTimes.push(res.ms)
    for (const [k, identity] of (res.body?.value ?? []).entries()) {
      if (!identity?.id) {
        dNull++
        continue
      }
      const origin = originById.get(String(chunk[k]))
      if (origin) {
        originSeen++
        if (origin.toLowerCase() === String(identity.id).toLowerCase()) originMatches++
      }
      const decoded = decode(chunk[k])
      const diff = decoded === null ? null : diffIndices(decoded, identity.id)
      if (diff && diff.length === 0) dIdentical++
      else if (diff && diff.length === 1 && diff[0] === 14) dNibble++
      else {
        dOther++
        if (otherExamples.length < 3) {
          otherExamples.push(`\`${esc(redact(String(decoded)).slice(0, 76))}\``)
        }
      }
    }
  }
  say(
    '',
    `Across **${scanned.length}** directory users, resolved in ${Math.ceil(scanned.length / CHUNK)} batched calls of ${CHUNK}:`,
    '',
    `- payload **identical** to the identity id: **${dIdentical}**`,
    `- payload differs **only at index 14**, the UUID version nibble (\`7\` in the descriptor, \`6\` in the id): **${dNibble}**`,
    `- payload is not GUID-shaped at all: **${dOther}**${
      otherExamples.length > 0 ? ` — e.g. ${otherExamples.join(', ')}` : ''
    }`,
    `- descriptor did not resolve: **${dNull}**`,
    '',
    `**Do not decode descriptors.** The transform is right for ${dNibble + dIdentical} of ${
      dIdentical + dNibble + dOther
    } and silently wrong for the other ${dOther}.`,
    '',
    `And the same scan settles \`originId\`: of **${originSeen}** users carrying one, it equalled the identity \`id\` **${originMatches}** times and differed on the other **${
      originSeen - originMatches
    }**. So \`originId\` is *sometimes* the id the PR API wants and sometimes the AAD object id, with nothing on the subject saying which — worse than a value that is always wrong. Do not use it as an id.`,
  )

  // Cost of the crossing: 1 batched call vs N storagekeys calls.
  const perSubject = []
  for (const d of allDescriptors.slice(0, 5)) {
    const one = await vssps(`_apis/graph/storagekeys/${encodeURIComponent(d)}?api-version=7.1-preview.1`)
    perSubject.push(one.ms)
  }
  // How many descriptors fit in one batched call? The limit is URL length, and it
  // announces itself as a 404 (a routing failure), not a 414 until much later.
  const limitRows = []
  let maxBatch = 0
  for (const n of [10, 50, 60, 70, 100, 200]) {
    if (allDescriptors.length < n) continue
    const q = encodeURIComponent(allDescriptors.slice(0, n).join(','))
    const res = await vssps(
      `_apis/identities?subjectDescriptors=${q}&queryMembership=None&api-version=7.1`,
    )
    if (res.status === 200) maxBatch = n
    limitRows.push(
      `| \`subjectDescriptors\` | ${n} | ${q.length} | ${res.status} | ${res.ms} | ${
        res.status === 200 ? `${(res.body?.value ?? []).filter(Boolean).length} resolved` : 'no body'
      } |`,
    )
    log(`  subjectDescriptors n=${n} → ${res.status}`)
  }
  const guidPool = (revBatch.body?.value ?? []).map((i) => i?.id).filter(Boolean)
  for (const n of [100, 200]) {
    const pool = Array.from({ length: n }, (_, i) => guidPool[i % Math.max(1, guidPool.length)])
    if (guidPool.length === 0) break
    const q = encodeURIComponent(pool.join(','))
    const res = await vssps(
      `_apis/identities?identityIds=${q}&queryMembership=None&api-version=7.1`,
    )
    limitRows.push(
      `| \`identityIds\` | ${n} (${new Set(pool).size} distinct) | ${q.length} | ${res.status} | ${res.ms} | ${
        res.status === 200 ? `${(res.body?.value ?? []).length} back` : 'no body'
      } |`,
    )
    log(`  identityIds n=${n} → ${res.status}`)
  }
  say('### How many fit in one call')
  table(
    ['| parameter | ids sent | URL length | status | ms | result |', '|---|---|---|---|---|---|'],
    limitRows,
  )

  say(
    '### What the crossing costs',
    '',
    `- one batched \`identities?subjectDescriptors=\` for **${descriptors.length}** descriptors: **${idsRes.ms} ms**`,
    `- the same call for 50 descriptors, repeated ${chunkTimes.length}×: ${chunkTimes.join(', ')} ms — ${stats(chunkTimes)}`,
    `- \`storagekeys\`, one descriptor at a time, 5 calls: ${perSubject.join(', ')} ms — ${stats(perSubject)}`,
    `- \`subjectlookup\` for ${Math.min(20, descriptors.length)} descriptors: **${lookupRes.ms} ms**`,
    '',
    `A page of autocomplete candidates is capped at 100 subjects (§3), so crossing a whole page of results costs **two** batched calls at ~${stats(chunkTimes)}, not one call per candidate. Resolving the handful the user can actually see costs one.`,
  )

  if (lookupRes.status === 200) {
    const entries = Object.entries(lookupRes.body?.value ?? {})
    say(
      '### `subjectlookup`, in detail',
      '',
      `- body shape sent: \`{ "lookupKeys": [ { "descriptor": "…" } ] }\``,
      `- descriptors sent: **${Math.min(20, descriptors.length)}**, entries back: **${entries.length}**`,
      `- top-level keys: ${Object.keys(lookupRes.body ?? {})
        .map((k) => `\`${k}\``)
        .join(' ')} — but \`value\` is **an object keyed by descriptor**, not an array. \`value[0]\` is \`undefined\`; you have to \`Object.entries\` it.`,
      `- the entries carry no \`id\`, so \`subjectlookup\` does **not** cross the gap — it is a batched \`graph/users/{descriptor}\`, nothing more.`,
    )
    if (entries.length > 0) {
      table(['| key | present | types |', '|---|---|---|'], census(entries.map(([, v]) => v)))
      say(
        'One looked-up subject, verbatim:',
        '',
        '```json',
        JSON.stringify(JSON.parse(redact(JSON.stringify(entries[0][1]))), null, 2),
        '```',
      )
    }
    // How many at once? Push it.
    const big = descriptors.length > 0 ? descriptors : []
    if (big.length > 0) {
      const padded = Array.from({ length: 120 }, (_, i) => big[i % big.length])
      const bulk = await vssps('_apis/graph/subjectlookup?api-version=7.1-preview.1', {
        method: 'POST',
        body: { lookupKeys: padded.map((d) => ({ descriptor: d })) },
      })
      say(
        `- 120 lookup keys (**${new Set(padded).size}** distinct, repeated to reach the count) → ${bulk.status} in ${bulk.ms} ms, ${
          Object.keys(bulk.body?.value ?? {}).length
        } entries back${
          bulk.status === 200 ? '' : ` — ${esc(redact(bulk.body?.message ?? bulk.text).slice(0, 160))}`
        }`,
      )
    }
    const badLookup = await vssps('_apis/graph/subjectlookup?api-version=7.1-preview.1', {
      method: 'POST',
      body: { lookupKeys: [{ descriptor: 'aad.notarealdescriptoratall' }] },
    })
    say(
      `- an invented descriptor → ${badLookup.status}, ${
        badLookup.status === 200
          ? `${Object.keys(badLookup.body?.value ?? {}).length} entries (silently dropped)`
          : esc(redact(badLookup.body?.message ?? badLookup.text).slice(0, 160))
      }`,
    )
  }

  // §4b — searchFilter=General, the alternative autocomplete. It answers with
  // GUIDs directly, so if it took a prefix it would skip the gap entirely.
  // Note the `api-version=7.1`: without it this call is a 400.
  say('### `_apis/identities?searchFilter=General` — the search that would skip the gap')
  const sfRows = []
  for (const [label, q] of [
    ['1 char', first.slice(0, 1)],
    ['2 chars', first.slice(0, 2)],
    ['3 chars', first.slice(0, 3)],
    ['first name', first],
    ['surname', surname],
    ['whole display name', subject.displayName],
    ['email local part', mailPrefix],
    ['whole email', subject.uniqueName ?? mailPrefix],
  ]) {
    const res = await vssps(
      `_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(q)}&queryMembership=None&api-version=7.1`,
    )
    const value = res.body?.value ?? []
    sfRows.push(
      `| ${label} | \`${esc(q)}\` | ${res.status} | ${res.ms} | ${value.length} | ${
        value.some((i) => String(i.id).toLowerCase() === String(subject.id).toLowerCase())
          ? '**yes**'
          : 'no'
      } |`,
    )
    log(`  searchFilter ${label} → ${res.status} ${value.length}`)
  }
  table(
    ['| term | value | status | ms | identities | target found |', '|---|---|---|---|---|---|'],
    sfRows,
  )
  // Which filters accept what. Only the ones that match are worth documenting.
  const filterRows = []
  for (const filter of ['General', 'AccountName', 'MailAddress', 'DisplayName', 'LocalGroupName']) {
    const res = await vssps(
      `_apis/identities?searchFilter=${filter}&filterValue=${encodeURIComponent(
        subject.uniqueName ?? mailPrefix,
      )}&queryMembership=None&api-version=7.1`,
    )
    filterRows.push(
      `| \`${filter}\` | ${res.status} | ${res.ms} | ${
        res.status === 200
          ? (res.body?.value ?? []).length
          : esc(redact(res.body?.message ?? res.text).slice(0, 90))
      } |`,
    )
  }
  say('', 'The same whole email address through each `searchFilter`:')
  table(['| `searchFilter` | status | ms | identities |', '|---|---|---|---|'], filterRows)
  say(
    '',
    '`searchFilter=General` is an **exact match**, not a prefix search: the whole display name and the whole email address each find the person, and every prefix of either finds nothing. It cannot drive an autocomplete, whatever GUIDs it would have handed back.',
  )

  const sfShape = await vssps(
    `_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(
      subject.displayName,
    )}&queryMembership=None&api-version=7.1`,
  )
  const sfValue = sfShape.body?.value ?? []
  if (sfValue.length > 0) {
    table(['| key | present | types |', '|---|---|---|'], census(sfValue))
    say(
      'One identity, verbatim:',
      '',
      '```json',
      JSON.stringify(JSON.parse(redact(JSON.stringify(sfValue[0]))), null, 2),
      '```',
    )
  }

  say(
    '### How the gap is crossed',
    '',
    '1. **descriptor → GUID, one subject:** `GET graph/storagekeys/{descriptor}` on `vssps`. The `value` it returns *is* the id the PR API and a mention use — not a related key, the same string. Not batchable.',
    `2. **descriptor → GUID, batched:** \`GET _apis/identities?subjectDescriptors={csv}&queryMembership=None&api-version=7.1\` on \`vssps\`. **${maxBatch}** descriptors per call was the largest that answered 200 here; past that the URL length turns it into a 404, not a 414. This is the call an autocomplete should make — once, over the candidates on screen.`,
    '3. **GUID → descriptor, one id:** `GET graph/descriptors/{guid}`. Batched: the same `identities` endpoint with `identityIds={csv}`, which answers with `subjectDescriptor` alongside `id`.',
    '4. **Not a crossing:** `subjectlookup` (no `id` in the response) and `originId` (the AAD object id, a different GUID from the ADO identity id — see the table above).',
    '',
    'The practical shape: `subjectquery` for the list, one batched `identities?subjectDescriptors=` for the ids, and nothing per candidate. Mention avatars are free — `threads.ts` already calls `identities?identityIds=` to resolve mention names, and `subjectDescriptor` rides along in that answer.',
  )
} else {
  say('_No subject to probe the gap with._')
}

// ---------------------------------------------------------------------------
// §5  graph/users and graph/groups — a cheaper prefetch?
// ---------------------------------------------------------------------------

log('§5 graph/users, graph/groups…')
say('## 5 — `graph/users` and `graph/groups` as a prefetch')

const enumRows = []
for (const [label, path] of [
  ['`graph/users`', '_apis/graph/users?api-version=7.1-preview.1'],
  ['`graph/groups`', '_apis/graph/groups?api-version=7.1-preview.1'],
  ['`graph/users?subjectTypes=aad`', '_apis/graph/users?api-version=7.1-preview.1&subjectTypes=aad'],
]) {
  const res = await vssps(path)
  enumRows.push(
    `| ${label} | ${res.status} | ${res.ms} | ${res.body?.count ?? '—'} | ${
      res.continuation ? `\`${String(res.continuation).slice(0, 24)}…\`` : '_none_'
    } | ${res.contentLength ? `${(Number(res.contentLength) / 1024).toFixed(1)} KB` : '—'} |`,
  )
  log(`  ${label} → ${res.status} count=${res.body?.count ?? '—'}`)
}
table(
  ['| endpoint | status | ms | `count` | continuation token | body size |', '|---|---|---|---|---|---|'],
  enumRows,
)

// How big is the whole-org list on the wire, and does it carry enough to search
// in the browser? `req` truncates `text`, so measure the payload separately.
const usersRaw = await fetch(`${VSSPS}/_apis/graph/users?api-version=7.1-preview.1`, {
  headers: authHeaders,
  redirect: 'manual',
})
calls++
const usersText = await usersRaw.text()
const usersBody = JSON.parse(usersText)
const users = usersBody.value ?? []
say(
  '### `graph/users` as a client-side prefetch',
  '',
  `- **${users.length}** users, **${(usersText.length / 1024).toFixed(0)} KB** of JSON in one response`,
  `- \`descriptor\` present on **${users.filter((u) => typeof u.descriptor === 'string').length}**, \`displayName\` on **${
    users.filter((u) => typeof u.displayName === 'string').length
  }**, \`mailAddress\` on **${users.filter((u) => u.mailAddress).length}**, \`originId\` on **${
    users.filter((u) => u.originId).length
  }**`,
  `- an \`id\` (the GUID the PR API wants) on **${users.filter((u) => 'id' in u).length}**`,
  `- \`origin\` values: ${tallyLine(users.map((u) => String(u.origin)))}`,
  `- \`subjectKind\` values: ${tallyLine(users.map((u) => String(u.subjectKind)))}`,
)
if (users.length > 0) {
  table(['| key | present | types |', '|---|---|---|'], census(users))
}

// Page it, if there is a token, to learn the page size and the whole-org cost.
const firstPage = await vssps('_apis/graph/users?api-version=7.1-preview.1')
if (firstPage.status === 200 && firstPage.continuation) {
  let token = firstPage.continuation
  let total = firstPage.body?.count ?? 0
  let pages = 1
  let ms = firstPage.ms
  while (token && pages < 8) {
    const next = await vssps(
      `_apis/graph/users?api-version=7.1-preview.1&continuationToken=${encodeURIComponent(token)}`,
    )
    if (next.status !== 200) break
    total += next.body?.count ?? 0
    ms += next.ms
    pages++
    token = next.continuation
  }
  say(
    `Paging \`graph/users\` on \`continuationToken\` (header \`x-ms-continuationtoken\`): **${pages}** pages, **${total}** users, **${ms} ms** total${
      token ? ' — and still more to come at the 8-page probe limit' : ' — exhausted'
    }. Page size is **${firstPage.body?.count ?? '—'}**.`,
  )
} else {
  say(
    `\`graph/users\` returned **${firstPage.body?.count ?? '—'}** users in one page with ${
      firstPage.continuation ? 'a' : '**no**'
    } continuation token.`,
  )
}

// ---------------------------------------------------------------------------
// §6  Reviewers, read-only
// ---------------------------------------------------------------------------

log('§6 reviewers…')
say('## 6 — `GET pullRequests/{id}/reviewers`')

const allReviewers = []
const reviewerRows = []
for (const ref of candidates) {
  const res = await core(`${base(ref)}/reviewers`)
  const value = res.body?.value ?? []
  if (res.status === 200) allReviewers.push(...value.map((r) => ({ ...r, __pr: ref.id })))
  reviewerRows.push(
    `| !${ref.id} | ${res.status} | ${res.ms} | ${value.length} | ${
      value.filter((r) => r.isContainer === true).length
    } | ${value.filter((r) => (r.vote ?? 0) !== 0).length} | ${
      Object.keys(res.rate).length === 0 ? '_none_' : JSON.stringify(res.rate)
    } |`,
  )
  log(`  !${ref.id} reviewers ${res.status} ${value.length}`)
}
table(
  [
    '| PR | status | ms | reviewers | containers | non-zero votes | rate-limit headers |',
    '|---|---|---|---|---|---|---|',
  ],
  reviewerRows,
)

say(
  `Reviewers collected: **${allReviewers.length}** across ${candidates.length} pull requests — mean **${(
    allReviewers.length / candidates.length
  ).toFixed(1)}** per PR, min **${Math.min(
    ...candidates.map((c) => allReviewers.filter((r) => r.__pr === c.id).length),
  )}**, max **${Math.max(
    ...candidates.map((c) => allReviewers.filter((r) => r.__pr === c.id).length),
  )}**.`,
)

if (allReviewers.length > 0) {
  say('### Reviewer field census')
  // `__pr` is this script's own bookkeeping; keep it out of the census.
  table(
    ['| key | present | types |', '|---|---|---|'],
    census(allReviewers.map(({ __pr, ...r }) => r)),
  )
  say(
    `- \`vote\` values: ${tallyLine(allReviewers.map((r) => String(r.vote)))}`,
    `- \`isContainer: true\`: **${allReviewers.filter((r) => r.isContainer === true).length}**/${allReviewers.length}`,
    `- \`isRequired: true\`: **${allReviewers.filter((r) => r.isRequired === true).length}**`,
    `- \`isFlagged: true\`: **${allReviewers.filter((r) => r.isFlagged === true).length}**`,
    `- \`hasDeclined: true\`: **${allReviewers.filter((r) => r.hasDeclined === true).length}**`,
    `- \`votedFor\` present: **${allReviewers.filter((r) => Array.isArray(r.votedFor)).length}**, non-empty on **${
      allReviewers.filter((r) => (r.votedFor ?? []).length > 0).length
    }**`,
    `- \`imageUrl\` present: **${allReviewers.filter((r) => typeof r.imageUrl === 'string').length}**/${allReviewers.length}`,
    `- \`uniqueName\` present: **${allReviewers.filter((r) => typeof r.uniqueName === 'string').length}**`,
    `- \`descriptor\` present: **${allReviewers.filter((r) => typeof r.descriptor === 'string').length}**`,
    `- distinct reviewer identities: **${new Set(allReviewers.map((r) => r.id)).size}**`,
  )
  const container = allReviewers.find((r) => r.isContainer === true)
  const voted = allReviewers.find((r) => (r.votedFor ?? []).length > 0)
  const one = voted ?? container ?? allReviewers[0]
  const strip = (r) => {
    const { __pr, ...rest } = r
    return rest
  }
  say(
    'One reviewer, verbatim:',
    '',
    '```json',
    JSON.stringify(JSON.parse(redact(JSON.stringify(strip(one)))), null, 2),
    '```',
  )
  if (voted && voted !== one) {
    say(
      'A reviewer with a non-empty `votedFor`:',
      '',
      '```json',
      JSON.stringify(JSON.parse(redact(JSON.stringify(strip(voted)))), null, 2),
      '```',
    )
  }

  // A reviewer has no `descriptor` field, but `_links.avatar.href` ends in one.
  // If that descriptor round-trips back to the same `id`, the graph and PR views
  // of a person can be joined without an extra call.
  const hrefDescriptors = allReviewers
    .map((r) => ({ id: r.id, d: String(r._links?.avatar?.href ?? '').split('/MemberAvatars/')[1] }))
    .filter((x) => x.d)
  const roundTrip = await vssps(
    `_apis/identities?subjectDescriptors=${encodeURIComponent(
      [...new Set(hrefDescriptors.map((x) => x.d))].join(','),
    )}&queryMembership=None&api-version=7.1`,
  )
  const backById = new Map(
    (roundTrip.body?.value ?? []).map((i) => [String(i.id).toLowerCase(), i]),
  )
  say(
    '### Recovering a reviewer\'s descriptor',
    '',
    `- reviewers carrying a \`descriptor\` field: **${allReviewers.filter((r) => r.descriptor).length}**/${allReviewers.length}`,
    `- reviewers whose \`_links.avatar.href\` ends in a descriptor: **${hrefDescriptors.length}**/${allReviewers.length}`,
    `- descriptor kinds seen there: ${tallyLine(hrefDescriptors.map((x) => x.d.split('.')[0]))}`,
    `- feeding those **${new Set(hrefDescriptors.map((x) => x.d)).size}** distinct descriptors back to \`identities?subjectDescriptors=\` → ${roundTrip.status} in ${roundTrip.ms} ms, **${
      (roundTrip.body?.value ?? []).length
    }** identities`,
    `- of the **${hrefDescriptors.length}** reviewers, the id recovered from their own avatar descriptor equalled their \`id\` on **${
      hrefDescriptors.filter((x) => backById.has(String(x.id).toLowerCase())).length
    }**`,
    '',
    'So a reviewer can be turned into a graph subject without a second network call — the descriptor is already sitting in `_links.avatar.href`, on both users and groups.',
  )

  // Is the collection endpoint worth it, given the list already embeds reviewers?
  const listReviewers = prs
    .filter((p) => candidates.some((c) => c.id === p.pullRequestId))
    .flatMap((p) => p.reviewers ?? [])
  const listKeys = new Set(listReviewers.flatMap((r) => Object.keys(r)))
  const endpointKeys = new Set(allReviewers.flatMap((r) => Object.keys(r)).filter((k) => k !== '__pr'))
  say(
    `**The PR listing already embeds reviewers.** ${listReviewers.length} embedded against ${allReviewers.length} from the collection endpoint on the same pull requests. Keys only the endpoint has: ${
      [...endpointKeys].filter((k) => !listKeys.has(k)).map((k) => `\`${k}\``).join(' ') || '_none_'
    }. Keys only the listing has: ${
      [...listKeys].filter((k) => !endpointKeys.has(k)).map((k) => `\`${k}\``).join(' ') || '_none_'
    }.`,
  )

  // One reviewer by id — read-only, and it tells us the path shape.
  const single = await core(`${base(candidates[0])}/reviewers/${allReviewers.find((r) => r.__pr === candidates[0].id)?.id ?? myId}`)
  say(
    `\`GET .../reviewers/{id}\` → ${single.status} in ${single.ms} ms${
      single.status === 200 ? ', a single reviewer, not wrapped in `value`' : ` — ${esc(redact(single.body?.message ?? single.text).slice(0, 160))}`
    }. The path segment is a **GUID**; a descriptor in the same position → ${
      (await core(`${base(candidates[0])}/reviewers/${encodeURIComponent(probeSubject?.descriptor ?? 'aad.x')}`)).status
    }.`,
  )

  // The write shapes. NOT SENT — every pull request here belongs to a colleague,
  // and this ticket authorises no write. Transcribed from Microsoft's reference
  // and marked unproven so nobody mistakes it for a measurement.
  say(
    '### Adding and removing a reviewer — **documented, not measured**',
    '',
    'No write was issued. Every pull request in this organisation belongs to a colleague and this ticket authorises exactly one non-`GET` call, `POST graph/subjectquery`. What follows is transcribed from Microsoft\'s REST reference (`git/pull-request-reviewers`) and is **unproven against this server**.',
    '',
    '```http',
    'PUT {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1',
    'Content-Type: application/json',
    '',
    '{ "vote": 0, "isRequired": false }',
    '```',
    '',
    '```http',
    'DELETE {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1',
    '```',
    '',
    `- \`{reviewerId}\` is documented as an *identity id*. Read-only evidence agrees: \`GET .../reviewers/{guid}\` answers 200 and the same path with a graph descriptor answers 400. **Assume GUID-only** — which means the autocomplete has to cross the gap in §4 before it can add anyone.`,
    '- `vote` is the same enum the read side uses: `10` approved · `5` approved with suggestions · `0` no vote · `-5` waiting for author · `-10` rejected. Adding a reviewer is a `PUT` with `vote: 0`.',
    `- \`isRequired\` marks the reviewer as a *required* reviewer, whose approval the branch policy waits for. It appears on the read side **only when true** (${allReviewers.filter((r) => r.isRequired === true).length}/${allReviewers.length} here), so a client must treat \`undefined\` as \`false\`.`,
    '- there is also a documented `POST .../reviewers` taking an array, for adding several at once. Also unproven.',
    '- **unproven:** whether `PUT` on an already-present reviewer is an upsert or an error, what status a removal of an absent reviewer returns, and whether `isRequired` can be changed after the fact.',
  )
}

// ---------------------------------------------------------------------------
// §7  Mentions — the storage form
// ---------------------------------------------------------------------------

log('§7 mentions…')
say('## 7 — How a mention is stored')

const MENTION_PATTERNS = [
  ['`@<GUID>`', /@<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>/gi],
  ['`#mention:` link', /#mention:/gi],
  ['`<a href=` anywhere', /<a\s+href=/gi],
  ['`@` followed by a letter', /@[A-Za-z]/g],
  ['a bare descriptor (`aad.`/`vssgp.`)', /\b(?:aad|vssgp|msa|svc)\.[A-Za-z0-9_-]{10,}/g],
]

let threadsSeen = 0
let commentsSeen = 0
let prsSearched = 0
const mentionHits = []
const patternCounts = new Map()
const mentionThreads = []

// A wide pool: nobody @-mentions on every pull request, and pass 1 of this
// script found nothing in 100 threads across 12 active PRs. Completed PRs are
// where the long argument threads live, so search those too.
const completedList = await core(
  '_apis/git/pullrequests?searchCriteria.status=completed&$top=100',
)
const mentionPool = [...prs, ...(completedList.body?.value ?? [])].map(refOf)
const MENTION_PR_LIMIT = Number(process.env.ADO_MENTION_PRS ?? 60)

for (const ref of mentionPool.slice(0, MENTION_PR_LIMIT)) {
  const res = await core(`${base(ref)}/threads`)
  prsSearched++
  const threads = res.body?.value ?? []
  threadsSeen += threads.length
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      commentsSeen++
      const content = comment.content
      if (typeof content !== 'string') continue
      for (const [label, pattern] of MENTION_PATTERNS) {
        const found = content.match(pattern)
        if (found) patternCounts.set(label, (patternCounts.get(label) ?? 0) + found.length)
      }
      const guid = content.match(MENTION_PATTERNS[0][1])
      if (guid) {
        mentionHits.push({ pr: ref.id, threadId: thread.id, commentId: comment.id, content, raw: guid })
        // Two mentions often sit in one thread. Keep two *distinct* threads.
        if (
          mentionThreads.length < 2 &&
          !mentionThreads.some((m) => m.thread.id === thread.id)
        ) {
          mentionThreads.push({ ref, thread, comment })
        }
      }
    }
  }
  if (prsSearched % 10 === 0 || mentionHits.length > 0) {
    log(`  ${prsSearched} PRs, ${threadsSeen} threads, ${mentionHits.length} mentions`)
  }
  if (mentionHits.length >= 5) break
}

say(
  `Searched **${prsSearched}** pull requests, **${threadsSeen}** threads, **${commentsSeen}** comments with a \`content\` key.`,
  '',
  '| pattern | occurrences |',
  '|---|---|',
)
report.pop()
for (const [label] of MENTION_PATTERNS) {
  report.push(`| ${label} | ${patternCounts.get(label) ?? 0} |`)
}
report.push('')

if (mentionHits.length === 0) {
  say(
    `**Not measured.** No comment in the sample contained a mention in any of the forms above. ${threadsSeen} threads across ${prsSearched} pull requests searched.`,
  )
} else {
  say(
    `Comments containing a mention: **${mentionHits.length}**.`,
    '',
    'The raw matched substrings, verbatim:',
    '',
    '```',
    ...[...new Set(mentionHits.flatMap((h) => h.raw))].slice(0, 12),
    '```',
  )
  const first = mentionHits[0]
  say(
    `One whole comment body, verbatim (from !${first.pr}, thread ${first.threadId}, comment ${first.commentId}):`,
    '',
    '```',
    redact(first.content).slice(0, 1200),
    '```',
  )
  say(
    `- casing of the GUID inside the mention: ${tallyLine(
      mentionHits.flatMap((h) => h.raw.map((r) => (/[A-F]/.test(r) ? 'upper' : 'lower'))),
    )}`,
    `- does the body contain the mentioned person's **display name** anywhere? ${
      mentionHits.some((h) => people.some((p) => h.content.includes(p.displayName))) ? 'yes' : '**no**'
    }`,
  )

  // Two mentions can live in one thread; show each thread once.
  const shownThreads = new Set()
  for (const { ref, thread, comment } of mentionThreads) {
    if (shownThreads.has(thread.id)) continue
    shownThreads.add(thread.id)
    say(
      `### The thread carrying it (!${ref.id}, thread ${thread.id})`,
      '',
      `\`thread.properties\`:`,
      '',
      '```json',
      JSON.stringify(thread.properties ?? null, null, 2),
      '```',
      `\`comment\` keys: ${Object.keys(comment).map((k) => `\`${k}\``).join(' ')}`,
      '',
      `A \`properties\` key on the **comment** itself: ${
        comment.properties === undefined ? '**absent**' : `\`${JSON.stringify(comment.properties)}\``
      }`,
    )
  }

  // Do the mentioned GUIDs resolve, and through which endpoint?
  const mentioned = [...new Set(mentionHits.flatMap((h) => h.raw.map((r) => r.slice(2, -1).toLowerCase())))]
  const resolveRes = await vssps(
    `_apis/identities?identityIds=${mentioned.join(',')}&queryMembership=None&api-version=7.1`,
  )
  const resolvedMentions = resolveRes.body?.value ?? []
  say(
    `### Do the ids in a mention resolve?`,
    '',
    `- ids mentioned, distinct: **${mentioned.length}**`,
    `- \`GET _apis/identities?identityIds=…&api-version=7.1\` on vssps → ${resolveRes.status} in ${resolveRes.ms} ms, **${
      resolvedMentions.length
    }** resolved`,
    `- they are ADO **identity GUIDs**, so \`identities\` answers and \`subjectlookup\` (descriptors only) cannot`,
    `- the answer also carries \`subjectDescriptor\` on **${
      resolvedMentions.filter((i) => i?.subjectDescriptor).length
    }**/${resolvedMentions.length} — so the avatar for a mention costs **no extra call**: \`threads.ts\` already makes this exact request to turn a mention into a name.`,
    `- casing: the mention stores the GUID upper case, this endpoint answers \`id\` ${
      resolvedMentions.some((i) => /[A-F]/.test(String(i?.id))) ? 'upper' : '**lower**'
    } case. Compare them as written and every mention silently fails to resolve.`,
  )
  const lookupByGuid = await vssps('_apis/graph/subjectlookup?api-version=7.1-preview.1', {
    method: 'POST',
    body: { lookupKeys: mentioned.slice(0, 3).map((d) => ({ descriptor: d })) },
  })
  say(
    `- \`subjectlookup\` handed the same GUIDs as descriptors → ${lookupByGuid.status}, ${
      lookupByGuid.status === 200
        ? `${Object.keys(lookupByGuid.body?.value ?? {}).length} entries`
        : esc(redact(lookupByGuid.body?.message ?? lookupByGuid.text).slice(0, 160))
    }`,
  )
  if (resolveRes.status === 200 && (resolveRes.body?.value ?? []).length > 0) {
    const identity = resolveRes.body.value[0]
    say(
      'And whether the mention GUID is the identity `id` or something else:',
      '',
      `- \`identities.id\`: \`${identity.id}\` · \`descriptor\`: \`${identity.descriptor}\` · \`displayName\`: \`${identity.providerDisplayName ?? identity.customDisplayName ?? '—'}\``,
    )
  }
}

// ---------------------------------------------------------------------------
// §8  Avatars
// ---------------------------------------------------------------------------

log('§8 avatars…')
say('## 8 — Avatars')

const authorImages = []
for (const ref of candidates.slice(0, 4)) {
  const res = await core(`${base(ref)}/threads`)
  for (const thread of res.body?.value ?? []) {
    for (const comment of thread.comments ?? []) {
      if (comment.author) authorImages.push(comment.author)
    }
  }
}

const imageUrls = [
  ...authorImages.map((a) => a.imageUrl),
  ...allReviewers.map((r) => r.imageUrl),
  ...prs.map((p) => p.createdBy?.imageUrl),
].filter((u) => typeof u === 'string')

const hostsOf = tally(
  imageUrls.map((u) => {
    try {
      return new URL(u).host
    } catch {
      return '(unparseable)'
    }
  }),
)
const pathShape = tally(
  imageUrls.map((u) => {
    try {
      return new URL(u)
        .pathname.replace(/(MemberAvatars\/)([a-z0-9]+\.)?[^/]+$/i, '$1$2{descriptor}')
        .replace(/[0-9a-f-]{20,}/gi, '{id}')
    } catch {
      return '(unparseable)'
    }
  }),
)

// Which of the two URL forms each kind of object puts in `imageUrl`. They are
// not the same, and only one of them works without a credential.
const formOf = (u) => (/GraphProfile\/MemberAvatars/i.test(u) ? 'MemberAvatars' : 'identityImage')
const formTally = (urls) =>
  tally(urls.filter((u) => typeof u === 'string').map(formOf))
    .map(([f, n]) => `\`${f}\`×${n}`)
    .join(' · ')

say(
  '### `imageUrl`, where it appears',
  '',
  `- on comment authors: **${authorImages.filter((a) => typeof a.imageUrl === 'string').length}**/${authorImages.length}`,
  `- on reviewers: **${allReviewers.filter((r) => typeof r.imageUrl === 'string').length}**/${allReviewers.length}`,
  `- on PR \`createdBy\`: **${prs.filter((p) => typeof p.createdBy?.imageUrl === 'string').length}**/${prs.length}`,
  `- hosts: ${hostsOf.map(([h, n]) => `\`${h}\`×${n}`).join(' · ')}`,
  `- path shapes: ${pathShape.map(([p, n]) => `\`${p}\`×${n}`).join(' · ')}`,
  '',
  '`imageUrl` is **not one URL form**. Which form you get depends on which object you read it from:',
  '',
  `- comment \`author.imageUrl\`: ${formTally(authorImages.map((a) => a.imageUrl))}`,
  `- reviewer \`imageUrl\`: ${formTally(allReviewers.map((r) => r.imageUrl))}`,
  `- PR \`createdBy.imageUrl\`: ${formTally(prs.map((p) => p.createdBy?.imageUrl))}`,
  '',
  'That matters because only one of the two forms works without a credential (see below). A comment author\'s avatar can go straight into an `<img src>`; a reviewer\'s or a PR author\'s cannot, and has to be swapped for the `MemberAvatars` form first.',
)

// Two shapes appear in the wild: `_api/_common/identityImage?id={guid}` (the one
// `imageUrl` carries) and `_apis/GraphProfile/MemberAvatars/{descriptor}` (the one
// `_links.avatar.href` carries). Probe both, with and without a credential, and
// with an image Accept header rather than JSON — `Accept: application/json` makes
// the same URL answer with a base64 wrapper, which inflates every byte count.
const identityImage = imageUrls.find((u) => u.includes('identityImage')) ?? null
const memberAvatar =
  [...allReviewers, ...authorImages].map((r) => r._links?.avatar?.href).find(Boolean) ??
  imageUrls.find((u) => u.includes('MemberAvatars')) ??
  null
const avatarRows = []

const avatarProbe = async (label, url, opts = {}) => {
  const res = await req(url, { bytes: true, accept: 'image/png,image/*;q=0.8,*/*;q=0.5', ...opts })
  avatarRows.push(
    `| ${label} | ${res.status} | ${res.ms} | ${res.contentType ?? '—'} | ${res.bytes ?? '—'} | ${
      res.location
        ? `→ \`${esc(String(res.location).slice(0, 60))}…\``
        : esc(JSON.stringify(res.cache))
    } |`,
  )
  log(`  ${label} → ${res.status} ${res.contentType ?? ''} ${res.bytes ?? ''}B`)

  return res
}

if (identityImage) {
  await avatarProbe('`identityImage?id={guid}`, credential', identityImage)
  await avatarProbe('`identityImage?id={guid}`, **no auth header**', identityImage, { anon: true })
  await avatarProbe(
    '`identityImage?id={guid}`, `Accept: application/json`',
    identityImage,
    { accept: 'application/json' },
  )
  await avatarProbe(
    '`identityImage?id=`, unknown GUID',
    `${CORE}/_api/_common/identityImage?id=00000000-0000-0000-0000-000000000001`,
  )
}
if (memberAvatar) {
  await avatarProbe('`MemberAvatars/{descriptor}`, credential', memberAvatar)
  await avatarProbe('`MemberAvatars/{descriptor}`, **no auth header**', memberAvatar, { anon: true })
  await avatarProbe(
    '`MemberAvatars/{descriptor}`, unknown descriptor',
    `${CORE}/_apis/GraphProfile/MemberAvatars/aad.bm90YXJlYWxkZXNjcmlwdG9yYXRhbGw`,
  )
}
if (probeSubject) {
  const graphAvatar = `${VSSPS}/_apis/graph/Subjects/${encodeURIComponent(
    probeSubject.descriptor,
  )}/avatars?api-version=7.1-preview.1`
  const res = await req(graphAvatar)
  const b64 = typeof res.body?.value === 'string' ? res.body.value : null
  avatarRows.push(
    `| \`graph/Subjects/{d}/avatars\` (vssps, JSON) | ${res.status} | ${res.ms} | ${
      res.contentType ?? '—'
    } | ${
      b64 ? `${Math.round((b64.length * 3) / 4)} decoded` : (res.contentLength ?? '—')
    } | ${res.status === 200 ? esc(JSON.stringify(res.cache)) : esc(redact(res.body?.message ?? res.text).slice(0, 80))} |`,
  )
  const big = await req(`${graphAvatar}&size=large`)
  const bigB64 = typeof big.body?.value === 'string' ? big.body.value : null
  avatarRows.push(
    `| \`graph/Subjects/{d}/avatars?size=large\` | ${big.status} | ${big.ms} | ${
      big.contentType ?? '—'
    } | ${bigB64 ? `${Math.round((bigB64.length * 3) / 4)} decoded` : '—'} | ${esc(
      JSON.stringify(big.cache),
    )} |`,
  )
  if (b64) {
    say(
      `\`graph/Subjects/{descriptor}/avatars\` answers **JSON**, not an image: keys ${Object.keys(
        res.body,
      )
        .map((k) => `\`${k}\``)
        .join(' ')}, with \`value\` a base64 payload of ${b64.length} characters (**${Math.round(
        (b64.length * 3) / 4,
      )}** bytes decoded) — so an \`<img src>\` cannot point at it directly.`,
    )
  }
}

table(
  ['| avatar route | status | ms | content-type | bytes | caching / note |', '|---|---|---|---|---|---|'],
  avatarRows,
)

// Sizes across several people, so the SQLite question has a number.
const sizes = []
for (const url of [...new Set(imageUrls)].slice(0, 8)) {
  const res = await req(url, { bytes: true, accept: 'image/png,image/*;q=0.8' })
  if (res.status === 200) sizes.push({ bytes: res.bytes, type: res.contentType })
}
if (sizes.length > 0) {
  say(
    '### How big is an avatar',
    '',
    `${sizes.length} avatars fetched with an image \`Accept\`: ${sizes
      .map((s) => `${s.bytes} B`)
      .join(', ')}.`,
    '',
    `${stats(sizes.map((s) => s.bytes))} bytes; content types ${tallyLine(sizes.map((s) => s.type))}.`,
  )
} else {
  say('### How big is an avatar', '', '_No avatar body was readable; sizes not measured._')
}

say(
  '### Which avatar URL to use',
  '',
  'The two forms are not interchangeable, and the difference decides whether an image proxy is needed:',
  '',
  '- **`_api/_common/identityImage?id={guid}`** — the form a reviewer\'s and a PR author\'s `imageUrl` carries. **Needs the credential**: without an auth header it answers `302` to the sign-in page, so putting it in an `<img src>` from the browser renders a broken image. With one it answers `200` and caches well (`max-age=172800`, plus an `ETag`). An unknown GUID answers `200` with a generated `image/svg+xml` and `cache-control: private`, so a wrong id fails silently rather than 404ing.',
  '- **`_apis/GraphProfile/MemberAvatars/{descriptor}`** — the form `_links.avatar.href` always carries, and the form a comment author\'s `imageUrl` happens to carry too. **Needs no credential at all**: anonymous, it answers `200` with the same image, byte for byte. It can go straight in an `<img src>`. With a credential it sends `Cache-Control: public, must-revalidate, max-age=172800`; anonymously that becomes `no-cache, no-store` and the `ETag` comes back different from the credentialed one, so the browser re-requests and revalidates rather than reusing a cached copy. An unknown descriptor answers **500**, not 404.',
  '',
  'So the deferred image proxy is **not needed** for avatars, provided the client is given a descriptor rather than a GUID. §4 and §6 both supply one for free: reviewers carry it in `_links.avatar.href`, and `identities?identityIds=` hands back `subjectDescriptor` in the same call that resolves a mention\'s name.',
  '',
  '`graph/Subjects/{descriptor}/avatars` on `vssps` is a third form and is a dead end for the DOM: it answers JSON with a base64 `value`, so it can only be used server-side.',
)

// ---------------------------------------------------------------------------
// §9  Failure statuses reachable read-only
// ---------------------------------------------------------------------------

log('§9 failures…')
say('## 9 — Failures reachable without writing anything')

const failRows = []
const failProbes = [
  [
    '`subjectquery` with no body',
    () => req(`${VSSPS}/${SQ}?api-version=7.1-preview.1`, { method: 'POST', body: {} }),
  ],
  [
    '`subjectquery` on the core host',
    () =>
      req(`${CORE}/${SQ}?api-version=7.1-preview.1`, {
        method: 'POST',
        body: { query: probeQuery, subjectKind: ['User'] },
      }),
  ],
  [
    '`subjectquery`, api-version `9.9`',
    () =>
      req(`${VSSPS}/${SQ}?api-version=9.9`, {
        method: 'POST',
        body: { query: probeQuery, subjectKind: ['User'] },
      }),
  ],
  [
    '`storagekeys` with an invented descriptor',
    () => vssps('_apis/graph/storagekeys/aad.bm90YXJlYWw?api-version=7.1-preview.1'),
  ],
  [
    '`identities?identityIds=` with a non-GUID',
    () => vssps('_apis/identities?identityIds=not-a-guid&api-version=7.1'),
  ],
  ['`graph/users` on the core host', () => core('_apis/graph/users?api-version=7.1-preview.1')],
  [
    '`subjectquery` unauthenticated',
    () =>
      req(`${VSSPS}/${SQ}?api-version=7.1-preview.1`, {
        method: 'POST',
        body: { query: probeQuery, subjectKind: ['User'] },
        anon: true,
      }),
  ],
]
for (const [label, run] of failProbes) {
  const res = await run()
  failRows.push(
    `| ${label} | ${res.status} | ${res.ms} | ${esc(
      redact(res.body?.message ?? res.location ?? res.text ?? res.error).slice(0, 170),
    )} |`,
  )
  log(`  ${label} → ${res.status}`)
}
table(['| probe | status | ms | body / `Location` |', '|---|---|---|---|'], failRows)

// ---------------------------------------------------------------------------

say(
  '## 10 — What could not be measured',
  '',
  '- **every write.** `PUT`/`DELETE .../reviewers/{id}`, `POST .../reviewers`, and posting a comment containing a mention. The shapes in §6 come from Microsoft\'s reference, not from this server. Nothing here proves a mention typed as `@<GUID>` renders as a name, only that ADO stores it that way.',
  '- **whether the mention markup is what the ADO web UI writes.** The 5 mentions found were written by colleagues through the ADO UI, so the form is certainly *accepted*; whether a different form is also accepted is unknown.',
  '- **`subjectquery` beyond 100 results.** There is no continuation token and `$top` is ignored, so a query matching more than 100 subjects cannot be paged. Whether a scope or filter parameter exists to narrow it was not found.',
  '- **`subjectquery` scoped to a project or repository.** Every probe here searched the whole organisation. Whether ADO offers a "people on this pull request\'s project" search — which is what a reviewer picker actually wants — was not established.',
  '- **rate limits under real load.** 182 requests over a few minutes drew no `429` and no `Retry-After`. The throttling behaviour of a per-keystroke autocomplete is unmeasured, and ADO throttles by slowing 200s rather than refusing, so it will not announce itself.',
  '- **avatar staleness.** `MemberAvatars` sends `max-age=172800` (2 days) and an `ETag`; whether the `ETag` actually changes when someone changes their photo was not tested.',
  '- **groups as reviewers.** 17 of 29 reviewers were containers, but no group was added, so whether `subjectquery` with `subjectKind: ["Group"]` returns the same groups that are addable as reviewers is unproven.',
  '',
  '## 11 — Call cost',
  '',
  `- requests sent: **${calls}** (${calls} total; the only non-GET verbs were \`POST graph/subjectquery\` and \`POST graph/subjectlookup\`)`,
  `- responses carrying any \`X-RateLimit-*\` or \`Retry-After\`: **${rateSeen.length}**${
    rateSeen.length > 0 ? ` — ${JSON.stringify(rateSeen.slice(0, 4))}` : ''
  }`,
)

await mkdir('docs/research', { recursive: true })
await writeFile(
  OUT,
  [
    '# Identity search and avatar inventory (T-030)',
    '',
    `Read-only probe of the identity-search, identity-resolution, reviewer-read and avatar surfaces against the live \`${ORG}\` org.`,
    '',
    'Every request was a `GET` except `POST _apis/graph/subjectquery` and `POST _apis/graph/subjectlookup`, which are searches that use `POST` only because the query travels in a body. Nothing under `pullRequests/` was written to.',
    '',
    'Generated by `scripts/identity-inventory.mjs`. The PAT is redacted; identity GUIDs and descriptors are left in because the app matches on them.',
    '',
    '---',
    '',
    ...report,
  ].join('\n'),
  'utf8',
)

log(`\nWrote ${OUT} (${calls} requests).`)
