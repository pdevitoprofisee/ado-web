import { describe, expect, it, vi } from 'vitest'

import { branchDiffSearch } from './repos_.$repo'

// The route's own module, so importing it drags the server functions it fetches
// with — and the real one spawns `git`. Nothing here calls either; the subject is
// the search parser, which is the one part of a route that is not a fetch.
vi.mock('@/server/local-git-fn', () => ({
  localChangesQuery: vi.fn(),
  dirtyCountQuery: vi.fn(),
  localBlobsQuery: vi.fn(),
}))

describe('branchDiffSearch', () => {
  // The common URL: `/repos/platform` with nothing after it, which means
  // "resolve now" — the branch from HEAD, the target off the ladder.
  it('reads an absent pin as absent', () => {
    expect(branchDiffSearch({})).toEqual({ branch: undefined, target: undefined })
  })

  it('keeps a pinned branch and a pinned target', () => {
    expect(branchDiffSearch({ branch: 'feature/sink', target: 'origin/release/9.1' })).toEqual({
      branch: 'feature/sink',
      target: 'origin/release/9.1',
    })
  })

  // `?branch=` with nothing after it is a URL that lost its value somewhere.
  // Reading it as "use HEAD" would show a diff of something other than what the
  // link said, and there is nothing else it could honestly mean.
  it('drops an empty pin rather than reading it as HEAD', () => {
    expect(branchDiffSearch({ branch: '', target: '' })).toEqual({
      branch: undefined,
      target: undefined,
    })
  })

  // `?branch=a&branch=b` arrives as an array, and a repeated key is not a ref.
  it('drops anything that is not a string', () => {
    expect(branchDiffSearch({ branch: ['a', 'b'], target: 3 })).toEqual({
      branch: undefined,
      target: undefined,
    })
  })

  // Nothing here is trying to make a ref safe for git's argv — the server looks
  // one up in the set it just enumerated, and a name that is not in it fails
  // closed. This only has to hand the name through unchanged.
  it('passes a ref through untouched, dashes and all', () => {
    expect(branchDiffSearch({ branch: '--upload-pack=touch' }).branch).toBe('--upload-pack=touch')
  })
})
