import { describe, expect, it } from 'vitest'

import { COMBINED, lastReview, viewRange } from './changes'

import type { Comment, Thread, VoteEvent } from './comment-contract'
import type { Iteration } from '@/server/pull-request'

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const COLLEAGUE = 'dddddddd-1111-2222-3333-444444444444'

const iteration = (id: number, createdAt: string): Iteration => ({
  id,
  subject: `push ${id}`,
  author: 'Paul DeVito',
  createdAt,
  reason: 'push',
})

/** Three pushes a day apart, which is the shape every case below measures against. */
const PUSHES: readonly Iteration[] = [
  iteration(1, '2026-07-20T12:00:00Z'),
  iteration(2, '2026-07-21T12:00:00Z'),
  iteration(3, '2026-07-22T12:00:00Z'),
]

const vote = (at: string, value = 10, voterId = ME): VoteEvent => ({ voterId, at, vote: value })

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 1,
  parentCommentId: null,
  author: { id: ME, displayName: 'Paul DeVito', uniqueName: null, imageUrl: null },
  content: 'this wants a null check',
  publishedDate: '2026-07-21T09:00:00Z',
  lastUpdatedDate: null,
  lastContentUpdatedDate: null,
  isDeleted: false,
  commentType: 'text',
  likedBy: [],
  mentions: {},
  ...over,
})

const said = (over: Partial<Comment> = {}): Thread => ({
  id: 100,
  status: 'active',
  resolution: 'open',
  kind: 'human',
  publishedDate: comment(over).publishedDate,
  lastUpdatedDate: null,
  isDeleted: false,
  context: null,
  iterationContext: null,
  comments: [comment(over)],
  properties: {},
})

describe('the pair a view names', () => {
  it('asks nothing for the combined diff, which arrived with the page', () => {
    expect(viewRange(COMBINED)).toBeNull()
  })

  it('measures an update from the push before it', () => {
    expect(viewRange({ kind: 'update', iterationId: 4 })).toEqual({ iterationId: 4, compareTo: 3 })
  })

  it('measures the first update against the merge base, with no special case', () => {
    expect(viewRange({ kind: 'update', iterationId: 1 })).toEqual({ iterationId: 1, compareTo: 0 })
  })

  it('takes a range at its word rather than subtracting one from it', () => {
    // The whole difference between the two kinds. If this ever answered
    // `compareTo: 4` the range would silently lose the update it starts at.
    expect(viewRange({ kind: 'since', iterationId: 5, compareTo: 1 })).toEqual({
      iterationId: 5,
      compareTo: 1,
    })
  })
})

