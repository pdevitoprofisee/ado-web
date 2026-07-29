// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  buildTimeline,
  clearBuildCache,
  decodeLog,
  findFailingStep,
  loadCheckDetail,
  loadChecksReport,
  logWindow,
  retryBuild,
  retryStage,
  toChecks,
  toTestRun,
} from './checks'
import { buildRetryRequest, checkDetailRequest, stageRetryRequest } from './checks-fn'

import type { AdoBytesOptions, AdoClient, AdoHost, AdoWriteMethod, QueryValue } from './ado-client'
import type { PullRequestRef } from './pull-request'

// The measured shapes this file defends, all from `docs/research/checks-inventory.md`:
// evaluations need `7.1-preview.1`, a pull request can hold five build policies,
// only one of the four `failed` records in a timeline is the answer, `issues` is
// an *absent* key, a log answers 200-with-an-empty-body instead of 404, and a run
// carries no failure count at all.

const PROJECT = 'ad098ab8-fc30-4fe4-982d-460e6c9eb694'
const REPO = 'bd5cb08b-e03b-41a4-9e54-34e32771d34c'
const BUILD = 194571

const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPO, id: 24833 }

interface Call {
  readonly path: string
  readonly params: Record<string, QueryValue>
  readonly host: AdoHost
}

interface WriteCall {
  readonly method: AdoWriteMethod
  readonly path: string
  readonly body: unknown
  readonly params: Record<string, QueryValue>
}

type Reply = Error | Record<string, unknown>
/**
 * What `getBytes` hands back: a log is text, whichever content type ADO chose.
 *
 * `size` is separate from the text on purpose — it is `Content-Length`, and stating
 * it independently is the only way to exercise the size ceiling without writing a
 * megabyte of fixture.
 */
type BytesReply =
  | Error
  | { readonly text: string; readonly contentType: string | null; readonly size?: number }

interface Fixture {
  readonly bytes?: Record<string, BytesReply>
  readonly written?: Reply
}

/**
 * Local, like every other server test's. Matched by path suffix so the fixtures
 * read as endpoints rather than as full URLs.
 */
function fakeClient(replies: Record<string, Reply>, fixture: Fixture = {}) {
  const calls: Call[] = []
  const writes: WriteCall[] = []

  const pick = <T>(source: Record<string, T>, path: string): T | undefined => {
    const match = Object.keys(source).find((suffix) => path.endsWith(suffix))

    return match === undefined ? undefined : source[match]
  }

  const client: AdoClient = {
    org: 'Profisee',
    get<T>(
      path: string,
      params: Record<string, QueryValue> = {},
      host: AdoHost = 'core',
    ): Promise<T> {
      calls.push({ path, params, host })
      const reply = pick(replies, path)
      if (reply === undefined) return Promise.reject(new Error(`unexpected call: ${path}`))
      if (reply instanceof Error) return Promise.reject(reply)

      return Promise.resolve(reply as T)
    },
    getBytes(
      path: string,
      params: Record<string, QueryValue> = {},
      { maxBytes }: AdoBytesOptions = {},
    ) {
      calls.push({ path, params, host: 'core' })
      const reply = pick(fixture.bytes ?? {}, path)
      if (reply === undefined) return Promise.reject(new Error(`unexpected log call: ${path}`))
      if (reply instanceof Error) return Promise.reject(reply)
      const bytes = new TextEncoder().encode(reply.text)
      const size = reply.size ?? bytes.length

      // The real client's refusal, in the real client's shape: the size is readable
      // before the body, so the too-large case is a stream never read rather than a
      // download thrown away.
      if (maxBytes !== undefined && size > maxBytes) {
        return Promise.resolve({ bytes: null, size, contentType: null })
      }

      return Promise.resolve({ bytes, size, contentType: reply.contentType })
    },
    write<T>(
      method: AdoWriteMethod,
      path: string,
      body?: unknown,
      params: Record<string, QueryValue> = {},
    ): Promise<T | null> {
      writes.push({ method, path, body, params })
      const written = fixture.written ?? {}
      if (written instanceof Error) return Promise.reject(written)

      return Promise.resolve(written as T)
    },
    fanOut: (items, task) => Promise.all(items.map(task)),
    rateLimit: () => ({
      remaining: null,
      limit: null,
      delay: null,
      resetAt: null,
      throttledUntil: null,
      throttled: false,
      calls: calls.length + writes.length,
      cost: 0,
    }),
  }

  return { client, calls, writes }
}

