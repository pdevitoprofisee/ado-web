import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BuildDetail } from './detail'
import { STACK_TRACE_CHARS } from '@/lib/checks-contract'

import type {
  BuildRun,
  CheckDetail,
  CheckSummary,
  FailedTest,
  LogSlice,
  TestRunSummary,
  TimelineNode,
  TimelineType,
} from '@/lib/checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// What an opened row is allowed to claim.
//
// Three of the assertions here are about restraint rather than about output: the
// log says it is a tail, the test list says how many failures are off the screen,
// and the stack trace says twice over that it is not the whole thing (once for our
// 1200 characters, once for the service's 4000). All three exist because the
// opposite is what a reviewer would act on.
//
// The fixtures are the sampled build: 2727 lines of log on the `Check formatting`
// task, 29 results of which 28 failed, and a stack trace Azure DevOps had already
// cut off.

vi.mock('@/server/checks-fn', () => ({ checkDetailQuery: vi.fn(), retryBuildRun: vi.fn() }))
vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const { checkDetailQuery, retryBuildRun } = await import('@/server/checks-fn')

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

/** The one leaf that broke, as `buildTimeline` hands it over. */
const step = (over: Partial<TimelineNode> = {}): TimelineNode => ({
  id: '9e0a2a1c-1111-4a5f-9a4c-2f0f0e0d0c0b',
  type: 'Task',
  name: 'Check formatting',
  state: 'completed',
  result: 'failed',
  startedAt: '2026-07-21T14:09:02.11Z',
  finishedAt: '2026-07-21T14:09:33.42Z',
  durationMs: 31_310,
  log: { id: 22, lineCount: 2727 },
  errorCount: 1,
  warningCount: 0,
  issues: [
    {
      type: 'error',
      category: 'General',
      message: 'CSharpier - Was not formatted: src/Services.Matching/Stats/StatTrakReader.cs',
      logLine: 45,
      sourcePath: 'src/Services.Matching/Stats/StatTrakReader.cs',
      sourceLine: 233,
    },
  ],
  children: [],
  isFailingStep: true,
  ...over,
})

/**
 * A record that is mid-flight, for building the chain a running build reports.
 *
 * The sampled in-progress timeline said `inProgress` on four records at once —
 * Stage, Phase, Job, Task — with no result, no finish time and no issues on any of
 * them, which is what makes "which one do you name" a question at all.
 */
const inflight = (type: TimelineType, name: string, children: TimelineNode[] = []): TimelineNode =>
  step({
    id: `${type}-${name}`,
    type,
    name,
    state: 'inProgress',
    result: null,
    finishedAt: null,
    durationMs: null,
    log: null,
    errorCount: 0,
    issues: [],
    children,
    isFailingStep: false,
  })

/** A tail: 200 lines out of the 2727 the sampled log held. */
const tail = (over: Partial<LogSlice> = {}): LogSlice => ({
  logId: 22,
  lines: Array.from({ length: 200 }, (_, at) => `##[error] line ${at + 2528}`),
  firstLine: 2527,
  totalLines: 2727,
  truncated: true,
  ...over,
})

const run = (over: Partial<TestRunSummary> = {}): TestRunSummary => ({
  id: 1_486_291,
  name: 'Matching.UnitTests',
  state: 'Completed',
  total: 29,
  passed: 0,
  notApplicable: 1,
  incomplete: 0,
  failed: 28,
  webUrl: 'https://dev.azure.com/profisee/_TestManagement/Runs?runId=1486291',
  ...over,
})

const failedTest = (at: number): FailedTest => ({
  id: 100_000 + at,
  name: `Matching.UnitTests.StatTrakReaderTests.Reads_case_${at}`,
  assembly: 'Matching.UnitTests.dll',
  errorMessage: 'Expected 4 but found 7.',
  // Already 1200 characters, because that is what the server hands over — and the
  // 4000 Azure DevOps cut it at is not recoverable from here.
  stackTrace: 'a'.repeat(STACK_TRACE_CHARS),
  durationMs: 41,
  url: `https://dev.azure.com/profisee/_TestManagement/Runs?runId=1486291&_a=resultSummary&resultId=${at}`,
})

