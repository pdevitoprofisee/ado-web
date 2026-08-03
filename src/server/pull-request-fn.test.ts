// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { mergeRequest, reviewerRequest, voteRequest } from './pull-request-fn'

// The write validators whose input decides something irreversible. Two of them are
// each other's mirror: the vote, which must not carry a reviewer, and the reviewer,
// which must not carry a vote. The third is the merge, whose commit message is
// written into the target branch's history for good. Node rather than jsdom for
// `viewed.test.ts`' reason: this module reaches `pr-cache.ts` and therefore SQLite,
// which jsdom has no business loading.
//
// Only the validators are covered here. The server functions around them need a
// connected client and an ADO to answer them, and what they do with what they are
// given is `pull-request.test.ts`' subject.

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'

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

describe('reviewerRequest', () => {
  it('keeps the pull request, the reviewer and the flag, and builds the rest out of nothing', () => {
    expect(reviewerRequest({ ...ref, reviewerId: COLLEAGUE, isRequired: true })).toEqual({
      ...ref,
      reviewerId: COLLEAGUE,
      isRequired: true,
    })
  })

  it('defaults `isRequired` to false rather than to whatever was sent', () => {
    // `=== true`, so a truthy string, a `1` or a missing field all mean optional.
    // Getting this wrong in the other direction puts a merge gate on somebody's
    // pull request, which is not a thing to infer from `'yes'`.
    for (const isRequired of ['true', 1, {}, null, undefined]) {
      expect(reviewerRequest({ ...ref, reviewerId: COLLEAGUE, isRequired }).isRequired).toBe(false)
    }
  })

  it('drops a vote the caller named, rather than validating it and ignoring it', () => {
    // `voteRequest`'s attempt from the other side, and the same endpoint underneath:
    // one `PUT` carries both a vote and a reviewer, so a `vote` surviving here would
    // let a request that reads as "add Naveen" also approve as him.
    const request = reviewerRequest({
      ...ref,
      reviewerId: COLLEAGUE,
      vote: 10,
      viewerId: ME,
      isRequired: false,
    })

    expect(request).toEqual({ ...ref, reviewerId: COLLEAGUE, isRequired: false })
    expect(Object.keys(request).sort()).toEqual([
      'id',
      'isRequired',
      'projectId',
      'repositoryId',
      'reviewerId',
    ])
  })

  it.each([
    ['aad.YWFhYWFhYWEtMTExMS0yMjIyLTMzMzMtNDQ0NDQ0NDQ0NDQ0'],
    ['vssgp.Uy0xLTktMTU1MTM3NDI0NS0x'],
    [`${COLLEAGUE}/../../24699/reviewers/${ME}`],
    [`${COLLEAGUE} `],
    [''],
    [null],
    [undefined],
    [{}],
  ])('refuses %o, because it is going into an ADO path', (reviewerId) => {
    expect(() => reviewerRequest({ ...ref, reviewerId, isRequired: false })).toThrow(
      'reviewerId must be an identity GUID.',
    )
  })

  it('refuses a request with no pull request in it, before it looks at the reviewer', () => {
    expect(() => reviewerRequest({ reviewerId: COLLEAGUE })).toThrow(
      'id must be a pull request number.',
    )
    expect(() => reviewerRequest(null)).toThrow('id must be a pull request number.')
  })
})

describe('mergeRequest', () => {
  const TIP = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'

  it('keeps the pull request, the tip and the message, and nothing else', () => {
    const request = mergeRequest({
      ...ref,
      lastMergeSourceCommit: TIP,
      commitMessage: 'Merged PR 24698: move the logging sink\n\nwhy this exists',
      // No completion option reaches ADO by being named here — the handler sends
      // the strategy and the deletion itself, and a `bypassPolicy` in a request
      // body must be a field that goes nowhere.
      bypassPolicy: true,
      deleteSourceBranch: false,
      mergeStrategy: 'noFastForward',
    })

    expect(request).toEqual({
      ...ref,
      lastMergeSourceCommit: TIP,
      commitMessage: 'Merged PR 24698: move the logging sink\n\nwhy this exists',
    })
  })

  it.each([['abc'], [`${TIP}x`], [TIP.slice(1)], [''], [null], [undefined], [{}]])(
    'refuses %o as a source tip, because the tip is the guard',
    (lastMergeSourceCommit) => {
      expect(() => mergeRequest({ ...ref, lastMergeSourceCommit, commitMessage: 'x' })).toThrow(
        'lastMergeSourceCommit must be a commit sha.',
      )
    },
  )

  it('trims the ends of the message and keeps the middle exactly', () => {
    // The blank line is the subject/body boundary and the indentation could be a
    // pasted stack trace; only the ends are somebody's stray newline.
    const request = mergeRequest({
      ...ref,
      lastMergeSourceCommit: TIP,
      commitMessage: '\n  Merged PR 1: a thing\n\n  indented\n\n',
    })

    expect(request.commitMessage).toBe('Merged PR 1: a thing\n\n  indented')
  })

  it.each([[''], ['   \n\n  '], [null], [undefined], [42], [{}]])(
    'refuses %o as a commit message',
    (commitMessage) => {
      // A commit whose message is whitespace is a commit nobody can find again,
      // and the field on the page cannot produce one — which is exactly why it is
      // checked here as well.
      expect(() => mergeRequest({ ...ref, lastMergeSourceCommit: TIP, commitMessage })).toThrow(
        /commitMessage must (be a string|not be empty)\./,
      )
    },
  )

  it('accepts a message far longer than any subject line, because ADO owns that refusal', () => {
    const long = `${'a'.repeat(5000)}\n\n${'b'.repeat(5000)}`

    expect(
      mergeRequest({ ...ref, lastMergeSourceCommit: TIP, commitMessage: long }).commitMessage,
    ).toBe(long)
  })

  it('refuses a request with no pull request in it, before it looks at anything else', () => {
    expect(() => mergeRequest({ lastMergeSourceCommit: TIP, commitMessage: 'x' })).toThrow(
      'id must be a pull request number.',
    )
    expect(() => mergeRequest(null)).toThrow('id must be a pull request number.')
  })
})
