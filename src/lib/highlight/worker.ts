import type { HighlightedLines } from '@/lib/diff-contract'
import type { Theme } from '@/lib/theme'
import { createTokeniser } from './tokenise'

// The whole of the worker. Everything with a decision in it lives in
// `tokenise.ts`; this file exists so that the main thread never runs it.

export interface HighlightRequest {
  readonly id: number
  readonly path: string
  readonly lines: readonly string[]
  /**
   * Per request, not set once on the worker. A theme sent as its own message
   * would race the requests already in flight, and the reply carries no theme —
   * the tokens would be right and arrive under the wrong sheet.
   */
  readonly theme: Theme
}

export interface HighlightReply {
  readonly id: number
  readonly tokens: HighlightedLines
}

// tsconfig's `lib` is DOM, not webworker, so `self` is typed as a `Window`
// here. Casting the global is cheaper than adding a second lib to the whole
// project for one file.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null
  postMessage: (message: HighlightReply) => void
}

const tokeniser = createTokeniser()

scope.onmessage = (event) => {
  const { id, path, lines, theme } = event.data
  // No error branch: `tokenise` answers plain text rather than rejecting.
  void tokeniser.tokenise(path, lines, theme).then((tokens) => scope.postMessage({ id, tokens }))
}
