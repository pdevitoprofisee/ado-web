import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkItemsPanel } from './panel'
import { workItemsQuery } from '@/server/work-items-fn'

import type { WorkItem } from '@/lib/work-item-contract'
import type { PullRequestRef } from '@/server/pull-request'

// What the board says this pull request is for.
//
// The claim that matters is the count. It is the pull request's own number of
// attached items, not the number of rows that arrived — those differ whenever a work
// item was deleted or lives in a project this token cannot read, and the section says
// so instead of showing a shorter list. `ChecksPanel`'s rule about "0" beside a
// failed read applies here for the same reason.

vi.mock('@/server/work-items-fn', () => ({
  workItemsQuery: vi.fn(),
  workItemSearchQuery: vi.fn(async () => ({ items: [], error: null, connected: true })),
  attachWorkItem: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

// Reached through `requeue.ts`, which owns the detail key an attach invalidates.
// `checks.test.tsx`' mock, for its reason: that module sits beside a server function
// that opens SQLite.
vi.mock('@/server/pull-request-fn', () => ({ requeuePolicy: vi.fn() }))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 162828,
  title: 'Login fails on a renamed account',
  state: 'Active',
  type: 'Bug',
  url: 'https://dev.azure.com/Profisee/Platform/_workitems/edit/162828',
  ...over,
})

function draw(
  answer: {
    items?: readonly WorkItem[]
    total?: number
    error?: string | null
    connected?: boolean
  } = {},
  canWrite = true,
) {
  const items = answer.items ?? [item()]
  vi.mocked(workItemsQuery).mockResolvedValue({
    items,
    total: answer.total ?? items.length,
    error: answer.error ?? null,
    connected: answer.connected ?? true,
  })

  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkItemsPanel prRef={REF} canWrite={canWrite} />
    </QueryClientProvider>,
  )
}

const heading = () => screen.getByRole('heading')

beforeEach(() => {
  vi.mocked(workItemsQuery).mockReset()
})

describe('WorkItemsPanel', () => {
  it('draws a row per work item, with the number as the way out to Azure DevOps', async () => {
    draw({ items: [item(), item({ id: 162901, title: 'Attach work items', type: 'User Story' })] })

    const link = await screen.findByRole('link', { name: '162828' })

    expect(link).toHaveAttribute('href', item().url)
    expect(link).toHaveAttribute('target', '_blank')
    // The title is not a link, `CommitRow`'s arrangement: leaving the app is a
    // deliberate act.
    expect(screen.getByText('Login fails on a renamed account').tagName).toBe('SPAN')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('User Story · Active')).toBeInTheDocument()
  })

  it('has something to show for a work item with no title', async () => {
    draw({ items: [item({ title: '' })] })

    expect(await screen.findByText('Untitled')).toBeInTheDocument()
  })

  it('counts what the pull request claims and names what is missing from it', async () => {
    // Five attached, three readable. A section that said "Work items 3" would be
    // hiding two, and the person reading is the only one who can tell which.
    draw({
      items: [item(), item({ id: 162901 }), item({ id: 163044 })],
      total: 5,
    })

    expect(await screen.findByRole('heading', { name: 'Work items, 5' })).toBeInTheDocument()
    expect(
      screen.getByText(/2 of 5 could not be looked up\./),
    ).toBeInTheDocument()
  })

  it('says nothing about a count it could not read', async () => {
    draw({ items: [], total: 0, error: 'Azure DevOps answered 500.' })

    expect(
      await screen.findByText(
        /Could not read the work items on this pull request\. Azure DevOps answered 500\./,
      ),
    ).toBeInTheDocument()
    // "Work items 0" beside that sentence reads as a pull request with none, which
    // is the opposite of what is known.
    expect(heading()).toHaveTextContent(/^Work items$/)
    expect(screen.queryByText(/could not be looked up/)).not.toBeInTheDocument()
  })

  it('says it is reading before it says there are none', async () => {
    vi.mocked(workItemsQuery).mockReturnValue(new Promise(() => {}))

    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkItemsPanel prRef={REF} canWrite={false} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Reading the work items…')).toBeInTheDocument()
    expect(heading()).toHaveTextContent(/^Work items$/)
  })

  it('says so when nothing is attached', async () => {
    draw({ items: [] })

    expect(
      await screen.findByText('No work item is attached to this pull request.'),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Work items, 0' })).toBeInTheDocument()
  })

  it('offers the picker on an active pull request and not on a closed one', async () => {
    draw({}, false)

    await screen.findByRole('link', { name: '162828' })
    expect(screen.queryByRole('button', { name: 'Attach a work item' })).not.toBeInTheDocument()

    draw({}, true)

    expect(
      await screen.findByRole('button', { name: 'Attach a work item' }),
    ).toBeInTheDocument()
  })

  it('leaves the page alone when the app has no credential', async () => {
    // The shell above has already said it, with room to explain. A second copy of
    // "not connected" per section is noise.
    draw({ items: [], total: 0, connected: false })

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Work items' })).not.toBeInTheDocument(),
    )
  })
})
