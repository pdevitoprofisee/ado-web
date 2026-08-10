import { describe, expect, it } from 'vitest'

import { filterPullRequests } from './pr-search'

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
  reviewers: [],
  closed: null,
  ...over,
})

const ROWS: readonly PullRequestRow[] = [
  row({ title: 'disable sql auditing', description: 'Turns the policy off on the shared server.' }),
  row({ title: 'bump the node image', project: 'Products', repository: 'platform' }),
  row({
    title: 'retry the deploy step',
    project: 'Products',
    repository: 'integrator-connector',
    description: 'Adds a backoff so a flaky agent does not fail the run.',
  }),
]

const titles = (rows: readonly PullRequestRow[]) => rows.map((one) => one.title)

describe('filterPullRequests', () => {
  it('gives the whole list back for an empty query', () => {
    expect(filterPullRequests(ROWS, '')).toBe(ROWS)
    expect(filterPullRequests(ROWS, '   ')).toBe(ROWS)
  })

  it('matches on the title', () => {
    expect(titles(filterPullRequests(ROWS, 'auditing'))).toEqual(['disable sql auditing'])
  })

  it('matches on the repository', () => {
    expect(titles(filterPullRequests(ROWS, 'platform'))).toEqual(['bump the node image'])
  })

  it('matches on the project', () => {
    expect(titles(filterPullRequests(ROWS, 'products'))).toEqual([
      'bump the node image',
      'retry the deploy step',
    ])
  })

  it('matches project and repository written as a path', () => {
    expect(titles(filterPullRequests(ROWS, 'saas/pc'))).toEqual(['disable sql auditing'])
  })

  it('matches on the description', () => {
    expect(titles(filterPullRequests(ROWS, 'backoff'))).toEqual(['retry the deploy step'])
  })

  it('ignores case on both sides', () => {
    expect(titles(filterPullRequests(ROWS, 'SQL'))).toEqual(['disable sql auditing'])
  })

  it('requires every term, in any order and across fields', () => {
    expect(titles(filterPullRequests(ROWS, 'modules backoff'))).toEqual([])
    expect(titles(filterPullRequests(ROWS, 'connector backoff'))).toEqual([
      'retry the deploy step',
    ])
    expect(titles(filterPullRequests(ROWS, 'backoff connector'))).toEqual([
      'retry the deploy step',
    ])
  })

  // What the newlines in the haystack are for: `image products` matches because
  // both terms are present, but the *phrase* spanning the seam does not.
  it('does not let a term run across the seam between two fields', () => {
    expect(filterPullRequests(ROWS, 'image products')).toHaveLength(1)
    expect(filterPullRequests(ROWS, 'image\nproducts')).toHaveLength(1)
    expect(filterPullRequests([row({ title: 'ab', project: 'cd' })], 'abcd')).toEqual([])
  })

  // A row with no description is the common case, not an error case.
  it('searches a row whose description is empty', () => {
    expect(titles(filterPullRequests(ROWS, 'node'))).toEqual(['bump the node image'])
  })

  it('does not reorder what it keeps', () => {
    expect(titles(filterPullRequests(ROWS, 'e'))).toEqual([
      'disable sql auditing',
      'bump the node image',
      'retry the deploy step',
    ])
  })
})
