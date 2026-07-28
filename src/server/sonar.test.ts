// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SonarError, createSonarClient, loadSonarProjects, loadSonarReport, sonarProjects } from './sonar'
import { SONAR_BACKOFF_MS } from '../lib/sonar-contract'

import type { AdoClient, QueryValue } from './ado-client'
import type { PullRequestRef } from './pull-request'
import type { AdoStatus, SonarClient } from './sonar'
import type { SonarProjectRef } from '../lib/sonar-contract'

// Fixtures are the shapes §4 and §7–§11 of the inventory recorded verbatim,
// trimmed to the fields this module reads and given fabricated values. Nothing
// here touches the network: the report tests drive a fake `SonarClient`, and the
// three client tests stub `fetch`.

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24809 }

const TOKEN = 's'.repeat(40)
const CREDENTIAL = { token: TOKEN }

const MATCHING: SonarProjectRef = {
  projectKey: 'profisee_matching',
  pullRequest: '24809',
  dashboardUrl: 'https://sonarcloud.io/dashboard?id=profisee_matching&pullRequest=24809',
}
const REST_API: SonarProjectRef = {
  projectKey: 'profisee_rest-api',
  pullRequest: '24809',
  dashboardUrl: 'https://sonarcloud.io/dashboard?id=profisee_rest-api&pullRequest=24809',
}

/** A SonarCloud status as ADO posts it — `context.genre` is the only reliable half. */
const sonarStatus = (projectKey: string, pullRequest = '24809'): AdoStatus => ({
  context: { name: `quality_gate_${projectKey}`, genre: 'SonarCloud' },
  targetUrl: `https://sonarcloud.io/dashboard?id=${projectKey}&pullRequest=${pullRequest}`,
})

const BUILD_STATUS: AdoStatus = {
  context: { name: 'profisee.platform', genre: 'continuous-integration' },
  targetUrl: 'https://dev.azure.com/Profisee/_build/results?buildId=987654',
}

/** The open issue of §10, minus `severity`/`type`/`status`, which nothing reads. */
const openIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'AZ-pXh-nP-U4fPfm1RSA',
  rule: 'csharpsquid:S107',
  component: 'profisee_matching:Services.Matching.Infrastructure/Stats/StatTrakReader.cs',
  project: 'profisee_matching',
  organization: 'profisee',
  line: 233,
  textRange: { startLine: 233, endLine: 235, startOffset: 55, endOffset: 94 },
  issueStatus: 'OPEN',
  message: 'Method has 8 parameters, which is greater than the 7 authorized.',
  effort: '20min',
  tags: ['brain-overload'],
  cleanCodeAttributeCategory: 'ADAPTABLE',
  impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'MEDIUM' }],
  ...over,
})

/**
 * The fixed issue of §7, and the point of it is what is *missing*: no `line`.
 * All three sampled fixed issues were like this.
 */
const FIXED_ISSUE: Record<string, unknown> = {
  key: 'AZ-lkpJ-C4SILGvTgy7A',
  rule: 'csharpsquid:S2583',
  component: 'profisee_rest-api:Gateway.Api/Services/Portal/AccountsService.cs',
  project: 'profisee_rest-api',
  organization: 'profisee',
  textRange: { startLine: 156, endLine: 156, startOffset: 16, endOffset: 47 },
  issueStatus: 'FIXED',
  message: 'Change this condition so that it does not always evaluate to True.',
  effort: '10min',
  tags: [],
  cleanCodeAttributeCategory: 'LOGICAL',
  impacts: [{ softwareQuality: 'RELIABILITY', severity: 'MEDIUM' }],
}

/** §8's block: the project carries no `path`, each file carries its own. */
const componentBlock = (projectKey: string, ...paths: readonly string[]) => [
  { key: projectKey, qualifier: 'TRK', name: projectKey },
  ...paths.map((path) => ({ key: `${projectKey}:${path}`, qualifier: 'FIL', path })),
]