describe('finding my last review', () => {
  it('measures from the vote, and from the push that was head when it was cast', () => {
    const review = lastReview(ME, [], [vote('2026-07-21T18:00:00Z')], PUSHES)

    // Push 2 was head at 18:00 on the 21st; push 3 came the next day. So the
    // question "what has changed since I approved" is 2 against 3.
    expect(review).toEqual({
      kind: 'behind',
      basis: { what: 'your approval', at: '2026-07-21T18:00:00Z' },
      view: { kind: 'since', iterationId: 3, compareTo: 2 },
    })
  })

  it('names the vote it found, because the sentences mean different things', () => {
    const at = '2026-07-20T18:00:00Z'
    const what = (value: number) => {
      const review = lastReview(ME, [], [vote(at, value)], PUSHES)
      return review.kind === 'none' ? review.reason : review.basis.what
    }

    // "Since your approval" and "since your rejection" are the same range and a
    // different amount of trust in what is under it.
    expect(what(10)).toBe('your approval')
    expect(what(5)).toBe('your approval with suggestions')
    expect(what(-5)).toBe('your waiting-for-author vote')
    expect(what(-10)).toBe('your rejection')
    // Not a vote ADO documents. The range is still right, so the sentence stays
    // vague rather than the answer being withheld.
    expect(what(7)).toBe('your vote')
  })

  it('falls back to my own comment, which is a review nobody voted on', () => {
    const review = lastReview(ME, [said({ publishedDate: '2026-07-21T18:00:00Z' })], [], PUSHES)

    expect(review).toMatchObject({
      kind: 'behind',
      basis: { what: 'your comment', at: '2026-07-21T18:00:00Z' },
      view: { kind: 'since', iterationId: 3, compareTo: 2 },
    })
  })

  it('takes whichever of the two came last', () => {
    const review = lastReview(
      ME,
      [said({ publishedDate: '2026-07-22T18:00:00Z' })],
      [vote('2026-07-20T18:00:00Z')],
      PUSHES,
    )

    expect(review).toMatchObject({ kind: 'current', basis: { what: 'your comment' } })
  })

  it('prefers the vote when both landed at the same instant', () => {
    const at = '2026-07-21T18:00:00Z'
    const review = lastReview(ME, [said({ publishedDate: at })], [vote(at)], PUSHES)

    // ADO writes the vote thread as the vote is cast, so a tie means I voted on
    // my own comment — and the vote is the stronger claim to having read it.
    expect(review).toMatchObject({ basis: { what: 'your approval' } })
  })

  it('ignores everybody else', () => {
    const review = lastReview(
      ME,
      [said({ author: { id: COLLEAGUE, displayName: 'Melissa Stan', uniqueName: null, imageUrl: null } })],
      [vote('2026-07-21T18:00:00Z', 10, COLLEAGUE)],
      PUSHES,
    )

    expect(review.kind).toBe('none')
  })

  it('matches an identity whatever case Azure DevOps sent it in', () => {
    // The threads endpoint and the identity the page was opened as do not agree
    // on GUID casing, and a case-sensitive compare here reads as "you have never
    // reviewed this" on a pull request you approved.
    const review = lastReview(ME.toUpperCase(), [], [vote('2026-07-21T18:00:00Z')], PUSHES)

    expect(review.kind).toBe('behind')
  })

  it('ignores a comment I deleted', () => {
    const review = lastReview(
      ME,
      [said({ publishedDate: '2026-07-23T18:00:00Z', isDeleted: true, content: null })],
      [vote('2026-07-21T18:00:00Z')],
      PUSHES,
    )

    expect(review).toMatchObject({ basis: { at: '2026-07-21T18:00:00Z' } })
  })

  it('says nothing has been pushed, rather than answering with no files', () => {
    const review = lastReview(ME, [], [vote('2026-07-23T18:00:00Z')], PUSHES)

    expect(review).toEqual({
      kind: 'current',
      basis: { what: 'your approval', at: '2026-07-23T18:00:00Z' },
    })
  })

  it('counts a review during the head push as up to date', () => {
    // Reviewed after push 3 arrived. `compareTo` would be 3, which is head, and
    // asking ADO for 3 against 3 is a pair the server refuses outright.
    const review = lastReview(ME, [], [vote('2026-07-22T18:00:00Z')], PUSHES)

    expect(review.kind).toBe('current')
  })

  it('starts at the merge base when I reviewed before the first push', () => {
    const review = lastReview(ME, [], [vote('2026-07-19T18:00:00Z')], PUSHES)

    // Nothing was head when I looked, so everything is new. Zero is the merge
    // base and this is the one time it is the honest answer.
    expect(review).toMatchObject({ view: { kind: 'since', iterationId: 3, compareTo: 0 } })
  })

  it('gives a reason instead of a date when I have never reviewed', () => {
    const review = lastReview(ME, [], [], PUSHES)

    expect(review).toEqual({
      kind: 'none',
      reason: 'You have not voted or commented here, so there is nothing to measure from.',
    })
  })

  it('gives a reason when Azure DevOps did not say who I am', () => {
    expect(lastReview(null, [], [vote('2026-07-21T18:00:00Z')], PUSHES).kind).toBe('none')
    expect(lastReview('', [], [vote('2026-07-21T18:00:00Z')], PUSHES).kind).toBe('none')
  })

  it('refuses to place a range against updates with no dates on them', () => {
    const undated = [iteration(1, ''), iteration(2, '')]
    const review = lastReview(ME, [], [vote('2026-07-21T18:00:00Z')], undated)

    // Left to itself the walk would leave `compareTo` at zero, and `0` against
    // `2` is a legal pair that answers the whole combined diff. Under a heading
    // that says "since your approval" that is a wrong answer nobody can see.
    expect(review).toEqual({
      kind: 'none',
      reason: 'Azure DevOps did not date these updates, so a range cannot be placed against them.',
    })
  })

  it('skips the undated updates and still uses the dated ones', () => {
    const review = lastReview(ME, [], [vote('2026-07-21T18:00:00Z')], [
      iteration(1, '2026-07-20T12:00:00Z'),
      iteration(2, ''),
      iteration(3, '2026-07-22T12:00:00Z'),
    ])

    expect(review).toMatchObject({ view: { kind: 'since', iterationId: 3, compareTo: 1 } })
  })

  it('gives a reason when there are no updates at all', () => {
    const review = lastReview(ME, [], [vote('2026-07-21T18:00:00Z')], [])

    expect(review).toEqual({ kind: 'none', reason: 'This pull request has no updates to compare.' })
  })
})
