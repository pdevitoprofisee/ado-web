import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two rules worth a test are both about *not* making a sound: muted, and
// not-yet-touched. Neither is checked by listening — audibility is not testable
// and would not be worth the fixture if it were. What is testable is that the
// audio context is never even constructed, which is the observable difference
// between "quiet" and "asked the browser for permission to make a noise and was
// refused".
//
// Every test re-imports the module, because the mute and the unlock are
// module-level state on purpose (see `notify.ts`) and a session cannot be locked
// again once it has been touched.

/** Frequencies actually scheduled, in order. The tone's shape, as data. */
let played: number[] = []
let built = 0

class RecordingContext {
  state = 'running'
  currentTime = 0
  destination = {}

  constructor() {
    built += 1
  }

  resume() {}

  createOscillator() {
    // Recorded on `start` rather than on creation, so an oscillator that is built
    // and then abandoned would not count as a note.
    const node = {
      type: '',
      frequency: { value: 0 },
      connect: () => {},
      start: () => played.push(node.frequency.value),
      stop: () => {},
    }

    return node
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    }
  }
}

async function load(Context: unknown = RecordingContext) {
  vi.resetModules()
  localStorage.clear()
  played = []
  built = 0
  ;(globalThis as { AudioContext?: unknown }).AudioContext = Context

  return import('./notify')
}

beforeEach(() => {
  vi.resetModules()
})

describe('the mute', () => {
  it('starts off, because an inbox you have to configure tells you nothing', async () => {
    const notify = await load()

    expect(notify.isMuted()).toBe(false)
  })

  it('persists, so the choice outlives the tab', async () => {
    const notify = await load()

    notify.toggleMuted()

    expect(notify.isMuted()).toBe(true)
    expect(localStorage.getItem('ado-web.muted')).toBe('true')

    // And is read back rather than reset by the next session.
    vi.resetModules()
    const again = await import('./notify')
    expect(again.isMuted()).toBe(true)
  })

  it('tells its subscribers, once each', async () => {
    const notify = await load()
    const listener = vi.fn()
    const unsubscribe = notify.subscribeMuted(listener)

    notify.setMuted(true)
    // Already muted: setting it again is not a change and must not notify.
    notify.setMuted(true)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    notify.setMuted(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('survives a localStorage that throws', async () => {
    const notify = await load()
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(notify.isMuted()).toBe(false)
    notify.setMuted(true)
    expect(notify.isMuted()).toBe(true)

    getItem.mockRestore()
    setItem.mockRestore()
  })
})

describe('nothing sounds', () => {
  it('before a gesture has unlocked the audio context', async () => {
    const notify = await load()

    notify.play('build')

    expect(built).toBe(0)
    expect(played).toEqual([])
  })

  it('while muted — checked before any of the machinery is built', async () => {
    const notify = await load()
    notify.unlockAudio()
    notify.setMuted(true)

    notify.play('build')
    notify.announce(['build', 'vote'])

    // Not "no oscillator": no *context*. A muted session never asks the browser
    // for audio at all.
    expect(built).toBe(0)
    expect(played).toEqual([])
  })

  it('for an empty batch', async () => {
    const notify = await load()
    notify.unlockAudio()

    notify.announce([])

    expect(played).toEqual([])
  })

  it('when the browser has no audio at all', async () => {
    const notify = await load(undefined)
    notify.unlockAudio()

    expect(() => notify.play('comment')).not.toThrow()
  })

  it('when constructing the context throws', async () => {
    const notify = await load(
      class {
        constructor() {
          throw new Error('no device')
        }
      },
    )
    notify.unlockAudio()

    expect(() => notify.play('comment')).not.toThrow()
  })
})

describe('announcing a batch', () => {
  it('plays one tone, the loudest thing in it', async () => {
    const notify = await load()
    notify.unlockAudio()

    // A poll that comes back with everything at once — which is what the first
    // one after lunch looks like — must not play four tones over each other.
    notify.announce(['commits', 'comment', 'vote', 'build'])

    expect(built).toBe(1)
    expect(played).toEqual([660, 520, 392])
  })

  it('falls back down the order when the loud ones are absent', async () => {
    const notify = await load()
    notify.unlockAudio()

    notify.announce(['commits', 'comment'])
    expect(played).toEqual([784, 587])

    played = []
    notify.announce(['commits'])
    expect(played).toEqual([494, 494])
  })

  it('gives each kind a shape of its own', async () => {
    const notify = await load()
    notify.unlockAudio()

    const tones = (['build', 'vote', 'comment', 'commits'] as const).map((kind) => {
      played = []
      notify.play(kind)

      return played.join(',')
    })

    expect(new Set(tones).size).toBe(4)
    // And one context for the session, not one per sound.
    expect(built).toBe(1)
  })
})
