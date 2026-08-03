/**
 * What a route puts in the tab strip.
 *
 * A helper rather than six literals because the suffix is the wordmark, and a
 * wordmark that drifts between pages reads as two apps. The router's own `head`
 * option is what carries this — see `__root.tsx`, which renders `<HeadContent />`
 * and sets the fallback title every page here overrides. Titles merge by the last
 * match, so a route only has to name itself.
 *
 * The page name comes first: a tab strip crops from the right, and in a strip of
 * eight Azure DevOps tabs the part worth surviving the crop is which page this is.
 */
export function pageTitle(page: string) {
  return { meta: [{ title: `${page} · ado-web` }] }
}
