import { describe, expect, it, vi } from 'vitest'

import { MENTION_SUGGESTIONS, filterPeople } from './identity-query'

import type { ReviewerCandidate } from './identity-contract'

// T-035. The matching half of the directory decision: the list is in memory, so
// what "matches" means is this file's answer rather than Azure DevOps'.
//
// The server function is mocked because importing this module reaches `@/server`,
// and nothing here calls it — `filterPeople` is a pure function over a list.
vi.mock('@/server/identity-fn', () => ({ directoryQuery: vi.fn() }))

const person = (displayName: string, uniqueName = ''): ReviewerCandidate => ({
  identityId: displayName.toLowerCase().replace(/\W/g, '-'),
  descriptor: `aad.${displayName}`,
  kind: 'user',
  displayName,
  uniqueName,
  avatarHref: '',
})

/** Sorted by display name, which is how `loadDirectory` hands it over. */
const PEOPLE: readonly ReviewerCandidate[] = [
  person('Jordan Vincent', 'jordan.vincent@profisee.com'),
  person('Marjorie Chen', 'marjorie.chen@profisee.com'),
  person('Paul DeVito', 'paul.devito@profisee.com'),
  person('Sonar Build Service', ''),
  person("Vincent O'Hara", 'vincent.ohara@profisee.com'),
]

const names = (query: string, limit?: number) =>
  filterPeople(PEOPLE, query, limit).map((found) => found.displayName)

describe('filterPeople', () => {
  it('finds a surname, which is the whole reason the directory is local', () => {
    // `POST graph/subjectquery` matches a prefix of the *whole* display name, so
    // asking Azure DevOps for `vincent` finds Jordan Vincent zero times. This is the
    // behaviour that decided against a live search.
    expect(names('vincent')).toEqual(["Vincent O'Hara", 'Jordan Vincent'])
  })

  it('puts a match on the front of the name first', () => {
    // A substring match over a few hundred people finds too many, so the order is
    // the feature: whole name, then a word inside it, then the mail address.
    expect(names('jo')).toEqual(['Jordan Vincent', 'Marjorie Chen'])
  })

  it('will match a mail address when no name contains it', () => {
    expect(names('devito@')).toEqual(['Paul DeVito'])
  })

  it('ignores case and surrounding space, because typing does not', () => {
    expect(names('  JORDAN ')).toEqual(['Jordan Vincent'])
  })

  it('splits a name on the punctuation names actually have in them', () => {
    // O'Hara is one word to a word-character regex and two to this one.
    expect(names('hara')).toEqual(["Vincent O'Hara"])
  })

  it('answers a bare @ with the top of the alphabet', () => {
    // Typing `@` on its own is a request to be shown who is there, and the list
    // arrives sorted, so this is the first page of it and not an empty answer.
    expect(names('')).toEqual(PEOPLE.map((found) => found.displayName))
    expect(names('', 2)).toEqual(['Jordan Vincent', 'Marjorie Chen'])
  })

  it('finds nobody rather than everybody when nobody matches', () => {
    // The failure mode worth pinning: a filter that fell back to the whole list on
    // no match would offer eight wrong people with no sign anything had gone wrong.
    expect(names('zzz')).toEqual([])
  })

  it('shows no more than a picker has room for', () => {
    const many = Array.from({ length: 40 }, (_, index) => person(`Person ${index}`))

    expect(filterPeople(many, 'person')).toHaveLength(MENTION_SUGGESTIONS)
  })
})
