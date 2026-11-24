// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { contentSecurityPolicy, withContentSecurityPolicy } from './content-security'

const scriptSrc = (policy: string): string =>
  policy.split('; ').find((directive) => directive.startsWith('script-src ')) ?? ''

describe('contentSecurityPolicy', () => {
  it('allows exactly the inline scripts in the document, by hash', () => {
    const html =
      '<head><script>window.ok=1</script><script type="module" src="/assets/index.js"></script></head>'

    // `openssl dgst -sha256 -binary | base64` of `window.ok=1`.
    expect(scriptSrc(contentSecurityPolicy(html))).toBe(
      "script-src 'self' 'sha256-CmeDYEZNLhjSjHU4KhVMjPtExWuRhufwDfF3QfVO1As='",
    )
  })

  it('hashes a script as the browser parses it, with NUL read as U+FFFD', () => {
    // TanStack Router writes `__root__\0` into its bootstrap script.
    expect(scriptSrc(contentSecurityPolicy('<script>window.ok=1\0</script>'))).toBe(
      scriptSrc(contentSecurityPolicy('<script>window.ok=1\uFFFD</script>')),
    )
  })

  it('never allows inline script or eval wholesale', () => {
    const policy = contentSecurityPolicy('<script>window.ok=1</script>')

    expect(scriptSrc(policy)).not.toContain('unsafe-inline')
    expect(policy).not.toContain('unsafe-eval')
  })
})

describe('withContentSecurityPolicy', () => {
  it('adds the header to a document and keeps its body', async () => {
    const html = '<html><script>window.ok=1</script></html>'
    const response = await withContentSecurityPolicy(
      new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )

    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await response.text()).toBe(html)
  })

  it('leaves a response that is not HTML alone', async () => {
    const response = await withContentSecurityPolicy(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )

    expect(response.headers.has('content-security-policy')).toBe(false)
  })
})
