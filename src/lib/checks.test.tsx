import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkDetailKey,
  checksKey,
  isRunning,
  useCheckDetail,
  useChecks,
  useRequeueCheck,
  useRetryBuild,
} from './checks'
import { pullRequestKey } from './requeue'
import { checkDetailQuery, checksReportQuery, retryBuildRun } from '@/server/checks-fn'
import { requeuePolicy } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { BuildRun, CheckDetail, CheckSummary, ChecksReport } from './checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// Three claims, none of which the server tests can make: that a page whose builds
// have all finished stops asking, that a refusal Azure DevOps *returned* becomes
// something a button can print, and that both surfaces drawing an evaluation get
// re-read when one of them acts on it.

vi.mock('@/server/checks-fn', () => ({
  checksReportQuery: vi.fn(),
  checkDetailQuery: vi.fn(),
  retryBuildRun: vi.fn(),
}))

vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24766,
}

const check = (over: Partial<CheckSummary> = {}): CheckSummary => ({
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Matching CI',
  status: 'rejected',
  blocking: true,
  build: {
    buildId: 194571,
    definitionId: 812,
    definitionName: 'Matching CI',
    startedAt: '2026-07-21T14:02:11.113Z',
    isNotCurrent: false,
  },
  url: null,
  requeueId: '44444444-4444-4444-4444-444444444444',
  ...over,
})

const build = (over: Partial<BuildRun> = {}): BuildRun => ({
  id: 194571,
  number: '1.0.0.84',
  status: 'completed',
  result: 'failed',
  queuedAt: '2026-07-21T14:01:55.5Z',
  startedAt: '2026-07-21T14:02:11.113Z',
  finishedAt: '2026-07-21T14:11:36.34Z',
  reason: 'pullRequest',
  webUrl: 'https://dev.azure.com/profisee/_build/results?buildId=194571',
  ...over,
})

const report = (over: Partial<ChecksReport> = {}): ChecksReport => ({
  checks: [check()],
  builds: [build()],
  errors: { checks: null, builds: null, timeline: null, tests: null },
  failed: [],
  ...over,
})

const answer = (over: Partial<ChecksReport> = {}) => ({
  report: report(over),
  error: null,
  connected: true,
  rateLimit: null,
})

