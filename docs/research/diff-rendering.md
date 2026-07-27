# Findings — virtualized diff rendering + syntax highlighting

Source: background research agent, mid-2026. Primary sources = shiki.style docs, shiki source, npm, GitHub.

## Who can hand you a token array (the requirement, since we virtualize rows ourselves)

| Library | Token API | Colors | Line-split |
|---|---|---|---|
| **Shiki** | ✅ first-class `ThemedToken[][]` | ✅ resolved hex | ✅ one array per line |
| `@lezer/highlight` | ✅ headless callbacks | ❌ CSS classes | ✅ via `putBreak()` |
| refractor | ⚠️ hast, not tokens | ❌ classes | ❌ you flatten |
| prismjs `tokenize` | ✅ but nested + newline-unaware | ❌ | ❌ |
| Monaco | ✅ but **no content, no color** | ❌ | ✅ |
| highlight.js | ❌ none public | ❌ | ❌ |

**Shiki wins outright** — the only one returning line-split tokens *with colors* at TextMate accuracy, zero glue.
Prism/refractor use hand-written flat regex grammars that visibly mis-tokenize nested template literals, JSX,
embedded languages, and TS generics-vs-comparison. Monaco is 97.9 MB unpacked / Monarch grammars (less accurate
than TextMate) / mandatory worker wiring → no. Prism v2 was announced 2022 and never published to npm; the
project accepts only security PRs.

## Shiki specifics

```ts
interface ThemedToken { content: string; offset: number; color?: string; bgColor?: string; fontStyle?: FontStyle; … }
interface TokensResult { tokens: ThemedToken[][]; fg?; bg?; themeName?; rootStyle?; grammarState? }
```
- **`codeToTokensBase` → `ThemedToken[][]` directly** — use this for a single theme; skips the dual-theme/CSS-var machinery.
- `codeToTokens` → `TokensResult` (branches on `themes` vs `theme` in options).
- Twoslash is a fully separate opt-in package; nothing in the tokens path touches it. DOM-free (docs demo it in CF Workers).
- **`getLastGrammarState(code, opts)`** returns a resumable `GrammarState` → highlight lazily-expanded context
  **without re-tokenizing from line 0**. Directly useful for "expand context" in a diff.

### Fine-grained setup (docs: *"Avoid importing `shiki`, `shiki/bundle/full`, `shiki/bundle/web` directly."*)
```ts
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
const highlighter = await createHighlighterCore({
  themes: [import('@shikijs/themes/nord')],
  langs:  [import('@shikijs/langs/typescript')],
  engine: createJavaScriptRegexEngine()
})
```
Cache as a singleton (expensive to create); call `dispose()` explicitly (*"can't be GC-ed automatically"*).
Since v1.0 nothing is implicit — using an unloaded lang **throws**. `npx shiki-codegen` generates the bundle.

### Engine choice — measured gzip
- **JS engine + 1 theme + TS grammar ≈ 70–78 KB gzip**
- Oniguruma wasm instead ≈ **+148 KB → ~200 KB gzip**
- Docs **explicitly recommend the JS engine for web**; all built-in languages supported as of v3.9.1.
  `{forgiving: true}` is an escape hatch that *"can result in highlighting mismatches"*.
