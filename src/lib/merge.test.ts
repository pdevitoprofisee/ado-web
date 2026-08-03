import { describe, expect, it } from 'vitest'

import { commitMessage, defaultDraft } from './merge'

// What actually lands in the target branch's history. Both functions are pure and
// both are one line long, and they are tested anyway: the blank line between
// subject and body is the difference between a commit with a subject and a commit
// whose subject is four paragraphs, and it is not the kind of mistake anybody
// notices from the page. The hook beside them needs a client and a mocked server
// function, and it is exercised through `pr-detail.test.tsx`.

describe('defaultDraft', () => {
  it("starts from Azure DevOps' own squash convention", () => {
    // The subject ADO writes when it composes the message itself. Copied so a
    // repository's history does not change shape depending on which client merged.
    expect(defaultDraft({ id: 24698, title: 'move the logging sink', description: 'why' })).toEqual({
      subject: 'Merged PR 24698: move the logging sink',
      body: 'why',
    })
  })

  it('leaves an empty description empty rather than inventing a body', () => {
    expect(defaultDraft({ id: 1, title: 'a thing', description: '' }).body).toBe('')
  })

  it('does not tidy the title on the way in', () => {
    // Whatever the pull request is called is what the subject offers; `commitMessage`
    // trims the ends, and nothing here decides the title was written wrong.
    expect(defaultDraft({ id: 1, title: 'fix:  the  spacing', description: '' }).subject).toBe(
      'Merged PR 1: fix:  the  spacing',
    )
  })
})

describe('commitMessage', () => {
  it('puts a blank line between the subject and the body', () => {
    expect(commitMessage({ subject: 'Merged PR 1: a thing', body: 'why this exists' })).toBe(
      'Merged PR 1: a thing\n\nwhy this exists',
    )
  })

  it('is the subject alone when there is no body, with nothing trailing it', () => {
    expect(commitMessage({ subject: 'Merged PR 1: a thing', body: '' })).toBe(
      'Merged PR 1: a thing',
    )
    // Whitespace is not a body: a blank line and a newline at the end of the commit
    // would be all a `git log` of it showed.
    expect(commitMessage({ subject: 'Merged PR 1: a thing', body: '  \n\n ' })).toBe(
      'Merged PR 1: a thing',
    )
  })

  it('keeps the inside of the body exactly as it was typed', () => {
    const body = 'first paragraph\n\n- a list\n    indented, as a pasted trace would be'

    expect(commitMessage({ subject: 'Merged PR 1: a thing', body })).toBe(
      `Merged PR 1: a thing\n\n${body}`,
    )
  })

  it('trims the ends, so a pasted description cannot pad the commit', () => {
    expect(commitMessage({ subject: '  Merged PR 1: a thing  ', body: '\n\nwhy\n\n' })).toBe(
      'Merged PR 1: a thing\n\nwhy',
    )
  })
})