// ---------------------------------------------------------------------------
// Fixtures, from the research doc's verbatim responses.
// ---------------------------------------------------------------------------

const evaluation = (
  id: number,
  buildId: number | null,
  status = 'rejected',
  extra: Record<string, unknown> = {},
) => ({
  evaluationId: `8cf8dbdc-33ef-4656-a2dd-c06dd9ea91b${id % 10}`,
  startedDate: '2026-07-28T20:46:16.1786274Z',
  status,
  context:
    buildId === null
      ? null
      : {
          lastMergeCommitId: 'cddb739cbb7369ac34f53803b99f403d4a157b0b',
          buildId,
          buildDefinitionId: 294,
          buildDefinitionName: 'platform (common)',
          buildIsNotCurrent: false,
          buildStartedUtc: '2026-07-28T20:46:14.9779517Z',
          isExpired: false,
          ...extra,
        },
  configuration: {
    isEnabled: true,
    isBlocking: true,
    id,
    type: { displayName: 'Build' },
    settings: { buildDefinitionId: 294, displayName: null },
  },
})

/** A reviewer policy: no `settings.buildDefinitionId`, so never a check row. */
const reviewerPolicy = {
  evaluationId: 'aaaaaaaa-33ef-4656-a2dd-c06dd9ea91be',
  status: 'approved',
  context: null,
  configuration: {
    isEnabled: true,
    isBlocking: true,
    id: 99,
    type: { displayName: 'Minimum number of reviewers' },
    settings: { minimumApproverCount: 2 },
  },
}

const build = (status = 'completed', result: string | null = 'failed') => ({
  id: BUILD,
  buildNumber: '1.0.0.84',
  status,
  ...(result === null ? {} : { result }),
  queueTime: '2026-07-28T21:40:00.0000000Z',
  startTime: '2026-07-28T21:41:00.0000000Z',
  // Absent, not null, on a build that has not finished — 0 of 6.
  ...(result === null ? {} : { finishTime: '2026-07-28T21:48:31.0000000Z' }),
  reason: 'pullRequest',
  _links: { web: { href: 'https://dev.azure.com/Profisee/Products/_build/results?buildId=194571' } },
})

/**
 * The shape that decides everything: three containers reporting `failed` with
 * `errorCount: 0`, one leaf that is the actual failure, and a sibling task whose
 * `issues` key is **absent**.
 */
const TIMELINE = {
  records: [
    {
      id: 'stage-1',
      parentId: null,
      type: 'Stage',
      name: '__default',
      state: 'completed',
      result: 'failed',
      errorCount: 0,
      warningCount: 0,
      order: 1,
      startTime: '2026-07-28T21:41:00.0000000Z',
      finishTime: '2026-07-28T21:48:00.0000000Z',
    },
    {
      id: 'phase-1',
      parentId: 'stage-1',
      type: 'Phase',
      name: 'Build',
      state: 'completed',
      result: 'failed',
      errorCount: 0,
      warningCount: 0,
      order: 1,
    },
    {
      id: 'job-1',
      parentId: 'phase-1',
      type: 'Job',
      name: 'Build',
      state: 'completed',
      result: 'failed',
      errorCount: 0,
      warningCount: 0,
      order: 1,
    },
    {
      // No `issues` key at all — 413 of 440 records look like this.
      id: 'task-restore',
      parentId: 'job-1',
      type: 'Task',
      name: 'Restore',
      state: 'completed',
      result: 'succeeded',
      errorCount: 0,
      warningCount: 0,
      order: 1,
      log: { id: 21, type: 'Container' },
    },
    {
      id: '7198c60a-49ab-5670-a4e5-d16aaeae84e5',
      parentId: 'job-1',
      type: 'Task',
      name: 'Check formatting',
      state: 'completed',
      result: 'failed',
      startTime: '2026-07-28T21:41:47.7766667Z',
      finishTime: '2026-07-28T21:41:54.0300000Z',
      errorCount: 1,
      warningCount: 0,
      order: 9,
      log: { id: 22, type: 'Container' },
      issues: [
        {
          type: 'error',
          category: 'General',
          message: "Cmd.exe exited with code '1'.",
          data: {
            source: 'TaskInternal',
            type: 'error',
            logFileLineNumber: '45',
            sourcepath: '/Api/Program.cs',
            linenumber: '12',
            columnnumber: '4',
          },
        },
      ],
    },
  ],
}

