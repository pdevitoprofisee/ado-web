import { describe, expect, it } from 'vitest'

import { filterRepositories } from './repository-search'

import type { RepositoryRow } from './repositories-contract'

const row = (project: string, name: string): RepositoryRow => ({
  name,
  project,
  defaultBranch: 'main',
  cloneUrl: `https://Profisee@dev.azure.com/Profisee/${project}/_git/${name}`,
  webUrl: `https://dev.azure.com/Profisee/${project}/_git/${name}`,
  isDisabled: false,
  isFork: false,
})

const ROWS: readonly RepositoryRow[] = [
  row('Products', 'integrator-connector'),
  row('Products', 'platform'),
  row('SaaS', 'PC.IAC.Networking'),
  row('SaaS', 'pc-portal'),
]

const names = (rows: readonly RepositoryRow[]) => rows.map((one) => one.name)

describe('filterRepositories', () => {
  it('gives the whole list back for an empty query', () => {
    expect(filterRepositories(ROWS, '')).toBe(ROWS)
    expect(filterRepositories(ROWS, '   ')).toBe(ROWS)
  })

  it('matches on the repository name', () => {
    expect(names(filterRepositories(ROWS, 'platform'))).toEqual(['platform'])
  })

  it('matches on the project name', () => {
    expect(names(filterRepositories(ROWS, 'saas'))).toEqual(['PC.IAC.Networking', 'pc-portal'])
  })

  it('ignores case on both sides', () => {
    expect(names(filterRepositories(ROWS, 'NETWORKING'))).toEqual(['PC.IAC.Networking'])
  })

  it('matches in the middle of a name, not only at the start', () => {
    expect(names(filterRepositories(ROWS, 'connector'))).toEqual(['integrator-connector'])
  })

  // The reason there is a `/` in the haystack at all.
  it('matches project and name written as a path', () => {
    expect(names(filterRepositories(ROWS, 'saas/pc'))).toEqual([
      'PC.IAC.Networking',
      'pc-portal',
    ])
  })

  it('requires every term, in any order', () => {
    expect(names(filterRepositories(ROWS, 'net saas'))).toEqual(['PC.IAC.Networking'])
    expect(names(filterRepositories(ROWS, 'saas net'))).toEqual(['PC.IAC.Networking'])
  })

  it('answers nothing when one term of several misses', () => {
    expect(filterRepositories(ROWS, 'saas platform')).toEqual([])
  })

  // The order is the loader's, and stays the loader's.
  it('does not reorder what it keeps', () => {
    expect(names(filterRepositories(ROWS, 'p'))).toEqual([
      'integrator-connector',
      'platform',
      'PC.IAC.Networking',
      'pc-portal',
    ])
  })
})
