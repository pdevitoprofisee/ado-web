// Throwaway spike for T-001. Not application code — do not import from it.
//
// Answers the six "unknowns that need a real credential" from docs/map.md and
// prices the inbox fan-out, then writes docs/research/live-inventory.md with the
// raw responses that prove each answer.
//
//   ADO_ORG=myorg ADO_PAT=... SONAR_TOKEN=... node scripts/live-inventory.mjs
//
// …or, once T-003's onboarding page has been used, just:
//
//   node scripts/live-inventory.mjs
//
// Optional: ADO_PR_ID (skip auto-selection), SONAR_ORG (skip discovery),
//           --allow-writes (permit the two mutating probes in §4).

import { writeFile, mkdir } from 'node:fs/promises'

const ALLOW_WRITES = process.argv.includes('--allow-writes')

/**
 * Environment first, then the OS credential store T-003 writes to.
 *
 * The store is the better source and not only for convenience: the documented
 * env-var invocation puts a PAT in a shell history and in the process table,
 * and that is a worse place for it than the Credential Manager. The import is
 * dynamic and guarded so the env-var path keeps working on a machine where the
 * native addon can't load.
 */
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
  console.error(
    'No ADO credential. Either set ADO_ORG and ADO_PAT, or store one at /onboarding.',
  )
  process.exit(1)
}
if (source) console.log(`Using credentials from the ${source}.`)

const ADO = `https://dev.azure.com/${ORG}`
const SONAR = 'https://sonarcloud.io'
const OUT = 'docs/research/live-inventory.md'

const secrets = [PAT, SONAR_TOKEN].filter(Boolean)
const redact = (s) =>
  secrets.reduce((acc, t) => acc.split(t).join('«redacted»'), String(s ?? ''))

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

