import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useResolveCallout } from './pipeline-callout'
import { changeThreadStatus } from '@/server/threads-fn'

import type { PullRequestRow } from '@/server/inbox'

// What the inbox button cannot be asked about: that every thread on the row is
// closed and not just the first, that a refusal Azure DevOps *returned* becomes a
// rejection the row can print, and that the row is re-read either way.

vi.mock('@/server/threads-fn', () => ({
  changeThreadStatus: vi.fn(async () => ({
    ok: true,
    error: null,
    connected: true,
    rateLimit: null,
    thread: null,
  })),
}))

/** A refusal in the shape the server function returns one, `ok: false` and all. */
const refused = (error: string | null) =>
  ({ ok: false, error, connected: true, rateLimit: null, thread: null }) as const

const row = {
  id: 24698,
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
} as PullRequestRow

const mount = (refresh: (row: PullRequestRow) => Promise<void>) =>
  renderHook(() => useResolveCallout(refresh)).result

describe('useResolveCallout', () => {
  it('closes every callout on the row, then waits for the row to be re-read', async () => {
    const refresh = vi.fn(async () => {})

    await mount(refresh).current(row, [9, 12])

    expect(vi.mocked(changeThreadStatus)).toHaveBeenNthCalledWith(1, {
      data: {
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        id: 24698,
        threadId: 9,
        status: 'fixed',
      },
    })
    expect(vi.mocked(changeThreadStatus)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ threadId: 12 }) }),
    )
    expect(refresh).toHaveBeenCalledWith(row)
  })

  it('rejects with what Azure DevOps said, and still re-reads', async () => {
    vi.mocked(changeThreadStatus).mockResolvedValueOnce(
      refused('Azure DevOps answered 403. (TF401027: You need the Contribute permission.)'),
    )
    const refresh = vi.fn(async () => {})

    await expect(mount(refresh).current(row, [9])).rejects.toThrow('TF401027')

    // A write can be refused on the way back after it landed, so the badges are
    // only trustworthy after a fresh read.
    expect(refresh).toHaveBeenCalledWith(row)
  })

  it('stops at the first refusal rather than writing over the rest', async () => {
    vi.mocked(changeThreadStatus).mockResolvedValueOnce(refused('Azure DevOps answered 403.'))
    const refresh = vi.fn(async () => {})
    vi.mocked(changeThreadStatus).mockClear()

    await expect(mount(refresh).current(row, [9, 12, 15])).rejects.toThrow('403')

    expect(vi.mocked(changeThreadStatus)).toHaveBeenCalledTimes(1)
  })

  it('rejects with something sayable when the refusal came with no reason', async () => {
    vi.mocked(changeThreadStatus).mockResolvedValueOnce(refused(null))

    await expect(mount(async () => {}).current(row, [9])).rejects.toThrow(
      'Azure DevOps did not say why.',
    )
  })

  it('refuses a row Azure DevOps sent without its ids, rather than writing to nowhere', async () => {
    const refresh = vi.fn(async () => {})
    vi.mocked(changeThreadStatus).mockClear()

    await expect(
      mount(refresh).current({ ...row, repositoryId: null }, [9]),
    ).rejects.toThrow('did not send the ids')

    expect(vi.mocked(changeThreadStatus)).not.toHaveBeenCalled()
    // Nothing was written, so there is nothing to correct.
    expect(refresh).not.toHaveBeenCalled()
  })
})