/** 44 logs on the sampled build; two of them are enough to prove the join. */
const LOGS = {
  count: 2,
  value: [
    { id: 21, type: 'Container', lineCount: 220 },
    { id: 22, type: 'Container', lineCount: 47 },
  ],
}

const LOG_JSON = {
  text: JSON.stringify({
    count: 2,
    value: [
      '2026-07-28T21:41:47.7812599Z ##[section]Starting: Check formatting',
      '2026-07-28T21:41:53.9800000Z ##[error]Cmd.exe exited with code \'1\'.',
    ],
  }),
  contentType: 'application/json; charset=utf-8',
}

/** `totalTests: 40 / passedTests: 39 / notApplicableTests: 1` — zero failures. */
const GREEN_RUN = {
  value: [
    {
      id: 1278607,
      name: 'VSTest_TestResults_194571',
      url: 'https://dev.azure.com/Profisee/Products/_apis/test/Runs/1278607',
      isAutomated: true,
      state: 'Completed',
      totalTests: 40,
      incompleteTests: 0,
      notApplicableTests: 1,
      passedTests: 39,
      unanalyzedTests: 0,
      revision: 4,
      webAccessUrl:
        'https://dev.azure.com/Profisee/Products/_TestManagement/Runs?runId=1278607&_a=runCharts',
    },
  ],
}

/** Run 1276996: 29 total, 0 passed, 28 derived failures. */
const RED_RUN = {
  value: [
    {
      id: 1276996,
      name: 'VSTest_TestResults_194571',
      state: 'Completed',
      totalTests: 29,
      incompleteTests: 0,
      notApplicableTests: 1,
      passedTests: 0,
      unanalyzedTests: 0,
      webAccessUrl:
        'https://dev.azure.com/Profisee/Products/_TestManagement/Runs?runId=1276996&_a=runCharts',
    },
  ],
}

const failedResults = (count: number) => ({
  value: Array.from({ length: count }, (_, index) => ({
    id: 100000 + index,
    outcome: 'Failed',
    testCaseTitle: `FirstBoot_ProvisionsTable_${index}`,
    automatedTestStorage: 'profisee.platform.testing.analytics.integration.dll',
    errorMessage: 'Expected 14 tables, found 0.',
    // ADO truncates at exactly 4000; this is longer than we keep either way.
    stackTrace: 'at Profisee.Platform.Testing.Analytics.Integration\n'.repeat(80),
    durationInMs: 1234,
    failureType: 'None',
    testRun: { id: '1276996' },
  })),
})

const detailReplies = (
  buildStatus = 'completed',
  result: string | null = 'failed',
  runs: Record<string, unknown> = GREEN_RUN,
) => ({
  [`/builds/${BUILD}`]: build(buildStatus, result),
  '/timeline': TIMELINE,
  '/logs': LOGS,
  '/test/runs': runs,
  '/results': failedResults(28),
})

const paths = (calls: readonly Call[]): string[] => calls.map((call) => call.path)

// ---------------------------------------------------------------------------

