import { getDatabase } from './db'

import type { DatabaseSync } from 'node:sqlite'
import type { AdoThread } from './hydrate'

// Server-only. What changed about a pull request since the last time this app
// looked at it.
//
// **A notification is a diff between two polls.** There is no loop in this file
// and there must never be one: the two callers are the inbox poll (`watch`,
// which is the only thing that decides a pull request is worth watching) and the
// per-PR hydration that follows it (`noteActivity`, which gets the threads and
// the checks for free because hydration already paid for them). A hidden tab
// polls not at all, so nothing here assumes a steady tick — every comparison is
// against the last thing *seen*, never against a clock.
//
// Two rules run through all of it.
//
// **The first poll announces nothing.** A pull request with no `pr_signal` row
// has no previous poll to be diffed against, so the first sight of it writes the
// row and stops. The same goes signal by signal: the three watermarks start at
// `UNOBSERVED`, and a watermark that has not been set yet primes rather than
// fires. Without this, opening the app would replay every comment on every pull
// request as news.
//
// **Keys describe what happened, not when it was noticed.** `vote:<pr>:<thread>`
// is the same string on every poll that can see that vote, and the primary key
// does the rest: re-detecting it after a restart, or from the other detection
// path, inserts nothing. Nothing in this file needs to be run exactly once.

/** Which of the four things happened. The client picks a sound from this. */
export type NotificationKind = 'commits' | 'comment' | 'vote' | 'build'

/**
 * Whether this pull request is mine or one I am reviewing — the inbox's two
 * sections, and the reason it is stored: "someone voted on **my** PR" and "a PR
 * **I am reviewing** got new commits" are different events, and by the time
 * hydration is diffing threads the section they came from is out of reach.
 */
export type Role = 'author' | 'reviewer'

/** A row of the panel. Self-contained: it outlives the `pr_signal` it came from. */
export interface Notification {
  readonly key: string
  readonly kind: NotificationKind
  readonly prId: number
  /** The pull request's title, as it read when this was detected. */
  readonly title: string
  /** One line about what happened, written here so the client formats nothing. */
  readonly detail: string
  readonly projectId: string
  readonly repositoryId: string
  readonly createdAt: number
  readonly read: boolean
}

/** One inbox row, as much of it as detection needs. */
export interface WatchedPullRequest {
  readonly prId: number
  readonly title: string
  readonly projectId: string
  readonly repositoryId: string
  readonly role: Role
  /** `lastMergeSourceCommit.commitId` — moves on every push, and free on the row. */
  readonly commitId: string
}

/** What one hydration saw, which is the threads and the checks it already fetched. */
export interface Activity {
  readonly prId: number
  /** The commit the checks were evaluated against — what a build event is keyed on. */
  readonly commitId: string
  /**
   * The person using the app, lower-cased, resolved from the credential
   * server-side. Never a value from a request body: this is the whole of "was it
   * me", and a client that could name itself could make the app congratulate
   * someone else on its own comment.
   */
  readonly viewerId: string
  readonly threads: readonly AdoThread[]
  /** The identities that also posted a status here, i.e. the bots. See `botIds`. */
  readonly bots: ReadonlySet<string>
  /** `checks.failed` — how many policy evaluations are rejected or broken. */
  readonly failed: number
}

/**
 * Not 0. "No check has failed" is news the moment one does; "I have never seen
 * the checks" must announce nothing. A nullable column would make every read
 * choose between those two, and choosing wrong is exactly the bug.
 */
const UNOBSERVED = -1

/** Longest a comment's own words are quoted for. Past this the panel just wraps. */
const SNIPPET = 120

interface Signal {
  readonly title: string
  readonly projectId: string
  readonly repositoryId: string
  readonly role: Role
  readonly commitId: string
  readonly commentAt: number
  readonly voteAt: number
  readonly failed: number
}

const key = (id: string | undefined): string => id?.toLowerCase() ?? ''

const property = (thread: AdoThread, name: string): string | undefined => {
  const value = thread.properties?.[name]?.$value

  return value === undefined || value === null ? undefined : String(value)
}

const at = (published: string | undefined): number => {
  const parsed = Date.parse(published ?? '')

  return Number.isNaN(parsed) ? 0 : parsed
}

/** Collapsed to one line: the panel is a list, and a code fence in it is noise. */
const snippet = (content: string | undefined): string => {
  const line = (content ?? '').replace(/\s+/g, ' ').trim()

  return line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line
}

/** ADO's vote scale, in the words a person would use about someone else's vote. */
function voteDetail(voter: string, value: number): string {
  switch (value) {
    case 10:
      return `${voter} approved`
    case 5:
      return `${voter} approved with suggestions`
    case -5:
      return `${voter} is waiting for the author`
    case -10:
      return `${voter} rejected`
    default:
      // 0 is what ADO writes when a vote is withdrawn, and also what a push
      // leaves behind when the policy resets votes.
      return `${voter} reset their vote`
  }
}

