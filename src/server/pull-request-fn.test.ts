// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { voteRequest } from './pull-request-fn'

// The vote request's validator, which is where "you may only vote as yourself"
// is enforced on the way in. Node rather than jsdom for `viewed.test.ts`' reason:
// this module reaches `pr-cache.ts` and therefore SQLite, which jsdom has no
// business loading.
//
// Only this validator is covered here. The server functions around it need a
// connected client and an ADO to answer them, and what they do with what they are
// given is `pull-request.test.ts`' subject.

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'

const ref = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

describe('voteRequest', () => {
  it('keeps the pull request and the vote, and builds the rest out of nothing', () => {
    expect(voteRequest({ ...ref, vote: 10 })).toEqual({ ...ref, vote: 10 })
  })

  it.each([10, 5, 0, -5, -10])('accepts %d, which is a vote ADO has', (vote) => {
    expect(voteRequest({ ...ref, vote }).vote).toBe(vote)
  })

  it('drops a reviewer the caller named, rather than validating it and ignoring it', () => {
    const request = voteRequest({
      ...ref,
      vote: 10,
      // The attempt this whole path is shaped against: approve as somebody else by
      // saying so in the body. The result is built field by field out of the ref
      // and the vote, so there is nowhere for any of this to survive.
      reviewerId: 'dddddddd-1111-2222-3333-444444444444',
      id: 24698,
      viewerId: ME,
      me: ME,
    })

    expect(request).toEqual({ ...ref, vote: 10 })
    expect(Object.keys(request).sort()).toEqual(['id', 'projectId', 'repositoryId', 'vote'])
  })

  it.each([['1'], [1], [-1], [7], [null], [undefined], [true], [{}]])(
    'refuses %o rather than sending it to ADO as some other vote',
    (vote) => {
      // ADO takes any integer on this field and silently means something by it, so
      // a value that is nearly a vote is the dangerous one: `1` is not "approve",
      // and `'10'` is not a number at all.
      expect(() => voteRequest({ ...ref, vote })).toThrow('vote must be one of 10, 5, 0, -5 or -10.')
    },
  )

  it('refuses a request with no pull request in it, before it looks at the vote', () => {
    expect(() => voteRequest({ vote: 10 })).toThrow('id must be a pull request number.')
    expect(() => voteRequest({ ...ref, projectId: 'Products', vote: 10 })).toThrow(
      'projectId must be a GUID.',
    )
    expect(() => voteRequest(null)).toThrow('id must be a pull request number.')
  })
})
