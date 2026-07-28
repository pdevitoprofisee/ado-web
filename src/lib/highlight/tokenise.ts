import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import type { HighlightedLines, HighlightToken } from '@/lib/diff-contract'
import { PLAIN_COLOR, plainLines } from './plain'
import { loadGrammar, loadTheme, languageFor, THEME, type BundledLanguage } from './bundle'

// The tokenising core. A plain module on purpose: `worker.ts` is a dozen lines
// of message plumbing around this, so everything worth testing is testable
// without standing up a worker under jsdom.
//
// Nothing here rejects. An unbundled language, a grammar that fails to fetch
// and a grammar that throws on the text all come back as plain lines, because
// the caller is a diff that has already rendered and is only waiting for
// colour.

/**
 * The cache is bounded in **lines**, not entries. An entry count bounds nothing
 * — one entry can be forty lines or forty thousand — and lines are what the
 * memory is proportional to.
 *
 * Measured at 1,208 B/line of retained heap for tokenised TypeScript, so 20,000
 * lines is ~24 MB held at the ceiling — about twenty large source files, more
 * than a reviewer scrolls back through in one pull request, and proportionate
 * next to the 80–120 MB GitHub reports for a whole diff view.
 */
const MAX_CACHED_LINES = 20_000

/**
 * Lines longer than this are emitted by Shiki as one unstyled token instead of
 * being tokenised. A minified bundle is one 10 MB line, and the JS regex engine
 * on a line that long is the hang this whole ticket exists to avoid; 4,000
 * characters is far past any line a person wrote.
 */
const MAX_LINE_LENGTH = 4_000

export interface Tokeniser {
  tokenise(path: string, lines: readonly string[]): Promise<HighlightedLines>
  /** Lines currently held. The bound is on this number. */
  readonly cachedLines: number
  dispose(): void
}

export function createTokeniser(maxCachedLines: number = MAX_CACHED_LINES): Tokeniser {
  type Core = ReturnType<typeof createHighlighterCoreSync>

  // Promises rather than values, so two concurrent files do not each build a
  // highlighter or fetch the same grammar twice. A rejected one stays in the
  // map deliberately: a grammar that failed to load fails fast from then on
  // instead of re-fetching per file.
  let core: Promise<Core> | null = null
  const grammars = new Map<BundledLanguage, Promise<void>>()

  const cache = new Map<string, HighlightedLines>()
  let cachedLines = 0

  const ensureCore = () =>
    (core ??= loadTheme().then((theme) =>
      createHighlighterCoreSync({
        themes: [theme],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
    ))

  const ensureGrammar = (loaded: Core, lang: BundledLanguage) => {
    let pending = grammars.get(lang)
    if (!pending) {
      pending = loadGrammar(lang).then((grammar) => loaded.loadLanguageSync(grammar))
      grammars.set(lang, pending)
    }
    return pending
  }

  const store = (key: string, value: HighlightedLines) => {
    // A file bigger than the whole cache is not cached at all: emptying the
    // cache to hold one file costs more than tokenising that file again.
    if (value.length > maxCachedLines) return

    cache.set(key, value)
    cachedLines += value.length

    while (cachedLines > maxCachedLines) {
      // `Map` iterates in insertion order and a hit re-inserts, so the first
      // key is the least recently used.
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cachedLines -= cache.get(oldest)?.length ?? 0
      cache.delete(oldest)
    }
  }

  return {
    get cachedLines() {
      return cachedLines
    },

    async tokenise(path, lines) {
      const lang = languageFor(path)
      if (!lang) return plainLines(lines)

      const text = lines.join('\n')
      const key = `${lang}:${lines.length}:${text.length}:${hash(text)}`

      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }

      let tokens
      try {
        const loaded = await ensureCore()
        await ensureGrammar(loaded, lang)
        tokens = loaded.codeToTokensBase(text, {
          lang,
          theme: THEME,
          tokenizeMaxLineLength: MAX_LINE_LENGTH,
        })
      } catch {
        return plainLines(lines)
      }

      // Shiki's outer dimension already is the lines, so there is nothing to
      // re-split — but a mismatch would silently paint every row below it with
      // the wrong line's colours, which is worse than no colour at all.
      if (tokens.length !== lines.length) return plainLines(lines)

      const result = tokens.map((line) => line.map(narrow))
      store(key, result)
      return result
    },

    dispose() {
      cache.clear()
      cachedLines = 0
      grammars.clear()
      // Shiki's docs: a highlighter "can't be GC-ed automatically".
      void core?.then((loaded) => loaded.dispose()).catch(() => {})
      core = null
    },
  }
}

/**
 * `ThemedToken` narrowed to what renders. `fontStyle` is dropped when it is
 * `None` (0) or `NotSet` (-1), which is nearly every token: each one crosses a
 * structured clone out of the worker, so an omitted field is real bandwidth.
 */
function narrow(token: { content: string; color?: string; fontStyle?: number }): HighlightToken {
  const color = token.color ?? PLAIN_COLOR
  return token.fontStyle && token.fontStyle > 0
    ? { text: token.content, color, fontStyle: token.fontStyle }
    : { text: token.content, color }
}

/**
 * cyrb53, a 53-bit content hash. Width matters here: a collision paints one
 * file in another file's colours, silently, and a 32-bit hash over a few
 * thousand cache keys has a percent-level chance of one. Line count and byte
 * length go into the key beside it.
 */
function hash(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
