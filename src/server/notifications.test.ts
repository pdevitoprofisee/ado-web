// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from './db'
import {
  claimUnannounced,
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  noteActivity,
  watch,
} from './notifications'

import { markReadRequest, observeRequest } from './notifications-fn'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoThread } from './hydrate'
import type { Activity, WatchedPullRequest } from './notifications'

// A real file rather than `:memory:`, because half of what this module promises
// is about surviving a restart: the dedup test closes the database and opens it
// again, which an in-memory one cannot do.

const ME = '11111111-1111-1111-1111-111111111111'
const THEM = '22222222-2222-2222-2222-222222222222'
const BOT = '33333333-3333-3333-3333-333333333333'
const PROJECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const REPO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

let dir: string
let path: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ado-web-notifications-'))
  path = join(dir, 'app.db')
  db = openDatabase(path)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const pr = (overrides: Partial<WatchedPullRequest> = {}): WatchedPullRequest => ({
  prId: 7,
  title: 'Teach the parser about tabs',
  projectId: PROJECT,
  repositoryId: REPO,
  role: 'author',
  commitId: 'a'.repeat(40),
  ...overrides,
})

const comment = (
  authorId: string,
  publishedDate: string,
  overrides: Partial<AdoThread> = {},
): AdoThread => ({
  id: 100,
  publishedDate,
  comments: [
    {
      id: 1,
      commentType: 'text',
      content: 'This loop reads the file twice.',
      publishedDate,
      author: { id: authorId, displayName: 'Dana' },
    },
  ],
  ...overrides,
})

const vote = (authorId: string, publishedDate: string, value = 10): AdoThread => ({
  id: 200,
  publishedDate,
  comments: [{ id: 1, author: { id: authorId, displayName: 'Dana' } }],
  properties: {
    CodeReviewThreadType: { $value: 'VoteUpdate' },
    CodeReviewVoteResult: { $value: value },
  },
})

const activity = (overrides: Partial<Activity> = {}): Activity => ({
  prId: 7,
  commitId: 'a'.repeat(40),
  viewerId: ME,
  threads: [],
  bots: new Set([BOT]),
  failed: 0,
  ...overrides,
})

describe('the first poll after a cold start', () => {
  it('announces nothing at all, and only writes down what it saw', () => {
    expect(watch([pr()], 1000, db)).toEqual([])
    expect(listNotifications(50, db)).toEqual([])
    expect(db.prepare('SELECT count(*) c FROM pr_signal').get()?.c).toBe(1)
  })

  it('says nothing about a pull request the inbox has never shown', () => {
    // Hydration also runs on the detail route, for pull requests that are
    // nobody's business here. `pr_signal` is the watch list.
    const fresh = noteActivity(
      activity({ threads: [comment(THEM, '2026-07-29T10:00:00Z')], failed: 3 }),
      2000,
      db,
    )

    expect(fresh).toEqual([])
    expect(listNotifications(50, db)).toEqual([])
  })

  it('primes each signal instead of replaying everything already on the PR', () => {
    watch([pr()], 1000, db)

    const first = noteActivity(
      activity({
        threads: [comment(THEM, '2026-07-29T10:00:00Z'), vote(THEM, '2026-07-29T10:05:00Z')],
        failed: 2,
      }),
      2000,
      db,
    )

    expect(first).toEqual([])

    // And the priming call is what makes the next one work: the same threads plus
    // one newer comment announces exactly the new comment.
    const second = noteActivity(
      activity({
        threads: [
          comment(THEM, '2026-07-29T10:00:00Z'),
          vote(THEM, '2026-07-29T10:05:00Z'),
          comment(THEM, '2026-07-29T11:00:00Z', { id: 101 }),
          // Ignored: ADO narrating its own bookkeeping.
          {
            id: 102,
            publishedDate: '2026-07-29T11:30:00Z',
            comments: [
              {
                id: 1,
                commentType: 'system',
                content: 'Dana added Ravi as a reviewer',
                publishedDate: '2026-07-29T11:30:00Z',
                author: { id: THEM },
              },
            ],
          },
          // Ignored: a bot, which posts as `text` like anyone else.
          comment(BOT, '2026-07-29T11:45:00Z', { id: 103 }),
        ],
        failed: 2,
      }),
      3000,
      db,
    )

    expect(second.map((item) => item.kind)).toEqual(['comment'])
    expect(second[0].detail).toBe('Dana: This loop reads the file twice.')
  })
})

