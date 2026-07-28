import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import { languageFor, loadTheme, THEME_NAMES } from './bundle'
import { createHighlighter } from './highlighter'
import { PLAIN_COLOR } from './plain'
import { createTokeniser } from './tokenise'

// Split on `\r?\n` rather than `\n`: this checkout is CRLF on disk, and the
// CR's fate is the subject of its own test below.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').split(/\r?\n/)

const colors = (lines: Awaited<ReturnType<ReturnType<typeof createTokeniser>['tokenise']>>) =>
  new Set(lines.flatMap((line) => line.map((token) => token.color)))

describe('languageFor', () => {
  it('maps the extensions this repository and the ones it reviews are written in', () => {
    expect(languageFor('src/lib/cadence.ts')).toBe('typescript')
    expect(languageFor('src/routes/__root.tsx')).toBe('tsx')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('Profisee.Api/Startup.cs')).toBe('csharp')
    expect(languageFor('build/Directory.Build.props')).toBe('xml')
  })

  it('reads through a directory named like a file, and is case-insensitive', () => {
    expect(languageFor('src/v1.2/notes.MD')).toBe('markdown')
    expect(languageFor('a.ts/b')).toBeNull()
  })

  it('gives no language to what has no extension', () => {
    expect(languageFor('Dockerfile')).toBeNull()
    expect(languageFor('.gitignore')).toBeNull()
    expect(languageFor('src/index.psd')).toBeNull()
  })
})

describe('the bundled themes', () => {
  // Both, because `plain.ts` hard-codes both foregrounds so that a file with no
  // grammar costs no theme fetch. A repointed theme has to fail here rather than
  // by rendering one file's plain lines in the other sheet's ink.
  it.each(['light', 'dark'] as const)('%s resolves to the foreground plain text is hard-coded to', async (theme) => {
    const core = createHighlighterCoreSync({
      themes: [await loadTheme(theme)],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
    expect(core.getTheme(THEME_NAMES[theme]).fg).toBe(PLAIN_COLOR[theme])
    core.dispose()
  })
})

describe('tokenise', () => {
  it('highlights a real TypeScript file, one array per line, text preserved', async () => {
    const lines = read('../cadence.ts')
    expect(lines.length).toBeGreaterThan(50)

    const tokens = await createTokeniser().tokenise('src/lib/cadence.ts', lines, 'light')

    expect(tokens.length).toBe(lines.length)
    expect(tokens.map((line) => line.map((token) => token.text).join(''))).toEqual(lines)
    // A grammar that loaded but matched nothing would give one colour for the
    // whole file, which is indistinguishable from plain text at a glance.
    expect(colors(tokens).size).toBeGreaterThan(3)
    expect(colors(tokens).has(PLAIN_COLOR.light)).toBe(false)
  })

  it('highlights a real JSON file', async () => {
    const lines = read('../../../package.json')

    const tokens = await createTokeniser().tokenise('package.json', lines, 'light')

    expect(tokens.length).toBe(lines.length)
    expect(tokens.map((line) => line.map((token) => token.text).join(''))).toEqual(lines)
    expect(colors(tokens).size).toBeGreaterThan(1)
  })

  it('renders an unbundled language as plain text rather than rejecting', async () => {
    const lines = ['(defun square (x) (* x x))', '']

    const tokens = await createTokeniser().tokenise('src/util.lisp', lines, 'light')

    expect(tokens).toEqual([
      [{ text: '(defun square (x) (* x x))', color: PLAIN_COLOR.light }],
      [{ text: '', color: PLAIN_COLOR.light }],
    ])
  })

  it('keeps CRLF lines aligned, though the CR itself is not a token', async () => {
    // The contract retains `\r` at line ends; Shiki splits on `\r?\n` and drops
    // it. Line counts still match, and a CR renders as nothing anyway.
    const lines = ['const a = 1\r', 'const b = 2\r', '']

    const tokens = await createTokeniser().tokenise('a.ts', lines, 'light')

    expect(tokens.length).toBe(3)
    expect(tokens[0].map((token) => token.text).join('')).toBe('const a = 1')
  })

  it('handles an empty file', async () => {
    expect(await createTokeniser().tokenise('a.ts', [], 'light')).toEqual([])
    expect(await createTokeniser().tokenise('a.ts', [''], 'light')).toEqual([[]])
  })

  it('returns the cached array on a second call and counts its lines', async () => {
    const tokeniser = createTokeniser()
    const lines = read('../cadence.ts')

    const first = await tokeniser.tokenise('src/lib/cadence.ts', lines, 'light')
    const second = await tokeniser.tokenise('somewhere/else.ts', lines, 'light')

    expect(second).toBe(first)
    expect(tokeniser.cachedLines).toBe(lines.length)
  })

  it('caches the two sheets apart, because the colours are the theme', async () => {
    const tokeniser = createTokeniser()
    const lines = ['const a = 1']

    const paper = await tokeniser.tokenise('a.ts', lines, 'light')
    const board = await tokeniser.tokenise('a.ts', lines, 'dark')

    expect(board).not.toBe(paper)
    expect(colors(board)).not.toEqual(colors(paper))
    expect(tokeniser.cachedLines).toBe(2)
  })

  it('evicts least-recently-used once the line bound is passed', async () => {
    const tokeniser = createTokeniser(6)
    const a = ['const a = 1', 'const b = 2', 'const c = 3']
    const b = ['const d = 4', 'const e = 5', 'const f = 6']
    const c = ['const g = 7']

    const firstA = await tokeniser.tokenise('a.ts', a, 'light')
    const firstB = await tokeniser.tokenise('b.ts', b, 'light')
    // Touching `a` makes `b` the oldest, so `b` is what the next store drops.
    expect(await tokeniser.tokenise('a.ts', a, 'light')).toBe(firstA)
    await tokeniser.tokenise('c.ts', c, 'light')

    expect(tokeniser.cachedLines).toBe(4)
    expect(await tokeniser.tokenise('a.ts', a, 'light')).toBe(firstA)
    expect(await tokeniser.tokenise('b.ts', b, 'light')).not.toBe(firstB)
  })

  // jsdom has no `Worker`, which makes this environment the prerender case too:
  // the main thread must answer plain text rather than tokenise in place.
  it('falls back to plain text where there is no worker to send to', async () => {
    const highlighter = createHighlighter()

    await expect(highlighter.highlight('a.ts', ['const a = 1'], 'light')).resolves.toEqual([
      [{ text: 'const a = 1', color: PLAIN_COLOR.light }],
    ])
    highlighter.dispose()
  })

  it('does not cache a file larger than the whole cache', async () => {
    const tokeniser = createTokeniser(2)

    const first = await tokeniser.tokenise('a.ts', ['const a = 1', 'const b = 2', 'const c = 3'], 'light')

    expect(tokeniser.cachedLines).toBe(0)
    expect(await tokeniser.tokenise('a.ts', ['const a = 1', 'const b = 2', 'const c = 3'], 'light')).not.toBe(first)
  })
})
