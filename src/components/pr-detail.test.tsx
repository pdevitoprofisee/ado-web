import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderBare, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { PullRequestDetailView as Detail, voteWord } from './pr-detail'
import { viewedKey } from '@/lib/viewed-key'
import { iterationChangesQuery } from '@/server/pull-request-fn'
import { markViewed, viewedQuery } from '@/server/viewed-fn'

import type { ComponentProps, ReactElement, ReactNode } from 'react'
import type { DetailTab } from './pr-detail'
import type {
  Commit,
  Iteration,
  Policy,
  PullRequestDetail,
  PullRequestRef,
  Reviewer,
} from '@/server/pull-request'

// The viewed store is SQLite on the other side of a server function, which is
// neither reachable nor the subject of anything here. Mocked to the store's own
// contract — `markViewed` returns the key it wrote — so the page's arithmetic is
// tested against the real key format rather than a stand-in for it.
vi.mock('@/server/viewed-fn', () => ({
  viewedQuery: vi.fn(async () => ({ keys: [] })),
  markViewed: vi.fn(async ({ data }) => ({
    key: viewedKey(data.objectId ?? data.originalObjectId, data.path),
    viewed: data.viewed,
  })),
}))

/**
 * One update's changes, which reach the page over a second server function.
 *
 * Answers a file that is in no combined-diff fixture, so a test that finds
 * `/src/only-in-update.ts` on screen has proved the update view is showing the
 * update — and one that finds `log.ts` there has caught it falling back to the
 * whole pull request, which is this feature's one real failure mode.
 */
vi.mock('@/server/pull-request-fn', () => ({
  iterationChangesQuery: vi.fn(async () => ({
    changes: {
      files: [
        {
          path: '/src/only-in-update.ts',
          changeType: ['edit'],
          originalPath: null,
          objectId: '11',
          originalObjectId: '22',
        },
      ],
      truncated: false,
    },
    error: null,
  })),
}))

// Two things the view needs that none of these tests are about.
//
// A ref, because the file list addresses the blob call by GUID and the payload
// carries only names — passed through here and never used, because jsdom has no
// `IntersectionObserver` and a panel that cannot tell whether it is on screen
// fetches nothing. And a query client, because the file rows became components
// that can fetch; the provider is what lets them decide not to.
const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

/**
 * The view, plus the one piece of its state the route owns.
 *
 * `tab` is a prop because a diff tab widens the page container, which is the
 * route's business — so a test that clicks a tab has to hold the answer for it.
 * `initialTab` rather than `tab` for the same reason it is not uncontrolled in
 * the component: what these tests are about is the tab *changing*.
 */
