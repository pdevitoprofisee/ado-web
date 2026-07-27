import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { PullRequestSection, age } from './pr-list'

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
  ...over,
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

  it('says why a section is empty instead of rendering a bare heading', () => {
    render(<PullRequestSection title="Mine" rows={[]} empty="You have no open pull requests." />)

    expect(screen.getByText('You have no open pull requests.')).toBeVisible()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
