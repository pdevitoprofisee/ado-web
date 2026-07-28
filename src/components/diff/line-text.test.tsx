import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LineText, segment } from './line-text'

import type { HighlightToken } from '@/lib/diff-contract'

const token = (text: string, color: string, fontStyle?: number): HighlightToken => ({
  text,
  color,
  ...(fontStyle === undefined ? {} : { fontStyle }),
})

describe('segment', () => {
  it('leaves a plain line in one piece', () => {
    expect(segment('const x = 1')).toEqual([
      { text: 'const x = 1', color: null, fontStyle: 0, edited: false },
    ])
  })

  it('has nothing to say about an empty line', () => {
    expect(segment('')).toEqual([])
  })

  it('cuts on the highlighter’s boundaries', () => {
    const parts = segment('const x', [token('const', '#569'), token(' x', '#eee')])

    expect(parts).toEqual([
      { text: 'const', color: '#569', fontStyle: 0, edited: false },
      { text: ' x', color: '#eee', fontStyle: 0, edited: false },
    ])
  })

  it('cuts on the diff’s boundaries', () => {
    expect(segment('abcdef', null, [[2, 4]])).toEqual([
      { text: 'ab', color: null, fontStyle: 0, edited: false },
      { text: 'cd', color: null, fontStyle: 0, edited: true },
      { text: 'ef', color: null, fontStyle: 0, edited: false },
    ])
  })

  it('cuts on both at once, where neither cut lines up with the other', () => {
    // The case the whole function exists for: the grammar splits at 3 and the
    // edit at 2 and 5, so the piece from 2 to 3 is both coloured and marked and
    // there is nowhere to nest one inside the other.
    const parts = segment('abcdefg', [token('abc', '#111'), token('defg', '#222')], [[2, 5]])

    expect(parts).toEqual([
      { text: 'ab', color: '#111', fontStyle: 0, edited: false },
      { text: 'c', color: '#111', fontStyle: 0, edited: true },
      { text: 'de', color: '#222', fontStyle: 0, edited: true },
      { text: 'fg', color: '#222', fontStyle: 0, edited: false },
    ])
  })

  it('keeps the font style with the token it came from', () => {
    expect(segment('ab', [token('a', '#111', 3), token('b', '#222')])).toEqual([
      { text: 'a', color: '#111', fontStyle: 3, edited: false },
      { text: 'b', color: '#222', fontStyle: 0, edited: false },
    ])
  })

  it('throws away tokens that were made for a different line', () => {
    // Highlighting is async and the diff is not, so a line can be re-rendered
    // with the previous content's tokens still in hand. Painting them by offset
    // would colour the wrong characters — losing the colour is the safe half.
    const stale = [token('const', '#569'), token(' old', '#eee')]

    expect(segment('const new text', stale)).toEqual([
      { text: 'const new text', color: null, fontStyle: 0, edited: false },
    ])
  })

  it('keeps the colour on a CRLF line, whose tokens are one character short', () => {
    // T-016 keeps the `\r` because the diff has to see it; Shiki splits on
    // /\r?\n/ and never does. Most files in the repos this reviews are CRLF, so
    // reading that gap as staleness would drop the highlighting for nearly
    // every line of nearly every file.
    expect(segment('const x\r', [token('const', '#569'), token(' x', '#eee')])).toEqual([
      { text: 'const', color: '#569', fontStyle: 0, edited: false },
      { text: ' x', color: '#eee', fontStyle: 0, edited: false },
      { text: '\r', color: '#eee', fontStyle: 0, edited: false },
    ])
  })

  it('still discards tokens one character short of a line that has no CR', () => {
    expect(segment('const xy', [token('const', '#569'), token(' x', '#eee')])).toEqual([
      { text: 'const xy', color: null, fontStyle: 0, edited: false },
    ])
  })

  it('clamps an edit range that runs off the end instead of dropping the line', () => {
    expect(segment('abc', null, [[1, 99]])).toEqual([
      { text: 'a', color: null, fontStyle: 0, edited: false },
      { text: 'bc', color: null, fontStyle: 0, edited: true },
    ])
  })

  it('ignores an empty or inverted range', () => {
    expect(segment('abc', null, [[2, 2], [3, 1]])).toEqual([
      { text: 'abc', color: null, fontStyle: 0, edited: false },
    ])
  })
})

describe('LineText', () => {
  it('renders an unhighlighted line as text with no element around it', () => {
    // The common case in a large diff, and the reason this is worth asserting:
    // a span per line is a span per line times five thousand.
    const { container } = render(<LineText text="  return null" />)

    expect(container.querySelectorAll('span')).toHaveLength(0)
    expect(container.textContent).toBe('  return null')
  })

  it('renders one flat span per piece, never nested', () => {
    const { container } = render(
      <LineText text="abcd" tokens={[token('ab', '#111'), token('cd', '#222')]} edits={[[1, 3]]} />,
    )
    const spans = container.querySelectorAll('span')

    // Four, not three: the grammar cuts at 2 and the edit at 1 and 3, and no
    // two neighbours end up agreeing on both colour and edit state.
    expect(spans).toHaveLength(4)
    for (const span of spans) expect(span.querySelector('span')).toBeNull()
    expect(container.textContent).toBe('abcd')
  })

  it('marks only the characters that changed', () => {
    const { container } = render(<LineText text="abcdef" edits={[[2, 4]]} />)
    const marked = [...container.querySelectorAll('span')].filter((span) =>
      span.className.includes('bg-diff-word'),
    )

    expect(marked.map((span) => span.textContent)).toEqual(['cd'])
  })
})