function PullRequestDetailView({
  initialTab = 'details',
  ...props
}: Omit<ComponentProps<typeof Detail>, 'prRef' | 'tab' | 'onTabChange'> & {
  initialTab?: DetailTab
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  return <Detail prRef={REF} tab={tab} onTabChange={setTab} {...props} />
}

/**
 * The diff list, and the tree beside it.
 *
 * Every file's name is on the page twice now — once in the tree and once on its
 * panel's header — so a bare `getByText('log.ts')` finds two elements and throws.
 * Scoping to one of these two says which copy the assertion is about, which is
 * information the test wanted anyway.
 */
const list = () => within(screen.getByRole('list', { name: 'Changed files' }))
const tree = () => within(screen.getByRole('navigation', { name: 'File tree' }))

/**
 * Render straight onto a diff tab, and wait for the file list to arrive.
 *
 * It is not there on the first paint: the page holds the list back until the
 * viewed marks have answered, because a panel decides whether to start expanded
 * when it mounts, and a list mounted a tick early opens all forty files of a pull
 * request that was half read yesterday. One tick here, one tick against local
 * SQLite on the page.
 */
async function drawDiff(props: Omit<ComponentProps<typeof PullRequestDetailView>, 'initialTab'>) {
  const result = render(<PullRequestDetailView initialTab="combined" {...props} />)
  await screen.findByRole('list', { name: 'Changed files' })

  return result
}

/**
 * Two updates, which is the median. Enough for the changes toggle to appear at
 * all — it is hidden on a one-push pull request, where the combined diff and the
 * only update are the same files.
 */
const ITERATIONS: readonly Iteration[] = [
  { id: 1, subject: 'point the sink at its own account', author: 'Paul DeVito', createdAt: '2026-07-20T00:00:00Z', reason: 'push' },
  { id: 2, subject: 'address review', author: 'Paul DeVito', createdAt: '2026-07-21T00:00:00Z', reason: 'push' },
]

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

const detail = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  id: 24698,
  title: 'move the logging sink off the shared account',
  description: 'why this exists',
  author: { id: 'author-1', displayName: 'Paul DeVito' },
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  status: 'active',
  sourceBranch: 'refs/heads/feature/logging-sink',
  targetBranch: 'refs/heads/main',
  merge: { status: 'succeeded', conflicted: false, conflicts: [] },
  reviewers: [],
  policies: [],
  commits: [],
  files: { files: [], iterationId: 2, iterations: [], truncated: false },
  project: 'Products',
  repository: 'utilities',
  url: 'https://dev.azure.com/Profisee/Products/_git/utilities/pullrequest/24698',
  viewerId: 'author-1',
  errors: { policies: null, commits: null, files: null, conflicts: null },
  ...over,
})

const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 'cfg-1',
  name: 'Build',
  status: 'queued',
  blocking: true,
  detail: null,
  url: null,
  ...over,
})

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  id: 'rev-1',
  displayName: 'Naveen Angali',
  vote: 0,
  isContainer: false,
  isRequired: true,
  votedFor: [],
  ...over,
})

const commit = (over: Partial<Commit> = {}): Commit => ({
  id: 'a1b2c3d4e5f6a7b8',
  subject: 'point the sink at the new workspace',
  bodyOmitted: false,
  author: 'Paul DeVito',
  at: '2026-07-21T00:00:00Z',
  url: 'https://dev.azure.com/Profisee/_git/utilities/commit/a1b2c3d4e5f6a7b8',
  ...over,
})

describe('voteWord', () => {
  it('spells out ADO’s five integers', () => {
    expect(voteWord(10)).toBe('approved')
    expect(voteWord(5)).toBe('approved with suggestions')
    expect(voteWord(0)).toBe('no vote')
    expect(voteWord(-5)).toBe('waiting for author')
    expect(voteWord(-10)).toBe('rejected')
  })

  it('says the number rather than inventing a word for a vote ADO added later', () => {
    expect(voteWord(7)).toBe('vote 7')
  })
})

describe('PullRequestDetailView header', () => {
  it('names the PR, the branches as a person says them, and keeps the ADO link', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(
      screen.getByRole('heading', { name: 'move the logging sink off the shared account' }),
    ).toBeVisible()
    expect(screen.getByText('!24698')).toBeVisible()
    expect(screen.getByText('feature/logging-sink → main')).toBeVisible()
    expect(screen.queryByText(/refs\/heads/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Azure DevOps' })).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/Products/_git/utilities/pullrequest/24698',
    )
  })

  it('marks a draft', () => {
    render(<PullRequestDetailView pr={detail({ isDraft: true })} />)

    expect(screen.getByText('draft')).toBeVisible()
  })

  it('renders the description whole, past the 400 characters the inbox keeps', () => {
    const description = `## Why\n\n${'a'.repeat(500)}\nsecond line`
    render(<PullRequestDetailView pr={detail({ description })} />)

    // Both halves of what this section is for: nothing is truncated, and the
    // markdown around it is rendered rather than printed. `textContent`, not the
    // text matcher, because the normaliser would fold the line break away and the
    // line break is half the assertion — see `markdown.test.tsx` for the rest.
    const body = within(screen.getByRole('region', { name: 'Description' }))
    expect(body.getByRole('heading', { name: 'Why' })).toBeVisible()
    expect(body.getByText(/second line/).textContent).toBe(`${'a'.repeat(500)}\nsecond line`)
  })
})