describe('loadChecksReport', () => {
  it('asks for evaluations with the preview api-version, because plain 7.1 is a 400', async () => {
    const { client, calls } = fakeClient({
      '/policy/evaluations': { value: [evaluation(172, BUILD)] },
      [`/builds/${BUILD}`]: build(),
    })

    await loadChecksReport(client, REF)

    const evaluations = calls.find((call) => call.path.endsWith('/policy/evaluations'))
    expect(evaluations?.params['api-version']).toBe('7.1-preview.1')
    expect(evaluations?.params.artifactId).toBe(
      `vstfs:///CodeReview/CodeReviewId/${PROJECT}/${REF.id}`,
    )
  })

  it('draws a row per build policy and reads each distinct build once', async () => {
    const ids = [194571, 194572, 194573, 194574, 194575]
    const { client, calls } = fakeClient({
      '/policy/evaluations': {
        // Five build policies, one of them pointing at a build another already
        // named, plus a reviewer policy that is not a check at all.
        value: [
          ...ids.map((id, index) => evaluation(170 + index, id)),
          evaluation(180, 194571),
          reviewerPolicy,
        ],
      },
      '/builds/194571': build(),
      '/builds/194572': build(),
      '/builds/194573': build(),
      '/builds/194574': build(),
      '/builds/194575': build(),
    })

    const report = await loadChecksReport(client, REF)

    expect(report.checks).toHaveLength(6)
    expect(report.checks.map((check) => check.name)).not.toContain('Minimum number of reviewers')
    expect(report.builds).toHaveLength(5)
    expect(paths(calls).filter((path) => path.includes('/builds/'))).toHaveLength(5)
    expect(report.errors).toEqual({ checks: null, builds: null, timeline: null, tests: null })
    expect(report.failed).toEqual([])
  })

  it('keeps a stale green build legible, and refuses to requeue a running one', () => {
    const checks = toChecks(
      [
        evaluation(172, BUILD, 'approved', { buildIsNotCurrent: true }),
        evaluation(173, 194572, 'approved'),
        evaluation(174, 194573, 'running'),
      ],
      'Profisee',
      PROJECT,
    )

    expect(checks[0].build?.isNotCurrent).toBe(true)
    // Approved but stale is still worth re-running; approved and current is not.
    expect(checks[0].requeueId).not.toBeNull()
    expect(checks[1].requeueId).toBeNull()
    // Requeueing cancels the build that is running, which is the answer you are
    // waiting for.
    expect(checks[2].requeueId).toBeNull()
    expect(checks[0].url).toBe(
      `https://dev.azure.com/Profisee/${PROJECT}/_build/results?buildId=${BUILD}`,
    )
  })

  it('reports a build policy that has not queued a build yet as a row without one', () => {
    const checks = toChecks([evaluation(172, null, 'queued')], 'Profisee', PROJECT)

    expect(checks).toHaveLength(1)
    expect(checks[0].build).toBeNull()
    expect(checks[0].url).toBeNull()
    expect(checks[0].blocking).toBe(true)
  })

  it('blames the row when one build will not load, and the build API when none will', async () => {
    const one = fakeClient({
      '/policy/evaluations': {
        value: [evaluation(172, 194571), evaluation(173, 194572)],
      },
      '/builds/194571': build(),
      '/builds/194572': new Error('Azure DevOps answered 500.'),
    })

    const partial = await loadChecksReport(one.client, REF)

    expect(partial.builds).toHaveLength(1)
    expect(partial.failed).toEqual([{ checkId: '173', message: 'Azure DevOps answered 500.' }])
    expect(partial.errors.builds).toBeNull()
    expect(partial.errors.checks).toBeNull()

    const none = fakeClient({
      '/policy/evaluations': { value: [evaluation(172, 194571), evaluation(173, 194572)] },
      '/builds/194571': new Error('Azure DevOps answered 500.'),
      '/builds/194572': new Error('Azure DevOps answered 500.'),
    })

    const lost = await loadChecksReport(none.client, REF)

    expect(lost.errors.builds).toBe('Azure DevOps answered 500.')
    expect(lost.failed).toHaveLength(2)
  })

  it('loses the checks and nothing else when the policy call fails', async () => {
    const { client, calls } = fakeClient({
      '/policy/evaluations': new Error('Azure DevOps answered 404.'),
    })

    const report = await loadChecksReport(client, REF)

    expect(report.errors.checks).toBe('Azure DevOps answered 404.')
    expect(report.checks).toEqual([])
    expect(report.builds).toEqual([])
    // No evaluations means no build ids, which means no build calls to make.
    expect(paths(calls).filter((path) => path.includes('/builds/'))).toEqual([])
  })
})

