import { createServerFn } from '@tanstack/react-start'

import {
  claimUnannounced,
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  watch,
} from './notifications'

import type { Notification, Role, WatchedPullRequest } from './notifications'

// The notification panel's four calls. Like `viewed-fn.ts` and for the same
// reason, none of them touches Azure DevOps: everything here is local SQLite, so
// there is no client to be connected to and no rate limit to report. That is the
// point — the inbox poll already paid for the data these events are diffed from,
// and an inbox that got slower to tell you about a vote would be a bad trade.
//
// Every field is still shape-checked rather than merely read, for `viewed-fn.ts`'
// reason: nothing below is interpolated into a URL, but a commit id that is not a
// sha writes a watermark no future poll can match, and the failure mode is a
// notification that never arrives — the one bug nothing on screen would reveal.
//
// **`observeNotifications` is a POST even though the panel reads it**, because it
// is two writes: it registers what the inbox poll saw, and it claims whatever has
// not been announced yet. A GET that consumed its own results would lose a sound
// to a refetch, and `refetchOnWindowFocus` is on.

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/i

/**
 * Our own key format — `kind:prId:…`. Checked because it arrives from the client:
 * the panel sends back the keys it was given, and anything else is a mark that
 * silently matches no row.
 */
const KEY = /^[a-z]+:[0-9]+:[0-9A-Za-z:-]+$/

/**
 * A backstop, not a limit anyone should reach. The live org's two inbox sections
 * came to well under a hundred rows; a request an order of magnitude past that is
 * a bug somewhere else, and refusing it is better than writing it.
 */
const MAX_WATCHED = 500

/** And one page of the panel's worth of keys per mark. */
const MAX_KEYS = 100

export interface ObserveRequest {
  readonly pullRequests: readonly WatchedPullRequest[]
}

export interface MarkReadRequest {
  readonly keys: readonly string[]
  readonly read: boolean
}

export interface ObserveResult {
  /**
   * Everything detected since the last call, whichever path detected it, each
   * appearing exactly once ever — this is what the client plays a sound for.
   */
  readonly announced: readonly Notification[]
  readonly unread: number
}

export interface NotificationsResult {
  readonly items: readonly Notification[]
  readonly unread: number
}

export interface MarkReadResult {
  readonly changed: number
  readonly unread: number
}

function guid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error(`${field} must be a GUID.`)
  }

  return value
}

function role(value: unknown): Role {
  if (value !== 'author' && value !== 'reviewer') {
    throw new Error('role must be author or reviewer.')
  }

  return value
}

function watched(input: unknown): WatchedPullRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Number.isSafeInteger(raw.prId) || (raw.prId as number) <= 0) {
    throw new Error('prId must be a pull request number.')
  }
  // Not length-checked or trimmed: the title is a label this app stores and hands
  // back, and a pull request whose title we found surprising is still one whose
  // vote you want to hear about.
  if (typeof raw.title !== 'string') {
    throw new Error('title must be a string.')
  }
  if (typeof raw.commitId !== 'string' || !SHA.test(raw.commitId)) {
    throw new Error('commitId must be a 40-character hex commit id.')
  }

  return {
    prId: raw.prId as number,
    title: raw.title,
    projectId: guid(raw.projectId, 'projectId'),
    repositoryId: guid(raw.repositoryId, 'repositoryId'),
    role: role(raw.role),
    commitId: raw.commitId,
  }
}

export function observeRequest(input: unknown): ObserveRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Array.isArray(raw.pullRequests)) {
    throw new Error('pullRequests must be an array.')
  }
  if (raw.pullRequests.length > MAX_WATCHED) {
    throw new Error(`pullRequests must hold at most ${MAX_WATCHED} rows.`)
  }

  return { pullRequests: raw.pullRequests.map(watched) }
}

export function markReadRequest(input: unknown): MarkReadRequest {
  const raw = (input ?? {}) as Record<string, unknown>

  if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
    throw new Error('keys must be a non-empty array.')
  }
  if (raw.keys.length > MAX_KEYS) {
    throw new Error(`keys must hold at most ${MAX_KEYS} entries.`)
  }
  if (typeof raw.read !== 'boolean') {
    throw new Error('read must be a boolean.')
  }

  return {
    keys: raw.keys.map((value: unknown) => {
      if (typeof value !== 'string' || !KEY.test(value)) {
        throw new Error('keys must hold notification keys.')
      }

      return value
    }),
    read: raw.read,
  }
}

export const observeNotifications = createServerFn({ method: 'POST' })
  .validator(observeRequest)
  .handler(async ({ data }): Promise<ObserveResult> => {
    watch(data.pullRequests)

    return { announced: claimUnannounced(), unread: countUnread() }
  })

export const notificationsQuery = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationsResult> => ({
    items: listNotifications(),
    unread: countUnread(),
  }),
)

export const markNotificationsRead = createServerFn({ method: 'POST' })
  .validator(markReadRequest)
  .handler(async ({ data }): Promise<MarkReadResult> => ({
    changed: markRead(data.keys, data.read),
    unread: countUnread(),
  }))

export const markAllNotificationsRead = createServerFn({ method: 'POST' }).handler(
  async (): Promise<MarkReadResult> => ({
    changed: markAllRead(),
    unread: countUnread(),
  }),
)