describe('PullRequestDetailView merge state', () => {
  it('states a conflict loudly, and names the files it is about', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          merge: {
            status: 'conflicts',
            conflicted: true,
            conflicts: [
              { path: '/src/log.ts', type: 'editEdit', resolved: false },
              { path: '/src/gone.ts', type: 'deleteEdit', resolved: true },
            ],
          },
        })}
      />,
    )

    const banner = screen.getByRole('alert')
    expect(within(banner).getByText('Merge conflicts')).toBeVisible()

    // The paths are the point: they say whether this is a rebase or an afternoon.
    const rows = within(within(banner).getByRole('list')).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('/src/log.ts editEdit')
    expect(rows[1]).toHaveTextContent('/src/gone.ts deleteEdit')
    expect(rows[1]).toHaveTextContent('resolved')
    expect(rows[0]).not.toHaveTextContent('resolved')
  })

  it('marks the conflicting files again in the file list they live in', async () => {
    await drawDiff({
      pr: detail({
        merge: {
          status: 'conflicts',
          conflicted: true,
          conflicts: [{ path: '/src/log.ts', type: 'editEdit', resolved: false }],
        },
        files: {
          iterationId: 2,
          iterations: ITERATIONS,
          truncated: false,
          files: [
            { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
            { path: '/src/ok.ts', changeType: ['edit'], originalPath: null, objectId: 'cc', originalObjectId: 'dd' },
          ],
        },
      }),
    })

    const rows = list().getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('conflict')
    expect(rows[1]).not.toHaveTextContent('conflict')
    // And in the tree, which is where you are looking when you are picking the
    // next file rather than reading one.
    expect(tree().getByTitle('/src/log.ts')).toHaveTextContent('!')
    expect(tree().getByTitle('/src/ok.ts')).not.toHaveTextContent('!')
  })

  it('does not dress an untested merge up as a conflict', () => {
    // `queued` and `notSet` both mean nobody has attempted the merge yet.
    const { rerender } = render(
      <PullRequestDetailView
        pr={detail({ merge: { status: 'queued', conflicted: false, conflicts: [] } })}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Azure DevOps has not tested this merge yet.')).toBeVisible()

    rerender(
      <PullRequestDetailView
        pr={detail({ merge: { status: 'notSet', conflicted: false, conflicts: [] } })}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Azure DevOps has not tested this merge yet.')).toBeVisible()
  })

  it('reads a status ADO omitted as neutral rather than as anything at all', () => {
    // `mergeStatus` is absent on every abandoned PR measured, and arrives as ''.
    render(
      <PullRequestDetailView
        pr={detail({ merge: { status: '', conflicted: false, conflicts: [] } })}
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/merge/i)).toBeNull()
  })

  it('still shouts the conflict when the list of files is the part that failed', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          merge: { status: 'conflicts', conflicted: true, conflicts: [] },
          errors: {
            policies: null,
            commits: null,
            files: null,
            conflicts: 'Azure DevOps answered 500.',
          },
        })}
      />,
    )

    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('This branch conflicts with its target.')
    expect(banner).toHaveTextContent('did not say which files: Azure DevOps answered 500.')
    // Not an empty path list dressed up as "nothing conflicts".
    expect(within(banner).queryByRole('list')).toBeNull()
  })

  it('says nothing at all once the merge has succeeded', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/merge/i)).toBeNull()
  })
})

