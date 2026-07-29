import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChecksPanel } from './panel'

import type {
  BuildRun,
  CheckDetail,
  CheckSummary,
  ChecksReport,
  TimelineNode,
} from '@/lib/checks-contract'
import type { PullRequestRef } from '@/server/pull-request'

// What the list is allowed to cost, and what it must not make anyone ask twice for.
//
// The two claims that matter are opposites of each other. A build that failed opens
// itself, because "which step broke" is the question this panel exists to answer and
// a click is a second question. A build that passed stays one line **and is never
// fetched at all** — opening a row is five or six ADO calls and up to 200 KB, so
// four green rows opening on mount would be twenty-odd calls to say "fine, fine,
// fine, fine".
//
// The third is the partial failure. `ChecksErrors` and `CheckFailure` exist because
// one build read can 404 while four are fine, and a panel that threw the four away
// would be the bug that shape was designed to prevent.

vi.mock('@/server/checks-fn', () => ({
  checksReportQuery: vi.fn(),
  checkDetailQuery: vi.fn(),
  retryBuildRun: vi.fn(),
}))

vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const { checkDetailQuery, checksReportQuery } = await import('@/server/checks-fn')

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
  issues: [],
  children: [],
  isFailingStep: true,
  ...over,
})

const detail = (over: Partial<CheckDetail> = {}): CheckDetail => ({
  build: build(),
  timeline: [step()],
  failingStep: step(),
  log: null,
  testRuns: [],
  failedTests: [],
  errors: { checks: null, builds: null, timeline: null, tests: null },
  ...over,
})

function draw(over: Partial<ChecksReport> = {}, detailOver: Partial<CheckDetail> = {}) {
  vi.mocked(checksReportQuery).mockResolvedValue({
    report: {
      checks: [check()],
      builds: [build()],
      errors: { checks: null, builds: null, timeline: null, tests: null },
      failed: [],
      ...over,
    },
    error: null,
    connected: true,
    rateLimit: null,
  })
  vi.mocked(checkDetailQuery).mockResolvedValue({
    detail: detail(detailOver),
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })

  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChecksPanel prRef={REF} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(checksReportQuery).mockReset()
  vi.mocked(checkDetailQuery).mockReset()
})

describe('ChecksPanel', () => {
  it('puts the failing step on the screen without a click', async () => {
    draw()

    // Not "after opening the row": the row that failed arrives open, and the step
    // name is the first thing a reviewer came here to read.
    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Matching CI/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('keeps a passing build to one line, and does not pay for it', async () => {
    draw({
      checks: [check({ status: 'approved' })],
      builds: [build({ result: 'succeeded' })],
    })

    const row = await screen.findByRole('button', { name: /Matching CI/ })

    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(within(row).getByText('succeeded')).toBeInTheDocument()
    // The second read is what a row costs, and nobody asked for it.
    expect(vi.mocked(checkDetailQuery)).not.toHaveBeenCalled()

    await userEvent.click(row)

    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
  })

  it('opens a build that is still running, because "which step" is the question', async () => {
    const live = build({ status: 'inProgress', result: null, finishedAt: null })

    draw(
      { checks: [check({ status: 'running', requeueId: null })], builds: [live] },
      {
        build: live,
        failingStep: null,
        timeline: [step({ state: 'inProgress', result: null, name: 'dotnet test' })],
      },
    )

    expect(await screen.findByText('dotnet test')).toBeInTheDocument()
  })

  it('names the one build that would not load and keeps the ones that did', async () => {
    const other = check({
      id: '55555555-5555-5555-5555-555555555555',
      name: 'Platform CI',
      build: {
        buildId: 194600,
        definitionId: 900,
        definitionName: 'Platform CI',
        startedAt: '2026-07-21T14:02:11.113Z',
        isNotCurrent: false,
      },
    })

    draw({
      checks: [check(), other],
      // 194600 is missing from `builds` on purpose: its read is the one that failed.
      builds: [build()],
      failed: [{ checkId: other.id, message: 'Azure DevOps answered 500.' }],
    })

    expect(
      await screen.findByText(/Could not read this check’s build. Azure DevOps answered 500./),
    ).toBeInTheDocument()
    // And the good news is still here — the failing step of the build that did load,
    // on the screen, unaffected by the read that did not.
    expect(await screen.findByText('Check formatting')).toBeInTheDocument()
    expect(screen.getByText('Platform CI')).toBeInTheDocument()
    // Nothing to open on the row that has no build, so it is not a button.
    expect(screen.getAllByRole('button', { name: /CI/ })).toHaveLength(1)
  })

  it('says the whole build read failed without pretending the list is empty', async () => {
    draw({ errors: { checks: null, builds: 'Azure DevOps answered 500.', tests: null, timeline: null } })

    expect(
      await screen.findByText(/Could not read any of this pull request’s builds/),
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Build checks' })).toBeInTheDocument()
  })

  it('tells the policy call failing apart from there being no build policy', async () => {
    draw({ errors: { checks: 'Azure DevOps answered 500.', builds: null, tests: null, timeline: null } })

    expect(await screen.findByText(/Could not read the build policies/)).toBeInTheDocument()
    // No count beside the heading: "Checks 0" is a claim, and the read that would
    // have produced it is the thing that just failed.
    expect(screen.getByRole('heading')).toHaveTextContent(/^Checks$/)
  })

  it('says so when no build policy has run', async () => {
    draw({ checks: [], builds: [] })

    expect(
      await screen.findByText('No build policy has run on this pull request.'),
    ).toBeInTheDocument()
  })
})
