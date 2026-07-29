import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderReact, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { CommandProvider } from '@/commands/command-provider'
import { setMuted } from '@/lib/notify'

import { Notifications } from './notifications'

import type { ReactNode } from 'react'
import type { Notification } from '@/server/notifications'

vi.mock('@/server/notifications-fn', () => ({
  notificationsQuery: vi.fn(),
  markNotificationsRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  observeNotifications: vi.fn(),
}))

const {
  markAllNotificationsRead,
  markNotificationsRead,
  notificationsQuery,
} = await import('@/server/notifications-fn')

const DETAIL = '/pr/$projectId/$repositoryId/$prId'

/**
 * A row links to a pull request and the bell binds a shortcut, so the panel
 * needs a router and the command provider in context — `RouterContextProvider`
 * for `pr-list.test.tsx`' reason, and a fresh `QueryClient` per render so no
 * test can read another's cache.
 */
function render(ui: ReactNode) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/' }),
      createRoute({ getParentRoute: () => root, path: DETAIL }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return renderReact(ui, {
    wrapper: ({ children }) => (
      <RouterContextProvider router={router}>
        <QueryClientProvider client={client}>
          <CommandProvider>{children}</CommandProvider>
        </QueryClientProvider>
      </RouterContextProvider>
    ),
  })
}

const item = (over: Partial<Notification> = {}): Notification => ({
  key: 'comment:3302:11:1',
  kind: 'comment',
  prId: 3302,
  title: 'disable sql auditing',
  detail: 'Naveen Angali: this needs a rollback plan',
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  createdAt: Date.parse('2026-07-29T09:00:00Z'),
  read: false,
  ...over,
})

const answer = (items: readonly Notification[]) => {
  vi.mocked(notificationsQuery).mockResolvedValue({
    items,
    unread: items.filter((entry) => !entry.read).length,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // The mute is module state that outlives a render, so each test starts audible.
  setMuted(false)
  vi.mocked(markNotificationsRead).mockResolvedValue({ changed: 1, unread: 0 })
  vi.mocked(markAllNotificationsRead).mockResolvedValue({ changed: 2, unread: 0 })
})

describe('the bell', () => {
  it('counts what has not been read yet', async () => {
    answer([item(), item({ key: 'build:3302:abc', kind: 'build', read: true })])
    render(<Notifications />)

    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy()
  })

  it('says nothing about a count of zero', async () => {
    answer([item({ read: true })])
    render(<Notifications />)

    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy()
  })

  it('opens the panel, and `b` opens it too', async () => {
    answer([item()])
    render(<Notifications />)

    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Close notifications' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.keyboard('b')
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeTruthy()
  })
})

describe('the panel', () => {
  const open = async (items: readonly Notification[]) => {
    answer(items)
    render(<Notifications />)
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }))

    return screen.findByRole('dialog', { name: 'Notifications' })
  }

  it('closes on Escape without navigating the page underneath it', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await open([item()])

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Escape means "back" in the shell. While the panel is up it means "close the
    // panel" and nothing else — otherwise dismissing a notification would leave
    // the page you were reading.
    expect(back).not.toHaveBeenCalled()

    back.mockRestore()
  })

  it('says what happened, on which pull request', async () => {
    await open([item()])

    expect(await screen.findByText('disable sql auditing')).toBeTruthy()
    expect(screen.getByText('Naveen Angali: this needs a rollback plan')).toBeTruthy()
    expect(screen.getByRole('link', { name: /disable sql auditing/ }).getAttribute('href')).toBe(
      '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
    )
  })

  it('admits when there is nothing', async () => {
    await open([])

    expect(await screen.findByText('Nothing new yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark all read' }).hasAttribute('disabled')).toBe(true)
  })

  it('marks one read, and puts it back', async () => {
    await open([item(), item({ key: 'build:3302:abc', kind: 'build', read: true })])

    await userEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
    expect(markNotificationsRead).toHaveBeenCalledWith({
      data: { keys: ['comment:3302:11:1'], read: true },
    })

    await userEvent.click(screen.getByRole('button', { name: 'Mark unread' }))
    expect(markNotificationsRead).toHaveBeenLastCalledWith({
      data: { keys: ['build:3302:abc'], read: false },
    })
  })

  it('clears the lot in one press', async () => {
    await open([item()])

    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }))

    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1)
  })

  it('reads a notification by opening it', async () => {
    await open([item()])

    await userEvent.click(await screen.findByRole('link', { name: /disable sql auditing/ }))

    expect(markNotificationsRead).toHaveBeenCalledWith({
      data: { keys: ['comment:3302:11:1'], read: true },
    })
    // And the panel is gone, because the row navigated out of it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('mutes the sounds, and remembers', async () => {
    await open([item()])

    const mute = await screen.findByRole('button', { name: 'Mute notification sounds' })
    expect(mute.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(mute)

    expect(mute.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('ado-web.muted')).toBe('true')
  })
})
