// Throwaway spike for T-046 (phase 9). Not application code — do not import from it.
//
// The destination promises one row per repository carrying "name, project, default
// branch, last updated". Three of those four are assumed to be on the list response
// and the fourth has never been looked for. This script looks.
//
//   node scripts/repositories-inventory.mjs
//
// …or, if the credential store is unreadable on this machine:
//
//   ADO_ORG=myorg ADO_PAT=... node scripts/repositories-inventory.mjs
//
// READ-ONLY. Every request here is a GET. There is no --allow-writes and no code
// path that could take one: phase 9 is a list page and the writes it might have
// wanted (create a repository, rename one) are not in the destination.

import { writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)

/**
 * Environment first, then the OS credential store T-003 writes to. Copied
 * deliberately from live-inventory.mjs rather than shared: these scripts are
 * throwaways and a helper module between them would be the one piece of
 * infrastructure nobody maintains.
 */
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
  console.error(
    'No ADO credential. Either set ADO_ORG and ADO_PAT, or store one at /onboarding.',
  )
  process.exit(1)
}
if (source) console.log(`Using credentials from the ${source}.`)

const ADO = `https://dev.azure.com/${ORG}`
const OUT = 'docs/research/repositories-inventory.md'
const REPOS_ROOT = process.env.ADO_WEB_REPOS_ROOT ?? join(homedir(), 'repos')

const redact = (s) => String(s ?? '').split(PAT).join('«redacted»')

const report = []
const say = (...lines) => report.push(...lines, '')
const log = (m) => console.log(m)

const RATE_HEADERS = [
  'x-ratelimit-cost',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-reset',
  'x-ratelimit-delay',
  'retry-after',
]

/** Header names worth knowing about beyond the rate-limit set — note 12's lesson. */
const PAGING_HEADERS = ['x-ms-continuationtoken', 'link']

