import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { groupByRepository, inReadingOrder, useGroupByRepository } from './pr-grouping'

import type { PullRequestRow } from '@/server/inbox'

let next = 3300

const row = (over: Partial<PullRequestRow> = {}): PullRequestRow => ({
  id: (next += 1),
  title: 'disable sql auditing',
  description: '',
  project: 'SaaS',
  repository: 'PC.IAC.Modules',
  author: 'Naveen Angali',
  targetBranch: 'main',
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  commitId: 'abc123',
  url: 'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
  viaTeam: null,
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  conflicted: false,
  myVote: 0,
  closed: null,
  ...over,
})

const inSaaS = (title: string) => row({ title })
const inProducts = (title: string, repository: string) =>
  row({ title, project: 'Products', repository })

const titles = (rows: readonly PullRequestRow[]) => rows.map((one) => one.title)

describe('groupByRepository', () => {
  it('has nothing to say about an empty inbox', () => {
    expect(groupByRepository([])).toEqual([])
  })

  it('keys a group on project and repository together, and labels it with the name alone', () => {
    expect(groupByRepository([inSaaS('one')])).toEqual([
      {
        key: 'SaaS/PC.IAC.Modules',
        label: 'PC.IAC.Modules',
        rows: [expect.objectContaining({ title: 'one' })],
      },
    ])
  })

  it('collects rows of the same repository that are not adjacent', () => {
    const groups = groupByRepository([
      inSaaS('one'),
      inProducts('two', 'platform'),
      inSaaS('three'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['PC.IAC.Modules', 'platform'])
    expect(titles(groups[0]!.rows)).toEqual(['one', 'three'])
  })

  // The one ordering promise: a poll cannot move a heading under a reader.
  it('orders groups alphabetically, not by their newest row', () => {
    const groups = groupByRepository([
      inProducts('newest', 'zzz-service'),
      inSaaS('older'),
      inProducts('oldest', 'alpha-service'),
    ])

    expect(groups.map((group) => group.label)).toEqual([
      'alpha-service',
      'PC.IAC.Modules',
      'zzz-service',
    ])
  })

  // The headings read alphabetically as *drawn*, which is not the order the keys
  // are in: `Products/zzz-service` sorts before `SaaS/PC.IAC.Modules`.
  it('sorts on the name it shows, not on the project in front of it', () => {
    const groups = groupByRepository([
      inProducts('one', 'zzz-service'),
      row({ title: 'two', project: 'Alpha', repository: 'middle' }),
    ])

    expect(groups.map((group) => group.label)).toEqual(['middle', 'zzz-service'])
  })

  it('leaves the rows inside a group in the order they arrived', () => {
    const groups = groupByRepository([inSaaS('first'), inSaaS('second'), inSaaS('third')])

    expect(titles(groups[0]!.rows)).toEqual(['first', 'second', 'third'])
  })

  // Two headings both reading `platform`, which is the accepted cost of dropping
  // the project — but two *groups*, never one bucket of both projects' rows.
  it('separates two repositories that share a name across projects', () => {
    const groups = groupByRepository([
      row({ title: 'one', project: 'SaaS', repository: 'platform' }),
      row({ title: 'two', project: 'Products', repository: 'platform' }),
    ])

    expect(groups.map((group) => group.key)).toEqual(['Products/platform', 'SaaS/platform'])
    expect(groups.map((group) => group.label)).toEqual(['platform', 'platform'])
    expect(titles(groups[0]!.rows)).toEqual(['two'])
  })
})

describe('inReadingOrder', () => {
  const ROWS = [inSaaS('one'), inProducts('two', 'platform'), inSaaS('three')]

  it('hands back the same array when the page is not grouped', () => {
    expect(inReadingOrder(ROWS, false)).toBe(ROWS)
  })

  // The whole point: this is what `j`/`k` walk, so it has to be what the page draws.
  it('flattens the groups in the order the page draws them', () => {
    expect(titles(inReadingOrder(ROWS, true))).toEqual(['one', 'three', 'two'])
  })

  it('keeps every row', () => {
    expect(inReadingOrder(ROWS, true)).toHaveLength(ROWS.length)
  })
})

describe('useGroupByRepository', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts flat', () => {
    expect(renderHook(() => useGroupByRepository()).result.current[0]).toBe(false)
  })

  it('remembers the choice for the next session', () => {
    const first = renderHook(() => useGroupByRepository())
    act(() => first.result.current[1](true))
    expect(first.result.current[0]).toBe(true)

    expect(renderHook(() => useGroupByRepository()).result.current[0]).toBe(true)
  })

  it('remembers being switched back off', () => {
    localStorage.setItem('ado-web.inbox.grouped', 'true')
    const { result } = renderHook(() => useGroupByRepository())
    expect(result.current[0]).toBe(true)

    act(() => result.current[1](false))
    expect(renderHook(() => useGroupByRepository()).result.current[0]).toBe(false)
  })

  // A hardened profile *throws* on `localStorage`, and an arrangement is not
  // worth a blank page.
  it('still toggles when storage is unavailable', () => {
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })

    try {
      const { result } = renderHook(() => useGroupByRepository())
      expect(result.current[0]).toBe(false)

      act(() => result.current[1](true))
      expect(result.current[0]).toBe(true)
    } finally {
      if (storage) Object.defineProperty(window, 'localStorage', storage)
    }
  })
})