- 🚩 **Do NOT use `createJavaScriptRawEngine()` + `@shikijs/langs-precompiled`** — README says "Experimental",
  docs say precompiled langs *"are not yet supported"* (shiki#918, affects many languages). And precompiled TS is
  *larger* gzipped (17.2 vs 16.1 KB) — the win is startup CPU, not size.
- ⚠️ Shiki's two published bundle-size tables disagree; one is stamped v1.1.6 / Feb 2024.
- `@shikijs/primitive@4.3.1` exists (tokens with zero hast/HTML renderer, 39.7 KB) but is **undocumented** and
  only ~4 KB gzip cheaper than `shiki/core`. Prefer the documented path.

### Workers: recommended, no official recipe
Docs verbatim: *"Shiki highlights code using regular expressions, which can be CPU-intensive. You can offload the
highlighting work to a Web Worker/Node Worker to avoid blocking the main thread."* followed by
*"🚧 We are still working on a guide for creating workers easily."*
Enabler is **`createHighlighterCoreSync(...)`** — a fully sync highlighter inside the worker. Standard practice in
the wild, just undocumented.

## Existing React diff libraries — none do virtualization + Shiki

| Package | Highlighting | Virtualization | Health |
|---|---|---|---|
| react-diff-view | refractor (injected) | ❌ **none** | 1012★, pushed 2026-03-30 |
| @git-diff-view/react | lowlight or `@git-diff-view/shiki` | ❌ none | 727★, pushed 2026-07-20 (most active) |
| react-diff-viewer-continued | refractor ^5 hard dep | ❌ none | 231★, pushed 2026-07-14 |
| diff2html | highlight.js optional | ❌ none | 3391★, HTML-string generator, not React |

- **react-diff-view's own published benchmark**: 2.2 MB / 375-file diff → parse 88.73 ms,
  **render 26,072 ms**, paint 6,199 ms; self-described *"quite slow but tolerable without lazy rendering."*
  That alone justifies rolling our own.
- It has **zero Shiki support**, and README claims it *"requires refractor@3.x… isn't compatible with 4.x"*
  while current refractor is 5.0.0. ⚠️ possibly stale, undocumented either way.
- `@git-diff-view/shiki@0.1.7` pins `shiki: ^3.23.0` — one major behind, not on Shiki 4.
- `react-virtualized-diff@0.1.6` claims virtualization — tiny, unvetted. Read it, don't depend on it.
- Useful prior art to *read*: `@git-diff-view/core` parse/template code, `react-diff-view`'s `tokenize`.

## Two production write-ups validating the plan

**GitHub, "The uphill climb of making diff lines performant" (2026-04-03):**
*"we integrated **TanStack Virtual** into our diff view, ensuring that only the visible portion of the diff list
is present in the DOM."* → **10× reduction in JS heap and DOM nodes** for PRs >10k lines; INP 275–700 ms → 40–80 ms.
Separately, collapsing **8 components per line → 2** cut memory ~50% (150–250 MB → 80–120 MB) and INP 78%.
Also dropped `<code>` wrappers and `:has()` selectors, replaced O(n) lookups with a `Map`.

**Pierre, "On Rendering Diffs" (2026-05-29):**
*"We use **Shiki** because it is fast enough for most cases, has a ton of language support, and can run in a
variety of contexts: the browser, **web workers**, and server-side rendering."* … *"Files and diffs render first as
plain text, then request highlighted output from the **worker pool**. Each worker owns its own Shiki highlighter."*
… *"we keep an **LRU cache** of highlighted results."* Memory 2.4 GB → 1.15 GB on the Linux v6→v7 diff.
**Their warning:** *"sending that data back and forth through the worker pool gets noticeably expensive"* for very
large files, *"sometimes dominating main-thread performance."*

## Recommended architecture

1. Shiki 4.x fine-grained: `shiki/core` + `createHighlighterCore` + `createJavaScriptRegexEngine()`,
   langs as dynamic-import thunks, bundle generated by `shiki-codegen`. No wasm, no precompiled langs.
2. Worker pool, one `createHighlighterCoreSync` singleton per worker, **LRU cache keyed by content hash**.
   Batch **per-file, not per-line**; transfer compact array-of-arrays, not object graphs.
3. Tokenize full old/new blobs **once**, index `ThemedToken[][]` by line number to build rows — falls out
   naturally since Shiki returns one array per line. Keep `GrammarState` for lazily-expanded context.
4. Render plain text first, upgrade on worker reply.
5. **Keep the per-line component tree flat** — GitHub's 8→2 collapse was worth ~50% memory / 78% INP
   independently of virtualization.

## CodeMirror note

🚩 `codemirror/dev` and `codemirror/merge` GitHub repos are now **archived**, pointing to
`code.haverbeke.berlin/codemirror/...`. npm + codemirror.net unaffected — a migration, not abandonment, but
GitHub stars/issues are no longer the signal.
CM6 virtualizes a **single document** well, but a PR diff is N files × M hunks with interleaved comment threads
and expand-context rows — a heterogeneous row list, not one document. `@codemirror/merge` takes **full documents,
not unified-diff patches**; one CM instance per file across 300 files is worse than one virtualizer over all rows.
Use only if the UI is literally "compare two files side by side".
