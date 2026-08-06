import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderBare, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { BranchDiff } from './branch-diff'
import { viewedKey } from '@/lib/viewed-key'
import { localViewedQuery, markLocalViewed } from '@/server/viewed-fn'

import type { ComponentProps, ReactElement, ReactNode } from 'react'
import type { DiffLayout } from '@/lib/diff-contract'
import type { DiffPair, LocalChangedFile, LocalChangeSet } from '@/lib/local-git-contract'

// The marks are SQLite behind a server function, and the local pair is the only
// half this page uses — but `lib/viewed.ts` imports all four at module level, so
// the factory has to answer for the pull request's two as well. Mocked to the
// store's own contract, as `pr-detail.test.tsx` mocks its twin: `markLocalViewed`
// returns the key it wrote, so the page's arithmetic is tested against the real
// key format rather than a stand-in for it.
vi.mock('@/server/viewed-fn', () => ({
  localViewedQuery: vi.fn(async () => ({ keys: [] })),
  markLocalViewed: vi.fn(async ({ data }) => ({
    key: viewedKey(data.objectId ?? data.originalObjectId, data.path),
    viewed: data.viewed,
  })),
  viewedQuery: vi.fn(async () => ({ keys: [] })),
  markViewed: vi.fn(async () => ({ key: '', viewed: false })),
}))

// Nothing here fetches a blob — jsdom implements no `IntersectionObserver`, so a
// panel cannot tell it is on screen and never asks — but `localDiffSource` closes
// over this module, and the real one spawns `git`. Mocked so a jsdom bundle
// cannot reach a child process.
vi.mock('@/server/local-git-fn', () => ({ localBlobsQuery: vi.fn() }))

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

function render(ui: ReactElement) {
  return renderBare(ui, { wrapper: Providers })
}

/**
 * The view, plus the one piece of its state the route owns.
 *
 * `layout` is a prop for the reason it is one on the pull request page: the
 * container has to widen for side-by-side, and that is the route's business — so
 * a test that presses the toggle has to hold the answer for it.
 */
function Diff({
  initialLayout = 'unified',
  ...props
}: Omit<ComponentProps<typeof BranchDiff>, 'layout' | 'onLayoutChange'> & {
  initialLayout?: DiffLayout
}) {
  const [layout, setLayout] = useState<DiffLayout>(initialLayout)
  return <BranchDiff layout={layout} onLayoutChange={setLayout} {...props} />
}

const AFTER = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'
const BEFORE = '9b8a7c6d5e4f30291a0b1c2d3e4f5061728394a5'

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

const diffed = (over: Partial<DiffPair> = {}): DiffPair => ({
  branch: { name: 'feature/sink', fullName: 'refs/heads/feature/sink', commit: 'a'.repeat(40) },
  base: { name: 'origin/main', fullName: 'refs/remotes/origin/main', commit: 'b'.repeat(40) },
  rung: 'origin-head',
  baseCommittedAt: '2026-07-20T12:00:00Z',
  ...over,
})

const changes = (over: Partial<LocalChangeSet> = {}): LocalChangeSet => ({
  files: [changed()],
  truncated: false,
  diffed: diffed(),
  renameDetectionSkipped: false,
  commits: 3,
  ...over,
})

/**
 * The view, once its marks have answered.
 *
 * The list is not on the first paint: a panel decides whether to start expanded
 * when it mounts, so the page holds it back for one tick against local SQLite.
 * Every test that looks at a file has to wait for that tick, and the ones that
 * look at the header do not — which is itself worth a test.
 */
async function draw(props: Partial<ComponentProps<typeof Diff>> = {}) {
  const result = render(<Diff slug="platform" changes={changes()} dirtyCount={0} dirtyError={null} {...props} />)
  await screen.findByRole('list', { name: 'Changed files' })

  return result
}

const list = () => within(screen.getByRole('list', { name: 'Changed files' }))

