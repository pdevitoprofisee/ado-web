// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SonarError,
  applyTransition,
  commentIssueKey,
  createSonarClient,
  loadSonarProjects,
  loadSonarReport,
  sonarProjects,
  sonarThreadFor,
} from './sonar'
import { SONAR_BACKOFF_MS, SONAR_MAX_PAGES } from '../lib/sonar-contract'

import type { AdoClient, QueryValue } from './ado-client'
import type { Comment, Thread, ThreadKind } from '../lib/comment-contract'
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
  /** Absent on a read, so a fixture that never writes reads the same as before. */
  readonly method?: 'POST'
}

/** A function is handed the params and may throw; anything else is the body. */
type Reply = ((params: Record<string, QueryValue>) => unknown) | Record<string, unknown>

/** Matched by path suffix, so a fixture names `issues/search` rather than the URL. */
function fakeSonar(replies: Record<string, Reply>) {
  const calls: Call[] = []

  function answer(path: string, params: Record<string, QueryValue>): unknown {
    const match = Object.keys(replies).find((suffix) => path.endsWith(suffix))
    if (match === undefined) throw new Error(`unexpected call: ${path}`)

    const reply = replies[match]

    return typeof reply === 'function' ? reply(params) : reply
  }

  const client: SonarClient = {
    async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, params })

      return answer(path, params) as T
    },
    async post<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T | null> {
      calls.push({ path, params, method: 'POST' })

      return answer(path, params) as T
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
  it('filters to open statuses, asks for the biggest page and for the components block', async () => {
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
    expect(issues?.params.p).toBe(1)
    // 500 and not 1000: `ps=501` answers 400 `'ps' value (501) must be less than
    // 500`, so this is the maximum and paging is the only way past it.
    expect(issues?.params.ps).toBe(500)
    expect(issues?.params.additionalFields).toBe('_all')
  })
})

