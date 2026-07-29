import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RuleHtml } from './rule-html'

// The half of this ticket that is a security property. `markdown.test.tsx` proves
// a description can never become markup; this proves a rule description does
// become markup, and that the allowlist is what decides how much of it.
//
// The first fixture is the §11 sample: the opening of `javascript:S4036`'s
// `root_cause`, verbatim down to the line wrapping, with a `<script>` added.

const MEASURED = `<p>When an OS command is executed using only its name (without an absolute or relative path), the operating system searches each directory listed in
the <code>PATH</code> environment variable until it finds a matching executable.</p>
<h3>What is the potential impact?</h3>
<h4>Arbitrary command execution</h4>
<p>If a directory in <code>PATH</code> is writable by an unprivileged user, that user controls the command.</p>`

/**
 * A `how_to_fix` pair as Sonar writes it: two `<pre>` blocks sharing one
 * `data-diff-id`, distinguished only by `data-diff-type`. This is the fixture the
 * pairing feature exists for — without the schema extension the two are byte-for-
 * byte the same element and the reader cannot tell which one is the answer.
 */
const PAIR = `<h4>Noncompliant code example</h4>
<pre data-diff-id="1" data-diff-type="noncompliant"><code>const child = spawn("ls")</code></pre>
<h4>Compliant solution</h4>
<pre data-diff-id="1" data-diff-type="compliant"><code>const child = spawn("/usr/bin/ls")</code></pre>`

const draw = (source: string) => render(<RuleHtml>{source}</RuleHtml>).container

