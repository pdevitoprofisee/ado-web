import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ShortcutSheet } from './shortcut-sheet'

import type { Command } from './registry'

// The sheet is rendered against a registry that does not exist in the app. If
// these rows show up, the sheet is generated; a hand-written one would print
// `j`/`k`/`Enter` no matter what the registry said. Group order is reversed
// from the real registry for the same reason.
const fabricated = vi.hoisted(
  () =>
    [
      { id: 'fake.first', key: 'z', label: 'Fabricated first', group: 'Help' },
      {
        id: 'fake.second',
        key: 'Escape',
        keyLabel: 'Sample',
        label: 'Fabricated second',
        group: 'Help',
      },
      {
        id: 'fake.third',
        key: 'q',
        label: 'Fabricated third',
        group: 'Navigation',
      },
    ] satisfies ReadonlyArray<Command>,
)

vi.mock('./registry', () => ({ COMMANDS: fabricated }))

function rows() {
  return [...document.querySelectorAll('[data-slot="shortcut"]')]
}

function open(bound: ReadonlySet<string> = new Set()) {
  render(
    <ShortcutSheet
      isOpen
      onOpenChange={() => {}}
      isBound={(id) => bound.has(id)}
    />,
  )
}

describe('ShortcutSheet', () => {
  it('renders exactly one row per registry entry, in registry order', () => {
    open()

    expect(
      rows().map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
      ]),
    ).toEqual(
      fabricated.map((command) => [
        command.label,
        command.keyLabel ?? command.key,
      ]),
    )
  })

  it('groups in the order the registry first mentions each group', () => {
    open()

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent),
    ).toEqual(['Help', 'Navigation'])
  })

  it('marks commands nothing is listening for', () => {
    open(new Set(['fake.second']))

    expect(
      Object.fromEntries(
        rows().map((row) => [
          row.querySelector('dt')?.textContent,
          row.getAttribute('data-bound'),
        ]),
      ),
    ).toEqual({
      'Fabricated first': 'false',
      'Fabricated second': 'true',
      'Fabricated third': 'false',
    })
  })
})
