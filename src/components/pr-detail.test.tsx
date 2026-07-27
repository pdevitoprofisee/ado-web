import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { PullRequestDetailView, voteWord } from './pr-detail'

import type { Commit, Policy, PullRequestDetail, Reviewer } from '@/server/pull-request'

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
  files: { files: [], iterationId: 2, truncated: false },
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
  truncated: false,
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
    const description = `${'a'.repeat(500)}\nsecond line`
    render(<PullRequestDetailView pr={detail({ description })} />)

    // Compared against `textContent`, not matched: the query normaliser would
    // fold the newline away and the point of the test is that nothing is folded.
    expect(screen.getByText(/second line/).textContent).toBe(description)
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

  it('marks the conflicting files again in the file list they live in', () => {
    render(
      <PullRequestDetailView
        pr={detail({
          merge: {
            status: 'conflicts',
            conflicted: true,
            conflicts: [{ path: '/src/log.ts', type: 'editEdit', resolved: false }],
          },
          files: {
            iterationId: 2,
            truncated: false,
            files: [
              { path: '/src/log.ts', changeType: ['edit'], objectId: 'aa', originalObjectId: 'bb' },
              { path: '/src/ok.ts', changeType: ['edit'], objectId: 'cc', originalObjectId: 'dd' },
            ],
          },
        })}
      />,
    )

    const rows = within(screen.getByRole('list', { name: 'edit' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('conflict')
    expect(rows[1]).not.toHaveTextContent('conflict')
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

  it('marks a message ADO clipped instead of presenting it as whole', () => {
    render(
      <PullRequestDetailView pr={detail({ commits: [commit({ truncated: true })] })} />,
    )

    expect(screen.getByText('truncated')).toBeVisible()
  })

  it('trusts the flag, not the text, which carries no marker either way', () => {
    render(
      <PullRequestDetailView
        pr={detail({ commits: [commit({ subject: 'and then, well…', truncated: false })] })}
      />,
    )

    expect(screen.queryByText('truncated')).toBeNull()
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
    truncated: true,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], objectId: 'aa', originalObjectId: 'bb' },
      { path: '/src/sink.ts', changeType: ['edit', 'rename'], objectId: 'cc', originalObjectId: 'dd' },
      { path: '/src/new.ts', changeType: ['add'], objectId: 'ee', originalObjectId: null },
    ],
  }

  it('groups by change type, keeping a flag combination as its own group', () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    expect(within(screen.getByRole('list', { name: 'edit' })).getAllByRole('listitem')).toHaveLength(
      1,
    )
    expect(within(screen.getByRole('list', { name: 'edit, rename' })).getByText('sink.ts')).toBeVisible()
    expect(within(screen.getByRole('list', { name: 'add' })).getByText('new.ts')).toBeVisible()
  })

  it('keeps the end of a path intact and hands the whole one to the mouse', () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    const row = screen.getByTitle('/src/log.ts')
    // The name is the part that must survive; the directory is what truncates.
    expect(within(row).getByText('log.ts')).not.toHaveClass('truncate')
    expect(within(row).getByText('/src/')).toHaveClass('truncate')
  })

  it('says so when the file list is short of the real one', () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    expect(screen.getByText(/only the first 3 files/)).toBeVisible()
  })

  it('tells the two empty file states apart', () => {
    const { rerender } = render(<PullRequestDetailView pr={detail()} />)
    expect(screen.getByText('No files changed.')).toBeVisible()

    rerender(<PullRequestDetailView pr={detail()} failed={{ files: true }} />)
    expect(screen.queryByText('No files changed.')).toBeNull()
    expect(screen.getByText('Could not load the changed files for this pull request.')).toBeVisible()
  })
})