describe('PullRequestDetailView policies', () => {
  it('splits what is blocking from what passed, what does not apply, and what is advice', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          policies: [
            policy({ id: '1', name: 'Build', detail: 'utilities.logging #4021', blocking: true }),
            policy({ id: '2', name: 'Require a merge strategy', status: 'approved', blocking: false }),
            policy({ id: '3', name: 'Work item linking', status: 'notApplicable', blocking: false }),
            policy({ id: '4', name: 'Comment requirements', status: 'rejected', blocking: false }),
          ],
        })}
      />,
    )

    const blocking = screen.getByRole('list', { name: 'Blocking' })
    expect(within(blocking).getAllByRole('listitem')).toHaveLength(1)
    expect(within(blocking).getByText(/utilities\.logging #4021/)).toBeVisible()

    expect(
      within(screen.getByRole('list', { name: 'Passed' })).getByText('Require a merge strategy'),
    ).toBeVisible()
    expect(
      within(screen.getByRole('list', { name: 'Not applicable' })).getByText('Work item linking'),
    ).toBeVisible()
    // Failing but not blocking is advice, not a reason the PR cannot complete.
    expect(
      within(screen.getByRole('list', { name: 'Optional' })).getByText('Comment requirements'),
    ).toBeVisible()
  })

  it('keeps two policies sharing a display name apart by what qualifies them', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          policies: [
            policy({ id: '5', name: 'Minimum number of reviewers', detail: '1 of 1 approvals' }),
            policy({ id: '6', name: 'Minimum number of reviewers', detail: '0 of 2 approvals' }),
          ],
        })}
      />,
    )

    const rows = within(screen.getByRole('list', { name: 'Blocking' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('1 of 1 approvals')
    expect(rows[1]).toHaveTextContent('0 of 2 approvals')
  })

  it('falls back to the configuration id when the settings qualify neither row', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          policies: [
            policy({ id: '5', name: 'Minimum number of reviewers', status: 'queued' }),
            policy({ id: '6', name: 'Minimum number of reviewers', status: 'approved', blocking: false }),
          ],
        })}
      />,
    )

    expect(
      within(screen.getByRole('list', { name: 'Blocking' })).getByText('#5'),
    ).toBeVisible()
    expect(within(screen.getByRole('list', { name: 'Passed' })).getByText('#6')).toBeVisible()
  })

  it('reads `queued` on a policy as unmet rather than as something running', () => {
    render(<PullRequestDetailView pr={detail({ policies: [policy()] })} />)

    expect(screen.getByText('not yet met')).toBeVisible()
  })

  it('tells the two empty policy states apart', () => {
    const { rerender } = render(<PullRequestDetailView pr={detail()} />)
    expect(screen.getByText('No branch policies apply to this pull request.')).toBeVisible()

    rerender(<PullRequestDetailView pr={detail()} failed={{ policies: true }} />)
    expect(screen.queryByText('No branch policies apply to this pull request.')).toBeNull()
    expect(
      screen.getByText('Could not load the branch policies for this pull request.'),
    ).toBeVisible()
    // No count beside the heading: zero is a number we do not have.
    expect(within(screen.getByRole('region', { name: 'Policies' })).getByRole('heading', { level: 2 }))
      .toHaveAccessibleName('Policies')
  })
})