/** Every ADO/Sonar call goes through here so nothing escapes the rate-limit accounting. */
async function call(url, { auth = 'ado', method = 'GET', body, headers = {} } = {}) {
  // Pin the api-version on every ADO call. Omitting it takes whatever default
  // the service picks, and T-003 learned the hard way that a version mistake is
  // invisible until a request actually authenticates — ADO checks the
  // credential first and 401s before it ever looks at the version.
  if (url.startsWith(ADO) && !url.includes('api-version=')) {
    url += `${url.includes('?') ? '&' : '?'}api-version=7.1`
  }
  const h = { Accept: 'application/json', ...headers }
  // Suppress goes on *every* ADO call including the unauthenticated ones: note 4
  // applies hardest there. Without it the anonymous route-existence probe in §4
  // measures a 302 to the sign-in page instead of the 401-vs-404 it is asking about.
  if (url.startsWith(ADO)) h['X-TFS-FedAuthRedirect'] = 'Suppress'
  if (auth === 'ado') {
    h.Authorization = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`
  } else if (auth === 'sonar') {
    h.Authorization = `Bearer ${SONAR_TOKEN}`
  }
  if (body !== undefined) h['Content-Type'] = 'application/json'

  const started = Date.now()
  let res
  try {
    res = await fetch(url, {
      method,
      headers: h,
      redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    return { url, method, error: String(err), ms: Date.now() - started }
  }
  const ms = Date.now() - started
  const text = await res.text()

  const rate = {}
  for (const k of RATE_HEADERS) if (res.headers.has(k)) rate[k] = res.headers.get(k)

  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* not json — keep text */
  }

  const out = { url, method, status: res.status, ms, rate, text, json }
  if (res.status === 200 && rate['retry-after']) {
    out.throttled = true
    log(`  !! 200 with Retry-After: ${rate['retry-after']} — this is throttling (note 2)`)
  }
  log(`  ${method} ${url.replace(ADO, '').replace(SONAR, '')} → ${res.status} (${ms}ms)`)
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

const verdict = (n, title, answer, detail) =>
  say(`## Unknown ${n} — ${title}`, '', `**Answer: ${answer}**`, '', ...(detail ? [detail] : []))

// ---------------------------------------------------------------------------

async function main() {
  say(
    '# Live API inventory — T-001',
    '',
    `Generated by \`scripts/live-inventory.mjs\` against org \`${ORG}\`.`,
    'Every claim below is backed by the raw response printed under it. Secrets are redacted.',
    '',
    '---',
  )

  // --- identity -----------------------------------------------------------
  log('§0 identity')
  // `-preview.1` because connectionData is a preview-only resource; plain 7.1
  // is a 400 (T-003 resolution).
  const conn = await call(`${ADO}/_apis/connectionData?api-version=7.1-preview.1`)
  const myId = conn.json?.authenticatedUser?.id
  // A public organization answers this anonymously with a well-formed body, so
  // an ignored PAT would otherwise sail through and the whole run would be an
  // inventory of what an anonymous visitor can see.
  const anonymous =
    myId === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' ||
    String(conn.json?.authenticatedUser?.descriptor ?? '').startsWith('System:')
  say(
    '## 0 — Identity',
    '',
    `\`GET /_apis/connectionData\` → ${conn.status}; \`authenticatedUser.id\` = \`${myId ?? 'MISSING'}\``,
    '',
    ...fence(
      {
        authenticatedUser: {
          id: conn.json?.authenticatedUser?.id,
          providerDisplayName: conn.json?.authenticatedUser?.providerDisplayName,
          subjectDescriptor: conn.json?.authenticatedUser?.subjectDescriptor,
        },
      },
      1200,
    ),
  )
  if (!myId || anonymous) {
    say(
      anonymous
        ? '> **Stop.** ADO answered as the *anonymous* identity — this organization allows public access, so the run would inventory what a stranger can see, not what the PAT can. Check the token.'
        : '> **Stop.** Without an identity GUID the rest of the run is meaningless — check the PAT.',
    )
    process.exitCode = 1
    return
  }

  // --- unknown 1: org-wide cross-project PR listing ------------------------
  log('§1 org-wide PR listing')
  const orgWide = await call(`${ADO}/_apis/git/pullrequests?searchCriteria.status=active&$top=500`)
  const orgPrs = orgWide.json?.value ?? []
  const orgProjects = [...new Set(orgPrs.map((p) => p.repository?.project?.name).filter(Boolean))]

  const projects = await call(`${ADO}/_apis/projects?$top=500`)
  const projectNames = (projects.json?.value ?? []).map((p) => p.name)

  const perProject = []
  for (const name of projectNames) {
    const r = await call(
      `${ADO}/${encodeURIComponent(name)}/_apis/git/pullrequests?searchCriteria.status=active&$top=500`,
    )
    perProject.push({ project: name, status: r.status, count: r.json?.value?.length ?? 0 })
  }
  const perProjectTotal = perProject.reduce((a, p) => a + p.count, 0)
  const crossProject = orgWide.status === 200 && orgProjects.length > 1

  verdict(
    1,
    'Does org-wide `/{org}/_apis/git/pullrequests` return cross-project results?',
    orgWide.status !== 200
      ? `NO — the route returned ${orgWide.status}`
      : crossProject
        ? 'YES'
        : orgProjects.length === 1 && projectNames.length > 1
          ? 'NO — single project only'
          : 'INCONCLUSIVE — the org has fewer than two projects with active PRs',
    [
      `Org-wide call returned **${orgPrs.length}** active PRs spanning **${orgProjects.length}** project(s): ${orgProjects.map((p) => `\`${p}\``).join(', ') || '—'}.`,
      '',
      `Per-project enumeration over ${projectNames.length} project(s) totalled **${perProjectTotal}** active PRs.`,
      orgPrs.length === perProjectTotal
        ? '**The two totals match — the org-wide route is complete and the per-project fan-out can be deleted.**'
        : '⚠️ **Totals differ — the org-wide route is NOT a drop-in replacement.** Reconcile before trusting it.',
      '',
      '| Project | status | active PRs |',
      '|---|---|---|',
      ...perProject.map((p) => `| ${p.project} | ${p.status} | ${p.count} |`),
      '',
      `Rate headers on the org-wide call: ${rateLine(orgWide)}`,
      '',
      'First org-wide result (shape evidence):',
      '',
      ...fence(orgPrs[0] ?? orgWide.text, 3000),
    ].join('\n'),
  )

  // --- unknown 6: max $top -------------------------------------------------
  log('§6 max $top')
  const topProbes = []
  for (const top of [100, 500, 1000, 2000, 5000]) {
    const r = await call(
      `${ADO}/_apis/git/pullrequests?searchCriteria.status=all&$top=${top}`,
    )
    topProbes.push({ top, status: r.status, count: r.json?.value?.length ?? 0, note: r.json?.message ?? '' })
  }
  const ceiling = Math.max(0, ...topProbes.filter((p) => p.status === 200).map((p) => p.count))

  // A count below the requested `$top` is NOT evidence of the end of the list —
  // this endpoint filters after applying `$top`. The only way to tell a ceiling
  // from a total is to skip past it and see whether more arrives.
  const beyond = await call(
    `${ADO}/_apis/git/pullrequests?searchCriteria.status=all&$top=1000&$skip=1000`,
  )
  const moreExists = (beyond.json?.value?.length ?? 0) > 0
  const short = topProbes.filter((p) => p.status === 200 && p.count < p.top)

  verdict(
    6,
    'What is the undocumented max `$top` on the PR list?',
    topProbes.every((p) => p.status !== 200)
      ? 'FAILED — no probe returned 200'
      : moreExists
        ? `\`$top\` clamps at 1000 (${ceiling} rows returned), and a short page is NOT the last page`
        : `INCONCLUSIVE — the org holds only ${ceiling} PRs, fewer than the clamp`,
    [
      '| requested `$top` | status | returned |',
      '|---|---|---|',
      ...topProbes.map((p) => `| ${p.top} | ${p.status} | ${p.count} ${p.note ? `— ${redact(p.note)}` : ''} |`),
      `| 1000 (\`$skip=1000\`) | ${beyond.status} | ${beyond.json?.value?.length ?? 0} |`,
      '',
      moreExists
        ? [
            `Requests above 1000 return the same ${ceiling} rows, so **1000 is the clamp**.`,
            short.length
              ? `But ${short.map((p) => `\`$top=${p.top}\`→${p.count}`).join(', ')} came back *short while more existed* — \`$skip=1000\` still yielded ${beyond.json?.value?.length} more. The service filters after applying \`$top\`.`
              : '',
            '',
            '**Page until a page comes back empty — never until it comes back short.**',
            'Advance `$skip` by the *requested* `$top` and dedupe by `pullRequestId`:',
            'whether `$skip` is applied before or after the filter is unresolved.',
          ].join('\n')
        : 'This org is too small to prove a ceiling. Page until an *empty* page regardless — a short page is not a reliable terminator on this endpoint.',
    ].join('\n'),
  )

  // --- pick a PR -----------------------------------------------------------
  log('§ picking a PR')
  const candidates = orgPrs.length ? orgPrs : []
  let target = null
  let statuses = null

  const explicit = process.env.ADO_PR_ID
  const ordered = explicit
    ? [{ pullRequestId: Number(explicit) }, ...candidates]
    : candidates

  for (const c of ordered.slice(0, 15)) {
    const full = c.repository
      ? c
      : (await call(`${ADO}/_apis/git/pullrequests/${c.pullRequestId}`)).json
    if (!full?.repository) continue
    const { project, id: repoId } = { project: full.repository.project?.name, id: full.repository.id }
    const st = await call(
      `${ADO}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${full.pullRequestId}/statuses?api-version=7.1`,
    )
    const hasSonar = (st.json?.value ?? []).some((s) =>
      /sonar/i.test(`${s.context?.genre} ${s.context?.name} ${s.targetUrl}`),
    )
    if (hasSonar || (!target && (st.json?.value ?? []).length)) {
      target = { pr: full, project, repoId }
      statuses = st
    }
    if (hasSonar) break
  }

  if (!target) {
    say(
      '## Unknowns 3, 4, 5 — NOT RUN',
      '',
      'No PR with statuses was found in the first 15 active PRs. Re-run with `ADO_PR_ID=<id>` pointing at a PR that has a Sonar analysis.',
    )
  } else {
    const { pr, project, repoId } = target
    const prBase = `${ADO}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${pr.pullRequestId}`
    say(
      '## Sample PR used for unknowns 3–5 and the fan-out pricing',
      '',
      `\`${project}\` · PR **!${pr.pullRequestId}** — ${redact(pr.title ?? '')}`,
      `Repository \`${repoId}\`, head commit \`${pr.lastMergeSourceCommit?.commitId ?? '?'}\`.`,
    )

    // --- unknown 3: statuses / Sonar genre+name ---------------------------
    log('§3 statuses')
    const all = statuses.json?.value ?? []
    const sonarStatuses = all.filter((s) =>
      /sonar/i.test(`${s.context?.genre} ${s.context?.name} ${s.targetUrl}`),
    )
    verdict(
      3,
      'One live `statuses` response, to confirm the Sonar `genre` / `name` split',
      sonarStatuses.length
        ? `CONFIRMED — genre \`${sonarStatuses[0].context?.genre}\`, name \`${sonarStatuses[0].context?.name}\``
        : 'NO SONAR STATUS on this PR',
      [
        `\`GET .../statuses\` → ${statuses.status}, ${all.length} status(es).`,
        '',
        'Distinct contexts:',
        '',
        '| genre | name | state | targetUrl |',
        '|---|---|---|---|',
        ...all.map(
          (s) =>
            `| \`${s.context?.genre ?? ''}\` | \`${s.context?.name ?? ''}\` | ${s.state} | ${redact(s.targetUrl ?? '')} |`,
        ),
        '',
        'Raw:',
        '',
        ...fence(all, 5000),
      ].join('\n'),
    )

    // Sonar project key + createdBy, per the map's zero-config mapping.
    const sonarStatus = sonarStatuses[0]
    let sonarProjectKey = null
    if (sonarStatus?.targetUrl) {
      try {
        sonarProjectKey = new URL(sonarStatus.targetUrl).searchParams.get('id')
      } catch {
        /* leave null */
      }
    }
    say(
      `Sonar author id (for thread attribution): \`${sonarStatus?.createdBy?.id ?? 'n/a'}\``,
      `Sonar projectKey recovered from \`targetUrl?id=\`: \`${sonarProjectKey ?? 'n/a'}\``,
    )

    // --- fan-out pricing --------------------------------------------------
    log('§ pricing the fan-out')
    const threads = await call(`${prBase}/threads?api-version=7.1`)
    say(
      '## Fan-out pricing (for the inbox concurrency cap)',
      '',
      '| call | status | ms | rate headers |',
      '|---|---|---|---|',
      `| PR list (org-wide, \`$top=500\`) | ${orgWide.status} | ${orgWide.ms} | ${rateLine(orgWide)} |`,
      `| per-PR \`statuses\` | ${statuses.status} | ${statuses.ms} | ${rateLine(statuses)} |`,
      `| per-PR \`threads\` | ${threads.status} | ${threads.ms} | ${rateLine(threads)} |`,
      '',
      'TSTU budget is 200 per sliding 5-minute window. Divide by the per-PR cost above',
      '(`statuses` + `threads`) to get the sustainable inbox size, then set T-004\'s',
      'concurrency cap from that number rather than from feel.',
      Object.keys(orgWide.rate).length
        ? ''
        : '⚠️ No `X-RateLimit-*` headers came back at all — ADO only emits them once you are near the limit. Re-run under load to price this properly.',
    )

    // --- unknown 4: comment likes write endpoint ---------------------------
    log('§4 comment likes')
    const firstThread = (threads.json?.value ?? []).find((t) => t.comments?.some((c) => c.id))
    const firstComment = firstThread?.comments?.find((c) => c.id)
    const likesUrl =
      firstThread && firstComment
        ? `${prBase}/threads/${firstThread.id}/comments/${firstComment.id}/likes?api-version=7.1`
        : null

    if (!likesUrl) {
      verdict(4, 'Does ADO expose a comment-*likes* write endpoint?', 'NOT RUN — no comment found on the sample PR', null)
    } else {
      // Route-existence discriminator: ADO routes before it authenticates, so a
      // missing controller 404s even unauthenticated while a real route 401s.
      const anon = await call(likesUrl, { auth: 'none' })
      const authed = await call(likesUrl)
      const routeExists = anon.status !== 404
      const probes = [
        `| unauthenticated GET | ${anon.status} | ${redact(anon.text.slice(0, 200))} |`,
        `| authenticated GET | ${authed.status} | ${redact(authed.text.slice(0, 200))} |`,
      ]

      let writeResult = 'not attempted (re-run with `--allow-writes` to exercise it)'
      if (ALLOW_WRITES) {
        const put = await call(likesUrl, { method: 'PUT' })
        const del = await call(likesUrl, { method: 'DELETE' })
        probes.push(
          `| authenticated PUT | ${put.status} | ${redact(put.text.slice(0, 200))} |`,
          `| authenticated DELETE | ${del.status} | ${redact(del.text.slice(0, 200))} |`,
        )
        writeResult =
          put.status < 300 ? 'PUT succeeded — likes are writable' : `PUT returned ${put.status}`
      }

      verdict(
        4,
        'Does ADO expose a comment-*likes* write endpoint?',
        routeExists ? `ROUTE EXISTS — ${writeResult}` : 'NO — route not found (likes are read-only)',
        [
          `Probed \`.../threads/${firstThread.id}/comments/${firstComment.id}/likes\`.`,
          'A 404 carrying "controller for path not found" means the route does not exist;',
          'a 401/403/405 means it does.',
          '',
          '| probe | status | body |',
          '|---|---|---|',
          ...probes,
          '',
          routeExists
            ? ''
            : 'Likes are read-only. `usersLiked` still renders; the UI simply offers no toggle.',
        ].join('\n'),
      )
    }

    // --- unknown 5: Sonar line drift ---------------------------------------
    log('§5 sonar line drift')
    if (!SONAR_TOKEN || !sonarProjectKey) {
      verdict(5, 'Sonar line drift on a PR pushed to after analysis', 'NOT RUN — needs SONAR_TOKEN and a Sonar-analysed PR', null)
    } else {
      const iterations = await call(`${prBase}/iterations?api-version=7.1`)
      const last = (iterations.json?.value ?? []).at(-1)
      const lastPush = last?.push?.date ?? last?.createdDate ?? null

      const prList = await call(
        `${SONAR}/api/project_pull_requests/list?project=${encodeURIComponent(sonarProjectKey)}`,
        { auth: 'sonar' },
      )
      const sonarPr = (prList.json?.pullRequests ?? []).find(
        (p) => String(p.key) === String(pr.pullRequestId),
      )
      const analysisDate = sonarPr?.analysisDate ?? null

      const issues = await call(
        `${SONAR}/api/issues/search?componentKeys=${encodeURIComponent(sonarProjectKey)}&pullRequest=${pr.pullRequestId}&ps=500`,
        { auth: 'sonar' },
      )
      const sonarIssues = issues.json?.issues ?? []

      // Map changed paths → head blob sha so we can count lines in the file Sonar flagged.
      const changes = last
        ? await call(`${prBase}/iterations/${last.id}/changes?$top=2000&api-version=7.1`)
        : null
      const byPath = new Map(
        (changes?.json?.changeEntries ?? [])
          .filter((c) => c.item?.path && c.item?.objectId)
          .map((c) => [c.item.path.replace(/^\//, ''), c.item.objectId]),
      )

      const drift = []
      for (const issue of sonarIssues.filter((i) => i.line)) {
        const path = String(issue.component).split(':').slice(1).join(':')
        const sha = byPath.get(path)
        if (!sha) {
          drift.push({ issue: issue.key, path, line: issue.line, result: 'file not in this iteration' })
          continue
        }
        const blob = await call(
          `${ADO}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/blobs/${sha}?$format=text&api-version=7.1`,
          { headers: { Accept: 'text/plain' } },
        )
        const lines = blob.text.split('\n').length
        drift.push({
          issue: issue.key,
          path,
          line: issue.line,
          result: issue.line > lines ? `⚠️ past EOF (file has ${lines} lines)` : `in range (${lines} lines)`,
        })
        if (drift.length >= 25) break
      }

      const stale = analysisDate && lastPush && new Date(analysisDate) < new Date(lastPush)
      const outOfRange = drift.filter((d) => d.result.startsWith('⚠️'))

      verdict(
        5,
        'Sonar line drift on a PR pushed to after analysis',
        stale
          ? `ANALYSIS IS STALE — ${outOfRange.length} of ${drift.length} checked issues point past EOF`
          : 'analysis is current for this PR — drift not reproduced here',
        [
          `Last ADO iteration pushed: \`${lastPush ?? 'unknown'}\``,
          `Sonar \`analysisDate\`: \`${analysisDate ?? 'unknown'}\``,
          '',
          '| issue | file | sonar line | check |',
          '|---|---|---|---|',
          ...drift.map((d) => `| ${d.issue} | \`${d.path}\` | ${d.line} | ${d.result} |`),
          '',
          '**Either way, anchor defensively** — Sonar line numbers are advisory, not a guarantee that the line exists.',
        ].join('\n'),
      )
    }

    // --- unknown 2: Sonar rule descriptions --------------------------------
    log('§2 sonar rule descriptions')
    if (!SONAR_TOKEN) {
      verdict(2, 'Does SonarCloud serve rule descriptions to an authenticated user?', 'NOT RUN — needs SONAR_TOKEN', null)
    } else {
      let sonarOrg = process.env.SONAR_ORG
      if (!sonarOrg && sonarProjectKey) {
        const comp = await call(
          `${SONAR}/api/components/show?component=${encodeURIComponent(sonarProjectKey)}`,
          { auth: 'sonar' },
        )
        sonarOrg = comp.json?.component?.organization
      }

      const ruleKeys = ['java:S1541', 'javascript:S1854', 'csharpsquid:S1118']
      const rows = []
      let anyDesc = false
      for (const key of ruleKeys) {
        const r = await call(
          `${SONAR}/api/rules/show?key=${encodeURIComponent(key)}${sonarOrg ? `&organization=${encodeURIComponent(sonarOrg)}` : ''}`,
          { auth: 'sonar' },
        )
        const rule = r.json?.rule
        const has = {
          htmlDesc: Boolean(rule?.htmlDesc),
          mdDesc: Boolean(rule?.mdDesc),
          sections: (rule?.descriptionSections ?? []).length,
        }
        if (has.htmlDesc || has.mdDesc || has.sections) anyDesc = true
        rows.push(
          `| \`${key}\` | ${r.status} | ${r.text.length} | ${has.htmlDesc} | ${has.mdDesc} | ${has.sections} | \`${(rule?.requiredEntitlements ?? []).join(',') || '—'}\` |`,
        )
      }

      const search = await call(
        // `rule_keys`, plural. The singular form does not error — it returns
        // `total: 0`, so the wrong name reads as "no such rules".
        `${SONAR}/api/rules/search?rule_keys=${encodeURIComponent(ruleKeys.join(','))}${sonarOrg ? `&organization=${encodeURIComponent(sonarOrg)}` : ''}&f=name,htmlDesc,descriptionSections&ps=10`,
        { auth: 'sonar' },
      )
      const searchHasDesc = (search.json?.rules ?? []).some(
        (r) => r.htmlDesc || (r.descriptionSections ?? []).length,
      )

      verdict(
        2,
        'Does SonarCloud serve rule descriptions to an authenticated user?',
        anyDesc || searchHasDesc
          ? 'YES — descriptions come back with a token. Render rule detail in-app.'
          : 'NO — still withheld with a token. **Fall back to https://rules.sonarsource.com/<lang>/RSPEC-<n>/.**',
        [
          `Organization used: \`${sonarOrg ?? 'none — SonarCloud requires this, so a miss here invalidates the result'}\``,
          '',
          '| rule | status | bytes | htmlDesc | mdDesc | sections | requiredEntitlements |',
          '|---|---|---|---|---|---|---|',
          ...rows,
          '',
          `Batched \`rules/search\` with \`f=htmlDesc,descriptionSections\` returned descriptions: **${searchHasDesc}** — this is the call the app would actually use (one request warms every rule in a PR).`,
          '',
          'Baseline: the same `rules/show` unauthenticated returned 1101 bytes with no description at all',
          '(captured during charting; see the "unauthenticated" row in docs/research/sonarcloud-api.md §5).',
          '',
          'Raw `rules/search`:',
          '',
          ...fence(search.json ?? search.text, 4000),
        ].join('\n'),
      )
    }
  }

  say(
    '---',
    '',
    '## Throttling watch',
    '',
    'Note 2 says throttling arrives as a slow HTTP 200 carrying `Retry-After`, not a 429.',
    'Any call in this run that hit that path is flagged `!!` in the console output above.',
  )
}

try {
  await main()
} catch (err) {
  say('---', '', '## Run aborted', '', '```', redact(err?.stack ?? err), '```')
  process.exitCode = 1
} finally {
  await mkdir('docs/research', { recursive: true })
  await writeFile(OUT, `${report.join('\n')}\n`, 'utf8')
  log(`\nWrote ${OUT}`)
}
