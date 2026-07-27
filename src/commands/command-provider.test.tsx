import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Input, Label, TextField } from 'react-aria-components'

import { CommandProvider, useCommand } from './command-provider'

import type { CommandId } from './registry'

function Bind({ id, run }: { id: CommandId; run: () => void }) {
  useCommand(id, run)
  return null
}

describe('CommandProvider', () => {
  it('dispatches a key to the surface that bound its command', async () => {
    const run = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandProvider>
        <Bind id="nav.next" run={run} />
      </CommandProvider>,
    )
    await user.keyboard('j')

    expect(run).toHaveBeenCalledOnce()
  })

  it('does not fire while focus is in a text input', async () => {
    const run = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandProvider>
        <Bind id="nav.next" run={run} />
        <label>
          Filter
          <input />
        </label>
      </CommandProvider>,
    )
    const input = screen.getByLabelText('Filter')
    await user.click(input)
    await user.keyboard('jk')

    expect(run).not.toHaveBeenCalled()
    expect(input).toHaveValue('jk')
  })

  it('does not fire while focus is in a React Aria TextField', async () => {
    const run = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandProvider>
        <Bind id="nav.next" run={run} />
        <TextField>
          <Label>Comment</Label>
          <Input />
        </TextField>
      </CommandProvider>,
    )
    await user.click(screen.getByLabelText('Comment'))
    await user.keyboard('j')

    expect(run).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Comment')).toHaveValue('j')
  })

  it('ignores the key when a modifier is held', async () => {
    const run = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandProvider>
        <Bind id="nav.next" run={run} />
      </CommandProvider>,
    )
    await user.keyboard('{Control>}j{/Control}')

    expect(run).not.toHaveBeenCalled()
  })

  it('gives the key to the most recent binding and hands it back', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const user = userEvent.setup()

    function App({ nested }: { nested: boolean }) {
      return (
        <CommandProvider>
          <Bind id="nav.next" run={outer} />
          {nested && <Bind id="nav.next" run={inner} />}
        </CommandProvider>
      )
    }

    const { rerender } = render(<App nested />)
    await user.keyboard('j')
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()

    rerender(<App nested={false} />)
    await user.keyboard('j')
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).toHaveBeenCalledOnce()
  })

  it('binds Esc to history without needing a router', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const user = userEvent.setup()

    render(<CommandProvider>{null}</CommandProvider>)
    await user.keyboard('{Escape}')

    expect(back).toHaveBeenCalledOnce()
    back.mockRestore()
  })
})

describe('the ? sheet', () => {
  it('opens on ? and lists the real registry', async () => {
    const user = userEvent.setup()

    render(<CommandProvider>{null}</CommandProvider>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.keyboard('?')

    const sheet = await screen.findByRole('dialog', {
      name: 'Keyboard shortcuts',
    })
    expect(sheet).toHaveTextContent('Next item')
    expect(sheet).toHaveTextContent('Back')
    // Only what the shell binds is live on this screen; `j` waits for T-006.
    expect(
      sheet.querySelector('[data-slot="shortcut"][data-bound="true"] dt')
        ?.textContent,
    ).toBe('Back')
  })

  it('holds the keyboard while it is open', async () => {
    const run = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandProvider>
        <Bind id="nav.next" run={run} />
      </CommandProvider>,
    )
    await user.keyboard('?')
    await screen.findByRole('dialog')
    await user.keyboard('j')

    expect(run).not.toHaveBeenCalled()
  })
})
