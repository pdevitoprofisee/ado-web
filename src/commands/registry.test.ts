import { describe, expect, it } from 'vitest'

import { COMMANDS } from './registry'

describe('command registry', () => {
  it('has no duplicate ids', () => {
    const ids = COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no two commands on the same key', () => {
    // The dispatcher resolves a key to exactly one command, so a collision
    // would silently give one of the two entries away to the other.
    const keys = COMMANDS.map((command) => command.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
