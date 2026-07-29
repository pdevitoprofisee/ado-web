import { describe, expect, it } from 'vitest'

import { insertMention, mentionQuery } from './mention-draft'

// T-035. Whether somebody is typing a mention, and what putting one in does to the
// text around it — both answerable without a DOM, which is why they are here and
// not in the composer's tests.

const GUID = 'fbfd3dd4-1a1a-4b4b-8c8c-0d0d0d0d0d0d'
const UPPER = GUID.toUpperCase()

/** Reads as it does in the composer: the caret is where you stopped typing. */
const at = (text: string) => mentionQuery(text, text.length)

describe('mentionQuery', () => {
  it('matches the instant the @ is typed, with nothing after it', () => {
    // An empty query is a request to be shown people, not a miss: the directory is
    // already in hand, so answering it costs nothing.
    expect(at('@')).toEqual({ at: 0, query: '' })
    expect(at('cc @')).toEqual({ at: 3, query: '' })
  })

  it('collects what has been typed after the @', () => {
    expect(at('cc @jor')).toEqual({ at: 3, query: 'jor' })
  })

  it('reads from the caret, not from the end of the text', () => {
    // The composer inserts mid-sentence, so the text after the caret is somebody
    // else's paragraph and must not become part of the search.
    expect(mentionQuery('cc @jor and the rest', 7)).toEqual({ at: 3, query: 'jor' })
    expect(mentionQuery('cc @jor', 2)).toBeNull()
  })

  it('will not fire on an @ in the middle of a word', () => {
    // `foo@bar` is an address. This is the one false positive that would make the
    // picker appear while somebody types an email.
    expect(at('mail jordan@profisee.com')).toBeNull()
    expect(at('jordan@')).toBeNull()
  })

  it('takes the start of a line, a space and an opening bracket as boundaries', () => {
    expect(at('first line\n@jor')).toEqual({ at: 11, query: 'jor' })
    expect(at('(@jor')).toEqual({ at: 1, query: 'jor' })
    expect(at('"@jor')).toEqual({ at: 1, query: 'jor' })
  })

  it('stops at whatever ended the query', () => {
    // A space means the name is finished; a second `@` starts a different thought;
    // `<` and `>` are what a *finished* mention is made of.
    expect(at('cc @jor ')).toBeNull()
    expect(at('cc @jor and')).toBeNull()
    expect(at(`cc @<${UPPER}>`)).toBeNull()
    expect(at(`cc @<${UPPER}> thanks`)).toBeNull()
  })

  it('gives up on a query longer than any name in the directory', () => {
    // Without a cap, an `@` in the first line of a comment would go on matching for
    // the rest of the paragraph.
    expect(at(`@${'x'.repeat(40)}`)).not.toBeNull()
    expect(at(`@${'x'.repeat(41)}`)).toBeNull()
  })

  it('stays shut inside an open code fence', () => {
    // A GUID in a code sample is a literal somebody pasted on purpose.
    expect(at('```\n@jor')).toBeNull()
    expect(at('~~~ts\n@jor')).toBeNull()
    expect(at('   ```\n@jor')).toBeNull()
  })

  it('comes back once the fence has been closed', () => {
    expect(at('```\ncode\n```\n@jor')).toEqual({ at: 13, query: 'jor' })
  })

  it('counts only whole lines above the @, so a fence beside one is not around it', () => {
    expect(at('``` @jor')).toEqual({ at: 4, query: 'jor' })
  })

  it('treats a backtick as part of a word, and lets a closed span past', () => {
    // A backtick is not a boundary, so an inline code span being typed does not open
    // the picker. A span that has already closed is no obstacle either: only fences
    // are counted, because one unmatched backtick in prose is common and a picker
    // that silently stopped working there would be a feature nobody could see the
    // edge of.
    expect(at('`@jor')).toBeNull()
    expect(at('use `x` then @jor')).toEqual({ at: 13, query: 'jor' })
  })
})

describe('insertMention', () => {
  it('writes the form ADO stores, in upper case', () => {
    // 5 of 5 mentions read live were upper cased, and a lower-cased GUID posts
    // without complaint and renders as literal text. There is no error to see.
    expect(insertMention('@jor', 0, 4, GUID).text).toBe(`@<${UPPER}>`)
  })

  it('leaves every character that was not the query alone', () => {
    const { text, caret } = insertMention('cc @jor please', 3, 7, GUID)

    expect(text).toBe(`cc @<${UPPER}> please`)
    // The character after the closing `>`, which is where the next thing typed goes.
    expect(caret).toBe(3 + `@<${UPPER}>`.length)
    expect(text[caret]).toBe(' ')
  })

  it('adds no trailing space of its own', () => {
    // The next thing typed is usually one, and inserting a character nobody typed is
    // the one thing a composer must not do to a draft.
    expect(insertMention('@jor', 0, 4, GUID).text.endsWith('>')).toBe(true)
  })

  it('replaces nothing behind the @ when the caret has moved back over it', () => {
    // A caret before the `@` is reachable — an arrow key, a click — and the answer
    // has to be "insert", never "delete backwards".
    expect(insertMention('@jor', 0, 0, GUID).text).toBe(`@<${UPPER}>@jor`)
  })
})
