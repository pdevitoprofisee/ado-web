// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { resolveRequest } from './sonar-fn'

// The one Sonar write's validator. Node rather than jsdom for
// `pull-request-fn.test.ts`' reason: this module reaches SQLite through the ref
// validator it shares, and jsdom has no business loading that.
//
// Only the validator is covered here. The server function around it needs a Sonar
// and an Azure DevOps to answer it, and what it does with what it is given —
// Sonar first, then the thread, neither outcome inferred from the other — is
// `sonar.test.ts`' subject.

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'

const ref = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24809 }
const KEY = 'AZ-pXh-nP-U4fPfm1RSA'

describe('resolveRequest', () => {
  it('keeps the pull request, the issue and the transition', () => {
    expect(resolveRequest({ ...ref, issueKey: KEY, transition: 'accept' })).toEqual({
      ...ref,
      issueKey: KEY,
      transition: 'accept',
      comment: undefined,
    })
  })

  it.each(['accept', 'falsepositive', 'confirm', 'reopen'])('accepts %s, which has a button', (transition) => {
    expect(resolveRequest({ ...ref, issueKey: KEY, transition }).transition).toBe(transition)
  })

  // The four above are what the panel offers. These are real `do_transition`
  // values with no button, and a validator that waved them through would turn a
  // missing button into an open endpoint — `close` in particular is the one
  // transition nothing here can undo.
  it.each(['close', 'resolve', 'wontfix', 'unconfirm', 'resolveassafe', 'resetastoreview'])(
    'refuses %s, which the API has and this app does not offer',
    (transition) => {
      expect(() => resolveRequest({ ...ref, issueKey: KEY, transition })).toThrow(/transition must be one of/)
    },
  )

  it.each([[''], ['a'.repeat(65)], ['has space'], ['../../admin'], ['k1,k2'], [null], [7], [{}], [undefined]])(
    'refuses %s as an issue key',
    (issueKey) => {
      expect(() => resolveRequest({ ...ref, issueKey, transition: 'accept' })).toThrow(/issueKey/)
    },
  )

  it('keeps a comment, and refuses one that is not text', () => {
    const request = resolveRequest({ ...ref, issueKey: KEY, transition: 'accept', comment: 'agreed debt' })
    expect(request.comment).toBe('agreed debt')

    expect(() => resolveRequest({ ...ref, issueKey: KEY, transition: 'accept', comment: 7 })).toThrow(
      /comment must be text/,
    )
  })

  it('builds the result field by field, so nothing else the caller sent survives', () => {
    const request = resolveRequest({
      ...ref,
      issueKey: KEY,
      transition: 'accept',
      // `threadId` is the attempt this shape is against: the thread the write
      // closes is found on the server from the issue key, and a caller who names
      // one directly would be choosing which comment gets resolved.
      threadId: 4102,
      status: 'closed',
    })

    expect(Object.keys(request).sort()).toEqual([
      'comment',
      'id',
      'issueKey',
      'projectId',
      'repositoryId',
      'transition',
    ])
  })
})
