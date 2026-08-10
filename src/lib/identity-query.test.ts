import { describe, expect, it, vi } from 'vitest'

import { MENTION_SUGGESTIONS, directoryNote, filterPeople } from './identity-query'

import type { ReviewerCandidate } from './identity-contract'
import type { DirectoryResult } from '@/server/identity-fn'

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

const arrived: DirectoryResult = {
  people: PEOPLE,
  total: PEOPLE.length,
  complete: true,
  error: null,
  connected: true,
  rateLimit: null,
}

describe('directoryNote', () => {
  it('says the browser is offline rather than looking up forever', () => {
    // The bug this function was written for. A paused query is `pending` with no
    // deadline on it, so "looking up…" is a sentence that never comes down and the
    // picker looks broken instead of disconnected.
    const note = directoryNote({
      fetchStatus: 'paused',
      status: 'pending',
      error: null,
      data: undefined,
    })

    expect(note).toBe('This browser says it is offline, so nobody can be looked up.')
  })

  it('says the read failed rather than that the org is empty', () => {
    // The other half of the same bug: an errored query has no `data`, so a picker
    // reading `data.error` finds nothing and falls through to the empty-list line.
    const note = directoryNote({
      fetchStatus: 'idle',
      status: 'error',
      error: new Error('Failed to fetch'),
      data: undefined,
    })

    expect(note).toBe('The list of people could not be read. Failed to fetch')
  })

  it('still says something when the failure came with no message', () => {
    const note = directoryNote({
      fetchStatus: 'idle',
      status: 'error',
      error: new Error(''),
      data: undefined,
    })

    expect(note).toBe('The list of people could not be read. No reason was given.')
  })

  it('looks up while it is genuinely in flight', () => {
    const note = directoryNote({
      fetchStatus: 'fetching',
      status: 'pending',
      error: null,
      data: undefined,
    })

    expect(note).toBe('Looking up who is in the organisation…')
  })

  it('passes on what Azure DevOps said, which the server returns rather than throws', () => {
    const note = directoryNote({
      fetchStatus: 'idle',
      status: 'success',
      error: null,
      data: { ...arrived, people: [], total: 0, error: 'Azure DevOps answered 401.' },
    })

    expect(note).toBe('Azure DevOps answered 401.')
  })

  it('has nothing to say once the directory is here', () => {
    // `null` is what hands the picker back to its own notes — "nobody matches", and
    // the two short-list admissions.
    expect(
      directoryNote({ fetchStatus: 'idle', status: 'success', error: null, data: arrived }),
    ).toBeNull()
  })
})
