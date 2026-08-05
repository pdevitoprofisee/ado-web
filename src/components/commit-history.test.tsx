import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderReact, screen, within } from '@testing-library/react'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { CommitHistory } from './commit-history'

import type { ReactNode } from 'react'
import type { CommitPage, LocalCommit } from '@/lib/local-git-contract'

const COMMITS = '/repos/$repo/commits'
const COMMIT = '/repos/$repo/commit/$sha'

/**
 * A row is a router `<Link>`, so the list cannot render without a router in
 * context. `RouterContextProvider` is the router *without* its `<Matches>` — the
 * half a component test wants — and the fake tree only holds the paths the links
 * name, since nothing here renders a route.
 */
function render(ui: ReactNode) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: COMMITS }),
      createRoute({ getParentRoute: () => root, path: COMMIT }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/repos/platform/commits'] }),
  })

  return renderReact(ui, {
    wrapper: ({ children }) => (
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    ),
  })
}

const commit = (over: Partial<LocalCommit> = {}): LocalCommit => ({
  sha: 'a'.repeat(40),
  abbreviated: 'aaaaaaa',
  authorName: 'Paul DeVito',
  authorEmail: 'paul.devito@profisee.com',
  committedAt: '2026-07-20T12:00:00Z',
  parents: ['b'.repeat(40)],
  subject: 'fix(pr): keep the merge off until the reviewers approve',
  ...over,
})

const page = (over: Partial<CommitPage> = {}): CommitPage => ({
  ref: { name: 'chore/rename', fullName: 'refs/heads/chore/rename', commit: 'a'.repeat(40) },
  commits: [commit()],
  skip: 0,
  more: false,
  ...over,
})

/** A history of `count` rows, each with a sha of its own. */
const many = (count: number) =>
  Array.from({ length: count }, (_, at) =>
    commit({ sha: String(at).padStart(40, '0'), abbreviated: `c${at}`, subject: `commit ${at}` }),
  )

const rows = () => within(screen.getByRole('list', { name: 'Commits' })).getAllByRole('listitem')

/** Fixed, because "7d ago" is a fact about today otherwise. */
const NOW = new Date('2026-07-27T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CommitHistory', () => {
  describe('a row', () => {
    it('states the abbreviation, the subject, the author and the age', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      const row = within(rows()[0])
      expect(row.getByText('aaaaaaa')).toBeInTheDocument()
      expect(row.getByText(/keep the merge off/)).toBeInTheDocument()
      expect(row.getByText('Paul DeVito')).toBeInTheDocument()
      expect(row.getByText('7d ago')).toBeInTheDocument()
    })

    // `%s` folds a whole paragraph, and `platform` holds a subject 46,490
    // characters long. The date is what goes in the `title` instead.
    it('puts the timestamp in the title and not the subject', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      expect(within(rows()[0]).getByRole('link')).toHaveAttribute('title', '2026-07-20T12:00:00Z')
    })

    // The way back has to be the page you were on, not the top of whatever
    // branch `HEAD` is on — and the *resolved* ref, which is the history
    // actually being shown rather than the pin the URL arrived with.
    it("carries the shown ref and the offset into the commit's own address", () => {
      render(<CommitHistory slug="platform" page={page({ commits: many(3), skip: 50 })} />)

      const href = within(rows()[0]).getByRole('link').getAttribute('href')
      expect(href).toContain('/repos/platform/commit/' + '0'.repeat(40))
      expect(href).toContain('ref=chore%2Frename')
      expect(href).toContain('skip=50')
    })

    it('leaves the offset out of the address on the first page', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      expect(within(rows()[0]).getByRole('link').getAttribute('href')).not.toContain('skip')
    })
  })

  // A merge's diff has to choose a side, and knowing that before the click is
  // what stops the choice being invisible.
  describe('what kind of commit it is', () => {
    it('marks a merge', () => {
      render(<CommitHistory slug="platform" page={page({ commits: [commit({ parents: ['b'.repeat(40), 'c'.repeat(40)] })] })} />)

      expect(screen.getByText('merge')).toBeInTheDocument()
    })

    it('marks a root commit', () => {
      render(<CommitHistory slug="platform" page={page({ commits: [commit({ parents: [] })] })} />)

      expect(screen.getByText('first commit')).toBeInTheDocument()
    })

    it('marks an ordinary commit as nothing at all', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      expect(screen.queryByText('merge')).not.toBeInTheDocument()
      expect(screen.queryByText('first commit')).not.toBeInTheDocument()
    })
  })

  describe('paging', () => {
    it('offers nothing when the whole history is on one page', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      expect(screen.queryByRole('navigation', { name: 'History paging' })).not.toBeInTheDocument()
    })

    it('offers older only, on the first page of a longer history', () => {
      render(<CommitHistory slug="platform" page={page({ commits: many(50), more: true })} />)

      const paging = within(screen.getByRole('navigation', { name: 'History paging' }))
      expect(paging.getByRole('link', { name: 'older' }).getAttribute('href')).toContain('skip=50')
      expect(paging.queryByRole('link', { name: 'newer' })).not.toBeInTheDocument()
    })

    // **The step is the page size and never `commits.length`.** A short last
    // page stepped back by its own length lands on a page overlapping the one
    // before it — here, 7 rows at offset 100 must go back to 50, not to 93.
    it('steps back by a page and not by the number of rows on it', () => {
      render(<CommitHistory slug="platform" page={page({ commits: many(7), skip: 100 })} />)

      const paging = within(screen.getByRole('navigation', { name: 'History paging' }))
      expect(paging.getByRole('link', { name: 'newer' }).getAttribute('href')).toContain('skip=50')
      expect(paging.queryByRole('link', { name: 'older' })).not.toBeInTheDocument()
    })

    // Page one is the absent `?skip=`, so the two ways of spelling the top of a
    // history stay one address.
    it('spells the first page as no offset at all', () => {
      render(<CommitHistory slug="platform" page={page({ commits: many(50), skip: 50, more: true })} />)

      const newer = within(screen.getByRole('navigation', { name: 'History paging' })).getByRole(
        'link',
        { name: 'newer' },
      )
      expect(newer.getAttribute('href')).not.toContain('skip')
    })

    // One-based, because a number beside a list is a place in it. There is no
    // page count to print instead: totalling a 90,000-commit history is a second
    // walk of all of it.
    it('says where in the history this page sits', () => {
      render(<CommitHistory slug="platform" page={page({ commits: many(50), skip: 50, more: true })} />)

      expect(screen.getByText('51–100')).toBeInTheDocument()
    })
  })

  describe('the empty cases', () => {
    it('names the ref it walked', () => {
      render(<CommitHistory slug="platform" page={page()} />)

      expect(screen.getByRole('heading', { name: 'Commits on chore/rename' })).toBeInTheDocument()
    })

    // "There are none" and "you walked off the end" are different facts, and the
    // output git gives for both is zero bytes and exit 0.
    it('says an offset is past the end of the history', () => {
      render(<CommitHistory slug="platform" page={page({ commits: [], skip: 500 })} />)

      expect(screen.getByText(/shorter than/)).toHaveTextContent(
        'This history is shorter than 500 commits',
      )
      expect(screen.queryByRole('list', { name: 'Commits' })).not.toBeInTheDocument()
    })

    it('says a ref has no commits at all', () => {
      render(<CommitHistory slug="platform" page={page({ commits: [] })} />)

      expect(screen.getByText(/has no commits/)).toBeInTheDocument()
      expect(screen.queryByText(/shorter than/)).not.toBeInTheDocument()
    })
  })
})
