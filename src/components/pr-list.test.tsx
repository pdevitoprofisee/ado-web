import { describe, expect, it, vi } from 'vitest'
import { render as renderReact, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { CommandProvider } from '@/commands/command-provider'

import { PullRequestSection, age, useInboxSelection } from './pr-list'

import type { ReactNode } from 'react'
import type { Hydration, HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

const DETAIL = '/pr/$projectId/$repositoryId/$prId'

/**
 * A row is a router `<Link>` now, so a section cannot be rendered without a
 * router in context. `RouterContextProvider` is the router *without* its
 * `<Matches>` — the half a component test wants — and the fake tree below only
 * has to hold the two paths, since nothing here renders a route.
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

  return {
    router,
    ...renderReact(ui, {
      wrapper: ({ children }) => (
        <RouterContextProvider router={router}>{children}</RouterContextProvider>
      ),
    }),
  }
}

const row = (over: Partial<PullRequestRow> = {}): PullRequestRow => ({
  id: 3302,
  title: 'disable sql auditing',
  project: 'SaaS',
  repository: 'PC.IAC.Modules',
  author: 'Naveen Angali',
  targetBranch: 'main',
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  commitId: 'abc123',
  url: 'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
  viaTeam: 'SaaS \\ DevOps Team',
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  conflicted: false,
  myVote: 0,
  ...over,
})

const rich = (data: Partial<Hydration> = {}): HydrationResult => ({
  id: 3302,
  ok: true,
  data: {
    checks: { passed: 0, failed: 0, pending: 0 },
    unresolved: 0,
    approvalReset: false,
    ...data,
  },
})

const NOW = Date.parse('2026-07-27T12:00:00Z')

describe('age', () => {
  it('picks the largest unit that fits', () => {
    expect(age('2026-07-27T11:59:30Z', NOW)).toBe('just now')
    expect(age('2026-07-27T11:30:00Z', NOW)).toBe('30m ago')
    expect(age('2026-07-27T06:00:00Z', NOW)).toBe('6h ago')
    expect(age('2026-07-20T12:00:00Z', NOW)).toBe('7d ago')
    expect(age('2022-03-01T12:00:00Z', NOW)).toBe('4y ago')
  })

  it('renders nothing rather than "NaN" for a date ADO did not send', () => {
    expect(age('', NOW)).toBe('')
  })
})

describe('PullRequestSection', () => {
  it('renders a row as an internal link to the detail route', () => {
    render(<PullRequestSection title="Assigned to me" rows={[row()]} empty="none" />)

    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    expect(link).toHaveAttribute(
      'href',
      '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
    )
    expect(link).toHaveAccessibleDescription(/SaaS\/PC\.IAC\.Modules · Naveen Angali · via SaaS/)
  })

  it('keeps Azure DevOps one gesture away, as a second labelled link', () => {
    render(<PullRequestSection title="Assigned to me" rows={[row()]} empty="none" />)

    const out = screen.getByRole('link', { name: 'Open in Azure DevOps' })
    expect(out).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    )
    expect(out).toHaveAttribute('target', '_blank')
    expect(out).toHaveAttribute('rel', 'noreferrer')
  })

  it('sends a row with no GUIDs to Azure DevOps rather than to a link that goes nowhere', () => {
    render(<PullRequestSection title="Mine" rows={[row({ repositoryId: null })]} empty="none" />)

    // One link, not two: the row itself is the way out, so a second control to
    // the same place would only be a second thing to read.
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName(/disable sql auditing/)
    expect(links[0]).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    )
  })

  it('shows the count beside the heading and one row per PR', () => {
    render(
      <PullRequestSection
        title="Mine"
        rows={[row({ id: 1 }), row({ id: 2 }), row({ id: 3 })]}
        empty="none"
      />,
    )

    const section = screen.getByRole('region', { name: 'Mine' })
    expect(within(section).getByRole('heading')).toHaveAccessibleName('Mine, 3 pull requests')
    expect(within(section).getAllByRole('listitem')).toHaveLength(3)
  })

  it('marks a draft', () => {
    render(<PullRequestSection title="Mine" rows={[row({ isDraft: true })]} empty="none" />)

    expect(screen.getByText('draft')).toBeVisible()
  })

  it('reserves the rich cell before the data arrives, so a row upgrades in place', () => {
    // The cell sits between the two fixed-width columns at the end of the row.
    const cell = () =>
      screen.getByRole('listitem').querySelector('a')?.lastElementChild?.previousElementSibling

    const { rerender } = render(
      <PullRequestSection title="Mine" rows={[row()]} empty="none" hydration={() => undefined} />,
    )
    const before = cell()
    // Read eagerly: `before` is a live node, and the point of the test is that
    // it is still the *same* node afterwards.
    const emptyText = before?.textContent
    const emptyClass = before?.className

    rerender(
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => rich({ unresolved: 3 })}
      />,
    )

    // Same element, same width class, contentful only afterwards: the badges
    // land inside a box the plain row already reserved.
    expect(cell()).toBe(before)
    expect(cell()?.className).toBe(emptyClass)
    expect(emptyText).toBe('')
    expect(cell()?.textContent).toContain('3')
  })

  it('shows failed checks, unresolved comments and a reset approval', () => {
    render(
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() =>
          rich({
            checks: { passed: 4, failed: 2, pending: 0 },
            unresolved: 3,
            approvalReset: true,
          })
        }
      />,
    )

    expect(screen.getByTitle('2 checks failed')).toBeVisible()
    expect(screen.getByTitle('3 unresolved comments')).toBeVisible()
    expect(screen.getByTitle('A push reset your approval')).toBeVisible()
  })

  it('collapses the checks to one badge: failures, else pending, else all-clear', () => {
    // One glyph rather than three counts, because the column is 6rem wide and
    // "something is red" is the whole decision a reviewer makes from a list.
    const section = (checks: Hydration['checks']) => (
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => rich({ checks })}
      />
    )

    const { rerender } = render(section({ passed: 1, failed: 2, pending: 3 }))
    expect(screen.getByTitle('2 checks failed')).toBeVisible()
    expect(screen.queryByTitle(/checks running/)).toBeNull()

    rerender(section({ passed: 1, failed: 0, pending: 3 }))
    expect(screen.getByTitle('3 checks running')).toBeVisible()

    rerender(section({ passed: 5, failed: 0, pending: 0 }))
    expect(screen.getByTitle('All checks passed')).toBeVisible()
  })

  it('renders the plain row with an inline error when a PR fails to hydrate', () => {
    render(
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => ({ id: 3302, ok: false, error: 'Azure DevOps answered 500.' })}
      />,
    )

    expect(screen.getByRole('link', { name: /disable sql auditing/ })).toBeVisible()
    expect(screen.getByTitle('Could not load: Azure DevOps answered 500.')).toBeVisible()
  })

  it('marks a conflict without waiting for hydration, because the list call carries it', () => {
    render(<PullRequestSection title="Mine" rows={[row({ conflicted: true })]} empty="none" />)

    expect(screen.getByTitle('Merge conflicts')).toBeVisible()
  })

  it('tags each row with its id so the hook can measure what is on screen', () => {
    render(<PullRequestSection title="Mine" rows={[row({ id: 77 })]} empty="none" />)

    expect(screen.getByRole('listitem')).toHaveAttribute('data-pr-id', '77')
  })

  it('says why a section is empty instead of rendering a bare heading', () => {
    render(<PullRequestSection title="Mine" rows={[]} empty="You have no open pull requests." />)

    expect(screen.getByText('You have no open pull requests.')).toBeVisible()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

/** The inbox as the keyboard sees it: two sections, one selection. */
function Sections({
  assigned,
  mine,
}: {
  assigned: readonly PullRequestRow[]
  mine: readonly PullRequestRow[]
}) {
  const selectedId = useInboxSelection([...assigned, ...mine])

  return (
    <>
      <PullRequestSection
        title="Assigned to me"
        rows={assigned}
        empty="none"
        selectedId={selectedId}
      />
      <PullRequestSection title="Mine" rows={mine} empty="none" selectedId={selectedId} />
    </>
  )
}

function Inbox(props: { assigned: readonly PullRequestRow[]; mine: readonly PullRequestRow[] }) {
  return (
    <CommandProvider>
      <Sections {...props} />
    </CommandProvider>
  )
}

/** The selected row's id, read the way a reader would: off what is marked. */
const selected = (): string | null =>
  document.querySelector('[aria-current="true"]')?.getAttribute('data-pr-id') ?? null

describe('useInboxSelection', () => {
  it('moves j and k across both sections as one list, and stops at the ends', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 }), row({ id: 2 })]} mine={[row({ id: 3 })]} />)

    expect(selected()).toBeNull()

    await user.keyboard('j')
    expect(selected()).toBe('1')
    await user.keyboard('jj')
    // Off the end of "Assigned to me" and onto the top of "Mine".
    expect(selected()).toBe('3')
    await user.keyboard('j')
    expect(selected()).toBe('3')

    await user.keyboard('kk')
    expect(selected()).toBe('1')
    await user.keyboard('k')
    expect(selected()).toBe('1')
  })

  it('starts from the bottom when the first key pressed is k', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[row({ id: 2 })]} />)

    await user.keyboard('k')

    expect(selected()).toBe('2')
  })

  it('focuses the selected row, so the keyboard and the screen reader agree', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[]} />)

    await user.keyboard('j')

    const item = screen.getByRole('listitem')
    expect(document.activeElement).toBe(within(item).getByRole('link', { name: /disable sql/ }))
  })

  it('opens the selected row on Enter', async () => {
    const user = userEvent.setup()
    const { router } = render(<Inbox assigned={[row({ id: 3302 })]} mine={[]} />)

    await user.keyboard('j{Enter}')

    await waitFor(() => {
      expect(router.history.location.pathname).toBe(
        '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
      )
    })
  })

  it('opens an unaddressable row in Azure DevOps on Enter, as clicking it would', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    const { router } = render(<Inbox assigned={[row({ projectId: null })]} mine={[]} />)

    await user.keyboard('j{Enter}')

    expect(open).toHaveBeenCalledWith(
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
      '_blank',
      'noreferrer',
    )
    expect(router.history.location.pathname).toBe('/')
    open.mockRestore()
  })

  it('clears the selection on Escape', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[]} />)

    await user.keyboard('j')
    expect(selected()).toBe('1')

    await user.keyboard('{Escape}')

    expect(selected()).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('lights the navigation shortcuts up in the ? sheet, because they now do something', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row()]} mine={[]} />)

    await user.keyboard('?')
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    const bound = [...sheet.querySelectorAll('[data-slot="shortcut"][data-bound="true"] dt')].map(
      (entry) => entry.textContent,
    )
    // Nothing dimmed: the shell's `?` and `t` plus the four this surface claims
    // is the whole registry.
    expect(bound).toEqual([
      'Next item',
      'Previous item',
      'Open',
      'Back',
      'Light or dark',
      'Keyboard shortcuts',
    ])
  })
})
