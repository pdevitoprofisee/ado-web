import { describe, expect, it } from 'vitest'

import { isTextEntry } from './text-entry'

function element(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild!
}

describe('isTextEntry', () => {
  it.each([
    ['a text input', '<input type="text" />'],
    ['an input with no type', '<input />'],
    ['a search input', '<input type="search" />'],
    ['a textarea', '<textarea></textarea>'],
    ['a contenteditable host', '<div contenteditable="true"></div>'],
    ['plaintext-only contenteditable', '<div contenteditable="plaintext-only"></div>'],
    // React Aria's DateField/TimeField segments.
    ['a spinbutton segment', '<div role="spinbutton" contenteditable=""></div>'],
    ['a role=textbox widget', '<div role="textbox"></div>'],
  ])('treats %s as text entry', (_name, html) => {
    expect(isTextEntry(element(html))).toBe(true)
  })

  it.each([
    ['a checkbox', '<input type="checkbox" />'],
    ['a radio', '<input type="radio" />'],
    ['a range', '<input type="range" />'],
    ['a button', '<button></button>'],
    ['a plain div', '<div></div>'],
    ['a link', '<a href="#"></a>'],
  ])('leaves shortcuts working from %s', (_name, html) => {
    expect(isTextEntry(element(html))).toBe(false)
  })

  it('catches a node nested inside a contenteditable host', () => {
    const host = element('<div contenteditable="true"><span>x</span></div>')
    expect(isTextEntry(host.querySelector('span'))).toBe(true)
  })

  it('ignores a target that is not an element', () => {
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry(window)).toBe(false)
  })
})
