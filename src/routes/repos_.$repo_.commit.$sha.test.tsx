import { describe, expect, it, vi } from 'vitest'

import { commitSearch } from './repos_.$repo_.commit.$sha'

// The route's own module, so importing it drags the server function it fetches
// with — and the real one spawns `git`. Nothing here calls it; the subject is the
// search parser, which is the one part of a route that is not a fetch.
vi.mock('@/server/local-git-fn', () => ({
  commitChangesQuery: vi.fn(),
  localBlobsQuery: vi.fn(),
}))

describe('commitSearch', () => {
  // The common URL: a commit and nothing after it, which is the first parent and
  // a way back to the top of the history.
  it('reads all three as absent', () => {
    expect(commitSearch({})).toEqual({ ref: undefined, skip: undefined, parent: undefined })
  })

  // `ref` and `skip` are not this page's state at all — they are the history
  // page's, carried so the way back is the page you came from.
  it('carries the history page it came from', () => {
    expect(commitSearch({ ref: 'chore/rename', skip: '50' })).toEqual({
      ref: 'chore/rename',
      skip: 50,
      parent: undefined,
    })
  })

  // 1-based because git is: `HEAD^1` is the first parent.
  it('keeps a chosen parent', () => {
    expect(commitSearch({ parent: 2 }).parent).toBe(2)
  })

  it('reads a numeric string as the number it is', () => {
    expect(commitSearch({ parent: '3' }).parent).toBe(3)
  })

  // The first parent is the absent `?parent=`, so the default and the explicit
  // choice stay one address rather than two.
  it('reads parent 0 as no choice, there being no such parent', () => {
    expect(commitSearch({ parent: 0 }).parent).toBeUndefined()
  })

  it.each([['a negative', -1], ['a fraction', 1.5], ['a word', 'second'], ['an array', ['1', '2']]])(
    'falls back to the first parent on %s',
    (_name, parent) => {
      expect(commitSearch({ parent }).parent).toBeUndefined()
    },
  )

  // **Not rejected here, deliberately.** The server knows how many parents the
  // commit has and says so — "This commit has no parent 3 — it has 2." — and that
  // sentence on the page beats a thrown search error, which is an error boundary
  // and not a page.
  it('lets a parent that may not exist through, for the server to answer for', () => {
    expect(commitSearch({ parent: 99 }).parent).toBe(99)
  })

  it('drops an empty ref rather than reading it as HEAD', () => {
    expect(commitSearch({ ref: '' }).ref).toBeUndefined()
  })

  it('passes a ref through untouched, dashes and all', () => {
    expect(commitSearch({ ref: '--upload-pack=touch' }).ref).toBe('--upload-pack=touch')
  })
})
