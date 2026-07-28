// Which theme and which grammars this app can highlight with. Separate from the
// tokeniser because "what is bundled" is a product decision and the tokeniser
// does not care what the answer is.
//
// Every entry is a dynamic import, so a grammar nobody opens is a chunk nobody
// fetches: the list below costs nothing in the initial bundle and nothing at
// runtime until a file with that extension is opened. That is why it is
// generous rather than minimal.
//
// Imported through `shiki/...` rather than `@shikijs/langs/...` — the research
// snippet uses the latter, but `@shikijs/langs` is a transitive dependency and
// pnpm does not hoist it, so only Shiki's own re-exports resolve from here.
//
// **On demand only works because `vite.config.ts:43` sets `worker: { format:
// 'es' }`.** Vite's default is `iife`, which cannot code-split, and under it the
// dynamic imports below mean nothing: the build inlines all fifteen grammars
// into one 176.6 kB gzip worker chunk, still lazy and still off the main thread
// but fetched whole on the first file. Measured on the current build, with the
// setting in place and the worker actually reached from the page: worker 53.1 kB
// gz + theme 2.5 + typescript 15.9, one chunk per grammar, i.e. **71.5 kB gz to
// highlight a `.ts` file**. Take that setting out and this list becomes a lie.
//
// The two themes below are on the same footing: the sheet you are not reading on
// costs nothing until you switch to it.

import type { Theme } from '@/lib/theme'

/**
 * One theme per sheet, fetched the same way a grammar is.
 *
 * `vitesse-light` over the more familiar `github-light` because Prof's paper is
 * warm (`--paper-0: #FAF6EF`): vitesse's palette is warm and muted, and its
 * `#393a34` foreground reads as ink on that stock where github-light's cool
 * `#24292e` and its blue/purple keywords read as a screen pasted onto paper.
 * `vitesse-dark` is that same palette drawn for a board, which is what the pair
 * is for — the diff should look like the same hand wrote it in chalk, not like a
 * second highlighter was bolted on for the dark theme.
 *
 * The theme is a **parameter**, not two colours per token. `HighlightToken.color`
 * stays a single resolved hex: emitting both would double what every token costs
 * to clone out of the worker, on every file, to serve a switch that is pressed
 * once a session. The price of the other choice is a re-tokenise on toggle, and
 * that path already exists and is already gentle — the diff renders its text
 * first and colours it when it arrives.
 */
export const THEME_NAMES: Record<Theme, string> = {
  light: 'vitesse-light',
  dark: 'vitesse-dark',
}

// Unannotated for the reason `GRAMMARS` is: a `Record` of thunks would widen
// the resolved registration to whatever the annotation says, and Shiki's core
// wants the real shape. `satisfies` checks the keys and keeps the type.
const THEMES = {
  light: () => import('shiki/themes/vitesse-light.mjs'),
  dark: () => import('shiki/themes/vitesse-dark.mjs'),
} satisfies Record<Theme, () => Promise<unknown>>

export const loadTheme = (theme: Theme) => THEMES[theme]().then((m) => m.default)

const GRAMMARS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
}

export type BundledLanguage = keyof typeof GRAMMARS

/**
 * Extension to grammar. The first block is this repository; the second is what
 * the Profisee repositories this reviews are actually written in.
 */
const EXTENSIONS: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',

  cs: 'csharp',
  sql: 'sql',
  xml: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',
  config: 'xml',
  resx: 'xml',
  ps1: 'powershell',
  psm1: 'powershell',
  sh: 'shellscript',
  bash: 'shellscript',
}

/**
 * The grammar for a path, or `null` for plain text. A file with no extension
 * (`Dockerfile`, `LICENSE`) and a dotfile (`.gitignore`) are both plain: the
 * segment after the last dot is only an extension if something precedes it.
 */
export function languageFor(path: string): BundledLanguage | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null
}

export const loadGrammar = (lang: BundledLanguage) => GRAMMARS[lang]().then((m) => m.default)
