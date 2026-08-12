import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRequeueRow } from './requeue'
import { requeuePolicy } from '@/server/pull-request-fn'

import type { Hydration, HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

// The inbox half of this module only. `useRequeue`, the checklist's, is a
// react-query mutation and is covered where the checklist is drawn.
//
// What the table's button cannot be asked about: that every broken build on the
// row is queued and not just the first, that a refusal Azure DevOps *returned*
// becomes a rejection the row can print, and that the row is read again until the
// queue has actually moved.

vi.mock('@/server/pull-request-fn', () => ({
  requeuePolicy: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

/** A refusal in the shape the server function returns one, `ok: false` and all. */
const refused = (error: string | null) => ({ ok: false, error, connected: true }) as const

const PROJECT = '11111111-1111-1111-1111-111111111111'

const row = { id: 24698, projectId: PROJECT } as PullRequestRow

/** One re-read's worth of row. Only the two fields the ladder can see it by. */
const read = (over: Partial<Hydration> = {}): HydrationResult => ({
  id: 24698,
  ok: true,
  data: {
    checks: { passed: 0, failed: 1, failedBuilds: 1, running: 0, waiting: 0, waitingOnPeople: 0 },
    unresolved: 0,
    pipelineThreads: [],
    requeueIds: ['a'],
    approvalReset: false,
    blocked: true,
    readyToMerge: false,
    ...over,
  },
})

/** The same row, once the build this write asked for is running. */
const moved = read({
  checks: { passed: 0, failed: 0, failedBuilds: 0, running: 1, waiting: 0, waitingOnPeople: 0 },
  requeueIds: [],
})

const mount = (refresh: (row: PullRequestRow) => Promise<HydrationResult | undefined>) =>
  renderHook(() => useRequeueRow(refresh)).result

/**
 * Runs the clock past every wait in the ladder, then gives back what the press
 * did. The outcome is captured before the clock moves, because a press that is
 * refused is refused on the first tick and an unhandled rejection would fail the
 * run rather than the test.
 */
const settle = async (press: Promise<void>) => {
  const outcome = press.then(
    () => null,
    (reason: unknown) => reason,
  )
  await vi.advanceTimersByTimeAsync(10_000)

  const error = await outcome
  if (error !== null) throw error
}

describe('useRequeueRow', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('queues every build on the row, then reads the row again', async () => {
    const refresh = vi.fn(async () => read())

    await settle(mount(refresh).current(row, ['a', 'b']))

    expect(vi.mocked(requeuePolicy)).toHaveBeenNthCalledWith(1, {
      data: { projectId: PROJECT, evaluationId: 'a' },
    })
    expect(vi.mocked(requeuePolicy)).toHaveBeenNthCalledWith(2, {
      data: { projectId: PROJECT, evaluationId: 'b' },
    })
    expect(refresh).toHaveBeenCalledWith(row)
  })

  it('keeps reading until the row moves, because one read is too early to tell', async () => {
    // The measured failure this ladder exists for: ADO answers the write before
    // the evaluation has left `broken`, so the row drawn from the first read is
    // the row the button was pressed on.
    const refresh = vi.fn<() => Promise<HydrationResult>>()
    refresh.mockResolvedValueOnce(read()).mockResolvedValue(moved)

    await settle(mount(refresh).current(row, ['a']))

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('gives up after a bounded wait rather than reading forever', async () => {
    // A row still unchanged by then is left to the inbox's own cadence, which is
    // ninety seconds for a blocked row.
    const refresh = vi.fn(async () => read())

    await settle(mount(refresh).current(row, ['a']))

    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('rejects with what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(requeuePolicy).mockResolvedValueOnce(
      refused('Azure DevOps answered 403. (TF401027: You need the Contribute permission.)'),
    )
    const refresh = vi.fn(async () => read())

    await expect(settle(mount(refresh).current(row, ['a']))).rejects.toThrow('TF401027')

    // A write can be refused on the way back after it landed, so the row is only
    // trustworthy after a fresh read. Once, though: a write that failed has no
    // queue to wait on.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(row)
  })

  it('stops at the first refusal rather than queueing the rest', async () => {
    vi.mocked(requeuePolicy).mockResolvedValueOnce(refused('Azure DevOps answered 403.'))
    const refresh = vi.fn(async () => read())
    vi.mocked(requeuePolicy).mockClear()

    await expect(settle(mount(refresh).current(row, ['a', 'b', 'c']))).rejects.toThrow('403')

    expect(vi.mocked(requeuePolicy)).toHaveBeenCalledTimes(1)
  })

  it('rejects with something sayable when the refusal came with no reason', async () => {
    vi.mocked(requeuePolicy).mockResolvedValueOnce(refused(null))

    await expect(
      settle(mount(async () => read()).current(row, ['a'])),
    ).rejects.toThrow('Azure DevOps did not say why.')
  })

  it('refuses a row Azure DevOps sent without its project, rather than writing to nowhere', async () => {
    const refresh = vi.fn(async () => read())
    vi.mocked(requeuePolicy).mockClear()

    await expect(settle(mount(refresh).current({ ...row, projectId: null }, ['a']))).rejects.toThrow(
      'did not send the project',
    )

    expect(vi.mocked(requeuePolicy)).not.toHaveBeenCalled()
    // Nothing was written, so there is nothing to correct.
    expect(refresh).not.toHaveBeenCalled()
  })
})
