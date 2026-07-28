import type { HighlightedLines } from '@/lib/diff-contract'
import { createTokeniser } from './tokenise'

// The whole of the worker. Everything with a decision in it lives in
// `tokenise.ts`; this file exists so that the main thread never runs it.

export interface HighlightRequest {
  readonly id: number
  readonly path: string
  readonly lines: readonly string[]
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
  const { id, path, lines } = event.data
  // No error branch: `tokenise` answers plain text rather than rejecting.
  void tokeniser.tokenise(path, lines).then((tokens) => scope.postMessage({ id, tokens }))
}
