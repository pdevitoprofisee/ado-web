import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderReact, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { CommitDiff } from './commit-diff'

import type { ComponentProps, ReactElement } from 'react'
import type { DiffLayout } from '@/lib/diff-contract'
import type {
  CommitChangeSet,
  DiffedAgainst,
  LocalChangedFile,
  LocalCommit,
} from '@/lib/local-git-contract'

// Nothing here fetches a blob — jsdom implements no `IntersectionObserver`, so a
// panel cannot tell it is on screen and never asks — but `localDiffSource` closes
// over this module, and the real one spawns `git`. Mocked so a jsdom bundle cannot
// reach a child process. See `branch-diff.test.tsx`.
vi.mock('@/server/local-git-fn', () => ({ localBlobsQuery: vi.fn() }))

const COMMITS = '/repos/$repo/commits'
const COMMIT = '/repos/$repo/commit/$sha'

/**
 * A router for the parent links and a query client for the panels.
 *
 * The memory history starts on a commit *with* a `?ref=` and a `?skip=`, because
 * the parent links are written with the updater form — the thing under test is
 * that switching parents keeps the way back, and it can only keep what the
 * location holds.
 */
function render(ui: ReactElement) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: COMMITS }),
      createRoute({ getParentRoute: () => root, path: COMMIT }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/repos/platform/commit/${'a'.repeat(40)}?ref=main&skip=50`],
    }),
  })

  return renderReact(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterContextProvider router={router}>{children}</RouterContextProvider>
      </QueryClientProvider>
    ),
  })
}

/** The view, plus the one piece of its state the route owns; see `branch-diff.test.tsx`. */
function Diff({
  initialLayout = 'unified',
  ...props
}: Omit<ComponentProps<typeof CommitDiff>, 'layout' | 'onLayoutChange'> & {
  initialLayout?: DiffLayout
}) {
  const [layout, setLayout] = useState<DiffLayout>(initialLayout)
  return <CommitDiff layout={layout} onLayoutChange={setLayout} {...props} />
}

const AFTER = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'
const BEFORE = '9b8a7c6d5e4f30291a0b1c2d3e4f5061728394a5'
const PARENT = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)

const changed = (over: Partial<LocalChangedFile> = {}): LocalChangedFile => ({
  path: '/src/log.ts',
  changeType: ['edit'],
  originalPath: null,
  objectId: AFTER,
  originalObjectId: BEFORE,
  beforeMode: '100644',
  afterMode: '100644',
  ...over,
})

const commit = (over: Partial<LocalCommit> = {}): LocalCommit => ({
  sha: 'a'.repeat(40),
  abbreviated: 'aaaaaaa',
  authorName: 'Paul DeVito',
  authorEmail: 'paul.devito@profisee.com',
  committedAt: '2026-07-20T12:00:00+02:00',
  parents: [PARENT],
  subject: 'fix(pr): keep the merge off until the reviewers approve',
  ...over,
})

const changes = (over: Partial<CommitChangeSet> = {}): CommitChangeSet => ({
  files: [changed()],
  truncated: false,
  commit: commit(),
  against: { kind: 'only', parent: PARENT } satisfies DiffedAgainst,
  renameDetectionSkipped: false,
  ...over,
})

/** A merge of two, diffed against one of them. */
const merge = (index = 1): Partial<CommitChangeSet> => ({
  commit: commit({ parents: [PARENT, OTHER] }),
  against: { kind: 'nth', parent: index === 1 ? PARENT : OTHER, index, of: 2 },
})

const draw = (props: Partial<ComponentProps<typeof Diff>> = {}) =>
  render(<Diff slug="platform" changes={changes()} {...props} />)

const list = () => within(screen.getByRole('list', { name: 'Changed files' }))

/** Fixed, because "7d ago" is a fact about today otherwise. */
const NOW = new Date('2026-07-27T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CommitDiff', () => {
  describe('the header', () => {
    it('states the subject, the author, the age and the abbreviation', () => {
      draw()

      expect(screen.getByText(/keep the merge off/)).toBeInTheDocument()
      expect(screen.getByText('Paul DeVito')).toHaveAttribute(
        'title',
        'paul.devito@profisee.com',
      )
      expect(screen.getByText(/committed 7d ago/)).toBeInTheDocument()
      expect(screen.getByText('aaaaaaa')).toHaveAttribute('title', 'a'.repeat(40))
    })

    // `%cI` comes back in the committer's own offset, un-normalised and mixed
    // within one repository, so rewriting it into local time would be this page
    // inventing a fact.
    it("prints the committer's own timestamp rather than reformatting it", () => {
      draw()

      expect(screen.getByText('2026-07-20T12:00:00+02:00')).toHaveAttribute(
        'datetime',
        '2026-07-20T12:00:00+02:00',
      )
    })

    it('counts the files', () => {
      draw({ changes: changes({ files: [changed(), changed({ path: '/src/other.ts' })] }) })

      // The whole line, not the number on its own: `2` is a string that a diff
      // has plenty of, and the count is the number beside the word.
      expect(screen.getByText('files')).toHaveTextContent('2 files')
    })
  })

  describe('which parent the diff is against', () => {
    it('says nothing when there is nothing to choose', () => {
      draw()

      expect(screen.queryByRole('navigation', { name: 'Merge parents' })).not.toBeInTheDocument()
      expect(screen.queryByText(/A merge of/)).not.toBeInTheDocument()
    })

    // A root has no parent, so an empty diff or an error would both be wrong: it
    // is the one commit where every file really is new.
    it('says a root commit is the first one', () => {
      draw({ changes: changes({ commit: commit({ parents: [] }), against: { kind: 'root' } }) })

      expect(screen.getByText('first commit')).toBeInTheDocument()
      expect(screen.getByText(/Nothing comes before it/)).toBeInTheDocument()
    })

    // **The one thing on this page that can quietly show less than the truth.**
    // 26.4% of the sample is a merge, so this is the common case and not an edge.
    it('says which parent a merge is diffed against, and that the other side is missing', () => {
      draw({ changes: changes(merge()) })

      expect(screen.getByText(/A merge of 2 parents/)).toHaveTextContent(
        'This diff is against parent 1 only',
      )
    })

    // Warning without offering a way to look is what the contract calls out, so
    // the other parents are links.
    it('offers the other parent as a link and marks the current one as current', () => {
      draw({ changes: changes(merge()) })

      const parents = within(screen.getByRole('navigation', { name: 'Merge parents' }))
      expect(parents.getByText(/parent 1/)).toHaveAttribute('aria-current', 'true')
      expect(parents.getByRole('link', { name: /parent 2/ }).getAttribute('href')).toContain(
        'parent=2',
      )
    })

    // The updater form, so the ref and the offset that make the way back work
    // survive a parent switch without this component being told what they are.
    it('keeps the way back across a parent switch', () => {
      draw({ changes: changes(merge()) })

      const href = within(screen.getByRole('navigation', { name: 'Merge parents' }))
        .getByRole('link', { name: /parent 2/ })
        .getAttribute('href')
      expect(href).toContain('ref=main')
      expect(href).toContain('skip=50')
    })

    it('spells the first parent as no parent at all', () => {
      draw({ changes: changes(merge(2)) })

      const href = within(screen.getByRole('navigation', { name: 'Merge parents' }))
        .getByRole('link', { name: /parent 1/ })
        .getAttribute('href')
      expect(href).not.toContain('parent=')
    })
  })

  describe('the empty cases', () => {
    // Zero files is data, and it means two different things.
    it('says an ordinary commit changed nothing', () => {
      draw({ changes: changes({ files: [] }) })

      expect(screen.getByText('This commit changed no files.')).toBeInTheDocument()
    })

    it('says a merge took nothing from this side, not that the commit is empty', () => {
      draw({ changes: changes({ files: [], ...merge() }) })

      expect(screen.getByText('Nothing changed against parent 1.')).toBeInTheDocument()
    })

    it('says rename detection was skipped rather than drawing a moved file as two', () => {
      draw({ changes: changes({ renameDetectionSkipped: true }) })

      expect(screen.getByText(/Too many changes to detect renames/)).toBeInTheDocument()
    })

    it('says the list was cut short', () => {
      draw({ changes: changes({ truncated: true }) })

      expect(screen.getByText(/Only the first 1 files are shown/)).toBeInTheDocument()
    })
  })

  describe('the diff itself', () => {
    it('draws the tree and the panels the pull request page draws', () => {
      draw({ changes: changes({ files: [changed(), changed({ path: '/src/other.ts' })] }) })

      expect(
        within(screen.getByRole('navigation', { name: 'File tree' })).getByText('log.ts'),
      ).toBeInTheDocument()
      expect(list().getAllByRole('listitem')).toHaveLength(2)
    })

    it('carries the same layout toggle, and hands the choice back to the route', async () => {
      draw()

      const toggle = within(screen.getByRole('group', { name: 'Diff layout' }))
      expect(toggle.getByRole('button', { name: 'Unified' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await userEvent.click(toggle.getByRole('button', { name: 'Side by side' }))

      expect(toggle.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    // Kept here rather than left to the pull request page's copy of it: the
    // point of one component is that all three pages have the control, and the
    // way that stops being true is a page that never renders it.
    it('carries the ignore-whitespace toggle, and holds the choice itself', async () => {
      draw()

      const toggle = screen.getByRole('button', { name: 'Ignore whitespace' })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')

      await userEvent.click(toggle)

      expect(toggle).toHaveAttribute('aria-pressed', 'true')
    })

    // A commit on your disk has no conversation to join, so there is no
    // invitation to write a comment that would go nowhere.
    it('offers nothing to comment with', () => {
      draw()

      expect(list().queryByRole('button', { name: /comment/i })).not.toBeInTheDocument()
      expect(list().queryByRole('textbox')).not.toBeInTheDocument()
    })

    // **The one place this page is deliberately poorer than the branch diff.** A
    // mark hung on a commit a rebase will replace is a mark that rots, so
    // `onViewedChange` is withheld — and that is what takes the box off the panel
    // rather than leaving a tick that goes nowhere.
    it('offers no viewed mark', () => {
      draw()

      expect(list().queryByRole('checkbox', { name: 'Viewed' })).not.toBeInTheDocument()
    })

    // The branch diff holds its whole list back for one tick against local
    // SQLite, because a panel decides whether to start expanded when it mounts.
    // With no marks to read there is nothing to wait for, so every test here
    // draws synchronously — a panel still says `Loading…` for its own bytes, which
    // is a different wait and not this one.
    it('draws the list on the first paint, having no marks to wait for', () => {
      draw()

      expect(screen.getByRole('list', { name: 'Changed files' })).toBeInTheDocument()
    })
  })
})