function signal(prId: number, db: DatabaseSync): Signal | undefined {
  const row = db
    .prepare(
      `SELECT title, project_id, repository_id, role, commit_id, comment_at, vote_at, failed
       FROM pr_signal WHERE pr_id = ?`,
    )
    .get(prId)

  return row === undefined
    ? undefined
    : {
        title: row.title as string,
        projectId: row.project_id as string,
        repositoryId: row.repository_id as string,
        role: row.role as Role,
        commitId: row.commit_id as string,
        commentAt: row.comment_at as number,
        voteAt: row.vote_at as number,
        failed: row.failed as number,
      }
}

/**
 * Writes the row and reports whether it was new.
 *
 * `DO NOTHING` on the key is the whole of deduplication and idempotency: the
 * caller can be run twice, or after a restart, or from either detection path,
 * and the second attempt returns false rather than a second row in the panel.
 */
function insert(notification: Notification, db: DatabaseSync): boolean {
  const result = db
    .prepare(
      `INSERT INTO notification
         (key, kind, pr_id, title, detail, project_id, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      notification.key,
      notification.kind,
      notification.prId,
      notification.title,
      notification.detail,
      notification.projectId,
      notification.repositoryId,
      notification.createdAt,
    )

  return result.changes > 0
}

/**
 * Registers what the inbox poll just saw, and reports the pushes in it.
 *
 * This is the only function that creates a `pr_signal` row, which makes it the
 * app's watch list: `noteActivity` says nothing about a pull request the inbox
 * has never shown. That is deliberate — hydration also runs on the detail page,
 * for pull requests that may be nobody's business here.
 *
 * The push is the one event the cheap list call can carry on its own, so this
 * costs no Azure DevOps call at all.
 */
export function watch(
  pullRequests: readonly WatchedPullRequest[],
  now: number = Date.now(),
  db: DatabaseSync = getDatabase(),
): readonly Notification[] {
  const fresh: Notification[] = []

  for (const pr of pullRequests) {
    const previous = signal(pr.prId, db)

    // A push I made to my own pull request is not news to me, and there is no
    // pusher on the list entry to compare against — only the section the row came
    // from. So the event is scoped to what the ticket asks for: a pull request I
    // am reviewing moved under me.
    if (previous !== undefined && previous.commitId !== pr.commitId && pr.role === 'reviewer') {
      const pushed: Notification = {
        key: `commits:${pr.prId}:${pr.commitId}`,
        kind: 'commits',
        prId: pr.prId,
        title: pr.title,
        detail: 'New commits since you last looked',
        projectId: pr.projectId,
        repositoryId: pr.repositoryId,
        createdAt: now,
        read: false,
      }
      if (insert(pushed, db)) fresh.push(pushed)
    }

    db.prepare(
      `INSERT INTO pr_signal
         (pr_id, title, project_id, repository_id, role, commit_id,
          comment_at, vote_at, failed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr_id) DO UPDATE SET
         title         = excluded.title,
         project_id    = excluded.project_id,
         repository_id = excluded.repository_id,
         role          = excluded.role,
         commit_id     = excluded.commit_id,
         updated_at    = excluded.updated_at`,
    ).run(
      pr.prId,
      pr.title,
      pr.projectId,
      pr.repositoryId,
      pr.role,
      pr.commitId,
      // Only ever set on insert — the three watermarks belong to `noteActivity`,
      // and an inbox poll that reset them would replay every comment on the pull
      // request as new the next time anyone hydrated it.
      UNOBSERVED,
      UNOBSERVED,
      UNOBSERVED,
      now,
    )
  }

  return fresh
}

/**
 * Diffs one hydration against the last one, for the three signals that only the
 * per-PR calls can see.
 *
 * Silent for a pull request the inbox has not registered, and silent for any
 * signal whose watermark is still `UNOBSERVED` — priming it instead. Both are
 * the cold-start rule; between them, the first hydration of a pull request can
 * never announce anything.
 */
export function noteActivity(
  activity: Activity,
  now: number = Date.now(),
  db: DatabaseSync = getDatabase(),
): readonly Notification[] {
  const previous = signal(activity.prId, db)
  if (previous === undefined) return []

  const fresh: Notification[] = []
  const record = (kind: NotificationKind, notificationKey: string, detail: string): void => {
    const event: Notification = {
      key: notificationKey,
      kind,
      prId: activity.prId,
      title: previous.title,
      detail,
      projectId: previous.projectId,
      repositoryId: previous.repositoryId,
      createdAt: now,
      read: false,
    }
    if (insert(event, db)) fresh.push(event)
  }

  let commentAt = previous.commentAt
  let voteAt = previous.voteAt

  for (const thread of activity.threads) {
    if (thread.isDeleted === true) continue

    const type = property(thread, 'CodeReviewThreadType')

    if (type === 'VoteUpdate') {
      const voter = thread.comments?.[0]
      const stamped = at(thread.publishedDate)
      voteAt = Math.max(voteAt, stamped)

      // My own vote is not news, and it is the one thing a sound must never play
      // for. Checked against the identity behind the credential, so no caller can
      // ask to be told about itself.
      if (
        previous.role === 'author' &&
        previous.voteAt !== UNOBSERVED &&
        stamped > previous.voteAt &&
        key(voter?.author?.id) !== activity.viewerId
      ) {
        record(
          'vote',
          `vote:${activity.prId}:${thread.id ?? stamped}`,
          voteDetail(
            voter?.author?.displayName ?? 'Someone',
            Number(property(thread, 'CodeReviewVoteResult') ?? 0),
          ),
        )
      }

      continue
    }

    for (const comment of thread.comments ?? []) {
      // Everything ADO narrates about itself — "X added Y as a reviewer" — plus
      // the bots, which post as `text` and would otherwise make SonarCloud the
      // most talkative colleague on the team (see `botIds`).
      if (comment.commentType === 'system') continue

      const author = key(comment.author?.id)
      const stamped = at(comment.publishedDate ?? thread.publishedDate)
      commentAt = Math.max(commentAt, stamped)

      if (
        previous.role === 'author' &&
        previous.commentAt !== UNOBSERVED &&
        stamped > previous.commentAt &&
        author !== activity.viewerId &&
        !activity.bots.has(author)
      ) {
        const said = snippet(comment.content)
        const who = comment.author?.displayName ?? 'Someone'
        record(
          'comment',
          `comment:${activity.prId}:${thread.id ?? 0}:${comment.id ?? stamped}`,
          said === '' ? `${who} commented` : `${who}: ${said}`,
        )
      }
    }
  }

  // More failing than last time, rather than "any failing": the count is a
  // standing state, not an event, so re-reading it must not re-announce it. The
  // key pins the event to the commit, which is what makes a second detection on
  // the same commit a no-op even if the count wobbles.
  if (previous.failed !== UNOBSERVED && activity.failed > previous.failed) {
    record(
      'build',
      `build:${activity.prId}:${activity.commitId}`,
      activity.failed === 1 ? 'A check is failing' : `${activity.failed} checks are failing`,
    )
  }

  db.prepare(
    `UPDATE pr_signal SET comment_at = ?, vote_at = ?, failed = ?, updated_at = ?
     WHERE pr_id = ?`,
  ).run(Math.max(commentAt, 0), Math.max(voteAt, 0), activity.failed, now, activity.prId)

  return fresh
}

const notification = (row: Record<string, unknown>): Notification => ({
  key: row.key as string,
  kind: row.kind as NotificationKind,
  prId: row.pr_id as number,
  title: row.title as string,
  detail: row.detail as string,
  projectId: row.project_id as string,
  repositoryId: row.repository_id as string,
  createdAt: row.created_at as number,
  read: row.read_at !== null,
})

const COLUMNS = 'key, kind, pr_id, title, detail, project_id, repository_id, created_at, read_at'

/** Newest first, bounded: the panel is a list of what is new, not an archive. */
export function listNotifications(
  limit = 50,
  db: DatabaseSync = getDatabase(),
): readonly Notification[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM notification ORDER BY created_at DESC, key DESC LIMIT ?`)
    .all(limit)
    .map((row) => notification(row as Record<string, unknown>))
}

