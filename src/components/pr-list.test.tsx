import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { PullRequestSection, age } from './pr-list'

import type { Hydration, HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

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
  it('renders a row that links to the PR on dev.azure.com', () => {
    render(<PullRequestSection title="Assigned to me" rows={[row()]} empty="none" />)

    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    expect(link).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    )
    expect(link).toHaveAccessibleDescription(/SaaS\/PC\.IAC\.Modules · Naveen Angali · via SaaS/)
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
