import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as renderBare, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkItemPicker } from './picker'
import { attachWorkItem, workItemSearchQuery } from '@/server/work-items-fn'

import type { ReactElement, ReactNode } from 'react'
import type { WorkItem } from '@/lib/work-item-contract'
import type { PullRequestRef } from '@/server/pull-request'

// `reviewer-picker.test.tsx`' claims, plus the one this field has of its own: the
// list is remote, so every keystroke would be two ADO calls if the debounce were
// not there. That is what the third test pins.
//
// The rest is the same keyboard feature and the same two-way write: nothing is read
// until the button is pressed, and what leaves for ADO is a work item *number*.

vi.mock('@/server/work-items-fn', () => ({
  workItemsQuery: vi.fn(),
  workItemSearchQuery: vi.fn(),
  attachWorkItem: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

// Reached through `requeue.ts`, which owns the detail key an attach invalidates.
// `checks.test.tsx`' mock, for its reason: that module sits beside a server function
// that opens SQLite.
vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 162828,
  title: 'Login fails on a renamed account',
  state: 'Active',
  type: 'Bug',
  url: 'https://dev.azure.com/Profisee/Platform/_workitems/edit/162828',
  ...over,
})

const THREE = [
  item(),
  item({ id: 162901, title: 'Attach work items to a pull request', type: 'User Story' }),
  item({ id: 163044, title: 'Rate limit the diff reads', type: 'Task', state: 'New' }),
]

const found = (items: readonly WorkItem[] = THREE, error: string | null = null) => ({
  items,
  error,
  connected: true,
})

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

const render = (ui: ReactElement) => renderBare(ui, { wrapper: Providers })

const picker = (attached: readonly number[] = []) =>
  render(<WorkItemPicker prRef={REF} attached={new Set(attached)} />)

const ask = () => screen.getByRole('button', { name: 'Attach a work item' })
const field = () => screen.getByRole('combobox', { name: 'Attach a work item' })

/** What was typed at each call, in order, which is the debounce made visible. */
const asked = () =>
  vi
    .mocked(workItemSearchQuery)
    .mock.calls.map((call) => (call[0] as { data: { query: string } }).data.query)

/** The list, once the first answer has arrived. */
const offered = async () => {
  await screen.findByRole('option', { name: /162828/ })

  return screen.getAllByRole('option').map((option) => option.textContent)
}

beforeEach(() => {
  // Reset rather than re-stubbed, `reviewer-picker.test.tsx`' reason: the first test
  // asserts nothing was searched for, and a call carried over would make it pass or
  // fail by where it sits in the file.
  vi.mocked(workItemSearchQuery).mockReset()
  vi.mocked(workItemSearchQuery).mockResolvedValue(found())
  vi.mocked(attachWorkItem).mockClear()
})

describe('WorkItemPicker', () => {
  it('searches nothing until the button is pressed', async () => {
    picker()

    expect(ask()).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(vi.mocked(workItemSearchQuery)).not.toHaveBeenCalled()

    await userEvent.click(ask())

    await waitFor(() => expect(vi.mocked(workItemSearchQuery)).toHaveBeenCalledTimes(1))
    expect(asked()).toEqual([''])
    expect(field()).toHaveFocus()
  })

  it('offers what is recent before anything is typed', async () => {
    picker()
    await userEvent.click(ask())

    // The empty query is not an empty list. Pressing the button is itself the
    // question "what am I working on", which the server answers from the board.
    const options = await offered()
    expect(options).toHaveLength(3)
    expect(options[1]).toContain('Attach work items to a pull request')
    expect(options[1]).toContain('User Story · Active')
  })

  it('does not offer a work item that is already on the pull request', async () => {
    picker([162828])
    await userEvent.click(ask())

    await screen.findByRole('option', { name: /162901/ })
    expect(screen.queryByRole('option', { name: /162828/ })).not.toBeInTheDocument()
  })

  it('does not ask once per keystroke', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'login')

    // Five letters, and what reaches the server is the word. Each call here is a
    // WIQL query plus a batch read, which is the whole reason `useWorkItemSearch`
    // waits for the typing to stop.
    await waitFor(() => expect(asked().at(-1)).toBe('login'))
    expect(asked().length).toBeLessThan(4)
  })

  it('sends the work item number, and nothing but the number', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.keyboard('{Enter}')

    expect(vi.mocked(attachWorkItem)).toHaveBeenCalledWith({
      data: { ...REF, workItemId: 162828 },
    })
  })

  it('walks the list with the arrow keys and wraps around', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    const active = () =>
      screen
        .getAllByRole('option')
        .find((option) => option.getAttribute('aria-selected') === 'true')?.textContent

    expect(active()).toContain('162828')

    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(active()).toContain('163044')

    // Wrapping rather than stopping, so holding the key never parks the highlight on
    // the last row.
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toContain('162828')

    await userEvent.keyboard('{ArrowUp}')
    expect(active()).toContain('163044')

    await userEvent.keyboard('{Enter}')
    expect(vi.mocked(attachWorkItem)).toHaveBeenCalledWith({
      data: { ...REF, workItemId: 163044 },
    })
  })

  it('picks with Tab as well as Enter', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.keyboard('{Tab}')

    expect(vi.mocked(attachWorkItem)).toHaveBeenCalledWith({
      data: { ...REF, workItemId: 162828 },
    })
  })

  it('picks with the mouse', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.click(screen.getByRole('option', { name: /162901/ }))

    expect(vi.mocked(attachWorkItem)).toHaveBeenCalledWith({
      data: { ...REF, workItemId: 162901 },
    })
  })

  it('stays open after an attach, and clears what was typed', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), '162828{Enter}')

    // A pull request that closes one ticket often closes two. Nothing is drawn
    // optimistically — the row appears when the re-read says it is there.
    await waitFor(() => expect(field()).toHaveValue(''))
    expect(field()).toBeInTheDocument()
  })

  it('closes on Escape without taking the page with it', async () => {
    // Escape at the shell is `nav.back`, so the handler stops the event as well as
    // preventing it.
    const away = vi.fn()
    render(
      <div onKeyDown={away}>
        <WorkItemPicker prRef={REF} attached={new Set()} />
      </div>,
    )

    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(ask()).toBeInTheDocument()
    expect(away).not.toHaveBeenCalled()
  })

  it('closes when Done is pressed', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('closes on a click outside it', async () => {
    render(
      <>
        <p>Elsewhere on the page</p>
        <WorkItemPicker prRef={REF} attached={new Set()} />
      </>,
    )

    await userEvent.click(ask())
    await offered()
    await userEvent.click(screen.getByText('Elsewhere on the page'))

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(ask()).toBeInTheDocument()
  })

  it('names the work item it is waiting on', async () => {
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(attachWorkItem).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    picker()
    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Enter}')

    await screen.findByText('Attaching 162828…')

    land({ ok: true, error: null, connected: true })
    await waitFor(() => expect(screen.queryByText('Attaching 162828…')).not.toBeInTheDocument())
  })

  it('says what Azure DevOps said, and lets it be dismissed', async () => {
    vi.mocked(attachWorkItem).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401326: You need the Contribute permission.)',
      connected: true,
    })

    picker()
    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Enter}')

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent('Azure DevOps did not attach it:')
    expect(refusal).toHaveTextContent('TF401326')

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so while the search is still out', async () => {
    vi.mocked(workItemSearchQuery).mockReturnValueOnce(new Promise(() => {}))

    picker()
    await userEvent.click(ask())

    expect(await screen.findByText('Looking for work items…')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('repeats the searchs own failure rather than showing an empty list', async () => {
    // The difference this field has to make and a local list never does: "nothing
    // matches" and "the search did not run" look identical as an empty list.
    vi.mocked(workItemSearchQuery).mockResolvedValue(found([], 'Azure DevOps answered 500.'))

    picker()
    await userEvent.click(ask())

    expect(
      await screen.findByText('Work items could not be searched. Azure DevOps answered 500.'),
    ).toBeInTheDocument()
  })

  it('says the whole call failed when it never arrived', async () => {
    vi.mocked(workItemSearchQuery).mockRejectedValue(new Error('Failed to fetch'))

    picker()
    await userEvent.click(ask())

    expect(
      await screen.findByText('Work items could not be searched. Failed to fetch'),
    ).toBeInTheDocument()
  })

  it('says nothing is recent, rather than leaving the list blank', async () => {
    vi.mocked(workItemSearchQuery).mockResolvedValue(found([]))

    picker()
    await userEvent.click(ask())

    expect(
      await screen.findByText('Nothing recent is assigned to you. Type a number or part of a title.'),
    ).toBeInTheDocument()
  })

  it('names what was typed when nothing matches it', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    vi.mocked(workItemSearchQuery).mockResolvedValue(found([]))
    await userEvent.type(field(), 'zzz')

    expect(await screen.findByText('Nothing matches “zzz”.')).toBeInTheDocument()
  })

  it('does nothing on Enter when there is nothing to pick', async () => {
    vi.mocked(workItemSearchQuery).mockResolvedValue(found([]))

    picker()
    await userEvent.click(ask())
    await screen.findByText(/Nothing recent/)

    await userEvent.type(field(), '162828{Enter}')

    // Typing a number is not attaching it. The number has to come back from ADO as
    // a work item first, which is also what stops a typo becoming a `PATCH`.
    expect(vi.mocked(attachWorkItem)).not.toHaveBeenCalled()
  })
})