const GATE_OK = {
  projectStatus: {
    status: 'OK',
    conditions: [
      { status: 'OK', metricKey: 'new_reliability_rating', comparator: 'GT', errorThreshold: '1', actualValue: '1' },
      { status: 'OK', metricKey: 'new_security_hotspots_reviewed', comparator: 'LT', errorThreshold: '100', actualValue: '100.0' },
    ],
  },
}

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
}

/** A function is handed the params and may throw; anything else is the body. */
type Reply = ((params: Record<string, QueryValue>) => unknown) | Record<string, unknown>

/** Matched by path suffix, so a fixture names `issues/search` rather than the URL. */
function fakeSonar(replies: Record<string, Reply>) {
  const calls: Call[] = []

  const client: SonarClient = {
    async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, params })
      const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
      if (match === undefined) throw new Error(`unexpected call: ${path}`)

      const reply = replies[match]

      return (typeof reply === 'function' ? reply(params) : reply) as T
    },
  }

  return { client, calls }
}

/**
 * Typed as the one verb this module uses. Widening it to the whole `AdoClient`
 * would make a test about Sonar statuses fail every time a verb is added to the
 * client for somebody else's feature.
 */
function fakeAdo(value: unknown) {
  const calls: string[] = []
  const client: Pick<AdoClient, 'get'> = {
    get<T>(path: string): Promise<T> {
      calls.push(path)

      return Promise.resolve(value as T)
    },
  }

  return { client: client as AdoClient, calls }
}

/** `make` is called per request, so every reply gets an unread body. */
function stubFetch(make: (call: number) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })

    return Promise.resolve(make(calls.length - 1))
  })

  return calls
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the projects a pull request is analysed as', () => {
  it('recovers one project per SonarCloud status, and ignores every other status', () => {
    const projects = sonarProjects([
      BUILD_STATUS,
      sonarStatus('profisee_matching'),
      { context: { name: 'quality gate', genre: 'SonarCloud' }, targetUrl: 'https://sonarcloud.io/dashboard?id=profisee_rest-api&pullRequest=24809' },
    ])

    // Two projects on one pull request — the case a single-project assumption
    // silently loses half the findings to.
    expect(projects).toEqual([MATCHING, REST_API])
  })

  it('collapses the status a project re-posts on every iteration', () => {
    // !24804 carried six SonarCloud statuses for one project. Six identical
    // issues calls is the bug this prevents.
    const projects = sonarProjects([
      sonarStatus('profisee_platform'),
      sonarStatus('profisee_platform'),
      sonarStatus('profisee_platform'),
    ])

    expect(projects).toHaveLength(1)
  })

  it('drops a Sonar status that names no project, and one pointing off SonarCloud', () => {
    const projects = sonarProjects([
      { context: { genre: 'SonarCloud' }, targetUrl: 'https://sonarcloud.io/dashboard?pullRequest=24809' },
      { context: { genre: 'SonarCloud' }, targetUrl: 'https://sonar.internal.example/dashboard?id=x&pullRequest=1' },
      { context: { genre: 'SonarCloud' }, targetUrl: 'not a url' },
      { context: { genre: 'SonarCloud' } },
    ])

    expect(projects).toEqual([])
  })

  it('reads them off the pull request statuses endpoint', async () => {
    const { client, calls } = fakeAdo({ value: [sonarStatus('profisee_matching')] })

    await expect(loadSonarProjects(client, REF)).resolves.toEqual([MATCHING])
    expect(calls).toEqual([
      `${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullRequests/24809/statuses`,
    ])
  })
})

