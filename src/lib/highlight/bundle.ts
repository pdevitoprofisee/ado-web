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

/**
 * One theme, not two. The app renders `<html className="dark">`
 * unconditionally (`src/routes/__root.tsx`), and `HighlightToken.color` in the
 * contract is a single resolved hex — dual-theme output would need CSS
 * variables the contract has no room for.
 */
export const THEME = 'github-dark'

export const loadTheme = () => import('shiki/themes/github-dark.mjs').then((m) => m.default)

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
