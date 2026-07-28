import { useSyncExternalStore } from 'react'

// Which sheet the app is drawn on.
//
// `src/styles.css` already carries both themes in full: every semantic token is
// indirection through a primitive, and `.dark` on `<html>` re-points the
// primitives. So the whole of "support dark mode" on this side is one class
// name, plus the question of who decides it.
//
// A module-level store read through `useSyncExternalStore`, not a context
// provider — the same shape as `sharedHighlighter()`. Two reasons: the theme has
// consumers in unrelated trees (a header control and the diff's tokeniser call
// site, which is inside a virtualised row), and a provider is a thing a test can
// forget to render. `useCommand` throws when its provider is missing; there is
// nothing here to forget.
//
// **Nothing in this module runs at import time.** `worker.ts` reaches it for the
// `Theme` type, through `diff-contract.ts` — that import is type-only and
// erased, but a `document` or `localStorage` touch at module scope would turn
// into a worker crash the day someone drops the `type` keyword.

/** The two sheets. Light is a pen on warm paper; dark is chalk on a board. */
export type Theme = 'light' | 'dark'

/** Where an explicit choice is kept. `THEME_INIT_SCRIPT` reads the same key. */
const STORAGE_KEY = 'ado-web.theme'

const QUERY = '(prefers-color-scheme: dark)'

/**
 * `undefined` until storage has been read once; `null` afterwards if nothing is
 * stored, which means "follow the OS".
 *
 * There is deliberately no third `'system'` value to cycle through. Following
 * the OS is what an app should do before it has been told anything, and pressing
 * the toggle is being told something — so the stored states are the two real
 * ones and the absence of a stored state is the default. A three-way cycle on
 * one key would make two of every three presses land somewhere nobody wanted.
 */
let choice: Theme | null | undefined

/** What was last written to `<html>`, so a no-op change stays a no-op. */
let shown: Theme | null = null

const listeners = new Set<() => void>()

/**
 * Both reads are wrapped, and not only for the prerender where neither global
 * exists: `localStorage` *throws* on access in a hardened browser profile, and
 * `matchMedia` is absent under jsdom. A theme is not worth a blank page.
 */
function stored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)

    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  try {
    return matchMedia(QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** The theme in force: an explicit choice, or the OS's until one is made. */
export function currentTheme(): Theme {
  if (choice === undefined) choice = stored()

  return choice ?? systemTheme()
}

/** Applies the resolved theme and wakes subscribers, if it actually moved. */
function settle(): void {
  const theme = currentTheme()
  if (theme === shown) return
  shown = theme

  document.documentElement.classList.toggle('dark', theme === 'dark')
  for (const listener of listeners) listener()
}

export function setTheme(theme: Theme): void {
  choice = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // A session that cannot persist still gets to change its theme.
  }
  settle()
}

/**
 * Flips the sheet, and in doing so stops following the OS — the theme you can
 * see is the one being flipped, so there is nothing else the press could mean.
 */
export function toggleTheme(): void {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

let watching = false

/**
 * One OS listener for the life of the tab, attached on the first subscribe and
 * never removed — like the shared highlighter's worker, and for the same reason:
 * the thing it belongs to is the tab, not a component. A `change` while an
 * explicit choice is stored resolves to the same theme and `settle` drops it.
 */
function watchSystem(): void {
  if (watching) return
  watching = true
  try {
    matchMedia(QUERY).addEventListener('change', settle)
  } catch {
    // No `matchMedia`: there is nothing to follow, and an explicit choice still works.
  }
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  watchSystem()

  return () => {
    listeners.delete(listener)
  }
}

/**
 * The theme, as a rendering input.
 *
 * The server snapshot is a guard rather than a rendered value: every consumer is
 * inside an `ssr: false` route, so none of them run during the prerender of the
 * shell.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => 'light')
}

/**
 * The class, set before first paint.
 *
 * Applying `.dark` from an effect means every load of a dark session paints the
 * page on white paper and then repaints it — the flash this constant exists to
 * avoid, and it is the whole page, because in this system the theme is the
 * primitives. So the class goes on from a blocking inline script in `<head>`,
 * and the store above only handles what changes afterwards.
 *
 * It restates four lines of logic on purpose: it has to run before the bundle
 * exists, so it cannot import them. The storage key is interpolated rather than
 * retyped, which leaves the class name as the only string that has to stay in
 * step by hand — and `.dark` is fixed by Tailwind's `dark:` variant anyway.
 *
 * ES5 on purpose too (`var`, a bound `catch`): nothing transpiles this string.
 */
export const THEME_INIT_SCRIPT =
  `try{var t=localStorage.getItem('${STORAGE_KEY}');` +
  `if(t!=='light'&&t!=='dark')t=matchMedia('${QUERY}').matches?'dark':'light';` +
  `if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}`
