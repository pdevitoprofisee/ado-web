// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { workItemLinkRequest, workItemSearchRequest } from './work-items-fn'

// The two validators. Node rather than jsdom, `pull-request-fn.test.ts`' reason:
// this module reaches `pull-request-fn.ts` and therefore SQLite, which jsdom has no
// business loading.
//
// The link validator is the one that matters. Its `workItemId` becomes a path
// segment on a `PATCH`, so a value that is nearly a number is the dangerous one:
// nothing here escapes anything, it only accepts shapes.

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'

const ref = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

describe('workItemSearchRequest', () => {
  it('keeps the project and the query, and builds the rest out of nothing', () => {
    expect(workItemSearchRequest({ projectId: PROJECT, query: 'login' })).toEqual({
      projectId: PROJECT,
      query: 'login',
    })
  })

  it('accepts an empty query, which is the request for what is recent', () => {
    expect(workItemSearchRequest({ projectId: PROJECT, query: '' }).query).toBe('')
  })

  it('drops anything else the caller sent', () => {
    const request = workItemSearchRequest({
      projectId: PROJECT,
      query: 'login',
      $top: 5000,
      wiql: 'SELECT [System.Id] FROM WorkItems',
    })

    expect(Object.keys(request).sort()).toEqual(['projectId', 'query'])
  })

  it.each([[undefined], [null], [7], [{}], [[]]])(
    'refuses %o as a query rather than sending it to WIQL',
    (query) => {
      expect(() => workItemSearchRequest({ projectId: PROJECT, query })).toThrow(
        'query must be text.',
      )
    },
  )

  it.each([['Platform'], [''], [PROJECT.slice(0, -1)], [undefined]])(
    'refuses %o as a project, because it becomes a path',
    (projectId) => {
      expect(() => workItemSearchRequest({ projectId, query: '' })).toThrow(
        'projectId must be a GUID.',
      )
    },
  )
})

describe('workItemLinkRequest', () => {
  it('keeps the pull request and the work item, and nothing else', () => {
    const request = workItemLinkRequest({ ...ref, workItemId: 162828 })

    expect(request).toEqual({ ...ref, workItemId: 162828 })
    expect(Object.keys(request).sort()).toEqual([
      'id',
      'projectId',
      'repositoryId',
      'workItemId',
    ])
  })

  it.each([['162828'], [0], [-1], [1.5], [null], [undefined], [true], [{}], [NaN], [Infinity]])(
    'refuses %o as a work item, rather than putting it in a PATCH path',
    (workItemId) => {
      expect(() => workItemLinkRequest({ ...ref, workItemId })).toThrow(
        'workItemId must be a work item number.',
      )
    },
  )

  it('refuses a request with no pull request in it, before it looks at the work item', () => {
    expect(() => workItemLinkRequest({ workItemId: 162828 })).toThrow(
      'id must be a pull request number.',
    )
  })
})
