import { useSyncExternalStore } from 'react'

import type { NotificationKind } from '@/server/notifications'

// The sound a notification makes, and whether it makes one.
//
// Four events, four tones, **synthesised** — three oscillator notes each, built
// on the fly. Nothing here is fetched: no asset host, no request that can 404 at
// the moment something needed announcing, nothing to bundle beyond this file. The
// tones are short and pitched inside a narrow band so that four of them are
// distinguishable without any of them being an alert.
//
// Two rules the ticket cares about are structural rather than incidental.
//
// **Muting is checked before anything is built.** `play` returns before it
// touches the audio context, so a muted session never constructs an oscillator,
// never resumes a suspended context, and never asks the browser for permission to
// make a noise. The mute is a module store on `localStorage`, the same shape as
// `theme.ts` and for the same reasons.
//
// **Nothing plays before a gesture.** An `AudioContext` created without one is
// born suspended, and resuming it uninvited is what browsers exist to prevent, so
// this module refuses to create one until `unlockAudio` has been called from a
// real event. Before that, `play` is silent by design — a notification that
// arrives in the first seconds of a page nobody has touched yet is exactly the
// one that should not shout.
//
// The type import reaches a server module and is erased; it must stay
// `import type`. `theme.ts` carries the same warning for the same reason.

/** Where the mute lives. Same namespace as the theme's key. */
const STORAGE_KEY = 'ado-web.muted'

/** Loud enough to hear over a keyboard, quiet enough not to be an alarm. */
const GAIN = 0.06

/**
 * The tones, as (hertz, seconds-from-start) pairs. Shape carries the meaning: a
 * build failure falls, a vote rises, a comment is a single soft note answered an
 * octave down, a push is two flat taps. Nobody has to learn them for the app to
 * work — you look at the panel — but after a day you know which ones you can
 * ignore.
 */
const TONES: Record<NotificationKind, ReadonlyArray<readonly [number, number]>> = {
  build: [
    [660, 0],
    [520, 0.09],
    [392, 0.18],
  ],
  vote: [
    [523, 0],
    [659, 0.08],
    [784, 0.16],
  ],
  comment: [
    [784, 0],
    [587, 0.1],
  ],
  commits: [
    [494, 0],
    [494, 0.11],
  ],
}

/** How long one note sounds. Any longer and two events overlap into a chord. */
const NOTE = 0.13

let muted: boolean | undefined
const listeners = new Set<() => void>()

/**
 * Wrapped for `theme.ts`' reason: `localStorage` is absent during the prerender
 * and *throws* on access in a hardened profile. Silence is a better failure than
 * a blank page, and so is noise.
 */
function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Sounds are on until turned off — an inbox you have to configure tells you nothing. */
export function isMuted(): boolean {
  muted ??= stored()

  return muted
}

export function setMuted(value: boolean): void {
  if (isMuted() === value) return
  muted = value
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // A session that cannot persist the choice still gets to make it.
  }
  for (const listener of listeners) listener()
}

export function toggleMuted(): void {
  setMuted(!isMuted())
}

export function subscribeMuted(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** The mute, as a rendering input. Server snapshot is a guard, not a value. */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribeMuted, isMuted, () => false)
}

type ContextFactory = new () => AudioContext

let context: AudioContext | null = null
let unlocked = false

/**
 * Called from the first pointer or key event of the session. Until then there is
 * no audio context at all, which is the only way to be sure nothing autoplays:
 * a suspended context that `play` keeps trying to resume is an autoplay attempt
 * with extra steps.
 */
export function unlockAudio(): void {
  unlocked = true
}

function audio(): AudioContext | null {
  if (!unlocked) return null
  if (context !== null) return context

  const Factory = (globalThis as { AudioContext?: ContextFactory }).AudioContext
  if (Factory === undefined) return null

  try {
    context = new Factory()
  } catch {
    // No audio device, or a policy that forbids one. The panel still works.
    return null
  }

  return context
}

/**
 * Plays this kind of event, unless the session is muted or has not been touched.
 *
 * Never throws: it is called from a poll's callback, where an exception would
 * cost the caller the rest of its work — the badge and the panel matter more than
 * the noise.
 */
export function play(kind: NotificationKind): void {
  // First, and before any of the machinery: muted means nothing is constructed.
  if (isMuted()) return

  const ctx = audio()
  if (ctx === null) return

  try {
    if (ctx.state === 'suspended') void ctx.resume()

    for (const [hertz, offset] of TONES[kind]) {
      const start = ctx.currentTime + offset
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()

      // A triangle rather than a sine: it carries through a room without the
      // buzz of a square, and it reads as drawn rather than electronic.
      oscillator.type = 'triangle'
      oscillator.frequency.value = hertz
      // Ramped down rather than stopped flat, because a hard stop clicks.
      gain.gain.setValueAtTime(GAIN, start)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE)

      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + NOTE)
    }
  } catch {
    // WebAudio is allowed to refuse — a locked context, a device that went away
    // mid-session. There is nothing to recover and nothing to tell anyone.
  }
}

/**
 * Loudest first. A batch plays one tone, this one — which is why the order is a
 * judgement and not the enum's: a broken build outranks a vote, a vote outranks a
 * comment, and a push is the quietest thing that can happen to a PR you are only
 * reviewing.
 */
const PRIORITY: readonly NotificationKind[] = ['build', 'vote', 'comment', 'commits']

/**
 * Announces a batch with a single sound.
 *
 * Twelve notifications arriving on one poll — which is what the first poll after
 * a lunch break looks like — must not play twelve tones over each other, and
 * staggering them turns a notification into a jingle. So the batch sounds like the
 * most important thing in it, and the panel carries the rest; the badge is what
 * says how many.
 */
export function announce(kinds: readonly NotificationKind[]): void {
  if (isMuted()) return

  const loudest = PRIORITY.find((kind) => kinds.includes(kind))
  if (loudest !== undefined) play(loudest)
}