describe('paging past one page', () => {
  it('reads every page, and keeps the paths each page described', async () => {
    // The pages are one issue long where real ones are five hundred: what is
    // under test is that a second request happens and that both answers survive
    // it, and `total` is what says so — not a page's length.
    const { client, calls } = fakeSonar({
      'issues/search': (params) =>
        params.p === 1
          ? {
              total: 2,
              // A second colon in the key, which is what makes `components[]`
              // load-bearing: split on the first one this reads
              // `Services.Matching:Stats/StatTrakReader.cs`, so a path map that
              // page 2 rebuilt would show up here as a mangled path rather than
              // as a missing one.
              issues: [openIssue({ component: 'profisee_matching:Services.Matching:Stats/StatTrakReader.cs' })],
              components: [
                { key: 'profisee_matching', qualifier: 'TRK', name: 'profisee_matching' },
                {
                  key: 'profisee_matching:Services.Matching:Stats/StatTrakReader.cs',
                  qualifier: 'FIL',
                  path: 'Stats/StatTrakReader.cs',
                },
              ],
            }
          : {
              total: 2,
              issues: [
                openIssue({ key: 'second', component: 'profisee_matching:Services.Matching/Program.cs' }),
              ],
              // Page 2 describes only its own file. Sonar does not repeat page
              // one's components, which is the whole reason the map accumulates.
              components: componentBlock('profisee_matching', 'Services.Matching/Program.cs'),
            },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])
    const issues = calls.filter((call) => call.path.endsWith('issues/search'))

    expect(issues.map((call) => call.params.p)).toEqual([1, 2])
    expect(report.groups.flatMap((group) => group.findings).map((finding) => finding.path)).toEqual([
      '/Stats/StatTrakReader.cs',
      '/Services.Matching/Program.cs',
    ])
    // Two of two: a list that is whole says nothing.
    expect(report.truncated).toEqual([])
  })

  it('stops when it has the whole list rather than asking for a page after the end', async () => {
    const { client, calls } = fakeSonar({
      'issues/search': (params) => ({
        total: 4,
        issues: [
          openIssue({ key: `a${String(params.p)}` }),
          openIssue({ key: `b${String(params.p)}` }),
        ],
        components: [],
      }),
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])

    expect(calls.filter((call) => call.path.endsWith('issues/search'))).toHaveLength(2)
    expect(report.groups[0].findings).toHaveLength(4)
    expect(report.truncated).toEqual([])
  })

  it('takes a page shorter than the maximum as the end when no total arrived', async () => {
    // `total` was on every 200 measured, so this is the unmeasured case: with
    // nothing to count against, a page that came back short is the only end
    // signal there is, and asking twenty times to be sure is worse.
    const { client, calls } = fakeSonar({
      'issues/search': { issues: [openIssue()], components: [] },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])

    expect(calls.filter((call) => call.path.endsWith('issues/search'))).toHaveLength(1)
    expect(report.truncated).toEqual([])
  })

  it('stops at the API’s own ceiling and says how short the list is', async () => {
    // `p * ps` cannot exceed 10 000 — page 21 at ps=500 answers 400 — so a
    // project with more findings than that has an unreachable tail and the only
    // honest thing to do is say so. Two issues a page rather than five hundred:
    // the bound under test is the page count, and fabricating 10 000 issues to
    // assert one number would test the fixture.
    const { client, calls } = fakeSonar({
      'issues/search': (params) => ({
        total: 12_000,
        issues: [
          openIssue({ key: `a${String(params.p)}` }),
          openIssue({ key: `b${String(params.p)}` }),
        ],
        components: [],
      }),
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])
    const issues = calls.filter((call) => call.path.endsWith('issues/search'))

    expect(issues).toHaveLength(SONAR_MAX_PAGES)
    expect(issues.at(-1)?.params.p).toBe(SONAR_MAX_PAGES)
    // `message: null` is the ceiling: nothing went wrong, there is just no
    // request that reads the rest. Not in `failed`, because these findings are on
    // the screen.
    expect(report.truncated).toEqual([
      { projectKey: 'profisee_matching', fetched: 40, total: 12_000, message: null },
    ])
    expect(report.failed).toEqual([])
    // Still a project that answered, so its gate is still worth asking for.
    expect(report.gate?.status).toBe('OK')
  })

  it('keeps the pages it got when a later one is refused, and says it backed off', async () => {
    // The failure this whole thing exists for. One throw on page 3 used to
    // discard pages 1 and 2 with it, and the report said the project could not be
    // read at all — of a project whose findings had already arrived.
    const { client, calls } = fakeSonar({
      'issues/search': (params) => {
        if (Number(params.p) >= 3) {
          throw new SonarError(429, 'SonarCloud rate-limited this token. Backing off for 2 minutes.')
        }

        return {
          total: 12_000,
          issues: [
            openIssue({ key: `a${String(params.p)}` }),
            openIssue({ key: `b${String(params.p)}` }),
          ],
          components: [],
        }
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])

    expect(calls.filter((call) => call.path.endsWith('issues/search'))).toHaveLength(3)
    expect(report.groups[0].findings.map((finding) => finding.key)).toEqual(['a1', 'b1', 'a2', 'b2'])
    // The distinction the panel repeats to the reader: this list stopped because
    // a request was refused, not because it ran out.
    expect(report.truncated).toEqual([
      {
        projectKey: 'profisee_matching',
        fetched: 4,
        total: 12_000,
        message: 'SonarCloud rate-limited this token. Backing off for 2 minutes.',
      },
    ])
    expect(report.failed).toEqual([])
    // The gate is skipped on a back-off even though pages answered first: the
    // client is closed to every further request and asking only manufactures a
    // second identical failure.
    expect(calls.some((call) => call.path.endsWith('project_status'))).toBe(false)
    expect(report.gate).toBeNull()
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

  it('keeps only the transitions this app offers, and nothing at all from an issue with none', async () => {
    const { client } = fakeSonar({
      'issues/search': {
        total: 2,
        issues: [
          // §10's wire array, verbatim. `resolve` and `wontfix` are real values
          // that no button sends, so they must not survive the parse.
          openIssue({
            transitions: ['accept', 'confirm', 'resolve', 'falsepositive', 'wontfix'],
          }),
          // The issue §10 also sampled: `"transitions": []` with `comment` as the
          // only action. A token without Administer Issues answers like this for
          // every issue, and an empty array is the whole reason the panel asks.
          openIssue({ key: 'no-actions', transitions: [] }),
        ],
        components: componentBlock('profisee_matching', 'Services.Matching.Infrastructure/Stats/StatTrakReader.cs'),
      },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [MATCHING])
    const findings = report.groups.flatMap((group) => group.findings)

    expect(findings.map((finding) => finding.transitions)).toEqual([
      ['accept', 'confirm', 'falsepositive'],
      [],
    ])
  })

  it('reads no transitions when the API does not send the field at all', async () => {
    const { client } = fakeSonar({
      'issues/search': { total: 1, issues: [FIXED_ISSUE], components: [] },
      'rules/search': { rules: [] },
      project_status: GATE_OK,
    })

    const { report } = await loadSonarReport(client, [REST_API])

    expect('transitions' in FIXED_ISSUE).toBe(false)
    expect(report.groups[0].findings[0].transitions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Triage.
// ---------------------------------------------------------------------------

const AUTHOR = { id: 'a', displayName: 'SonarCloud', uniqueName: null, imageUrl: null }

const comment = (content: string | null): Comment => ({
  id: 1,
  parentCommentId: null,
  author: AUTHOR,
  content,
  publishedDate: '2026-01-01T00:00:00Z',
  lastUpdatedDate: null,
  lastContentUpdatedDate: null,
  isDeleted: false,
  commentType: 'text',
  likedBy: [],
  mentions: {},
})

const thread = (id: number, kind: ThreadKind, ...bodies: readonly (string | null)[]): Thread => ({
  id,
  status: 'active',
  resolution: 'open',
  kind,
  publishedDate: '2026-01-01T00:00:00Z',
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments: bodies.map(comment),
  properties: {},
})

/** What Sonar's bot posts: a sentence, then a link with the key in the query. */
const botBody = (key: string) =>
  `**Code Smell** Method has 8 parameters. [View in SonarCloud](https://sonarcloud.io/project/issues?id=profisee_matching&pullRequest=24809&open=${key}&issues=${key})`

describe('applying a transition', () => {
  it('posts the issue and the transition, and reports the status Sonar answers with', async () => {
    const { client, calls } = fakeSonar({
      do_transition: { issue: { key: 'AZ-pXh-nP-U4fPfm1RSA', issueStatus: 'ACCEPTED' } },
    })

    const status = await applyTransition(client, 'AZ-pXh-nP-U4fPfm1RSA', 'accept')

    expect(status).toBe('ACCEPTED')
    expect(calls).toEqual([
      {
        path: 'api/issues/do_transition',
        params: { issue: 'AZ-pXh-nP-U4fPfm1RSA', transition: 'accept', comment: undefined },
        method: 'POST',
      },
    ])
  })

  it('sends a comment only when there is one, and never a blank one', async () => {
    const { client, calls } = fakeSonar({ do_transition: { issue: { issueStatus: 'ACCEPTED' } } })

    await applyTransition(client, 'k1', 'accept', '  ')
    await applyTransition(client, 'k2', 'accept', '  agreed debt  ')

    expect(calls.map((call) => call.params.comment)).toEqual([undefined, 'agreed debt'])
  })

  it('answers null for a status it does not know, rather than passing it on', async () => {
    const { client } = fakeSonar({ do_transition: { issue: { issueStatus: 'SOMETHING_NEW' } } })

    // The transition landed. Only the *new state* is unknown, and the caller
    // reports `transitioned: true` with `status: null` rather than inventing one.
    await expect(applyTransition(client, 'k1', 'accept')).resolves.toBeNull()
  })

  it('survives an empty body, which a write is allowed to answer with', async () => {
    const { client } = fakeSonar({ do_transition: () => null })

    await expect(applyTransition(client, 'k1', 'confirm')).resolves.toBeNull()
  })
})

describe('the issue key in a bot comment', () => {
  it('reads it out of the SonarCloud link', () => {
    expect(commentIssueKey(botBody('AZ-pXh-nP-U4fPfm1RSA'))).toBe('AZ-pXh-nP-U4fPfm1RSA')
  })

  it('refuses a link that names several issues', () => {
    // This one is Sonar's summary comment, and the key that selects an ADO thread
    // to write to must name exactly one issue.
    expect(commentIssueKey('https://sonarcloud.io/project/issues?issues=one,two')).toBeNull()
  })

  it('refuses a link on another host, however it is spelled', () => {
    expect(commentIssueKey('https://sonarcloud.io.evil.test/x?issues=k1')).toBeNull()
    expect(commentIssueKey('https://example.test/?issues=k1')).toBeNull()
    expect(commentIssueKey('no link here at all')).toBeNull()
  })
})

describe('the thread a finding belongs to', () => {
  it('finds the bot thread whose comment names the issue', () => {
    const wanted = thread(102, 'bot', botBody('k2'))

    expect(sonarThreadFor([thread(101, 'bot', botBody('k1')), wanted], 'k2')).toBe(wanted)
  })

  it('ignores a person who pasted the same link', () => {
    // The write closes whatever thread this returns, so a colleague quoting a
    // finding must not be the thread that gets resolved.
    expect(sonarThreadFor([thread(101, 'human', botBody('k1'))], 'k1')).toBeNull()
  })

  it('reads the first comment only', () => {
    // A reply under Sonar's own thread is a person talking in the bot's thread.
    // The finding is whatever the bot opened it about.
    const one = thread(101, 'bot', botBody('k1'), botBody('k2'))

    expect(sonarThreadFor([one], 'k1')).toBe(one)
    expect(sonarThreadFor([one], 'k2')).toBeNull()
  })

  it('answers null for a deleted thread, an empty one, and no thread at all', () => {
    const deleted = { ...thread(101, 'bot', botBody('k1')), isDeleted: true }

    expect(sonarThreadFor([deleted], 'k1')).toBeNull()
    expect(sonarThreadFor([thread(102, 'bot')], 'k1')).toBeNull()
    expect(sonarThreadFor([thread(103, 'bot', null)], 'k1')).toBeNull()
    expect(sonarThreadFor([], 'k1')).toBeNull()
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

  it('sends a write as a form body with an empty query string', async () => {
    const calls = stubFetch(() => json({ issue: { issueStatus: 'ACCEPTED' } }))
    const client = createSonarClient(CREDENTIAL)

    await client.post('api/issues/do_transition', { issue: 'k1', transition: 'accept' })

    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].url).toBe('https://sonarcloud.io/api/issues/do_transition')
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(calls[0].init.body).toBe('issue=k1&transition=accept')
  })

  it('answers null for a write that returns no body, and does not call it an error', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    const client = createSonarClient(CREDENTIAL)

    await expect(client.post('api/issues/do_transition', { issue: 'k1' })).resolves.toBeNull()
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
    // Nothing arrived, so nothing is truncated: a project with no findings on the
    // screen is `failed`, and the two lists never describe the same project.
    expect(report.truncated).toEqual([])
  })
})
