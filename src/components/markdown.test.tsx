import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

// What a pull request description is allowed to do to this page, and what it is
// not. The first three tests are the feature; the last two are the reason the
// renderer is configured the way it is rather than the way the README suggests.

const draw = (source: string) => render(<Markdown>{source}</Markdown>).container

describe('Markdown', () => {
  it('renders the structure instead of printing its punctuation', () => {
    draw('## Summary\n\nMoves the sink.\n\n- one\n- two')

    // A description's headings are flattened, so this asserts *a* heading rather
    // than a level: what matters is that `## Summary` stopped being two hashes.
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeVisible()
    expect(screen.getByText('Moves the sink.')).toBeVisible()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two'])
    expect(screen.queryByText(/##/)).toBeNull()
  })

  it('tells an inline code span from a fenced block', () => {
    const container = draw('Call `sink()` first.\n\n```ts\nconst a = 1\n```')

    // Both are `code`; only one is inside a `pre`, and the styling has to follow
    // that rather than a prop react-markdown stopped passing.
    const [inline, fenced] = Array.from(container.querySelectorAll('code'))
    expect(inline).toHaveTextContent('sink()')
    expect(inline.closest('pre')).toBeNull()
    expect(fenced.closest('pre')).not.toBeNull()
    expect(container.querySelector('pre')).toHaveTextContent('const a = 1')
  })

  it('keeps a single newline as a break, the way the box it was typed in does', () => {
    // The regression this guards: CommonMark would fold these into one line, and
    // a description is mostly lines that were meant to stay lines.
    const container = draw('Fixes the sink.\nRef: AB#1234')

    // `toHaveTextContent` is no use here: it normalises the break to a space, so
    // it cannot tell a break from the fold this test exists to rule out. The
    // newline in the text is real — mdast keeps one beside the `br` — so the
    // paragraph reads the same as the box it was typed in either way.
    expect(container.querySelectorAll('br')).toHaveLength(1)
    expect(container.querySelector('p')?.textContent).toBe('Fixes the sink.\nRef: AB#1234')
  })

  it('renders a GFM table and a checklist nobody can tick', () => {
    // Tables and `- [ ]` are both GFM, both common in real descriptions, and
    // neither exists without the plugin.
    const container = draw('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] not')

    expect(screen.getByRole('columnheader', { name: 'a' })).toBeVisible()
    expect(screen.getByRole('cell', { name: '1' })).toBeVisible()

    // Disabled on purpose: a tick here would not reach Azure DevOps, and a
    // checkbox that forgets is worse than one that never offered.
    const boxes = Array.from(container.querySelectorAll('input[type=checkbox]'))
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
    for (const box of boxes) expect(box).toBeDisabled()
  })

  it('refuses to turn a description into markup', () => {
    // Somebody else's text. `rehype-raw` is not installed, which is what makes
    // this true: the tags are escaped rather than parsed, so they arrive as
    // characters on the page and no element of that name is ever created.
    const container = draw('a <b>bold</b> word\n\n<script>alert(1)</script>')

    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible()
  })

  it('neutralises a javascript: link and sends real ones to a new tab', () => {
    const container = draw(
      '[run](javascript:alert(1)) and [work item](https://dev.azure.com/x/_workitems/1)',
    )

    // Emptied, not merely ignored — and an anchor with no `href` is not a link to
    // begin with, which is why this goes through the DOM rather than by role.
    const [neutralised] = Array.from(container.querySelectorAll('a'))
    expect(neutralised).toHaveTextContent('run')
    expect(neutralised.getAttribute('href')).toBe('')

    const link = screen.getByRole('link', { name: 'work item' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })
})
