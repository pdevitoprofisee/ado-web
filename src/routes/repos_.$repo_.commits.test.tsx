import { describe, expect, it, vi } from 'vitest'

import { commitsSearch } from './repos_.$repo_.commits'

// The route's own module, so importing it drags the server function it fetches
// with — and the real one spawns `git`. Nothing here calls it; the subject is the
// search parser, which is the one part of a route that is not a fetch.
vi.mock('@/server/local-git-fn', () => ({
  commitsQuery: vi.fn(),
  localBlobsQuery: vi.fn(),
}))

describe('commitsSearch', () => {
  // The common URL: `/repos/platform/commits` with nothing after it, which means
  // walk whatever branch HEAD is on, from the top.
  it('reads an absent ref and an absent offset as absent', () => {
    expect(commitsSearch({})).toEqual({ ref: undefined, skip: undefined })
  })

  it('keeps a pinned ref and an offset', () => {
    expect(commitsSearch({ ref: 'origin/release/9.1', skip: 50 })).toEqual({
      ref: 'origin/release/9.1',
      skip: 50,
    })
  })

  // A typed address arrives as text and a `<Link search={{ skip: 50 }}>` arrives
  // as a number. Both are the same page.
  it('reads a numeric string as the number it is', () => {
    expect(commitsSearch({ skip: '100' }).skip).toBe(100)
  })

  // `?ref=` with nothing after it is a URL that lost its value somewhere. Reading
  // it as "use HEAD" would walk a history other than the one the link named.
  it('drops an empty ref rather than reading it as HEAD', () => {
    expect(commitsSearch({ ref: '' }).ref).toBeUndefined()
  })

  it('drops a ref that is not a string, which is what a repeated key arrives as', () => {
    expect(commitsSearch({ ref: ['a', 'b'] }).ref).toBeUndefined()
  })

  // The opposite of the ref, and deliberately: a bad offset lands the reader at
  // the top of the history, which is where a reader without an offset was going
  // anyway. A bad ref would have shown a different repository's worth of work.
  it.each([['zero', 0], ['a negative', -1], ['a fraction', 1.5], ['a word', 'top'], ['nothing readable', {}]])(
    'falls back to the top of the history on %s',
    (_name, skip) => {
      expect(commitsSearch({ skip }).skip).toBeUndefined()
    },
  )

  // The server refuses a negative offset in words as well, because `--skip=-1` is
  // a flag that the leading-dash rule cannot see.
  it('never lets a negative through', () => {
    expect(commitsSearch({ skip: '-1' }).skip).toBeUndefined()
  })

  // Nothing here is trying to make a ref safe for git's argv — the server looks
  // one up in the set it just enumerated, and a name that is not in it fails
  // closed. This only has to hand the name through unchanged.
  it('passes a ref through untouched, dashes and all', () => {
    expect(commitsSearch({ ref: '--upload-pack=touch' }).ref).toBe('--upload-pack=touch')
  })
})
