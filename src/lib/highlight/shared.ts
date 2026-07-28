import { createHighlighter } from './highlighter'

import type { Highlighter } from '@/lib/diff-contract'

// One highlighter for the life of the tab, created the first time a diff opens.
//
// Not one per page, and never disposed. The worker holds a 20,000-line token
// cache and pays ~1 s to fetch and compile a grammar the first time it sees
// one; tying either to a route means throwing both away on every navigation,
// and this is a tool for reading one pull request after another. A single
// worker sitting idle costs a few MB.
//
// Disposal is also a trap: `createHighlighter`'s `bury()` is one-way, so a
// highlighter disposed by an unmount effect and then reused — which is exactly
// what StrictMode's double-mount would do — answers plain text forever after.
let shared: Highlighter | null = null

export function sharedHighlighter(): Highlighter {
  shared ??= createHighlighter()
  return shared
}