describe('what it announces', () => {
  it('reports new commits on a pull request I am reviewing', () => {
    watch([pr({ role: 'reviewer' })], 1000, db)

    const fresh = watch([pr({ role: 'reviewer', commitId: 'b'.repeat(40) })], 2000, db)

    expect(fresh.map((item) => [item.kind, item.detail])).toEqual([
      ['commits', 'New commits since you last looked'],
    ])
    expect(fresh[0].projectId).toBe(PROJECT)
    expect(fresh[0].prId).toBe(7)
  })

  it('stays quiet about a push to my own pull request', () => {
    watch([pr()], 1000, db)

    expect(watch([pr({ commitId: 'b'.repeat(40) })], 2000, db)).toEqual([])
  })

  it('reads a vote in the words a person would use', () => {
    watch([pr()], 1000, db)
    noteActivity(activity({ threads: [vote(THEM, '2026-07-29T10:00:00Z')] }), 2000, db)

    const fresh = noteActivity(
      activity({ threads: [vote(THEM, '2026-07-29T12:00:00Z', -10)] }),
      3000,
      db,
    )

    expect(fresh.map((item) => [item.kind, item.detail])).toEqual([['vote', 'Dana rejected']])
  })

  it('reports a check that started failing, and only the once', () => {
    watch([pr()], 1000, db)
    noteActivity(activity({ failed: 0 }), 2000, db)

    const fresh = noteActivity(activity({ failed: 1 }), 3000, db)
    expect(fresh.map((item) => [item.kind, item.detail])).toEqual([['build', 'A check is failing']])

    // The count is a standing state, not an event. Re-reading it, and even a
    // wobble down and back up on the same commit, must not announce it again.
    expect(noteActivity(activity({ failed: 1 }), 4000, db)).toEqual([])
    noteActivity(activity({ failed: 0 }), 5000, db)
    expect(noteActivity(activity({ failed: 1 }), 6000, db)).toEqual([])
  })
})

describe('never for something I did myself', () => {
  it('ignores my own comment and my own vote', () => {
    watch([pr()], 1000, db)
    noteActivity(
      activity({
        threads: [comment(THEM, '2026-07-29T10:00:00Z'), vote(THEM, '2026-07-29T10:00:00Z')],
      }),
      2000,
      db,
    )

    const fresh = noteActivity(
      activity({
        threads: [
          comment(ME.toUpperCase(), '2026-07-29T12:00:00Z', { id: 101 }),
          vote(ME.toUpperCase(), '2026-07-29T12:00:00Z'),
        ],
      }),
      3000,
      db,
    )

    // Cased differently on purpose: ADO is inconsistent about identity casing,
    // and a mismatch here would announce my own comment back at me.
    expect(fresh).toEqual([])
    expect(countUnread(db)).toBe(0)
  })

  it('still moves the watermark past my own activity', () => {
    watch([pr()], 1000, db)
    noteActivity(activity({ threads: [comment(THEM, '2026-07-29T10:00:00Z')] }), 2000, db)
    noteActivity(activity({ threads: [comment(ME, '2026-07-29T12:00:00Z', { id: 101 })] }), 3000, db)

    // Someone else, *earlier* than my comment but later than the one that primed
    // this: skipping my own comment must not turn its timestamp into a hole
    // through which older comments arrive as news.
    const fresh = noteActivity(
      activity({ threads: [comment(THEM, '2026-07-29T11:00:00Z', { id: 102 })] }),
      4000,
      db,
    )

    expect(fresh).toEqual([])
  })
})

describe('deduplication', () => {
  it('inserts one row per thing that happened, however often it is seen', () => {
    watch([pr()], 1000, db)
    noteActivity(activity({ threads: [comment(THEM, '2026-07-29T10:00:00Z')] }), 2000, db)

    const seen = activity({ threads: [comment(THEM, '2026-07-29T12:00:00Z', { id: 101 })] })
    expect(noteActivity(seen, 3000, db).length).toBe(1)
    expect(noteActivity(seen, 4000, db)).toEqual([])
    expect(listNotifications(50, db).length).toBe(1)
  })

  it('survives a restart, because the key is what happened and not when', () => {
    watch([pr({ role: 'reviewer' })], 1000, db)
    watch([pr({ role: 'reviewer', commitId: 'b'.repeat(40) })], 2000, db)
    expect(listNotifications(50, db).length).toBe(1)

    db.close()
    db = openDatabase(path)

    // The same push, noticed again by a process that has forgotten everything
    // except the database. The watermark is gone from memory; the key is not.
    const again = watch([pr({ role: 'reviewer', commitId: 'b'.repeat(40) })], 5000, db)

    expect(again).toEqual([])
    expect(listNotifications(50, db).length).toBe(1)
    expect(countUnread(db)).toBe(1)
  })
})

