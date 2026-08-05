import { afterEach, describe, expect, it, vi } from 'vitest'
import { render as renderReact, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommandProvider } from '@/commands/command-provider'

import { OrgRepositoryList } from './org-repo-list'

import type { RepositoryRow } from '@/lib/repositories-contract'

/**
 * No router here, unlike `repo-list.test.tsx`: every row on this page is an
 * ordinary `<a>` to Azure DevOps rather than a router `<Link>`, because there is
 * nowhere in the app for an org repository to go.
 *
 * `CommandProvider` is not optional, though. The selection has to run over what
 * the search left, and the search box belongs to this component, so the hook is
 * inside it rather than lifted into the route the way `useRepoSelection` is.
 */
const render = (rows: readonly RepositoryRow[], returned = rows.length) =>
  renderReact(
    <CommandProvider>
      <OrgRepositoryList rows={rows} returned={returned} />
    </CommandProvider>,
  )

const row = (project: string, name: string, over: Partial<RepositoryRow> = {}): RepositoryRow => ({
  name,
  project,
  defaultBranch: 'main',
  cloneUrl: `https://Profisee@dev.azure.com/Profisee/${project}/_git/${name}`,
  webUrl: `https://dev.azure.com/Profisee/${project}/_git/${name}`,
  isDisabled: false,
  isFork: false,
  ...over,
})

const THREE: readonly RepositoryRow[] = [
  row('Products', 'platform'),
  row('SaaS', 'PC.IAC.Networking'),
  row('SaaS', 'pc-portal'),
]

/** The selected row, read the way a reader would: off what is marked. */
const selected = (): string | null =>
  document.querySelector('[aria-current="true"]')?.getAttribute('data-repo-key') ?? null

const rowNames = () =>
  screen.getAllByRole('listitem').map((item) => item.getAttribute('data-repo-key'))