const detail = (over: Partial<CheckDetail> = {}): CheckDetail => ({
  build: build(),
  timeline: [step()],
  failingStep: step(),
  log: tail(),
  testRuns: [run()],
  failedTests: Array.from({ length: 25 }, (_, at) => failedTest(at + 1)),
  errors: { checks: null, builds: null, timeline: null, tests: null },
  ...over,
})

function draw(over: Partial<CheckDetail> = {}, props: { check?: CheckSummary; build?: BuildRun } = {}) {
  vi.mocked(checkDetailQuery).mockResolvedValue({
    detail: detail(over),
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })

  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BuildDetail prRef={REF} check={props.check ?? check()} build={props.build ?? build()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(checkDetailQuery).mockReset()
  vi.mocked(retryBuildRun).mockReset()
})

describe('BuildDetail', () => {
  it('names the one step that broke and where in the source it happened', async () => {
    draw()

    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
    // The issue's `sourcepath`/`linenumber`, which were present on 62 of 95 sampled
    // issues and are the only mapping from a build error to a file.
    expect(
      screen.getByText('src/Services.Matching/Stats/StatTrakReader.cs:233'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Was not formatted: src\/Services.Matching\/Stats\/StatTrakReader.cs/),
    ).toBeInTheDocument()
  })

  it('says the log is a tail and how much of it is not on the screen', async () => {
    draw()

    // The sentence the whole log section exists for. Without it, a reader who
    // scrolls to the top of 200 lines and finds no cause concludes there was none.
    expect(await screen.findByText('the last 200 of 2727 lines')).toBeInTheDocument()
  })

  it('says which lines a centred window is showing', async () => {
    // `TimelineIssue.logLine` put the error at line 45 of 2727, so the window is
    // centred there rather than taken from the end — a tail would have missed it.
    draw({ log: tail({ firstLine: 0, lines: Array.from({ length: 200 }, () => 'x') }) })

    expect(await screen.findByText('lines 1–200 of 2727')).toBeInTheDocument()
  })

  it('says a short log is all of it', async () => {
    draw({ log: tail({ lines: ['one', 'two'], firstLine: 0, totalLines: 47, truncated: false }) })

    expect(await screen.findByText('all 47 lines')).toBeInTheDocument()
  })

  it('reads an empty answer as an empty log rather than as a failure', async () => {
    // A log id that does not exist answers 200 with an empty body, and so does a
    // start line past the end. There is no error to report, only an emptiness.
    draw({ log: tail({ lines: [], truncated: false, totalLines: 47 }) })

    expect(
      await screen.findByText(/Azure DevOps returned nothing for this step’s log/),
    ).toBeInTheDocument()
  })

  it('shows the failures, never the passes, and says how many it left out', async () => {
    draw()

    const tests = await screen.findByRole('list', { name: 'Failed tests' })

    // 25 of the 28 the run reported, and the 28 comes from subtracting passes and
    // skips because a run carries no failure count at all.
    expect(within(tests).getAllByRole('button')).toHaveLength(25)
    expect(screen.getByText(/showing 25/)).toBeInTheDocument()
    expect(screen.getByText('28')).toBeInTheDocument()
  })

  it('does not say "showing 25" when 25 is all there were', async () => {
    draw({ testRuns: [run({ total: 26, failed: 25 })] })

    expect(await screen.findByRole('list', { name: 'Failed tests' })).toBeInTheDocument()
    expect(screen.queryByText(/showing/)).not.toBeInTheDocument()
  })

  it('draws no test section for a run with nothing failing in it', async () => {
    // `total: 40 / passed: 39 / notApplicable: 1` is zero failures — the case that
    // makes subtraction worth doing rather than counting results.
    draw({
      testRuns: [run({ total: 40, passed: 39, notApplicable: 1, failed: 0 })],
      failedTests: [],
    })

    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Failed tests' })).not.toBeInTheDocument()
  })

  it('keeps a stack trace shut, and never calls it complete when it opens', async () => {
    draw()

    const tests = await screen.findByRole('list', { name: 'Failed tests' })
    const first = within(tests).getAllByRole('button')[0]

    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/first 1200 characters/)).not.toBeInTheDocument()

    await userEvent.click(first)

    expect(screen.getByText('Expected 4 but found 7.')).toBeInTheDocument()
    // Both truncations named: ours, and the one the service had already applied.
    expect(
      screen.getByText(/first 1200 characters, and Azure DevOps had already cut it at 4000/),
    ).toBeInTheDocument()
  })

  it('loses a timeline without losing the tests, and the other way round', async () => {
    draw({
      failingStep: null,
      log: null,
      errors: {
        checks: null,
        builds: null,
        timeline: 'Azure DevOps answered 500.',
        tests: null,
      },
    })

    expect(await screen.findByText(/Could not read this build’s timeline/)).toBeInTheDocument()
    // The failures still arrived, which is the point of four error fields.
    expect(screen.getByRole('list', { name: 'Failed tests' })).toBeInTheDocument()

    draw({
      testRuns: [],
      failedTests: [],
      errors: { checks: null, builds: null, timeline: null, tests: 'Azure DevOps answered 500.' },
    })

    expect(await screen.findByText(/Could not read this build’s tests/)).toBeInTheDocument()
  })

  it('says a build failed before its steps rather than blaming a missing timeline', async () => {
    draw({ failingStep: null, log: null, testRuns: [], failedTests: [] })

    expect(
      await screen.findByText(/reported no failing step — the build failed before or after/),
    ).toBeInTheDocument()
  })

  it('says which step a running build is on, and names the innermost one', async () => {
    const live = build({ status: 'inProgress', result: null, finishedAt: null })

    draw(
      {
        build: live,
        timeline: [
          inflight('Stage', '__default', [
            inflight('Phase', 'Test_and_Analyze', [
              inflight('Job', 'Test_and_Analyze', [inflight('Task', 'dotnet test')]),
            ]),
          ]),
        ],
        failingStep: null,
        log: null,
        testRuns: [],
        failedTests: [],
      },
      { build: live, check: check({ status: 'running', requeueId: null }) },
    )

    expect(await screen.findByText('dotnet test')).toBeInTheDocument()
    // Not the containers above it: three of the four records in the chain say
    // `inProgress` about something they are only waiting on.
    expect(screen.queryByText('Test_and_Analyze')).not.toBeInTheDocument()
  })

  it('says a build that has not started has no step yet', async () => {
    // A `notStarted` build's timeline came back empty, so there is neither a failing
    // step nor a running one, and "no failing step" would be a lie about a build
    // that has not had the chance to fail.
    const queued = build({ status: 'notStarted', result: null, startedAt: null, finishedAt: null })

    draw(
      { build: queued, timeline: [], failingStep: null, log: null, testRuns: [], failedTests: [] },
      { build: queued, check: check({ status: 'queued' }) },
    )

    expect(await screen.findByText(/No step has started yet/)).toBeInTheDocument()
  })

  it('keeps the failing step when it was the log that would not read', async () => {
    // `errors.timeline` carries both, because the frozen contract has one field for
    // the tree and its log — and a lost log must not cost the reader the step.
    draw({
      log: null,
      errors: {
        checks: null,
        builds: null,
        timeline: "This step's log is 4200 kB, too large to show here.",
        tests: null,
      },
    })

    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
    expect(screen.getByText(/4200 kB, too large to show here/)).toBeInTheDocument()
  })

  it('offers the rest of a log it only showed a window of', async () => {
    draw()

    // The honest control for the other 2527 lines: ADO's own log viewer pages them,
    // and `view=logs` is the tab it does it on.
    const link = await screen.findByRole('link', { name: /the whole log in Azure DevOps/ })

    expect(link).toHaveAttribute('href', `${build().webUrl}&view=logs`)
  })

  it('offers nothing further when it showed the whole log', async () => {
    draw({ log: tail({ lines: ['one', 'two'], firstLine: 0, totalLines: 47, truncated: false }) })

    expect(await screen.findByText('all 47 lines')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /the whole log/ })).not.toBeInTheDocument()
  })

  it('warns when the verdict was reached on an older version of the branch', async () => {
    // 2 of 27 sampled evaluations. A green build against a stale merge commit is
    // the one verdict on this page that can mislead a reviewer into merging.
    draw({}, { check: check({ build: { ...check().build!, isNotCurrent: true } }) })

    expect(
      await screen.findByText('This build ran on an earlier version of the branch.'),
    ).toBeInTheDocument()
  })

  it('says the build is gone rather than that the read broke', async () => {
    vi.mocked(checkDetailQuery).mockResolvedValue({
      detail: null,
      error: 'Azure DevOps answered 404.',
      connected: true,
      notFound: true,
      rateLimit: null,
    })

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BuildDetail prRef={REF} check={check()} build={build()} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText(/no longer has this build/)).toBeInTheDocument()
  })
})

