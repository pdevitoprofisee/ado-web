import { describe, expect, it } from 'vitest'
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

import { RepositoryList, useRepoSelection } from './repo-list'

import type { ReactNode } from 'react'
import type {
  LocalRepository,
  RepositoryEntry,
  RepositoryScan,
  ScannedRoot,
  UnreadableRepository,
} from '@/lib/local-git-contract'

const DIFF = '/repos/$repo'

/**
 * A row is a router `<Link>`, so the list cannot render without a router in
 * context. `RouterContextProvider` is the router *without* its `<Matches>` —
 * the half a component test wants — and the fake tree only has to hold the two
 * paths, since nothing here renders a route.
 */
function render(ui: ReactNode) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/repos' }),
      createRoute({ getParentRoute: () => root, path: DIFF }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/repos'] }),
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

const ROOT = 'C:\\Users\\PaulDe\\repos'

const repo = (over: Partial<LocalRepository> = {}): LocalRepository => ({
  kind: 'repository',
  slug: 'platform',
  path: `${ROOT}\\platform`,
  head: { kind: 'branch', name: 'chore/rename', commit: 'a'.repeat(40) },
  target: {
    kind: 'resolved',
    rung: 'origin-head',
    ref: {
      name: 'origin/master',
      fullName: 'refs/remotes/origin/master',
      commit: 'b'.repeat(40),
    },
    baseCommittedAt: '2026-07-14T09:00:00Z',
  },
  unaddressable: null,
  ...over,
})

const unreadable = (over: Partial<UnreadableRepository> = {}): UnreadableRepository => ({
  kind: 'unreadable',
  slug: 'broken',
  path: `${ROOT}\\broken`,
  message: 'git for-each-ref failed (exit 128): fatal: not a git repository',
  ...over,
})

const root = (over: Partial<ScannedRoot> = {}): ScannedRoot => ({
  path: ROOT,
  configured: true,
  exists: true,
  ...over,
})

const scan = (
  repositories: readonly RepositoryEntry[],
  roots: readonly ScannedRoot[] = [root()],
): RepositoryScan => ({ roots, repositories })

const list = (
  repositories: readonly RepositoryEntry[],
  roots?: readonly ScannedRoot[],
) => render(<RepositoryList scan={scan(repositories, roots)} />)

describe('RepositoryList', () => {
  it('sends each repository to its branch diff, addressed by slug alone', () => {
    list([repo()])

    // No filesystem path anywhere in the URL: the slug is looked up in the
    // scanned set on the way back in, which is what keeps one out.
    expect(screen.getByRole('link', { name: /platform/ })).toHaveAttribute('href', '/repos/platform')
  })

  it('shows the count beside the heading and one row per repository', () => {
    list([repo({ slug: 'a', path: 'a' }), repo({ slug: 'b', path: 'b' }), unreadable()])

    const section = screen.getByRole('region', { name: 'Repositories' })
    expect(within(section).getByRole('heading')).toHaveAccessibleName('Repositories, 3')
    expect(within(section).getAllByRole('listitem')).toHaveLength(3)
  })

  it('names the branch you are on, and the target a diff would be taken against', () => {
    list([repo()])

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('chore/rename')).toBeVisible()
    expect(within(row).getByText('→origin/master')).toBeVisible()
    // The rung in the contract's wording, so this page and the diff page cannot
    // drift into two sentences for one fact.
    expect(within(row).getByText("origin's default branch")).toBeVisible()
  })

  it('says a repository with no origin resolved against a local branch', () => {
    list([
      repo({
        target: {
          kind: 'resolved',
          rung: 'local-branch',
          ref: { name: 'main', fullName: 'refs/heads/main', commit: 'c'.repeat(40) },
          baseCommittedAt: '2026-07-14T09:00:00Z',
        },
      }),
    ])

    expect(
      screen.getByText('a local branch — this repository has no origin'),
    ).toBeVisible()
  })

  it('prints what an unresolved target tried, rather than leaving the cell blank', () => {
    list([repo({ target: { kind: 'unresolved', tried: ['origin/HEAD', 'origin/main'] } })])

    // "No target" on a repository with three remotes is a bug report; the list
    // of attempts is an explanation.
    expect(screen.getByText(/no target — tried origin\/HEAD, origin\/main/)).toBeVisible()
  })

  it('tells a detached HEAD and an unborn one apart, and neither reads as a branch', () => {
    const { rerender } = list([repo({ head: { kind: 'detached', commit: 'abc1234' + '0'.repeat(33) } })])
    expect(screen.getByText('detached')).toBeVisible()
    expect(screen.getByText('abc1234')).toBeVisible()

    rerender(<RepositoryList scan={scan([repo({ head: { kind: 'unborn', name: 'main' } })])} />)
    expect(screen.getByText('unborn')).toBeVisible()
    // Still the branch that *would* be created, because that is what git can
    // still say about a repository with no commits.
    expect(screen.getByText('main')).toBeVisible()
  })

  it('keeps an unreadable repository in the list, with its reason and no link', () => {
    // A silently shortened list reads as "you have eighteen repositories".
    list([repo(), unreadable()])

    expect(screen.getByText(/fatal: not a git repository/)).toBeVisible()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('refuses to address either half of a slug collision, and shows both paths', () => {
    const message = 'Two repositories under your roots are called `fixture`.'
    list(
      [
        repo({ slug: 'fixture', path: `${ROOT}\\fixture`, unaddressable: message }),
        repo({ slug: 'fixture', path: 'D:\\work\\fixture', unaddressable: message }),
      ],
      [root(), root({ path: 'D:\\work' })],
    )

    // Numbering them would mean a third arrival renumbers the second, and the
    // viewed marks keyed on the slug would re-point at another repository.
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.getAllByText(message)).toHaveLength(2)
    expect(screen.getByText(`${ROOT}\\fixture`)).toBeVisible()
    expect(screen.getByText('D:\\work\\fixture')).toBeVisible()
  })
})

describe('the four ways the list can be empty', () => {
  it('asks to be pointed somewhere when no root was ever configured', () => {
    list([], [root({ configured: false, exists: false, path: 'C:\\Users\\PaulDe\\repos' })])

    expect(screen.getByText(/Point the app at your repositories/)).toBeVisible()
    expect(screen.getByText('ADO_WEB_REPOS_ROOT')).toBeVisible()
  })

  it('names a configured root that is not there', () => {
    list([], [root({ path: 'D:\\gone' })].map((one) => ({ ...one, exists: false })))

    expect(screen.getByText('D:\\gone')).toBeVisible()
    expect(screen.getByText(/is not there/)).toBeVisible()
  })

  it('names a configured root that is there and holds nothing', () => {
    list([], [root({ path: 'D:\\empty' })])

    expect(screen.getByText('D:\\empty')).toBeVisible()
    expect(screen.getByText(/holds no git repositories/)).toBeVisible()
    // The scan is one level deep by construction, and that is why a directory
    // full of nested checkouts looks empty here.
    expect(screen.getByText(/one level deep/)).toBeVisible()
  })

  it('still says a root is missing when another root filled the list', () => {
    // Otherwise the page draws a plausible list and never mentions that half of
    // what was asked for is not there.
    list([repo()], [root(), root({ path: 'D:\\gone', exists: false })])

    expect(screen.getByText('D:\\gone')).toBeVisible()
    expect(screen.getByRole('link', { name: /platform/ })).toBeVisible()
    // And it does not go on to claim the working root is empty.
    expect(screen.queryByText(/holds no git repositories/)).toBeNull()
  })
})

function Page({ repositories }: { repositories: readonly RepositoryEntry[] }) {
  const selectedSlug = useRepoSelection(repositories)

  return <RepositoryList scan={scan(repositories)} selectedSlug={selectedSlug} />
}

const bound = (repositories: readonly RepositoryEntry[]) =>
  render(
    <CommandProvider>
      <Page repositories={repositories} />
    </CommandProvider>,
  )

/** The selected row's slug, read the way a reader would: off what is marked. */
const selected = (): string | null =>
  document.querySelector('[aria-current="true"]')?.getAttribute('data-repo-slug') ?? null

describe('useRepoSelection', () => {
  const three = [
    repo({ slug: 'a', path: 'a' }),
    repo({ slug: 'b', path: 'b' }),
    repo({ slug: 'c', path: 'c' }),
  ]

  it('moves j and k down the list and stops at the ends', async () => {
    const user = userEvent.setup()
    bound(three)

    expect(selected()).toBeNull()

    await user.keyboard('j')
    expect(selected()).toBe('a')
    await user.keyboard('jj')
    expect(selected()).toBe('c')
    await user.keyboard('j')
    expect(selected()).toBe('c')

    await user.keyboard('kk')
    expect(selected()).toBe('a')
    await user.keyboard('k')
    expect(selected()).toBe('a')
  })

  it('starts from the bottom when the first key pressed is k', async () => {
    const user = userEvent.setup()
    bound(three)

    await user.keyboard('k')

    expect(selected()).toBe('c')
  })

  it('focuses the selected row, so the keyboard and the screen reader agree', async () => {
    const user = userEvent.setup()
    bound([repo()])

    await user.keyboard('j')

    const row = screen.getByRole('listitem')
    expect(document.activeElement).toBe(within(row).getByRole('link'))
  })

  it('opens the selected repository on Enter', async () => {
    const user = userEvent.setup()
    const { router } = bound([repo()])

    await user.keyboard('j{Enter}')

    await waitFor(() => {
      expect(router.history.location.pathname).toBe('/repos/platform')
    })
  })

  it('skips the rows Enter could not open', async () => {
    // A cursor exists so that Enter has something to open. Stopping it on a row
    // that goes nowhere would be a cursor that sometimes lies — and both rows
    // are still on the page saying why they go nowhere.
    const user = userEvent.setup()
    bound([
      unreadable({ slug: 'broken', path: 'broken' }),
      repo({ slug: 'good', path: 'good' }),
      repo({ slug: 'twin', path: 'twin', unaddressable: 'Two repositories are called `twin`.' }),
    ])

    await user.keyboard('j')
    expect(selected()).toBe('good')
    await user.keyboard('j')
    expect(selected()).toBe('good')
    await user.keyboard('k')
    expect(selected()).toBe('good')
  })

  it('clears the selection on Escape', async () => {
    const user = userEvent.setup()
    bound([repo()])

    await user.keyboard('j')
    expect(selected()).toBe('platform')

    await user.keyboard('{Escape}')

    expect(selected()).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('adds nothing to the ? sheet: the four navigation keys are the whole claim', async () => {
    const user = userEvent.setup()
    bound([repo()])

    await user.keyboard('?')
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    const lit = [...sheet.querySelectorAll('[data-slot="shortcut"][data-bound="true"] dt')].map(
      (entry) => entry.textContent,
    )
    expect(lit).toEqual([
      'Next item',
      'Previous item',
      'Open',
      'Back',
      'Light or dark',
      'Keyboard shortcuts',
    ])
  })
})