describe('OrgRepositoryList', () => {
  it('draws one row per repository, with the count beside the heading', () => {
    render(THREE)

    const section = screen.getByRole('region', { name: 'Organisation repositories' })
    expect(within(section).getByRole('heading')).toHaveAccessibleName('Repositories, 3 of 3')
    expect(rowNames()).toEqual(['Products/platform', 'SaaS/PC.IAC.Networking', 'SaaS/pc-portal'])
  })

  // `webUrl`, not `url` — the API address would open JSON — and not `remoteUrl`,
  // which belongs to git.
  it('opens each row in Azure DevOps', () => {
    render([row('SaaS', 'pc-portal')])

    const link = screen.getByRole('link', { name: /pc-portal/ })
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/Profisee/SaaS/_git/pc-portal')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('narrows as you type, on the name or the project', async () => {
    const user = userEvent.setup()
    render(THREE)

    await user.type(screen.getByRole('searchbox', { name: 'Search repositories' }), 'saas')

    expect(rowNames()).toEqual(['SaaS/PC.IAC.Networking', 'SaaS/pc-portal'])
    // And says it is showing a subset, rather than letting 2 read as the whole org.
    expect(screen.getByRole('heading')).toHaveAccessibleName('Repositories, 2 of 3')
  })

  // The empty state this page exists to get right: a filtered-to-zero list must
  // not read as "this organisation has no repositories".
  it('says what was typed when the search matches nothing', async () => {
    const user = userEvent.setup()
    render(THREE)

    await user.type(screen.getByRole('searchbox'), 'zzz')

    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.getByText('zzz')).toBeVisible()
    expect(screen.getByText(/No repository matches/)).toBeVisible()
    expect(screen.getByText(/across the organisation/)).toBeVisible()
  })

  it('says the organisation is empty in different words', () => {
    render([])

    expect(screen.getByText(/returned no repositories/)).toBeVisible()
    expect(screen.queryByText(/No repository matches/)).toBeNull()
  })

  it('clears the search on Escape rather than going back', async () => {
    const user = userEvent.setup()
    render(THREE)
    const box = screen.getByRole('searchbox')

    await user.type(box, 'saas')
    await user.keyboard('{Escape}')

    expect(box).toHaveValue('')
    expect(rowNames()).toHaveLength(3)
  })

  it('keeps a disabled repository in the list, marked', () => {
    render([row('SaaS', 'off', { isDisabled: true }), row('SaaS', 'on')])

    expect(rowNames()).toHaveLength(2)
    const off = screen.getAllByRole('listitem')[0]
    expect(within(off).getByText('disabled')).toBeVisible()
  })

  it('marks a fork', () => {
    render([row('SaaS', 'one', { isFork: true })])

    expect(screen.getByText('fork')).toBeVisible()
  })

  // Not a blank cell. A repository with no commits is a fact about the repository.
  it('says "no commits yet" where there is no default branch', () => {
    const empty = row('SaaS', 'fresh')
    delete (empty as { defaultBranch?: string }).defaultBranch

    render([empty])

    expect(screen.getByText('no commits yet')).toBeVisible()
    expect(screen.queryByText('main')).toBeNull()
  })

  describe('copying the clone URL', () => {
    function stubClipboard(clipboard: unknown) {
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    }

    afterEach(() => {
      // Back to jsdom's own navigator, which has no clipboard at all.
      Reflect.deleteProperty(navigator, 'clipboard')
    })

    it('puts remoteUrl on the clipboard verbatim, prefix and all', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      // `userEvent.setup()` installs a clipboard stub of its own, so this has to
      // come after it.
      const user = userEvent.setup()
      stubClipboard({ writeText })
      render([row('SaaS', 'pc-portal')])

      await user.click(screen.getByRole('button', { name: /^Copy clone URL/ }))

      expect(writeText).toHaveBeenCalledWith(
        'https://Profisee@dev.azure.com/Profisee/SaaS/_git/pc-portal',
      )
      // A button that gives no feedback is a button people press twice.
      expect(
        await screen.findByRole('button', { name: 'Copied clone URL for pc-portal' }),
      ).toHaveAttribute('data-state', 'copied')
    })

    it('says it failed rather than throwing when there is no clipboard', async () => {
      const user = userEvent.setup()
      stubClipboard(undefined)
      render([row('SaaS', 'pc-portal')])

      await user.click(screen.getByRole('button', { name: /^Copy clone URL/ }))

      expect(
        await screen.findByRole('button', { name: 'Failed to copy clone URL for pc-portal' }),
      ).toHaveAttribute('data-state', 'failed')
    })
  })

  describe('the keyboard', () => {
    it('moves j and k over the rows and stops at the ends', async () => {
      const user = userEvent.setup()
      render(THREE)

      expect(selected()).toBeNull()

      await user.keyboard('j')
      expect(selected()).toBe('Products/platform')
      await user.keyboard('jj')
      expect(selected()).toBe('SaaS/pc-portal')
      await user.keyboard('j')
      expect(selected()).toBe('SaaS/pc-portal')

      await user.keyboard('kk')
      expect(selected()).toBe('Products/platform')
    })

    // The reason the hook lives inside the component: the cursor has to move over
    // what is on screen, not over what was fetched.
    it('moves over the filtered rows only', async () => {
      const user = userEvent.setup()
      render(THREE)

      await user.type(screen.getByRole('searchbox'), 'saas')
      // Out of the field, because the command layer ignores keys typed into one.
      await user.click(screen.getByRole('heading'))
      await user.keyboard('j')

      expect(selected()).toBe('SaaS/PC.IAC.Networking')
    })

    it('opens the selected row on Enter', async () => {
      const user = userEvent.setup()
      // The command layer calls `preventDefault()` on Enter, so the focused
      // anchor's own activation never fires and the hook has to do the opening.
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      render(THREE)

      await user.keyboard('j')
      await user.keyboard('{Enter}')

      expect(open).toHaveBeenCalledWith(
        'https://dev.azure.com/Profisee/Products/_git/platform',
        '_blank',
        'noreferrer',
      )
      open.mockRestore()
    })

    it('drops the selection on Escape', async () => {
      const user = userEvent.setup()
      render(THREE)

      await user.keyboard('j')
      await user.keyboard('{Escape}')

      expect(selected()).toBeNull()
    })
  })
})