describe('buildTimeline', () => {
  it('picks the one leaf out of four records that all say failed', () => {
    const nodes = buildTimeline(TIMELINE.records)

    const failed = JSON.stringify(nodes).match(/"result":"failed"/g) ?? []
    expect(failed).toHaveLength(4)

    const step = findFailingStep(nodes)
    expect(step?.name).toBe('Check formatting')
    expect(step?.type).toBe('Task')
    expect(step?.children).toEqual([])
    expect(step?.errorCount).toBe(1)
  })

  it('does not throw on the 413 records whose issues key is absent', () => {
    const nodes = buildTimeline(TIMELINE.records)
    const job = nodes[0].children[0].children[0]

    expect(job.children.map((child) => child.issues)).toEqual([
      [],
      [
        {
          type: 'error',
          category: 'General',
          message: "Cmd.exe exited with code '1'.",
          logLine: 45,
          // Lower-cased on the wire: `sourcepath`, not `sourcePath`.
          sourcePath: '/Api/Program.cs',
          sourceLine: 12,
        },
      ],
    ])
  })

  it('nests by parentId, orders by order, and derives a duration', () => {
    const nodes = buildTimeline(TIMELINE.records)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('__default')
    expect(nodes[0].durationMs).toBe(420_000)
    const tasks = nodes[0].children[0].children[0].children
    expect(tasks.map((task) => task.name)).toEqual(['Restore', 'Check formatting'])
    // Still running: no finish time, so no duration to draw.
    expect(nodes[0].children[0].durationMs).toBeNull()
  })

  it('joins lineCount from the logs collection, which the timeline does not carry', () => {
    const counts = new Map([
      [21, 220],
      [22, 47],
    ])
    const nodes = buildTimeline(TIMELINE.records, counts)
    const step = findFailingStep(nodes)

    expect(step?.log).toEqual({ id: 22, lineCount: 47 })
    // A Stage has no log at all — 14 of 14.
    expect(nodes[0].log).toBeNull()
  })

  it('does not hang on a parent cycle', () => {
    const nodes = buildTimeline([
      { id: 'a', parentId: 'b', type: 'Job', name: 'a', state: 'completed', result: 'succeeded' },
      { id: 'b', parentId: 'a', type: 'Job', name: 'b', state: 'completed', result: 'succeeded' },
    ])

    expect(nodes).toEqual([])
  })
})

describe('logWindow', () => {
  it('asks for the whole log when it fits, or when its length is unknown', () => {
    expect(logWindow(47, 45)).toEqual({ startLine: null, endLine: null })
    expect(logWindow(null, null)).toEqual({ startLine: null, endLine: null })
  })

  it('takes the tail of a long log', () => {
    expect(logWindow(2727, null)).toEqual({ startLine: 2527, endLine: null })
    // An error inside the tail needs no special window.
    expect(logWindow(2727, 2600)).toEqual({ startLine: 2527, endLine: null })
  })

  it('centres on the error when the error is above the tail', () => {
    // 200 lines around line 1400 of 2727, not the last 200 of upload chatter.
    expect(logWindow(2727, 1400)).toEqual({ startLine: 1300, endLine: 1499 })
    expect(logWindow(2727, 45)).toEqual({ startLine: 0, endLine: 199 })
  })
})