describe('the issues request', () => {
  it('filters to open statuses, asks for one page and for the components block', async () => {
    const { client, calls } = fakeSonar({
      'issues/search': { total: 0, issues: [], components: [] },
      project_status: GATE_OK,
    })

    await loadSonarReport(client, [MATCHING])

    const issues = calls.find((call) => call.path.endsWith('issues/search'))
    // Without this the API answers with FIXED and CLOSED issues too: a pull
    // request whose three issues were all fixed reads as three live findings.
    expect(issues?.params.issueStatuses).toBe('OPEN,CONFIRMED,ACCEPTED')
    // `componentKeys`, not `components` — the latter 400s on Cloud.
    expect(issues?.params.componentKeys).toBe('profisee_matching')
    expect(issues?.params.pullRequest).toBe('24809')
    expect(issues?.params.ps).toBe(500)
    expect(issues?.params.additionalFields).toBe('_all')
  })
})

describe('a finding', () => {
  it('anchors on textRange.startLine when the API sends no line at all', async () => {
    const { client } = fakeSonar({
      'issues/search': {
        total: 1,
        issues: [FIXED_ISSUE],
        components: componentBlock('profisee_rest-api', 'Gateway.Api/Services/Portal/AccountsService.cs'),
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [REST_API])
    const finding = report.groups[0].findings[0]

    expect('line' in FIXED_ISSUE).toBe(false)
    expect(finding.textRange).toEqual({ startLine: 156, endLine: 156, startOffset: 16, endOffset: 47 })
    expect(finding.status).toBe('FIXED')
  })

  it('normalises component to a leading-slash path, from the block or by splitting it', async () => {
    const { client } = fakeSonar({
      'issues/search': {
        total: 3,
        issues: [
          openIssue(),
          // Not described in `components[]` — the fallback split has to carry it.
          openIssue({
            key: 'unlisted',
            component: 'profisee_matching:Services.Matching/Program.cs',
          }),
          // A project-level issue: no `:`, so no file.
          openIssue({ key: 'project-level', component: 'profisee_matching' }),
        ],
        components: componentBlock(
          'profisee_matching',
          'Services.Matching.Infrastructure/Stats/StatTrakReader.cs',
        ),
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])
    const paths = report.groups.flatMap((group) => group.findings).map((finding) => finding.path)

    expect(paths).toEqual([
      '/Services.Matching.Infrastructure/Stats/StatTrakReader.cs',
      '/Services.Matching/Program.cs',
      null,
    ])
  })
})

describe('grouping', () => {
  it('orders groups by finding count descending, with the worst impact as the badge', async () => {
    const { client } = fakeSonar({
      'issues/search': {
        issues: [
          openIssue({ key: 'a1', rule: 'csharpsquid:S1481' }),
          openIssue({ key: 'b1', rule: 'csharpsquid:S107' }),
          openIssue({ key: 'a2', rule: 'csharpsquid:S1481' }),
          openIssue({
            key: 'a3',
            rule: 'csharpsquid:S1481',
            impacts: [{ softwareQuality: 'RELIABILITY', severity: 'BLOCKER' }],
          }),
        ],
        components: [],
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])

    expect(report.groups.map((group) => [group.rule, group.findings.length, group.severity])).toEqual([
      ['csharpsquid:S1481', 3, 'BLOCKER'],
      ['csharpsquid:S107', 1, 'MEDIUM'],
    ])
  })

  it('names a rule from one batched call, and leaves an undescribable one null', async () => {
    const { client, calls } = fakeSonar({
      'issues/search': {
        issues: [
          openIssue({ key: 'known-1' }),
          openIssue({ key: 'known-2' }),
          // Requested and simply not returned: an externally-imported analyser
          // rule is not in Sonar's rule repository.
          openIssue({ key: 'external', rule: 'external_roslyn:CA1861' }),
        ],
        components: [],
      },
      'rules/search': {
        rules: [
          {
            key: 'csharpsquid:S107',
            name: 'Functions should not have too many parameters',
            langName: 'C#',
            cleanCodeAttribute: 'FOCUSED',
            impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'MEDIUM' }],
            sysTags: ['brain-overload'],
            htmlDesc: '<p>too many</p>',
            // Arrival order is deliberately wrong: §11 measured two calls for
            // one rule returning the sections in two different orders.
            descriptionSections: [
              { key: 'resources', content: '<p>links</p>' },
              { key: 'how_to_fix', content: '<p>fix</p>', context: { key: 'spring', displayName: 'Spring' } },
              { key: 'introduction', content: '<p>intro</p>' },
              { key: 'a_section_invented_later', content: '<p>new</p>' },
            ],
          },
        ],
      },
      project_status: GATE_OK,
    })

    const { report, rules } = await loadSonarReport(client, [MATCHING])
    const ruleCalls = calls.filter((call) => call.path.endsWith('rules/search'))

    // One call for the whole pull request, not one per rule.
    expect(ruleCalls).toHaveLength(1)
    expect(ruleCalls[0].params.rule_keys).toBe('csharpsquid:S107,external_roslyn:CA1861')
    // Mandatory, and taken off the issues themselves rather than configured.
    expect(ruleCalls[0].params.organization).toBe('profisee')
    // `type` in `f=` 400s the entire request.
    expect(String(ruleCalls[0].params.f).split(',')).not.toContain('type')

    expect(report.groups.map((group) => [group.rule, group.name])).toEqual([
      ['csharpsquid:S107', 'Functions should not have too many parameters'],
      ['external_roslyn:CA1861', null],
    ])
    expect(rules[0].sections.map((section) => section.key)).toEqual([
      'introduction',
      'how_to_fix',
      'resources',
      'a_section_invented_later',
    ])
    expect(rules[0].sections[1].context).toEqual({ key: 'spring', displayName: 'Spring' })
    expect(rules[0].language).toBe('C#')
  })

  it('asks for no rules when there is nothing to describe', async () => {
    const { client, calls } = fakeSonar({
      'issues/search': { total: 0, issues: [] },
      project_status: GATE_OK,
    })

    await loadSonarReport(client, [MATCHING])

    expect(calls.some((call) => call.path.endsWith('rules/search'))).toBe(false)
  })
})

describe('the quality gate', () => {
  it('reads the deprecated project_status shape with failing conditions first', async () => {
    const { client, calls } = fakeSonar({
      'issues/search': { total: 0, issues: [] },
      project_status: {
        projectStatus: {
          status: 'ERROR',
          conditions: [
            { status: 'OK', metricKey: 'new_security_rating', comparator: 'GT', errorThreshold: '1', actualValue: '1' },
            { status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '61.4' },
          ],
        },
      },
    })

    const { report } = await loadSonarReport(client, [MATCHING])

    expect(calls.find((call) => call.path.endsWith('project_status'))?.params).toEqual({
      projectKey: 'profisee_matching',
      pullRequest: '24809',
    })
    expect(report.gate?.status).toBe('ERROR')
    expect(report.gate?.conditions.map((condition) => condition.metricKey)).toEqual([
      'new_coverage',
      'new_security_rating',
    ])
    // Strings on the wire, displayed verbatim.
    expect(report.gate?.conditions[0].actualValue).toBe('61.4')
  })

  it('merges several projects into one verdict, where a failure wins', async () => {
    const { client } = fakeSonar({
      'issues/search': { total: 0, issues: [] },
      project_status: (params) =>
        params.projectKey === 'profisee_rest-api'
          ? { projectStatus: { status: 'ERROR', conditions: [{ status: 'ERROR', metricKey: 'new_coverage' }] } }
          : GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING, REST_API])

    expect(report.gate?.status).toBe('ERROR')
    expect(report.gate?.conditions).toHaveLength(3)
    expect(report.gate?.conditions[0].metricKey).toBe('new_coverage')
  })
})

describe('partial failure', () => {
  it('keeps one project when another fails, and names the one it lost', async () => {
    const { client } = fakeSonar({
      'issues/search': (params) => {
        if (params.componentKeys === 'profisee_rest-api') {
          throw new SonarError(403, 'SonarCloud answered 403.', 'Insufficient privileges')
        }

        return { issues: [openIssue()], components: [] }
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING, REST_API])

    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].findings[0].key).toBe('AZ-pXh-nP-U4fPfm1RSA')
    expect(report.failed).toEqual([
      { projectKey: 'profisee_rest-api', message: 'SonarCloud answered 403. (Insufficient privileges)' },
    ])
    // Both projects are still listed: the panel says what it looked at.
    expect(report.projects).toEqual([MATCHING, REST_API])
    // The failed project's gate is still asked for — two independent answers.
    expect(report.gate?.conditions).toHaveLength(4)
  })

  it('survives a rules call that fails, losing names rather than findings', async () => {
    const { client } = fakeSonar({
      'issues/search': { issues: [openIssue()], components: [] },
      'rules/search': () => {
        throw new SonarError(500, 'SonarCloud answered 500.')
      },
      project_status: GATE_OK,
    })

    const { report, rules } = await loadSonarReport(client, [MATCHING])

    expect(rules).toEqual([])
    expect(report.groups[0].name).toBeNull()
    expect(report.groups[0].findings).toHaveLength(1)
    expect(report.failed).toEqual([])
  })
})

describe('the request itself', () => {
  it('carries Bearer auth and never follows a redirect', async () => {
    const calls = stubFetch(() => json({ total: 0, issues: [] }))
    const client = createSonarClient(CREDENTIAL)
    await client.get('api/issues/search', { componentKeys: 'profisee_matching', ps: 500 })

    expect(calls).toHaveLength(1)
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[0].init.redirect).toBe('manual')
    expect(calls[0].url).toBe(
      'https://sonarcloud.io/api/issues/search?componentKeys=profisee_matching&ps=500',
    )
  })

  it('drops an error body that echoes the token back', async () => {
    stubFetch(() => json({ errors: [{ msg: `Token ${TOKEN} was revoked` }] }, { status: 401 }))
    const client = createSonarClient(CREDENTIAL)

    const error = await client.get('api/issues/search').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(SonarError)
    expect((error as SonarError).status).toBe(401)
    // The whole string goes, not the token inside it — the alternative is a
    // redaction that has to guess every shape a server might echo.
    expect((error as SonarError).message).not.toContain(TOKEN)
    expect((error as SonarError).message).toBe('SonarCloud answered 401.')
  })
})