describe('PullRequestDetailView reviewers', () => {
  it('spells the votes out, and marks teams, required, and the viewer', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          viewerId: 'rev-2',
          reviewers: [
            reviewer({ id: 'rev-1', displayName: '[Products]\\Contributors', isContainer: true }),
            reviewer({ id: 'rev-2', displayName: 'Paul DeVito', vote: 10 }),
            reviewer({ id: 'rev-3', displayName: 'Naveen Angali', vote: 5, isRequired: false }),
            reviewer({ id: 'rev-4', displayName: 'Sam Reed', vote: -5 }),
            reviewer({ id: 'rev-5', displayName: 'Jo Bell', vote: -10 }),
          ],
        })}
      />,
    )

    const rows = within(screen.getByRole('region', { name: 'Reviewers' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('no vote')
    expect(rows[0]).toHaveTextContent('team')
    expect(rows[0]).toHaveTextContent('required')
    expect(rows[1]).toHaveTextContent('approved')
    expect(rows[1]).toHaveTextContent('you')
    expect(rows[2]).toHaveTextContent('approved with suggestions')
    expect(rows[2]).toHaveTextContent('optional')
    expect(rows[3]).toHaveTextContent('waiting for author')
    expect(rows[4]).toHaveTextContent('rejected')

    // Only the viewer's own row is marked.
    expect(screen.getAllByText('you')).toHaveLength(1)
  })

  it('attributes a person’s vote to the container it counted toward', () => {
    // `votedFor` hangs off the person and names containers — never the reverse,
    // and the container's own vote is its top-level one.
    const team = { id: 't1', displayName: '[Products]\\Contributors' }
    render(
      <PullRequestDetailView
        pr={detail({
          reviewers: [
            reviewer({ ...team, vote: 10, isContainer: true, isRequired: true }),
            reviewer({ id: 'p1', displayName: 'Naveen Angali', vote: 10, votedFor: [team] }),
          ],
        })}
      />,
    )

    const rows = within(screen.getByRole('region', { name: 'Reviewers' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('team')
    expect(rows[0]).toHaveTextContent('required')
    expect(rows[0]).toHaveTextContent('approved')
    expect(rows[1]).toHaveTextContent('Naveen Angali')
    expect(rows[1]).toHaveTextContent('on behalf of [Products]\\Contributors')
  })

  it('says who is not there rather than rendering a bare heading', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(screen.getByText('Nobody has been asked to review this.')).toBeVisible()
  })
})

describe('PullRequestDetailView commits', () => {
  it('shows the subject, a short sha, the author and the age', () => {
    render(<PullRequestDetailView pr={detail({ commits: [commit()] })} />)

    const row = within(screen.getByRole('region', { name: 'Commits' })).getByRole('listitem')
    expect(within(row).getByRole('link', { name: 'a1b2c3d' })).toBeVisible()
    expect(row).toHaveTextContent('point the sink at the new workspace')
    expect(row).toHaveTextContent('Paul DeVito')
  })

  it('says a body was left behind, and does not call the subject truncated', () => {
    render(
      <PullRequestDetailView pr={detail({ commits: [commit({ bodyOmitted: true })] })} />,
    )

    expect(screen.getByText('+ body')).toBeVisible()
    // The word that was here before was wrong about live data on half the
    // commits in the org: the subject ADO hands over is complete.
    expect(screen.queryByText('truncated')).toBeNull()
  })

  it('trusts the flag, not the text, which carries no marker either way', () => {
    render(
      <PullRequestDetailView
        pr={detail({ commits: [commit({ subject: 'and then, well…', bodyOmitted: false })] })}
      />,
    )

    expect(screen.queryByText('+ body')).toBeNull()
  })

  it('tells the two empty commit states apart', () => {
    const { rerender } = render(<PullRequestDetailView pr={detail()} />)
    expect(screen.getByText('No commits on this branch.')).toBeVisible()

    rerender(<PullRequestDetailView pr={detail()} failed={{ commits: true }} />)
    expect(screen.queryByText('No commits on this branch.')).toBeNull()
    expect(screen.getByText('Could not load the commits for this pull request.')).toBeVisible()
  })
})

describe('PullRequestDetailView files', () => {
  const files = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: true,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
      {
        path: '/src/sink.ts',
        changeType: ['edit', 'rename'],
        originalPath: '/src/drain.ts',
        objectId: 'cc',
        originalObjectId: 'dd',
      },
      { path: '/src/new.ts', changeType: ['add'], originalPath: null, objectId: 'ee', originalObjectId: null },
    ],
  }

  it('lists the files in the tree’s order, so a tree row and a panel line up', async () => {
    // Path order, and the same order in both halves. Grouping the list by change
    // type — which is what this replaced — puts `src/log.ts` and `src/new.ts` a
    // screen apart from each other while the tree has them adjacent, and then
    // clicking the tree lands somewhere in the middle of the page.
    await drawDiff({ pr: detail({ files }) })

    expect(list().getAllByTitle(/^\/src\//).map((row) => row.title)).toEqual([
      '/src/log.ts',
      '/src/new.ts',
      '/src/sink.ts',
    ])
  })

  it('draws the changed files as a tree, one row per directory', async () => {
    await drawDiff({ pr: detail({ files }) })

    // One directory holding all three, so it says three — what a shut directory
    // needs in order to be worth shutting.
    expect(tree().getByTitle('/src')).toHaveTextContent('src3')
    // A letter each, since the list no longer groups by change type: modified,
    // added, and a rename that is also an edit, where the rename is the half the
    // diff body cannot show.
    expect(tree().getByTitle('/src/log.ts')).toHaveTextContent('Mlog.ts')
    expect(tree().getByTitle('/src/new.ts')).toHaveTextContent('Anew.ts')
    expect(tree().getByTitle('/src/sink.ts')).toHaveTextContent('Rsink.ts')
  })

  it('keeps the end of a path intact and hands the whole one to the mouse', async () => {
    await drawDiff({ pr: detail({ files }) })

    const row = list().getByTitle('/src/log.ts')
    // The name is the part that must survive; the directory is what truncates.
    expect(within(row).getByText('log.ts')).not.toHaveClass('truncate')
    expect(within(row).getByText('/src/')).toHaveClass('truncate')
  })

  it('says so when the file list is short of the real one', async () => {
    await drawDiff({ pr: detail({ files }) })

    expect(screen.getByText(/only the first 3 files/)).toBeVisible()
  })

  it('shows how much has been read without any bytes being fetched', async () => {
    // The ticket's third success criterion for T-021, and the reason the
    // checkbox lives on the header rather than inside the diff.
    await drawDiff({ pr: detail({ files }) })
    expect(screen.getByText('0 of 3 read')).toBeVisible()

    const [first] = screen.getAllByRole('checkbox', { name: 'Viewed' })
    await userEvent.click(first as HTMLElement)

    expect(screen.getByText('1 of 3 read')).toBeVisible()
    expect(vi.mocked(markViewed)).toHaveBeenCalledWith({
      data: {
        repositoryId: REF.repositoryId,
        id: REF.id,
        path: '/src/log.ts',
        objectId: 'aa',
        originalObjectId: 'bb',
        viewed: true,
      },
    })
  })

  it('starts with the marks the store already had', async () => {
    // The whole point of persisting them: coming back to a half-read pull
    // request finds it half-read.
    vi.mocked(viewedQuery).mockResolvedValueOnce({
      keys: [viewedKey('cc', '/src/sink.ts'), viewedKey('ee', '/src/new.ts')],
    })
    await drawDiff({ pr: detail({ files }) })

    expect(screen.getByText('2 of 3 read')).toBeVisible()

    const boxes = screen.getAllByRole('checkbox', { name: 'Viewed' })
    expect(boxes[0]).not.toBeChecked()
    expect(boxes[1]).toBeChecked()
    expect(boxes[2]).toBeChecked()

    // And the panels the marks are about are shut, which is what "expanded by
    // default" has to mean on the second pass: the unread ones are open and
    // yesterday's are out of the way.
    const headers = list().getAllByTitle(/^\/src\//)
    expect(headers[0]).toHaveAttribute('aria-expanded', 'true')
    expect(headers[1]).toHaveAttribute('aria-expanded', 'false')
    expect(headers[2]).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks a delete on its before-sha, the only one it has', async () => {
    // `objectId` is absent on every delete, so a mark keyed on the after-side
    // alone could not be made at all — and a hole in the progress count sits
    // exactly where a reviewer is most likely to skim.
    const deleted = {
      ...files,
      files: [
        { path: '/src/gone.ts', changeType: ['delete'], originalPath: null, objectId: null, originalObjectId: 'ff' },
      ],
    }
    await drawDiff({ pr: detail({ files: deleted }) })

    // The tree says so too, in the one letter it has for the job.
    expect(tree().getByTitle('/src/gone.ts')).toHaveTextContent('Dgone.ts')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))

    expect(screen.getByText('1 of 1 read')).toBeVisible()
    expect(vi.mocked(markViewed).mock.lastCall?.[0]?.data).toMatchObject({
      objectId: null,
      originalObjectId: 'ff',
    })
  })

  it('offers one layout choice for the whole page, not one per file', async () => {
    const onLayoutChange = vi.fn()
    await drawDiff({ pr: detail({ files }), layout: 'unified', onLayoutChange })

    const group = screen.getByRole('group', { name: 'Diff layout' })
    expect(within(group).getByRole('button', { name: 'Unified' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await userEvent.click(within(group).getByRole('button', { name: 'Side by side' }))

    expect(onLayoutChange).toHaveBeenCalledWith('split')
  })

  it('tells the two empty file states apart', async () => {
    const { rerender } = await drawDiff({ pr: detail() })
    expect(screen.getByText('No files changed.')).toBeVisible()

    rerender(
      <PullRequestDetailView initialTab="combined" pr={detail()} failed={{ files: true }} />,
    )
    expect(screen.queryByText('No files changed.')).toBeNull()
    expect(screen.getByText('Could not load the changed files for this pull request.')).toBeVisible()
  })
})

describe('PullRequestDetailView tabs', () => {
  const files = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
    ],
  }

  it('opens on the details, which is what the page is for', () => {
    // T-020's criterion, kept: the diff is added to the page that answers "what is
    // stopping this from merging", not put in front of it. So the checklist is
    // what a freshly opened pull request shows, and the diff is one click away.
    render(<PullRequestDetailView pr={detail({ files, policies: [policy()] })} />)

    expect(screen.getByRole('tab', { name: /Details/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Policies' })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull()
  })

  it('gives the diff the whole page, without the details above it', async () => {
    render(<PullRequestDetailView pr={detail({ files, policies: [policy()] })} />)

    await userEvent.click(screen.getByRole('tab', { name: /Combined/ }))

    expect(list().getByTitle('/src/log.ts')).toBeVisible()
    // The three details sections are gone rather than pushed down: the whole
    // reason for a third tab is that the diff gets the window to itself.
    expect(screen.queryByRole('region', { name: 'Policies' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull()
  })

  it('counts the changed files on the tab, so the count survives leaving the tab', () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    expect(screen.getByRole('tab', { name: /Combined/ })).toHaveTextContent('Combined1')
  })

  it('withholds the count when the file list is the part that failed', () => {
    // Zero would be a number we do not have, and it is the same number a pull
    // request with nothing in it shows.
    render(<PullRequestDetailView pr={detail({ files })} failed={{ files: true }} />)

    expect(screen.getByRole('tab', { name: /Combined/ })).toHaveTextContent('Combined')
    expect(screen.getByRole('tab', { name: /Combined/ })).not.toHaveTextContent('0')
  })

  it('moves between tabs on the arrow keys, one tab stop for the strip', async () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    screen.getByRole('tab', { name: /Details/ }).focus()
    await userEvent.keyboard('{ArrowRight}')

    const combined = screen.getByRole('tab', { name: /Combined/ })
    expect(combined).toHaveAttribute('aria-selected', 'true')
    // Focus follows selection, or the next arrow press has nothing to move from:
    // the row we were standing on is now `tabIndex={-1}`.
    expect(combined).toHaveFocus()
    expect(screen.getByRole('tab', { name: /Details/ })).toHaveAttribute('tabindex', '-1')
  })

  it('falls back to the details when the tab it was on stops existing', () => {
    // The route's state outlives the payload it was chosen against: a poll can
    // answer a pull request whose update tab is no longer on offer.
    const { rerender } = render(
      <PullRequestDetailView initialTab="update" pr={detail({ files })} />,
    )
    expect(screen.getByRole('tab', { name: 'By update' })).toHaveAttribute('aria-selected', 'true')

    rerender(
      <PullRequestDetailView
        initialTab="update"
        pr={detail({ files: { ...files, iterations: [ITERATIONS[0]!] } })}
      />,
    )

    expect(screen.queryByRole('tab', { name: 'By update' })).toBeNull()
    expect(screen.getByRole('tab', { name: /Details/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('PullRequestDetailView changes views', () => {
  const files = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
    ],
  }

  const asked = () => vi.mocked(iterationChangesQuery).mock.lastCall?.[0]?.data

  // Nothing in this file resets the mocks, so calls accumulate across tests and
  // the tab tests above render an update view of their own. The two assertions
  // here about *not* asking need a clean slate rather than a number.
  beforeEach(() => {
    vi.mocked(iterationChangesQuery).mockClear()
  })

  it('offers no choice on a pull request with one update', async () => {
    // Nearly half of them, measured across 120: 58 had a single iteration. There
    // the combined diff and the only update are the same files, and a tab that
    // implies otherwise invites a hunt for a difference that is not there.
    await drawDiff({ pr: detail({ files: { ...files, iterations: [ITERATIONS[0]!] } }) })

    expect(screen.queryByRole('tab', { name: 'By update' })).toBeNull()
    expect(list().getByTitle('/src/log.ts')).toBeVisible()
  })

  it('leads with the combined diff, which needs no request', async () => {
    await drawDiff({ pr: detail({ files }) })

    expect(screen.getByRole('tab', { name: /Combined/ })).toHaveAttribute('aria-selected', 'true')
    // The files came with the page, so the second server function is untouched.
    expect(vi.mocked(iterationChangesQuery)).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Update')).toBeNull()
  })

  it('asks the latest update for its own changes, and shows only those', async () => {
    await drawDiff({ pr: detail({ files }) })

    await userEvent.click(screen.getByRole('tab', { name: 'By update' }))

    // The newest push, because "what changed since I last looked" is the question
    // this view exists for — measured against the one before it, never the merge
    // base, which is what the other view already answers.
    expect(asked()).toEqual({
      projectId: REF.projectId,
      repositoryId: REF.repositoryId,
      id: REF.id,
      iterationId: 2,
      compareTo: 1,
    })

    expect(await list().findByTitle('/src/only-in-update.ts')).toBeVisible()
    // The whole point: the combined diff's file is gone, not merely joined.
    expect(list().queryByTitle('/src/log.ts')).toBeNull()
    expect(tree().queryByTitle('/src/log.ts')).toBeNull()
    expect(screen.getByText('0 of 1 read')).toBeVisible()
  })

  it('measures update 1 against the merge base', async () => {
    await drawDiff({ pr: detail({ files }) })

    await userEvent.click(screen.getByRole('tab', { name: 'By update' }))
    await userEvent.selectOptions(screen.getByLabelText('Update'), '1')

    // Zero is the merge base, so the first update needs no special case: every
    // update compares against the one before it and update 1's predecessor is
    // where the branch started.
    expect(asked()).toMatchObject({ iterationId: 1, compareTo: 0 })
  })

  it('says an update failed rather than falling back to the whole pull request', async () => {
    vi.mocked(iterationChangesQuery).mockResolvedValueOnce({
      changes: null,
      error: 'TF401019: The Git repository does not exist.',
    })
    await drawDiff({ pr: detail({ files }) })

    await userEvent.click(screen.getByRole('tab', { name: 'By update' }))

    expect(
      await screen.findByText(/Could not load this update’s changes\./),
    ).toBeVisible()
    // `$compareTo=999` answers 200 with the complete combined diff, so a wrong
    // answer here would wear an update's label and look right. Showing the
    // combined list on failure would do the same thing deliberately.
    expect(list().queryByTitle(/^\/src\//)).toBeNull()
    expect(tree().queryByTitle(/^\/src\//)).toBeNull()
  })

  it('distinguishes an update that changed nothing from a pull request that did', async () => {
    vi.mocked(iterationChangesQuery).mockResolvedValueOnce({
      changes: { files: [], truncated: false },
      error: null,
    })
    await drawDiff({ pr: detail({ files }) })

    await userEvent.click(screen.getByRole('tab', { name: 'By update' }))

    expect(await screen.findByText(/This update changed no files\./)).toBeVisible()
    expect(screen.queryByText('No files changed.')).toBeNull()
  })
})