describe('decodeLog', () => {
  it('reads the JSON form and strips the timestamp nobody needs', () => {
    const lines = decodeLog(
      new TextEncoder().encode(LOG_JSON.text),
      'application/json; charset=utf-8',
    )

    expect(lines).toEqual([
      '##[section]Starting: Check formatting',
      "##[error]Cmd.exe exited with code '1'.",
    ])
  })

  it('reads the text form a startLine forces, without the trailing blank', () => {
    const lines = decodeLog(
      new TextEncoder().encode('2026-07-28T21:41:47.7812599Z one\n2026-07-28T21:41:48Z two\n'),
      'text/plain; charset=utf-8',
    )

    expect(lines).toEqual(['one', 'two'])
  })

  it('reads an empty body as an empty log, because that is what a missing log id answers', () => {
    expect(decodeLog(new TextEncoder().encode(''), 'text/plain')).toEqual([])
    expect(decodeLog(null, 'text/plain')).toEqual([])
  })
})

describe('toTestRun', () => {
  it('derives the failure count by subtraction, since no field carries it', () => {
    // 40 total, 39 passed, 1 not applicable: zero failures, not one.
    expect(toTestRun(GREEN_RUN.value[0]).failed).toBe(0)
    expect(toTestRun(RED_RUN.value[0]).failed).toBe(28)
    expect(toTestRun({ totalTests: 179, passedTests: 177 }).failed).toBe(2)
    // `unanalyzedTests` is not in the subtraction, so the floor is zero.
    expect(toTestRun({ totalTests: 1, passedTests: 4 }).failed).toBe(0)
  })
})