/** Every ADO call goes through here so nothing escapes the accounting. */
async function call(url, { method = 'GET', headers = {} } = {}) {
  if (!url.includes('api-version=')) {
    url += `${url.includes('?') ? '&' : '?'}api-version=7.1`
  }
  // Note 4: without Suppress, an auth failure is a 302 to a sign-in page and
  // every assertion below would be made about an HTML document.
  const h = {
    Accept: 'application/json',
    'X-TFS-FedAuthRedirect': 'Suppress',
    Authorization: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`,
    ...headers,
  }

  const started = Date.now()
  let res
  try {
    res = await fetch(url, { method, headers: h, redirect: 'manual' })
  } catch (err) {
    return { url, method, error: String(err), ms: Date.now() - started }
  }
  const ms = Date.now() - started
  const text = await res.text()

  const rate = {}
  for (const k of RATE_HEADERS) if (res.headers.has(k)) rate[k] = res.headers.get(k)
  const paging = {}
  for (const k of PAGING_HEADERS) if (res.headers.has(k)) paging[k] = res.headers.get(k)

  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* not json — keep text */
  }

  const out = { url, method, status: res.status, ms, rate, paging, text, json }
  // Note 2, restated where it can fire: a slow 200 carrying Retry-After is
  // throttling, and a script that only branches on 429 records it as success.
  if (res.status === 200 && rate['retry-after']) {
    out.throttled = true
    log(`  !! 200 with Retry-After: ${rate['retry-after']} — this is throttling (note 2)`)
  }
  log(`  ${method} ${url.replace(ADO, '')} → ${res.status} (${ms}ms)`)
  return out
}

const fence = (value, max = 4000) => {
  let s = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  s = redact(s)
  const truncated = s.length > max
  if (truncated) s = `${s.slice(0, max)}\n… [truncated, ${s.length} chars total]`
  return ['```json', s, '```']
}

const rateLine = (r) =>
  Object.keys(r.rate ?? {}).length
    ? Object.entries(r.rate).map(([k, v]) => `\`${k}: ${v}\``).join(' · ')
    : '_no rate-limit headers on this response_'

/**
 * Count how many of `rows` carry each key, so an absence is a number rather than
 * an impression. Nested one level, because `project.name` is the field the row
 * actually wants and `project` alone says nothing about it.
 */
function census(rows, nest = []) {
  const counts = new Map()
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const row of rows) {
    for (const [k, v] of Object.entries(row ?? {})) {
      if (v === null) bump(`${k} (null)`)
      else bump(k)
      if (nest.includes(k) && v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) bump(`${k}.${k2}${v2 === null ? ' (null)' : ''}`)
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
]

// ---------------------------------------------------------------------------

async function main() {
  say(
    '# Repository listing inventory — T-046',
    '',
    `Generated by \`scripts/repositories-inventory.mjs\` against org \`${ORG}\`.`,
    'Every claim below is backed by the raw response printed under it. The PAT is redacted.',
    '',
    'Read-only: every request in this file is a `GET`.',
    '',
    '---',
  )

  // --- §0 identity --------------------------------------------------------
  log('§0 identity')
  const conn = await call(`${ADO}/_apis/connectionData?api-version=7.1-preview.1`)
  const myId = conn.json?.authenticatedUser?.id
  // T-003's finding: a *public* org answers this anonymously with a well-formed
  // 200, so without this check the whole file could be an inventory of what a
  // stranger can see rather than what the PAT can.
  const anonymous =
    myId === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' ||
    String(conn.json?.authenticatedUser?.descriptor ?? '').startsWith('System:')

  say(
    '## 0 — Identity',
    '',
    `\`GET /_apis/connectionData\` → ${conn.status}; \`authenticatedUser.id\` = \`${myId ?? 'MISSING'}\``,
  )
  if (!myId || anonymous) {
    say(
      '> **Stop.** ADO did not authenticate this PAT as a person, so nothing below',
      '> describes what the app will see. Check the token.',
    )
    await flush()
    process.exit(1)
  }

  // --- §1 is the org-wide route real? -------------------------------------
  //
  // The PR list is genuinely cross-project (a live fact, note under Structural
  // facts) and it is tempting to assume every git route is. The documented
  // route for repositories carries {project} as a path segment, so "drop it and
  // it goes org-wide" is exactly the kind of guess this project pays for later.
  log('§1 org-wide vs per-project')
  const orgWide = await call(`${ADO}/_apis/git/repositories`)
  const projects = await call(`${ADO}/_apis/projects?$top=1000`)
  const projectNames = (projects.json?.value ?? []).map((p) => p.name)

  const perProject = []
  for (const name of projectNames) {
    const r = await call(`${ADO}/${encodeURIComponent(name)}/_apis/git/repositories`)
    perProject.push({ name, status: r.status, count: r.json?.count, value: r.json?.value ?? [], ms: r.ms })
  }

  const orgIds = new Set((orgWide.json?.value ?? []).map((r) => r.id))
  const unionIds = new Set(perProject.flatMap((p) => p.value.map((r) => r.id)))
  const missingFromOrgWide = [...unionIds].filter((id) => !orgIds.has(id))
  const extraInOrgWide = [...orgIds].filter((id) => !unionIds.has(id))

  say(
    '## 1 — Is there an org-wide repository list?',
    '',
    `\`GET /_apis/git/repositories\` (no project segment) → **${orgWide.status}**, ` +
      `\`count\` = ${orgWide.json?.count ?? 'absent'}, \`value.length\` = ${(orgWide.json?.value ?? []).length}.`,
    '',
    `Per-project enumeration over all ${projectNames.length} projects → ` +
      `${unionIds.size} distinct repository ids.`,
    '',
    ...table(
      ['project', 'status', 'count', 'ms'],
      perProject.map((p) => [p.name, String(p.status), String(p.count ?? '—'), String(p.ms)]),
    ),
    '',
    `**In the per-project union but not in the org-wide list:** ${missingFromOrgWide.length}` +
      (missingFromOrgWide.length ? ` — \`${missingFromOrgWide.join('`, `')}\`` : ''),
    `**In the org-wide list but not in any project:** ${extraInOrgWide.length}` +
      (extraInOrgWide.length ? ` — \`${extraInOrgWide.join('`, `')}\`` : ''),
    '',
    `**Answer: ${
      orgWide.status !== 200
        ? `NO — the project segment is mandatory (${orgWide.status}). Phase 9 must fan out over projects.`
        : missingFromOrgWide.length === 0 && extraInOrgWide.length === 0
          ? 'YES — one call covers the org, and it matches per-project enumeration exactly.'
          : 'PARTIAL — the route answers but the two sets differ. See the id lists above.'
    }**`,
    '',
    `Rate: ${rateLine(orgWide)}`,
    '',
    'First row, verbatim and whole — this is the field inventory the row is drawn from:',
    '',
    ...fence((orgWide.json?.value ?? [])[0] ?? orgWide.text, 2500),
  )

  const repos = orgWide.status === 200 ? (orgWide.json?.value ?? []) : [...unionIds].map((id) =>
    perProject.flatMap((p) => p.value).find((r) => r.id === id),
  )

  // --- §2 field census ----------------------------------------------------
  log('§2 field census')
  const fields = census(repos, ['project'])
  const has = (k) => fields.find(([name]) => name === k)?.[1] ?? 0

  // The four the destination promised, checked one at a time rather than as a
  // group, because "three of four" is the answer that changes the design.
  const promised = [
    ['name', 'name'],
    ['project', 'project.name'],
    ['default branch', 'defaultBranch'],
    ['last updated', null],
  ]
  const timestampish = fields.filter(([k]) => /date|time|updated|modified|push/i.test(k))

  say(
    '## 2 — What is actually on a repository row',
    '',
    `Across ${repos.length} repositories:`,
    '',
    ...table(
      ['field', 'present on'],
      fields.map(([k, n]) => [`\`${k}\``, `${n} / ${repos.length}`]),
    ),
    '',
    '### The four fields the destination promised',
    '',
    ...table(
      ['promised column', 'field', 'present on'],
      promised.map(([label, key]) => [
        label,
        key ? `\`${key}\`` : '_nothing found_',
        key ? `${has(key)} / ${repos.length}` : '—',
      ]),
    ),
    '',
    `**Any timestamp-shaped field at all:** ${
      timestampish.length ? timestampish.map(([k, n]) => `\`${k}\` (${n})`).join(', ') : '**none**'
    }`,
    '',
    timestampish.length
      ? '_A timestamp exists. Check below what it actually means before drawing it as "last updated"._'
      : '_**No timestamp of any kind is on this response.** "Last updated" is not a field ' +
        'of a repository in the list; it is a property of the repository\'s most recent push, ' +
        'and §4 prices what fetching it costs._',
    '',
    `**\`defaultBranch\` missing or null on ${repos.length - has('defaultBranch')} of ${repos.length}.**` +
      (repos.length - has('defaultBranch') === 0
        ? ' Every repository in this org has one, so the empty-repository case is **unmeasured ' +
          'here, not disproven** — ADO omits `defaultBranch` on a repository with no commits, ' +
          'and this org happens to contain none. The row still needs a word for it, and the ' +
          'type still has to admit the absence, on the documentation rather than on this evidence.'
        : ' An initialised repository has one and an empty repository does not, so the row needs ' +
          'a word for "no commits yet" rather than a blank.'),
    '',
    ...(repos.length - has('defaultBranch') > 0
      ? [
          'The ones without:',
          '',
          ...fence(
            repos
              .filter((r) => !r?.defaultBranch)
              .map((r) => ({ name: r?.name, project: r?.project?.name, size: r?.size })),
            1200,
          ),
        ]
      : []),
    `**\`isDisabled\` true on ${repos.filter((r) => r?.isDisabled).length}**, ` +
      `**\`isFork\` true on ${repos.filter((r) => r?.isFork).length}**, ` +
      `**\`isInMaintenance\` true on ${repos.filter((r) => r?.isInMaintenance).length}**.`,
  )

  // --- §3 flags and paging ------------------------------------------------
  //
  // Note 12 is the reason the headers are read here: a graph list pages through
  // a *response header* and `AdoClient.get` cannot see one, so "does this route
  // page, and if so how" has to be answered before a page depends on it.
  log('§3 flags and paging')
  const flagRuns = [
    ['baseline', ''],
    ['includeLinks', '?includeLinks=true'],
    ['includeAllUrls', '?includeAllUrls=true'],
    ['includeHidden', '?includeHidden=true'],
    ['all three', '?includeLinks=true&includeAllUrls=true&includeHidden=true'],
    ['$top=5', '?$top=5'],
    ['$top=5&$skip=5', '?$top=5&$skip=5'],
  ]
  const flags = []
  for (const [label, qs] of flagRuns) {
    const r = await call(`${ADO}/_apis/git/repositories${qs}`)
    flags.push({
      label,
      qs: qs || '(none)',
      status: r.status,
      count: (r.json?.value ?? []).length,
      ms: r.ms,
      keys: Object.keys((r.json?.value ?? [])[0] ?? {}).sort().join(' '),
      paging: r.paging,
      bytes: r.text.length,
    })
  }
  const baseline = flags[0]
  const withLinks = flags.find((f) => f.label === 'includeLinks')
  const withUrls = flags.find((f) => f.label === 'includeAllUrls')
  const top5 = flags.find((f) => f.label === '$top=5')
  const skip5 = flags.find((f) => f.label === '$top=5&$skip=5')

  say(
    '## 3 — Flags, paging, and whether `$top` means anything here',
    '',
    ...table(
      ['run', 'query', 'status', 'rows', 'bytes', 'ms', 'paging headers'],
      flags.map((f) => [
        f.label,
        `\`${f.qs}\``,
        String(f.status),
        String(f.count),
        String(f.bytes),
        String(f.ms),
        Object.keys(f.paging).length ? `\`${JSON.stringify(f.paging)}\`` : '_none_',
      ]),
    ),
    '',
    `**\`$top\` ${
      top5?.count === 5
        ? 'is honoured** — 5 rows came back for `$top=5`'
        : `is **ignored** — \`$top=5\` returned ${top5?.count} rows`
    }, and \`$skip=5\` returned ${skip5?.count}.`,
    '',
    `**\`includeLinks\` ${
      withLinks?.keys === baseline?.keys ? 'changed nothing on the row' : 'adds fields'
    }**; **\`includeAllUrls\` ${
      withUrls?.keys === baseline?.keys ? 'changed nothing on the row' : 'adds fields'
    }**.`,
    '',
    'Row keys per run, so a flag that adds a field is visible rather than inferred:',
    '',
    ...fence(Object.fromEntries(flags.map((f) => [f.label, f.keys])), 2000),
    '',
    `**No continuation-token header appeared on any run** ${
      flags.every((f) => !Object.keys(f.paging).length) ? '(confirmed)' : '(see the table — one did)'
    }. ${
      baseline.count === repos.length
        ? `The baseline call returned all ${repos.length} repositories in one response, so paging is ` +
          'not on the critical path at this org size — but that is a fact about this org and not ' +
          'about the route.'
        : 'The baseline call did not return everything, so paging is on the critical path.'
    }`,
  )

  // --- §4 what "last updated" costs ---------------------------------------
  //
  // Only run if §2 found no timestamp. If it did find one this section still
  // runs, because a field called `lastUpdateTime` on a *repository* has never
  // been checked against the repository's actual last push.
  log('§4 pricing "last updated"')
  const sample = repos.filter((r) => r?.defaultBranch).slice(0, 5)
  const priced = []
  for (const r of sample) {
    const project = encodeURIComponent(r.project?.name ?? '')
    const pushes = await call(
      `${ADO}/${project}/_apis/git/repositories/${r.id}/pushes?$top=1`,
    )
    const commits = await call(
      `${ADO}/${project}/_apis/git/repositories/${r.id}/commits?searchCriteria.$top=1`,
    )
    priced.push({
      name: r.name,
      pushStatus: pushes.status,
      pushDate: pushes.json?.value?.[0]?.date ?? null,
      pushBy: pushes.json?.value?.[0]?.pushedBy?.displayName ?? null,
      pushMs: pushes.ms,
      pushCost: pushes.rate['x-ratelimit-cost'] ?? null,
      commitStatus: commits.status,
      commitDate:
        commits.json?.value?.[0]?.committer?.date ?? commits.json?.value?.[0]?.author?.date ?? null,
      commitMs: commits.ms,
    })
  }

  const meanPushMs = priced.length
    ? Math.round(priced.reduce((a, p) => a + p.pushMs, 0) / priced.length)
    : null
  const serialSeconds = meanPushMs ? Math.round((meanPushMs * repos.length) / 100) / 10 : null

  say(
    '## 4 — What "last updated" costs',
    '',
    'Two candidate sources, one repository per row, measured on the first five ' +
      'repositories that have a default branch:',
    '',
    ...table(
      ['repository', 'pushes → status', 'pushes date', 'pushed by', 'ms', 'commits → status', 'commits date', 'ms'],
      priced.map((p) => [
        p.name,
        String(p.pushStatus),
        p.pushDate ?? '_absent_',
        p.pushBy ?? '—',
        String(p.pushMs),
        String(p.commitStatus),
        p.commitDate ?? '_absent_',
        String(p.commitMs),
      ]),
    ),
    '',
    `**This is 1+N, and N is ${repos.length}.** At ${meanPushMs ?? '?'} ms a call that is ` +
      `roughly ${serialSeconds ?? '?'} s of serial latency for one column, against a rate ` +
      'budget the inbox is already spending. Decide the column, not the call: either the list ' +
      'ships without "last updated", or the column hydrates lazily the way inbox rows do, ' +
      'or it is dropped from the destination. **Do not fan out eagerly on a list page.**',
  )

  // --- §5 the clone URLs, and the join phase 9 owes phase 2 ---------------
  //
  // The map says the two repository lists converge "on the origin URL: a clone
  // whose remote matches an ADO repository is that repository". That sentence is
  // a promise about string equality between a field nobody has printed and a
  // value nobody has read. Print both.
  log('§5 clone URLs vs local origins')
  const urlShapes = repos.slice(0, 3).map((r) => ({
    name: r?.name,
    remoteUrl: r?.remoteUrl,
    sshUrl: r?.sshUrl,
    webUrl: r?.webUrl,
    url: r?.url,
  }))

  let locals = []
  let localsError = null
  try {
    const entries = await readdir(REPOS_ROOT, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(REPOS_ROOT, e.name)
      try {
        // --no-optional-locks on every invocation (note 18), even a config read:
        // it is a construction rule precisely so nobody has to decide per call.
        const { stdout } = await run(
          'git',
          ['--no-optional-locks', '-C', dir, 'remote', 'get-url', '--end-of-options', 'origin'],
          { windowsHide: true },
        )
        locals.push({ slug: e.name, origin: stdout.trim() })
      } catch (err) {
        locals.push({ slug: e.name, origin: null, why: (err.stderr ?? String(err)).trim() })
      }
    }
  } catch (err) {
    localsError = String(err)
  }

  // The comparison the map's sentence needs: does an origin ever equal remoteUrl
  // verbatim, and if not, what exactly differs?
  const byRemote = new Map(repos.filter((r) => r?.remoteUrl).map((r) => [r.remoteUrl, r]))

  // First attempt: the obvious cosmetic differences.
  const normalise = (u) =>
    String(u ?? '')
      .replace(/\.git$/, '')
      .replace(/^https:\/\/[^@/]+@/, 'https://')
      .toLowerCase()

  /**
   * Second attempt, after the first one joined almost nothing. Reduce both sides
   * to the triple that actually identifies a repository — org, project, name —
   * because the *host* is not part of that identity: a clone made before the
   * dev.azure.com migration still says `{org}.visualstudio.com`, and ADO will
   * never report that spelling back. Anything not matching either shape returns
   * null rather than a partial key, so a shape nobody anticipated shows up as
   * "no match" instead of joining the wrong repository.
   */
  const identity = (u) => {
    const s = String(u ?? '').replace(/\.git$/, '')
    let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(s)
    if (m) return `${m[1]}/${m[2]}/${m[3]}`.toLowerCase()
    m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i.exec(s)
    if (m) return `${m[1]}/${m[2]}/${m[3]}`.toLowerCase()
    m = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(s)
    if (m) return `${m[1]}/${m[2]}/${m[3]}`.toLowerCase()
    return null
  }

  const byNormalised = new Map(
    repos.filter((r) => r?.remoteUrl).map((r) => [normalise(r.remoteUrl), r]),
  )
  const byIdentity = new Map(
    repos.filter((r) => identity(r?.remoteUrl)).map((r) => [identity(r.remoteUrl), r]),
  )

  const joined = locals.map((l) => ({
    ...l,
    exact: l.origin ? (byRemote.get(l.origin)?.name ?? null) : null,
    normalised: l.origin ? (byNormalised.get(normalise(l.origin))?.name ?? null) : null,
    ident: l.origin ? identity(l.origin) : null,
    aliased: l.origin ? (byIdentity.get(identity(l.origin))?.name ?? null) : null,
  }))
  const exactHits = joined.filter((j) => j.exact).length
  const normHits = joined.filter((j) => j.normalised).length
  const aliasHits = joined.filter((j) => j.aliased).length
  const withOrigin = joined.filter((j) => j.origin).length
  const noOrigin = joined.filter((j) => !j.origin).length
  const unparsed = joined.filter((j) => j.origin && !j.ident)

  say(
    '## 5 — Clone URLs, and the join this list owes the local one',
    '',
    'Three repositories\' URL fields verbatim:',
    '',
    ...fence(urlShapes, 2000),
    '',
    localsError
      ? `_Local repositories under \`${REPOS_ROOT}\` were not readable: ${localsError}_`
      : `\`${REPOS_ROOT}\` holds ${locals.length} directories; ${noOrigin} have no \`origin\` remote.`,
    '',
    ...(localsError
      ? []
      : [
          ...table(
            ['local slug', 'origin', 'exact', 'cosmetic', 'org/project/name', 'aliased'],
            joined.map((j) => [
              `\`${j.slug}\``,
              j.origin ? `\`${j.origin}\`` : `_none — ${j.why?.split('\n')[0] ?? 'no remote'}_`,
              j.exact ? '✓' : '—',
              j.normalised ? '✓' : '—',
              j.ident ? `\`${j.ident}\`` : '_unparsed_',
              j.aliased ? `\`${j.aliased}\`` : '—',
            ]),
          ),
          '',
          `Of ${locals.length} directories, ${withOrigin} have an \`origin\`. Against those ${withOrigin}:`,
          '',
          ...table(
            ['join rule', 'matched'],
            [
              ['exact string equality with `remoteUrl`', `**${exactHits} / ${withOrigin}**`],
              ['cosmetic (drop `.git`, strip `user@`, lowercase)', `**${normHits} / ${withOrigin}**`],
              ['org/project/name, host aliased', `**${aliasHits} / ${withOrigin}**`],
            ],
          ),
          '',
          '**The map says the two lists "converge … on the `origin` URL: a clone whose remote ' +
            'matches an ADO repository is that repository." On this disk, `matches` cannot mean ' +
            'string equality.** ' +
            `Exact equality joined ${exactHits} of ${withOrigin}; cosmetic normalisation added ` +
            `${normHits - exactHits}; aliasing the host joined ${aliasHits}.`,
          '',
          'The reason is one substitution, and it is not cosmetic: a clone taken before the ' +
            '`dev.azure.com` migration still says `{org}.visualstudio.com/{project}/_git/{name}`, ' +
            'and **ADO never reports that spelling back** — `remoteUrl` is always the ' +
            '`dev.azure.com` form. The host is therefore not part of a repository\'s identity; ' +
            'the triple org/project/name is. A join written on the URL as a string would report ' +
            (withOrigin - exactHits > 0 ? `${withOrigin - exactHits} of these ${withOrigin} clones ` : 'most clones ') +
            'as unrelated to the organisation they were cloned from — silently, and looking ' +
            'exactly like a correct empty answer.',
          '',
          unparsed.length
            ? `**${unparsed.length} origin(s) matched none of the three URL shapes** and would need ` +
              `a fourth rule or an honest "cannot tell": ${unparsed.map((j) => `\`${j.origin}\``).join(', ')}.`
            : '_Every `origin` on this disk parsed into an org/project/name triple._ That is ' +
              'this disk, not a guarantee: a fork, a mirror, a `file://` remote or a non-ADO ' +
              'origin all reach that code, and the parse returning `null` has to mean "cannot ' +
              'tell" rather than "no match".',
        ]),
    '',
    '**This section is evidence, not a licence to build the join.** The destination puts the ' +
      'join after both lists exist; what it buys here is knowing the join is possible and ' +
      'what it will cost when somebody writes it.',
  )

  // --- §6 the price of the page -------------------------------------------
  say(
    '## 6 — What the page costs',
    '',
    ...table(
      ['call', 'ms', 'bytes', 'rate headers'],
      [
        ['`GET /_apis/git/repositories`', String(orgWide.ms), String(orgWide.text.length), rateLine(orgWide)],
        ['`GET /_apis/projects`', String(projects.ms), String(projects.text.length), rateLine(projects)],
      ],
    ),
    '',
    'Note the standing caveat from T-001: ADO emits `X-RateLimit-*` only near the limit, so ' +
      'an empty rate column is a *could not measure* and not a *cost nothing*.',
  )

  await flush()
}

async function flush() {
  await mkdir('docs/research', { recursive: true })
  await writeFile(OUT, report.join('\n'), 'utf8')
  log(`\nWrote ${OUT}`)
}

await main()