function providers(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

/**
 * The poll interval react-query would actually use, asked of the live query.
 *
 * `refetchInterval` is a function here — the decision is made from the answer —
 * so the only way to assert it is to hand it the query it was given. Reading the
 * observer's options rather than watching the clock, because what is being claimed
 * is "this decides not to poll", and a test that waited to see nothing arrive
 * would pass just as well if the interval were merely long.
 */
function interval(client: QueryClient, key: readonly unknown[]): number | false | undefined {
  const query = client.getQueryCache().find({ queryKey: key })
  if (query === undefined) throw new Error('no query under that key')

  const option = query.observers[0]?.options.refetchInterval

  return typeof option === 'function' ? option(query) : option
}

beforeEach(() => {
  vi.mocked(checksReportQuery).mockReset()
  vi.mocked(checkDetailQuery).mockReset()
  vi.mocked(retryBuildRun).mockReset()
  vi.mocked(requeuePolicy).mockReset()
})

describe('isRunning', () => {
  it('says no about nothing, because a page with no answer yet is not a page with news', () => {
    expect(isRunning(null)).toBe(false)
  })

  it('says no once every check has settled and every build has finished', () => {
    expect(isRunning(report())).toBe(false)
  })

  it('says yes about a policy that is not yet met, even before it has a build', () => {
    // 35 of 150 sampled evaluations read `queued` with no `context.buildId` at
    // all: the build is coming, and there is nothing else to watch for it.
    expect(isRunning(report({ checks: [check({ status: 'queued', build: null })], builds: [] }))).toBe(
      true,
    )
  })

  it('says yes about a build still going under a check that has already settled', () => {
    // The two halves disagree because they are written by different services. A
    // rejected policy with a running retry underneath it is a page worth re-asking.
    expect(
      isRunning(report({ builds: [build({ status: 'inProgress', result: null, finishedAt: null })] })),
    ).toBe(true)
  })

  it('treats a broken policy as settled, because only an edit will fix it', () => {
    expect(isRunning(report({ checks: [check({ status: 'broken' })] }))).toBe(false)
  })
})

describe('useChecks', () => {
  it('asks for the pull request it was given and indexes the builds by id', async () => {
    vi.mocked(checksReportQuery).mockResolvedValue(answer())

    const { result } = renderHook(() => useChecks(REF), { wrapper: providers(fresh()) })

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(vi.mocked(checksReportQuery)).toHaveBeenCalledWith({ data: REF })
    // `BuildLink.buildId` is the only handle a check has on its build, so the map
    // has to be keyed by that and not by position: five policies can share one.
    expect(result.current.builds.get(194571)?.number).toBe('1.0.0.84')
  })

  it('stops asking once nothing is moving, and keeps asking while something is', async () => {
    const client = fresh()
    vi.mocked(checksReportQuery).mockResolvedValue(answer())

    const { result } = renderHook(() => useChecks(REF), { wrapper: providers(client) })
    await waitFor(() => expect(result.current.pending).toBe(false))

    // A finished build's verdict cannot change on its own, and a review tab is
    // very often left open on exactly this state for an afternoon.
    expect(interval(client, checksKey(REF))).toBe(false)

    const running = fresh()
    vi.mocked(checksReportQuery).mockResolvedValue(
      answer({ builds: [build({ status: 'inProgress', result: null, finishedAt: null })] }),
    )
    const live = renderHook(() => useChecks(REF), { wrapper: providers(running) })
    await waitFor(() => expect(live.result.current.pending).toBe(false))

    expect(interval(running, checksKey(REF))).toBeGreaterThan(0)
  })

  it('hands back the sections that failed without losing the ones that did not', async () => {
    vi.mocked(checksReportQuery).mockResolvedValue(
      answer({
        errors: {
          checks: null,
          builds: null,
          timeline: null,
          tests: null,
        },
        failed: [{ checkId: check().id, message: 'Azure DevOps answered 404.' }],
      }),
    )

    const { result } = renderHook(() => useChecks(REF), { wrapper: providers(fresh()) })

    await waitFor(() => expect(result.current.failed).toHaveLength(1))
    // The check is still drawn — one build failing to load is a row with a
    // sentence under it, not a panel with an error in place of five rows.
    expect(result.current.checks).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('says the read failed when the read failed, and that it is disconnected when it is', async () => {
    vi.mocked(checksReportQuery).mockResolvedValue({
      report: null,
      error: 'No Azure DevOps connection is configured.',
      connected: false,
      rateLimit: null,
    })

    const { result } = renderHook(() => useChecks(REF), { wrapper: providers(fresh()) })

    await waitFor(() => expect(result.current.error).toBe('No Azure DevOps connection is configured.'))
    expect(result.current.connected).toBe(false)
    expect(result.current.checks).toEqual([])
  })
})

describe('useCheckDetail', () => {
  const detail = (over: Partial<CheckDetail> = {}): CheckDetail => ({
    build: build(),
    timeline: [],
    failingStep: null,
    log: null,
    testRuns: [],
    failedTests: [],
    errors: { checks: null, builds: null, timeline: null, tests: null },
    ...over,
  })

  const found = (over: Partial<CheckDetail> = {}) => ({
    detail: detail(over),
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })

  it('reads the build it was given and does not poll a finished one', async () => {
    vi.mocked(checkDetailQuery).mockResolvedValue(found())

    const client = fresh()
    const { result } = renderHook(() => useCheckDetail(REF.projectId, 194571, false), {
      wrapper: providers(client),
    })

    await waitFor(() => expect(result.current.detail).not.toBeNull())
    expect(vi.mocked(checkDetailQuery)).toHaveBeenCalledWith({
      data: { projectId: REF.projectId, buildId: 194571 },
    })
    expect(interval(client, checkDetailKey(REF.projectId, 194571))).toBe(false)
  })

  it('polls a build that is still being written', async () => {
    vi.mocked(checkDetailQuery).mockResolvedValue(
      found({ build: build({ status: 'inProgress', result: null, finishedAt: null }) }),
    )

    const client = fresh()
    const { result } = renderHook(() => useCheckDetail(REF.projectId, 194571, true), {
      wrapper: providers(client),
    })

    await waitFor(() => expect(result.current.detail).not.toBeNull())
    expect(interval(client, checkDetailKey(REF.projectId, 194571))).toBeGreaterThan(0)
  })

  it('stops polling when its own answer says the build finished, whatever the row thought', async () => {
    // The row's `live` came from the list, which is up to 30 seconds behind. The
    // detail's own read is the newer fact and wins.
    vi.mocked(checkDetailQuery).mockResolvedValue(found())

    const client = fresh()
    const { result } = renderHook(() => useCheckDetail(REF.projectId, 194571, true), {
      wrapper: providers(client),
    })

    await waitFor(() => expect(result.current.detail).not.toBeNull())
    expect(interval(client, checkDetailKey(REF.projectId, 194571))).toBe(false)
  })

  it('distinguishes a build retention deleted from a call that broke', async () => {
    vi.mocked(checkDetailQuery).mockResolvedValue({
      detail: null,
      error: 'Azure DevOps answered 404.',
      connected: true,
      notFound: true,
      rateLimit: null,
    })

    const { result } = renderHook(() => useCheckDetail(REF.projectId, 194571, false), {
      wrapper: providers(fresh()),
    })

    await waitFor(() => expect(result.current.notFound).toBe(true))
  })
})

describe('useRequeueCheck', () => {
  it('sends the evaluation id and re-reads both surfaces that draw it', async () => {
    vi.mocked(requeuePolicy).mockResolvedValue({ ok: true, error: null, connected: true })

    const client = fresh()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useRequeueCheck(REF, check()), {
      wrapper: providers(client),
    })

    result.current.ask()

    await waitFor(() => expect(vi.mocked(requeuePolicy)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(requeuePolicy)).toHaveBeenCalledWith({
      data: { projectId: REF.projectId, evaluationId: check().requeueId },
    })

    // The checklist above the panel and the row that was pressed are two drawings
    // of one evaluation, so both keys go stale together.
    await waitFor(() => {
      expect(invalidated).toHaveBeenCalledWith({ queryKey: checksKey(REF) })
      expect(invalidated).toHaveBeenCalledWith({ queryKey: pullRequestKey(REF) })
    })
  })

  it('surfaces what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(requeuePolicy).mockResolvedValue({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    const client = fresh()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useRequeueCheck(REF, check()), {
      wrapper: providers(client),
    })

    result.current.ask()

    await waitFor(() =>
      expect(result.current.error).toBe(
        'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      ),
    )
    // A write that was refused on the way back may still have landed, which is the
    // whole reason this is `onSettled`.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: checksKey(REF) })
  })

  it('refuses a check with no evaluation behind it before touching the network', async () => {
    const { result } = renderHook(() => useRequeueCheck(REF, check({ requeueId: null })), {
      wrapper: providers(fresh()),
    })

    result.current.ask()

    await waitFor(() =>
      expect(result.current.error).toBe('That check has no evaluation to requeue.'),
    )
    expect(vi.mocked(requeuePolicy)).not.toHaveBeenCalled()
  })
})

describe('useRetryBuild', () => {
  it('sends the build and drops both the list and the open row', async () => {
    vi.mocked(retryBuildRun).mockResolvedValue({ ok: true, error: null, connected: true })

    const client = fresh()
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useRetryBuild(REF, REF.projectId, 194571), {
      wrapper: providers(client),
    })

    result.current.ask()

    await waitFor(() =>
      expect(vi.mocked(retryBuildRun)).toHaveBeenCalledWith({
        data: { projectId: REF.projectId, buildId: 194571 },
      }),
    )
    await waitFor(() => {
      expect(invalidated).toHaveBeenCalledWith({ queryKey: checksKey(REF) })
      expect(invalidated).toHaveBeenCalledWith({
        queryKey: checkDetailKey(REF.projectId, 194571),
      })
    })
  })

  it('prints the 403 this write has never been proved not to get', async () => {
    // The stored token was only ever shown to hold `vso.build`. Until T-040 sends
    // one of these for real, "Azure DevOps refused it" is the likeliest outcome
    // and has to be legible rather than swallowed.
    vi.mocked(retryBuildRun).mockResolvedValue({
      ok: false,
      error: 'Azure DevOps answered 403.',
      connected: true,
    })

    const { result } = renderHook(() => useRetryBuild(REF, REF.projectId, 194571), {
      wrapper: providers(fresh()),
    })

    result.current.ask()

    await waitFor(() => expect(result.current.error).toBe('Azure DevOps answered 403.'))
  })

  it('says something sayable when the refusal came with no reason', async () => {
    vi.mocked(retryBuildRun).mockResolvedValue({ ok: false, error: null, connected: true })

    const { result } = renderHook(() => useRetryBuild(REF, REF.projectId, 194571), {
      wrapper: providers(fresh()),
    })

    result.current.ask()

    await waitFor(() => expect(result.current.error).toBe('Azure DevOps did not say why.'))
  })
})