describe('read state', () => {
  const two = (): void => {
    watch([pr({ role: 'reviewer' })], 1000, db)
    watch([pr({ role: 'reviewer', commitId: 'b'.repeat(40) })], 2000, db)
    watch([pr({ role: 'reviewer', commitId: 'c'.repeat(40) })], 3000, db)
  }

  it('counts what has not been read', () => {
    two()
    expect(countUnread(db)).toBe(2)

    const [newest] = listNotifications(50, db)
    expect(markRead([newest.key], true, 4000, db)).toBe(1)
    expect(countUnread(db)).toBe(1)

    // Idempotent: marking it again changes nothing, so a double click cannot
    // make the badge disagree with the list.
    expect(markRead([newest.key], true, 5000, db)).toBe(0)
    expect(countUnread(db)).toBe(1)
    expect(listNotifications(50, db).find((item) => item.key === newest.key)?.read).toBe(true)
  })

  it('can put one back, and can clear the lot', () => {
    two()
    const keys = listNotifications(50, db).map((item) => item.key)

    expect(markAllRead(4000, db)).toBe(2)
    expect(countUnread(db)).toBe(0)
    expect(markAllRead(5000, db)).toBe(0)

    expect(markRead([keys[0]], false, 6000, db)).toBe(1)
    expect(countUnread(db)).toBe(1)
  })

  it('ignores a key that matches nothing', () => {
    two()
    expect(markRead(['comment:9:1:1'], true, 4000, db)).toBe(0)
    expect(countUnread(db)).toBe(2)
  })
})

describe('announcing', () => {
  it('hands back each event once, whatever else is read or unread', () => {
    watch([pr({ role: 'reviewer' })], 1000, db)
    watch([pr({ role: 'reviewer', commitId: 'b'.repeat(40) })], 2000, db)

    expect(claimUnannounced(3000, db).map((item) => item.kind)).toEqual(['commits'])
    // The sound has been played. A refetch, a second tab, a window regaining
    // focus — none of them may play it again.
    expect(claimUnannounced(4000, db)).toEqual([])

    watch([pr({ role: 'reviewer', commitId: 'c'.repeat(40) })], 5000, db)
    expect(claimUnannounced(6000, db).length).toBe(1)
  })

  it('announces what the other detection path wrote', () => {
    // The point of `announced_at`: a build failure is detected during hydration,
    // which has no way to reach the client, so the inbox's next observation is
    // what plays it.
    watch([pr()], 1000, db)
    noteActivity(activity({ failed: 0 }), 2000, db)
    claimUnannounced(2500, db)

    noteActivity(activity({ failed: 2 }), 3000, db)

    expect(claimUnannounced(4000, db).map((item) => item.kind)).toEqual(['build'])
  })
})

describe('the request validators', () => {
  it('takes a watched pull request whole', () => {
    expect(observeRequest({ pullRequests: [pr()] })).toEqual({ pullRequests: [pr()] })
    expect(observeRequest({ pullRequests: [] })).toEqual({ pullRequests: [] })
  })

  it('refuses anything that would write a watermark nothing can match', () => {
    expect(() => observeRequest({})).toThrow('pullRequests must be an array.')
    expect(() => observeRequest({ pullRequests: [pr({ prId: 0 })] })).toThrow(
      'prId must be a pull request number.',
    )
    expect(() => observeRequest({ pullRequests: [pr({ commitId: 'abc' })] })).toThrow(
      'commitId must be a 40-character hex commit id.',
    )
    expect(() => observeRequest({ pullRequests: [pr({ projectId: 'the-project' })] })).toThrow(
      'projectId must be a GUID.',
    )
    expect(() => observeRequest({ pullRequests: [pr({ repositoryId: '' })] })).toThrow(
      'repositoryId must be a GUID.',
    )
    // The role decides which events this pull request can even have, so it is a
    // literal and not a string.
    expect(() =>
      observeRequest({ pullRequests: [{ ...pr(), role: 'owner' }] }),
    ).toThrow('role must be author or reviewer.')
  })

  it('bounds the batch rather than writing whatever arrives', () => {
    expect(() =>
      observeRequest({ pullRequests: Array.from({ length: 501 }, () => pr()) }),
    ).toThrow('pullRequests must hold at most 500 rows.')
  })

  it('takes marks as keys and a direction', () => {
    expect(markReadRequest({ keys: ['commits:7:abc'], read: true })).toEqual({
      keys: ['commits:7:abc'],
      read: true,
    })
    expect(() => markReadRequest({ keys: [], read: true })).toThrow(
      'keys must be a non-empty array.',
    )
    expect(() => markReadRequest({ keys: ['commits:7:abc'] })).toThrow(
      'read must be a boolean.',
    )
    // Not a key: a mark that silently matches no row is a bug that nothing on
    // screen would reveal.
    expect(() => markReadRequest({ keys: ['DROP TABLE notification'], read: true })).toThrow(
      'keys must hold notification keys.',
    )
  })
})