describe('loadCheckDetail', () => {
  it('fetches the timeline, the log window and the tests for one build', async () => {
    const { client, calls } = fakeClient(detailReplies(), { bytes: { '/logs/22': LOG_JSON } })

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(detail.build.result).toBe('failed')
    expect(detail.failingStep?.name).toBe('Check formatting')
    expect(detail.log?.logId).toBe(22)
    expect(detail.log?.lines).toHaveLength(2)
    expect(detail.log?.totalLines).toBe(47)
    expect(detail.log?.truncated).toBe(false)
    expect(detail.errors).toEqual({ checks: null, builds: null, timeline: null, tests: null })

    // Six calls, not twenty-four: build, timeline, logs, one log, one test run,
    // and no results because the run reports no failures.
    expect(paths(calls)).toHaveLength(5)
    expect(paths(calls).some((path) => path.endsWith('/results'))).toBe(false)
  })

  it('asks for the tail of a long log, centred on the error when it is above it', async () => {
    const { client, calls } = fakeClient(
      {
        ...detailReplies(),
        '/logs': { count: 1, value: [{ id: 22, lineCount: 2727 }] },
      },
      { bytes: { '/logs/22': { text: 'a line\n', contentType: 'text/plain' } } },
    )

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    const log = calls.find((call) => call.path.endsWith('/logs/22'))
    // The issue says line 45, which is nowhere near the last 200 of 2727.
    expect(log?.params).toEqual({ startLine: 0, endLine: 199 })
    expect(detail.log?.totalLines).toBe(2727)
  })

  it('caps the failed tests and leaves the true count on the run', async () => {
    const { client } = fakeClient(detailReplies('completed', 'failed', RED_RUN), {
      bytes: { '/logs/22': LOG_JSON },
    })

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(detail.failedTests).toHaveLength(25)
    expect(detail.testRuns[0].failed).toBe(28)
    // 6985 bytes a result; the trace is cut before it crosses to the browser.
    expect(detail.failedTests[0].stackTrace).toHaveLength(1200)
    expect(detail.failedTests[0].assembly).toBe(
      'profisee.platform.testing.analytics.integration.dll',
    )
  })

  it('fails the timeline, the log and the tests independently', async () => {
    const brokenTimeline = fakeClient({
      ...detailReplies(),
      '/timeline': new Error('Azure DevOps answered 500.'),
    })
    const one = await loadCheckDetail(brokenTimeline.client, {
      projectId: PROJECT,
      buildId: BUILD,
    })
    expect(one.errors.timeline).toBe('Azure DevOps answered 500.')
    expect(one.errors.tests).toBeNull()
    expect(one.testRuns).toHaveLength(1)

    const brokenLog = fakeClient(detailReplies(), {
      bytes: { '/logs/22': new Error('Azure DevOps answered 403.') },
    })
    const two = await loadCheckDetail(brokenLog.client, { projectId: PROJECT, buildId: BUILD })
    // The tree is the more useful half, so a lost log does not cost it.
    expect(two.errors.timeline).toBe('Azure DevOps answered 403.')
    expect(two.failingStep?.name).toBe('Check formatting')
    expect(two.log).toBeNull()

    const brokenTests = fakeClient(
      { ...detailReplies(), '/test/runs': new Error('Azure DevOps answered 503.') },
      { bytes: { '/logs/22': LOG_JSON } },
    )
    const three = await loadCheckDetail(brokenTests.client, { projectId: PROJECT, buildId: BUILD })
    expect(three.errors.tests).toBe('Azure DevOps answered 503.')
    expect(three.errors.timeline).toBeNull()
    expect(three.failingStep?.name).toBe('Check formatting')
  })

  it('holds a finished build and re-reads a running one', async () => {
    const finished = fakeClient(detailReplies(), { bytes: { '/logs/22': LOG_JSON } })
    await loadCheckDetail(finished.client, { projectId: PROJECT, buildId: BUILD })
    const first = finished.calls.length
    await loadCheckDetail(finished.client, { projectId: PROJECT, buildId: BUILD })

    // Only the build read repeats: it is the validity token, so it is the one
    // thing that is never cached.
    expect(finished.calls.length - first).toBe(1)
    expect(paths(finished.calls).filter((path) => path.endsWith('/timeline'))).toHaveLength(1)

    const running = fakeClient(detailReplies('inProgress', null), {
      bytes: { '/logs/22': LOG_JSON },
    })
    await loadCheckDetail(running.client, { projectId: PROJECT, buildId: BUILD })
    const before = running.calls.length
    await loadCheckDetail(running.client, { projectId: PROJECT, buildId: BUILD })

    expect(running.calls.length).toBe(before * 2)
    expect(paths(running.calls).filter((path) => path.endsWith('/timeline'))).toHaveLength(2)
  })

  it('forgets a build when it is retried, because the id may be reused', async () => {
    const { client, calls, writes } = fakeClient(detailReplies(), {
      bytes: { '/logs/22': LOG_JSON },
    })

    await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })
    await retryBuild(client, { projectId: PROJECT, buildId: BUILD })
    await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(writes).toHaveLength(1)
    expect(paths(calls).filter((path) => path.endsWith('/timeline'))).toHaveLength(2)
  })

  it('reads an empty log body as an empty log rather than as a failure', async () => {
    const { client } = fakeClient(detailReplies(), {
      // A log id that does not exist answers 200 with no body at all.
      bytes: { '/logs/22': { text: '', contentType: 'text/plain' } },
    })

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(detail.errors.timeline).toBeNull()
    expect(detail.log).toEqual({
      logId: 22,
      lines: [],
      firstLine: 0,
      totalLines: 47,
      truncated: false,
    })
  })

  it('refuses a log too large to show rather than drawing it as an empty one', async () => {
    const { client } = fakeClient(detailReplies(), {
      // Declares more than the ceiling, so the body is never read. `bytes` is then
      // `null`, which is the same `null` a missing log id answers with — and "this
      // step printed nothing" is the opposite of "this step printed too much".
      bytes: { '/logs/22': { text: 'a line\n', contentType: 'text/plain', size: 4_200_000 } },
    })

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(detail.log).toBeNull()
    expect(detail.errors.timeline).toBe("This step's log is 4200 kB, too large to show here.")
    // The step it belongs to survives it, as it does for any other lost log.
    expect(detail.failingStep?.name).toBe('Check formatting')
  })

  it('reads a green build without asking for a log or a result list', async () => {
    const green = {
      ...detailReplies(),
      '/timeline': {
        records: TIMELINE.records.map((record) =>
          record.result === 'failed' ? { ...record, result: 'succeeded', errorCount: 0 } : record,
        ),
      },
    }
    const { client, calls } = fakeClient(green)

    const detail = await loadCheckDetail(client, { projectId: PROJECT, buildId: BUILD })

    expect(detail.failingStep).toBeNull()
    expect(detail.log).toBeNull()
    expect(paths(calls).some((path) => path.includes('/logs/'))).toBe(false)
  })
})