describe('a 429', () => {
  it('backs off instead of retrying, and asks again once the back-off is over', async () => {
    vi.useFakeTimers()
    const calls = stubFetch((call) =>
      call === 0 ? json({ errors: [{ msg: 'rate limited' }] }, { status: 429 }) : json({ total: 0 }),
    )
    const client = createSonarClient(CREDENTIAL)

    const first = await client.get('api/issues/search').catch((thrown: unknown) => thrown)
    expect((first as SonarError).status).toBe(429)
    expect((first as SonarError).message).toContain('2 minutes')

    // The second call never leaves: no `Retry-After` exists to shorten the wait
    // with, so asking again immediately is the storm this refuses to start.
    const second = await client.get('api/issues/search').catch((thrown: unknown) => thrown)
    expect((second as SonarError).status).toBe(429)
    expect((second as SonarError).message).toContain('120 seconds')
    expect(calls).toHaveLength(1)

    vi.advanceTimersByTime(SONAR_BACKOFF_MS)
    await expect(client.get('api/issues/search')).resolves.toEqual({ total: 0 })
    expect(calls).toHaveLength(2)
  })

  it('loses every project to the back-off without sending a second request', async () => {
    const calls = stubFetch(() => json({ errors: [{ msg: 'rate limited' }] }, { status: 429 }))
    const client = createSonarClient(CREDENTIAL)

    const { report } = await loadSonarReport(client, [MATCHING, REST_API])

    // Two projects, four possible calls, one request. Every project is named as
    // lost rather than shown as clean.
    expect(calls).toHaveLength(1)
    expect(report.failed.map((failure) => failure.projectKey)).toEqual([
      'profisee_matching',
      'profisee_rest-api',
    ])
    expect(report.groups).toEqual([])
    expect(report.gate).toBeNull()
  })
})