describe('the three ways to run it again', () => {
  it('offers the requeue that works, and sends it', async () => {
    const { requeuePolicy } = await import('@/server/pull-request-fn')
    vi.mocked(requeuePolicy).mockResolvedValue({ ok: true, error: null, connected: true })

    draw()

    const button = await screen.findByRole('button', { name: 'Requeue the policy' })
    expect(button).toBeEnabled()

    await userEvent.click(button)

    expect(vi.mocked(requeuePolicy)).toHaveBeenCalledWith({
      data: { projectId: REF.projectId, evaluationId: check().requeueId },
    })
  })

  it('refuses to requeue a running policy, and says why', async () => {
    // Requeueing cancels the build that is running, which is the answer the
    // reviewer is waiting for — so the control is not merely greyed out.
    draw({}, { check: check({ status: 'running', requeueId: null }) })

    const button = await screen.findByRole('button', { name: 'Requeue the policy' })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(/cancels the build that is running/)
  })

  it('will not retry a build that has not finished, and says why', async () => {
    draw({ build: build({ status: 'inProgress', result: null, finishedAt: null }) }, {
      build: build({ status: 'inProgress', result: null, finishedAt: null }),
    })

    const button = await screen.findByRole('button', { name: 'Retry the build' })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(/has not finished/)
  })

  it('ships stage retry disabled, with the measurement that makes it pointless', async () => {
    // 0 of 10 pipelines in this organisation declare a stage identifier other than
    // `__default`, and `TimelineNode` carries no identifier to name one with. The
    // control is drawn so the reason is readable once.
    draw()

    const button = await screen.findByRole('button', { name: 'Retry the stage' })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(/__default/)
  })

  it('prints the refusal a build retry has never been proved not to get', async () => {
    vi.mocked(retryBuildRun).mockResolvedValue({
      ok: false,
      error: 'Azure DevOps answered 403.',
      connected: true,
    })

    draw()

    await userEvent.click(await screen.findByRole('button', { name: 'Retry the build' }))

    expect(
      await screen.findByText('Azure DevOps refused it: Azure DevOps answered 403.'),
    ).toBeInTheDocument()
  })

  it('offers the re-runs before the detail has arrived, because that is when they are wanted', async () => {
    // Held open, so the detail never lands. "This failed and I cannot tell you
    // why" is exactly the moment somebody presses one of these.
    vi.mocked(checkDetailQuery).mockImplementation(() => new Promise(() => {}))

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BuildDetail prRef={REF} check={check()} build={build()} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('button', { name: 'Retry the build' })).toBeEnabled()
    expect(screen.getByText('Reading the build…')).toBeInTheDocument()
  })
})