describe('RuleHtml', () => {
  it('renders the measured description as markup rather than as angle brackets', () => {
    const container = draw(MEASURED)

    // The headings are flattened, so this asserts *a* heading rather than a
    // level: what matters is that `<h3>` stopped being five characters.
    expect(screen.getByRole('heading', { name: 'What is the potential impact?' })).toBeVisible()
    expect(screen.getAllByRole('heading')).toHaveLength(2)
    expect(container.querySelectorAll('code')).toHaveLength(2)
    expect(screen.queryByText(/<code>/)).toBeNull()
  })

  it('strips a script tag while a pre/code block survives it', () => {
    // The whole reason this renderer is allowed to parse HTML at all. The block
    // has to come through — a rule's "How can I fix it?" is code — and the
    // script has to not, and both facts are decided by the allowlist rather than
    // by trusting sonarcloud.io.
    const container = draw(
      `<script>window.alert(1)</script><pre><code>const child = spawn("/usr/bin/ls")</code></pre><p>after</p>`,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(container.innerHTML).not.toContain('window.alert')

    const pre = container.querySelector('pre')
    expect(pre).toHaveTextContent('const child = spawn("/usr/bin/ls")')
    expect(pre?.querySelector('code')).not.toBeNull()
    // Everything after the stripped node still renders: the script is removed,
    // not the document from that point on.
    expect(screen.getByText('after')).toBeVisible()
  })

  it('keeps the tags a rule description is made of', () => {
    // `<pre>`, `<code>`, `<h2>`–`<h4>`, `<ul>`, tables and `<a>` — the set the
    // corpus uses, all of it already on the GitHub schema, which is why that
    // schema is used unextended.
    const container = draw(
      `<h2>a</h2><h3>b</h3><h4>c</h4><ul><li>one</li></ul>` +
        `<table><thead><tr><th>head</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>` +
        `<pre><code>code</code></pre><p><a href="https://cwe.mitre.org/data/definitions/426.html">CWE-426</a></p>`,
    )

    expect(screen.getAllByRole('heading').map((node) => node.textContent)).toEqual(['a', 'b', 'c'])
    expect(screen.getByRole('listitem')).toHaveTextContent('one')
    expect(screen.getByRole('columnheader', { name: 'head' })).toBeVisible()
    expect(screen.getByRole('cell', { name: 'cell' })).toBeVisible()
    expect(container.querySelector('pre > code')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'CWE-426' })).toBeVisible()
  })

  it('drops the attributes markup should not be able to bring with it', () => {
    // An `onclick` and an inline `style` are the two cheapest ways to turn a
    // description into behaviour, and neither is on the allowlist. The element
    // itself stays — sanitising filters attributes rather than deleting the
    // paragraph they were on.
    const container = draw(
      `<p onclick="window.alert(1)" style="position:fixed;inset:0">click</p>` +
        `<a href="javascript:window.alert(1)">run</a>`,
    )

    const paragraph = container.querySelector('p')
    expect(paragraph).toHaveTextContent('click')
    expect(paragraph?.getAttribute('onclick')).toBeNull()
    expect(paragraph?.getAttribute('style')).toBeNull()

    // The protocol is not on the schema's `href` list, so the attribute is gone
    // entirely — and an anchor with no `href` is not a link, which is why this
    // goes through the DOM rather than by role.
    const [neutralised] = Array.from(container.querySelectorAll('a'))
    expect(neutralised).toHaveTextContent('run')
    expect(neutralised.getAttribute('href')).toBeNull()
  })

  it('draws the compliant half of a pair differently from the non-compliant one', () => {
    const container = draw(PAIR)
    const [bad, good] = Array.from(container.querySelectorAll('pre'))

    // The whole point: two blocks that used to be identical are not any more.
    expect(bad.className).not.toBe(good.className)
    expect(bad.className).toContain('border-pen-red')
    expect(good.className).toContain('border-pen-green')
    // And the pair is still a pair in the DOM — `data-diff-id` is what says which
    // non-compliant example a compliant solution answers.
    expect(bad.closest('[data-diff-id]')).toHaveAttribute('data-diff-id', '1')
    expect(good.closest('[data-diff-id]')).toHaveAttribute('data-diff-id', '1')

    expect(bad).toHaveTextContent('const child = spawn("ls")')
    expect(good).toHaveTextContent('const child = spawn("/usr/bin/ls")')
  })

  it('says which half is which in words, not only in a colour', () => {
    // A reader who cannot separate `pen-green` from `pen-red` still has to be able
    // to read a rule. Sonar's own headings are `<h4>`s in the content, so these
    // labels repeat them — deliberately, because the block is what carries the
    // attribute and a heading three lines up is not a caption on it.
    draw(PAIR)

    expect(screen.getByText('Compliant solution', { selector: 'p' })).toBeVisible()
    expect(screen.getByText('Noncompliant code example', { selector: 'p' })).toBeVisible()
  })

  it('leaves a block with no diff type, or an unmeasured one, drawn as it was', () => {
    const container = draw(
      `<pre data-diff-type="something-new"><code>a</code></pre><pre><code>b</code></pre>`,
    )
    const [unknown, plain] = Array.from(container.querySelectorAll('pre'))

    expect(unknown.className).toBe(plain.className)
    expect(unknown.className).toContain('border-border')
    expect(screen.queryByText('Compliant solution')).toBeNull()
  })

  it('lets those two attributes through and nothing else', () => {
    // The extension is narrow by name, so the neighbouring attribute a widened
    // schema would have admitted is still gone, and `<p>` did not gain anything.
    const container = draw(
      `<pre data-diff-type="compliant" data-diff-other="x" id="block"><code>a</code></pre>` +
        `<p data-diff-type="compliant">prose</p>`,
    )

    const pre = container.querySelector('pre')
    expect(pre?.getAttribute('data-diff-other')).toBeNull()
    expect(pre?.getAttribute('id')).toBeNull()
    expect(container.querySelector('p[data-diff-type]')).toBeNull()
  })

  it('sends a real link to a new tab, the way the description renderer does', () => {
    // A "Resources" section is a list of links to OWASP and CWE, and following
    // one should not cost the diff you are half way down.
    draw('<p><a href="https://owasp.org/Top10/">OWASP</a></p>')

    const link = screen.getByRole('link', { name: 'OWASP' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })
})