/** Fixed, because "7d ago" is a fact about today otherwise. */
const NOW = new Date('2026-07-27T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
  vi.mocked(localViewedQuery).mockResolvedValue({ keys: [] })
  vi.mocked(markLocalViewed).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BranchDiff', () => {
  describe('the header', () => {
    it('states both refs and which rung found the target', async () => {
      await draw()

      expect(screen.getByText('feature/sink')).toBeInTheDocument()
      expect(screen.getByText('origin/main')).toBeInTheDocument()
      expect(screen.getByText("origin's default branch")).toBeInTheDocument()
    })

    it("says the target was pinned rather than naming a rung nobody climbed", async () => {
      await draw({ changes: changes({ diffed: diffed({ rung: null }) }) })

      expect(screen.getByText('pinned in the URL')).toBeInTheDocument()
      expect(screen.queryByText("origin's default branch")).not.toBeInTheDocument()
    })

    // The app never fetches, so the base is as old as the last time you pulled
    // and only the reader can judge whether that matters. Stating it is the whole
    // of what this page can do about it.
    it('says how old the base is, with the timestamp behind it', async () => {
      await draw()

      expect(screen.getByText(/base last committed 7d ago/)).toHaveAttribute(
        'title',
        '2026-07-20T12:00:00Z',
      )
    })

    it('counts the commits and the files that have been read', async () => {
      await draw({
        changes: changes({ files: [changed(), changed({ path: '/src/other.ts' })], commits: 1 }),
      })

      expect(screen.getByText('0 of 2 read')).toBeInTheDocument()
      expect(screen.getByText('commit')).toBeInTheDocument()
    })

    it('counts a file as read once its mark is in the store', async () => {
      vi.mocked(localViewedQuery).mockResolvedValue({ keys: [viewedKey(AFTER, '/src/log.ts')] })

      await draw()

      expect(screen.getByText('1 of 1 read')).toBeInTheDocument()
    })
  })

  describe('the uncommitted count', () => {
    // "My change is missing" and "my change is not committed" look identical
    // until something says six files are uncommitted.
    it('says what is not in the diff because it is not committed', async () => {
      await draw({ dirtyCount: 6 })

      expect(screen.getByText(/uncommitted, not shown below/)).toBeInTheDocument()
    })

    // It arrives on its own query, ~200 ms behind the diff. A zero that is about
    // to become a six is worse than nothing at all.
    it('says nothing at all while the count is still being taken', async () => {
      await draw({ dirtyCount: null })

      expect(screen.queryByText(/uncommitted/)).not.toBeInTheDocument()
    })

    it('says nothing when the tree is clean', async () => {
      await draw({ dirtyCount: 0 })

      expect(screen.queryByText(/uncommitted/)).not.toBeInTheDocument()
    })

    it('says the count failed rather than reporting a clean tree', async () => {
      await draw({ dirtyCount: null, dirtyError: 'git status failed (exit 128)' })

      expect(screen.getByText('uncommitted files could not be counted')).toBeInTheDocument()
    })
  })

  describe('the empty cases', () => {
    // 11 of 19 repositories sit on their own default branch, where the diff is
    // correctly empty — and an empty file list is the same blank space a broken
    // read would show. The commits tell them apart, not the files.
    it('says a branch that is the target has nothing to compare', async () => {
      const same = { name: 'main', fullName: 'refs/heads/main', commit: 'c'.repeat(40) }

      await draw({
        changes: changes({
          files: [],
          commits: 0,
          diffed: diffed({ branch: same, base: { ...same, name: 'origin/main' } }),
        }),
      })

      expect(screen.getByText(/is.*the target/)).toBeInTheDocument()
      expect(screen.queryByText(/No files changed/)).not.toBeInTheDocument()
    })

    it('says nothing changed across the commits when there are commits and no files', async () => {
      await draw({ changes: changes({ files: [], commits: 12 }) })

      // The whole sentence, not the number: `12` is on the page twice — once in
      // the header's count and once here — and only one of them is this case.
      expect(screen.getByText(/No files changed, across/)).toHaveTextContent(
        'No files changed, across 12 commits.',
      )
    })

    it('says rename detection was skipped rather than drawing a moved file as two', async () => {
      await draw({ changes: changes({ renameDetectionSkipped: true }) })

      expect(screen.getByText(/Too many changes to detect renames/)).toBeInTheDocument()
    })

    it('says the list was cut short', async () => {
      await draw({ changes: changes({ truncated: true }) })

      expect(screen.getByText(/Only the first 1 files are shown/)).toBeInTheDocument()
    })
  })

  describe('the diff itself', () => {
    it('draws the tree and the panels the pull request page draws', async () => {
      await draw({ changes: changes({ files: [changed(), changed({ path: '/src/other.ts' })] }) })

      expect(within(screen.getByRole('navigation', { name: 'File tree' })).getByText('log.ts'))
        .toBeInTheDocument()
      expect(list().getAllByRole('checkbox', { name: 'Viewed' })).toHaveLength(2)
    })

    it('carries the same layout toggle, and hands the choice back to the route', async () => {
      await draw()

      const toggle = within(screen.getByRole('group', { name: 'Diff layout' }))
      expect(toggle.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true')

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
      await draw()

      const toggle = screen.getByRole('button', { name: 'Ignore whitespace' })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')

      await userEvent.click(toggle)

      expect(toggle).toHaveAttribute('aria-pressed', 'true')
    })

    // A diff read off this disk has no conversation to join, so there is no
    // invitation to write a comment that would go nowhere. This is what
    // withholding `threadActions` buys, and it is the difference the ticket is
    // most explicit about.
    it('offers nothing to comment with', async () => {
      await draw()

      expect(list().queryByRole('button', { name: /comment/i })).not.toBeInTheDocument()
      expect(list().queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('holds the list back until the marks have answered', () => {
      render(<Diff slug="platform" changes={changes()} dirtyCount={0} dirtyError={null} />)

      expect(screen.queryByRole('list', { name: 'Changed files' })).not.toBeInTheDocument()
      expect(screen.getByText('Loading…')).toBeInTheDocument()
    })
  })

  describe('the marks', () => {
    it('writes a mark against this slug and this branch', async () => {
      await draw()

      await userEvent.click(list().getByRole('checkbox', { name: 'Viewed' }))

      expect(vi.mocked(markLocalViewed).mock.lastCall?.[0]?.data).toMatchObject({
        slug: 'platform',
        // The *resolved* branch, which is why the view reads its own marks: on
        // `/repos/platform` with nothing after it, the route does not know this
        // name until the change set arrives.
        branch: 'feature/sink',
        path: '/src/log.ts',
        objectId: AFTER,
        viewed: true,
      })
    })

    it('ticks the box on the frame it was clicked on', async () => {
      await draw()

      await userEvent.click(list().getByRole('checkbox', { name: 'Viewed' }))

      expect(screen.getByText('1 of 1 read')).toBeInTheDocument()
    })
  })
})