export function countUnread(db: DatabaseSync = getDatabase()): number {
  return db.prepare('SELECT count(*) c FROM notification WHERE read_at IS NULL').get()?.c as number
}

/**
 * Hands back everything that has not been announced yet and marks it announced,
 * so a sound plays once per event however many polls saw it and whichever path
 * detected it.
 *
 * A write, not a read, which is why the client reaches it through a POST: a GET
 * that quietly consumed its own results would lose a notification to a refetch.
 */
export function claimUnannounced(
  now: number = Date.now(),
  db: DatabaseSync = getDatabase(),
): readonly Notification[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM notification WHERE announced_at IS NULL ORDER BY created_at`)
    .all()
    .map((row) => notification(row as Record<string, unknown>))

  if (rows.length > 0) {
    db.prepare('UPDATE notification SET announced_at = ? WHERE announced_at IS NULL').run(now)
  }

  return rows
}

/** `read_at` rather than a flag, because "when did I see this" is free to keep. */
export function markRead(
  keys: readonly string[],
  read: boolean,
  now: number = Date.now(),
  db: DatabaseSync = getDatabase(),
): number {
  const statement = db.prepare(
    read
      ? 'UPDATE notification SET read_at = ? WHERE key = ? AND read_at IS NULL'
      : 'UPDATE notification SET read_at = NULL WHERE key = ? AND read_at IS NOT NULL',
  )
  let changed = 0

  for (const notificationKey of keys) {
    changed += statement.run(...(read ? [now, notificationKey] : [notificationKey])).changes as number
  }

  return changed
}

export function markAllRead(
  now: number = Date.now(),
  db: DatabaseSync = getDatabase(),
): number {
  return db
    .prepare('UPDATE notification SET read_at = ? WHERE read_at IS NULL')
    .run(now).changes as number
}
