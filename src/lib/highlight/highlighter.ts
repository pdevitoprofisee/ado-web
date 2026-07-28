import type { Highlighter, HighlightedLines } from '@/lib/diff-contract'
import { plainLines } from './plain'
import type { HighlightReply, HighlightRequest } from './worker'

// The main-thread half. It knows how to post a message and how to give up; it
// does not import `tokenise.ts`, and so carries none of Shiki. The only value
// import here is `plain.ts`, which is nine lines and reaches nothing.

export function createHighlighter(): Highlighter {
  let worker: Worker | null = null
  let dead = false
  let nextId = 0

  // The lines are kept beside the resolver so that a dying worker can still
  // settle everything it was holding — as plain text, never as a rejection. An
  // unawaited `highlight()` must not become an unhandled rejection.
  const pending = new Map<number, { resolve: (tokens: HighlightedLines) => void; lines: readonly string[] }>()

  const bury = () => {
    dead = true
    worker?.terminate()
    worker = null
    for (const { resolve, lines } of pending.values()) resolve(plainLines(lines))
    pending.clear()
  }

  const start = (): Worker | null => {
    // Prerender and jsdom have no `Worker`. Tokenising on the main thread
    // instead is exactly what this ticket forbids, so the answer there is plain
    // text — the same answer an unbundled language gets.
    if (dead || typeof Worker === 'undefined') return null

    const spawned = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    spawned.onmessage = (event: MessageEvent<HighlightReply>) => {
      const waiting = pending.get(event.data.id)
      if (!waiting) return
      pending.delete(event.data.id)
      waiting.resolve(event.data.tokens)
    }
    // One crash retires the worker rather than respawning it: a grammar that
    // kills the worker would kill its replacement on the next file too.
    spawned.onerror = bury
    spawned.onmessageerror = bury
    return spawned
  }

  return {
    highlight(path, lines) {
      worker ??= start()
      if (!worker) return Promise.resolve(plainLines(lines))

      const id = nextId++
      const posted = new Promise<HighlightedLines>((resolve) => pending.set(id, { resolve, lines }))
      worker.postMessage({ id, path, lines } satisfies HighlightRequest)
      return posted
    },

    dispose: bury,
  }
}