describe('the writes, which have never been sent', () => {
  it('retries a build with retry=true and the default api-version', async () => {
    const { client, writes } = fakeClient({})

    await retryBuild(client, { projectId: PROJECT, buildId: BUILD })

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `${PROJECT}/_apis/build/builds/${BUILD}`,
        body: {},
        // No `api-version` of our own: the client injects 7.1, which this route
        // takes without a preview suffix.
        params: { retry: true },
      },
    ])
  })

  it('retries a stage with the two fields UpdateStageParameters has', async () => {
    const { client, writes } = fakeClient({})

    await retryStage(client, {
      projectId: PROJECT,
      buildId: BUILD,
      stageRefName: '__default',
      forceRetryAllJobs: false,
    })

    expect(writes[0].path).toBe(`${PROJECT}/_apis/build/builds/${BUILD}/stages/__default`)
    expect(writes[0].body).toEqual({ state: 'retry', forceRetryAllJobs: false })
  })

  it('reports a refusal rather than repeating the request', async () => {
    const { client, writes } = fakeClient({}, { written: new Error('Azure DevOps answered 403.') })

    await expect(retryBuild(client, { projectId: PROJECT, buildId: BUILD })).rejects.toThrow(
      'Azure DevOps answered 403.',
    )
    expect(writes).toHaveLength(1)
  })

  it('clears nothing it was not asked to clear', () => {
    const { client } = fakeClient({})

    // No cache for this client yet, which must not be an error.
    expect(() => clearBuildCache(client, PROJECT, BUILD)).not.toThrow()
  })
})

describe('the validators', () => {
  it('refuses anything that is not a project GUID and a build number', () => {
    expect(() => checkDetailRequest({ projectId: PROJECT, buildId: BUILD })).not.toThrow()
    expect(() => checkDetailRequest({ projectId: '../../secrets', buildId: BUILD })).toThrow(
      'projectId must be a GUID.',
    )
    expect(() => checkDetailRequest({ projectId: PROJECT, buildId: 0 })).toThrow(
      'buildId must be a positive number.',
    )
    expect(() => checkDetailRequest({ projectId: PROJECT, buildId: '194571' })).toThrow(
      'buildId must be a positive number.',
    )
    expect(() => buildRetryRequest({ projectId: PROJECT, buildId: -1 })).toThrow(
      'buildId must be a positive number.',
    )
  })

  it('refuses a stage name that is not a stage identifier', () => {
    const base = { projectId: PROJECT, buildId: BUILD, forceRetryAllJobs: false }

    expect(stageRetryRequest({ ...base, stageRefName: '__default' }).stageRefName).toBe('__default')
    expect(() => stageRetryRequest({ ...base, stageRefName: '../builds/1' })).toThrow(
      'stageRefName must be a stage identifier.',
    )
    expect(() => stageRetryRequest({ ...base, stageRefName: '' })).toThrow(
      'stageRefName must be a stage identifier.',
    )
    expect(() =>
      stageRetryRequest({ projectId: PROJECT, buildId: BUILD, stageRefName: '__default' }),
    ).toThrow('forceRetryAllJobs must be true or false.')
  })
})
