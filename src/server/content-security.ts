import { createHash } from 'node:crypto'

// The page can spend the PAT through the server functions, so script injection
// is the attack worth a second wall behind React's escaping and the sanitiser.
//
// Inline scripts are allowed by hash, computed from the document being served.
// That is safe only because no document here carries anyone's data: SSR is off,
// so the server sends the build's shell and nothing else, and every script in it
// is one the build wrote.

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi

/**
 * Hashes the text the browser hashes, which is the script after HTML parsing:
 * line breaks become `\n`, and NUL becomes U+FFFD. TanStack Router puts a raw NUL
 * in its match ids, so without this its bootstrap script is blocked.
 */
const hashOf = (script: string): string => {
  const parsed = script.replace(/\r\n?/g, '\n').replaceAll('\0', '\uFFFD')

  return `'sha256-${createHash('sha256').update(parsed, 'utf8').digest('base64')}'`
}

/** The policy for `html`, with a hash for each inline script it holds. */
export function contentSecurityPolicy(html: string): string {
  const hashes = new Set([...html.matchAll(INLINE_SCRIPT)].map(([, script]) => hashOf(script)))

  return [
    "default-src 'self'",
    `script-src 'self' ${[...hashes].join(' ')}`.trim(),
    // React writes `style` props through the DOM, which CSP does not govern, but
    // libraries in the tree insert `<style>` elements at runtime.
    "style-src 'self' 'unsafe-inline'",
    // Avatars and images in descriptions come from ADO and from anywhere a PR
    // author linked.
    "img-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Adds the policy to an HTML response. Any other response passes unchanged. */
export async function withContentSecurityPolicy(response: Response): Promise<Response> {
  if (!response.headers.get('content-type')?.startsWith('text/html')) return response

  const html = await response.text()
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', contentSecurityPolicy(html))

  return new Response(html, { status: response.status, statusText: response.statusText, headers })
}
