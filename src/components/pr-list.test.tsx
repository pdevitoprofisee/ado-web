import { describe, expect, it, vi } from 'vitest'
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

import { PullRequestSection, age, useInboxSelection } from './pr-list'

import type { ReactNode } from 'react'
import type { Hydration, HydrationResult } from '@/server/hydrate'
import type { PullRequestRow } from '@/server/inbox'

const DETAIL = '/pr/$projectId/$repositoryId/$prId'

/**
 * A row is a router `<Link>` now, so a section cannot be rendered without a
 * router in context. `RouterContextProvider` is the router *without* its
 * `<Matches>` — the half a component test wants — and the fake tree below only
 * has to hold the two paths, since nothing here renders a route.
 */
function render(ui: ReactNode) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/' }),
      createRoute({ getParentRoute: () => root, path: DETAIL }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
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

const row = (over: Partial<PullRequestRow> = {}): PullRequestRow => ({
  id: 3302,
  title: 'disable sql auditing',
  description: 'Turns off the auditing policy on the shared server.',
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
  reviewers: [],
  closed: null,
  ...over,
})

const rich = (data: Partial<Hydration> = {}): HydrationResult => ({
  id: 3302,
  ok: true,
  data: {
    checks: { passed: 0, failed: 0, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 },
    unresolved: 0,
    pipelineThreads: [],
    requeueIds: [],
    approvalReset: false,
    // Not ready by default, so the strongest badge in the column only ever shows
    // up in the tests that ask for it. Unblocked *and* unready is a real
    // combination, not a contrived one — it is what a draft looks like.
    blocked: false,
    readyToMerge: false,
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
  it('renders a row as an internal link to the detail route', () => {
    render(<PullRequestSection title="Assigned to me" rows={[row()]} empty="none" />)

    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    expect(link).toHaveAttribute(
      'href',
      '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
    )
    expect(link).toHaveAccessibleDescription(/SaaS\/PC\.IAC\.Modules · Naveen Angali · via SaaS/)
  })

  it('leaves the author out of a section you wrote every row of', () => {
    render(
      <PullRequestSection title="Mine" rows={[row({ author: 'Paul DeVito' })]} empty="none" mine />,
    )

    expect(screen.queryByText('Paul DeVito')).not.toBeInTheDocument()
    // Out of the accessible name as well, and not at the cost of the rest of it.
    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    expect(link).toHaveAccessibleDescription('SaaS/PC.IAC.Modules · via SaaS \\ DevOps Team')
  })

  it('keeps Azure DevOps one gesture away, as a second labelled link', () => {
    render(<PullRequestSection title="Assigned to me" rows={[row()]} empty="none" />)

    const out = screen.getByRole('link', { name: 'Open in Azure DevOps' })
    expect(out).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    )
    expect(out).toHaveAttribute('target', '_blank')
    expect(out).toHaveAttribute('rel', 'noreferrer')
  })

  it('sends a row with no GUIDs to Azure DevOps rather than to a link that goes nowhere', () => {
    render(<PullRequestSection title="Mine" rows={[row({ repositoryId: null })]} empty="none" />)

    // One link, not two: the row itself is the way out, so a second control to
    // the same place would only be a second thing to read.
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName(/disable sql auditing/)
    expect(links[0]).toHaveAttribute(
      'href',
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
    )
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
            checks: { passed: 4, failed: 2, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 },
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

  it('collapses the checks to one badge: failures, else running, else waiting, else all-clear', () => {
    // One glyph rather than four counts, because the column is narrow and
    // "something is red" is the whole decision a reviewer makes from a list.
    const section = (checks: Hydration['checks']) => (
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => rich({ checks })}
      />
    )

    const { rerender } = render(
      section({ passed: 1, failed: 2, failedBuilds: 0, running: 3, waiting: 1, waitingOnPeople: 0 }),
    )
    expect(screen.getByTitle('2 checks failed')).toBeVisible()
    expect(screen.queryByTitle(/checks running/)).toBeNull()

    rerender(section({ passed: 1, failed: 0, failedBuilds: 0, running: 3, waiting: 4, waitingOnPeople: 0 }))
    expect(screen.getByTitle('3 checks running')).toBeVisible()
    // The count is what is moving, not what is outstanding: four policies are
    // unmet here and the badge deliberately says three.
    expect(screen.queryByTitle(/not satisfied/)).toBeNull()

    rerender(section({ passed: 1, failed: 0, failedBuilds: 0, running: 0, waiting: 4, waitingOnPeople: 0 }))
    expect(screen.getByTitle('4 policies not satisfied yet')).toBeVisible()
    // The bug this split exists for: nothing is running, so nothing may claim to
    // be. An expired build and a reviewer who has not voted are not progress.
    expect(screen.queryByTitle(/checks running/)).toBeNull()

    rerender(section({ passed: 5, failed: 0, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 }))
    expect(screen.getByTitle('All checks passed')).toBeVisible()
  })

  it('splits the unmet policies into the half a person clears and the half a machine does', () => {
    const section = (checks: Hydration['checks']) => (
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => rich({ checks })}
      />
    )

    const { rerender } = render(
      section({ passed: 1, failed: 0, failedBuilds: 0, running: 0, waiting: 5, waitingOnPeople: 2 }),
    )
    expect(screen.getByTitle('2 reviewer policies not satisfied yet')).toBeVisible()
    // Three, not five: the reviewer half is already drawn and counting it twice
    // would tell a reviewer there are eight things outstanding.
    expect(screen.getByTitle('3 policies not satisfied yet')).toBeVisible()

    // One kind only draws one badge, which is the shape this column had before
    // the split. An empty badge saying nothing is worse than no badge.
    rerender(section({ passed: 1, failed: 0, failedBuilds: 0, running: 0, waiting: 2, waitingOnPeople: 2 }))
    expect(screen.getByTitle('2 reviewer policies not satisfied yet')).toBeVisible()
    expect(screen.queryByTitle(/^\d+ policies not satisfied yet$/)).toBeNull()

    rerender(section({ passed: 1, failed: 0, failedBuilds: 0, running: 0, waiting: 2, waitingOnPeople: 0 }))
    expect(screen.getByTitle('2 policies not satisfied yet')).toBeVisible()
    expect(screen.queryByTitle(/reviewer policies/)).toBeNull()
  })

  it('splits the failures the same way, and says which of them is a build', () => {
    const section = (checks: Hydration['checks']) => (
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() => rich({ checks })}
      />
    )

    const { rerender } = render(
      section({ passed: 1, failed: 3, failedBuilds: 2, running: 0, waiting: 0, waitingOnPeople: 0 }),
    )
    expect(screen.getByTitle('2 build checks failed')).toBeVisible()
    // One, not three: the build half is already drawn beside it.
    expect(screen.getByTitle('1 check failed')).toBeVisible()

    // The filled chip is the whole signal, so it has to be a filled chip.
    rerender(section({ passed: 1, failed: 1, failedBuilds: 1, running: 0, waiting: 0, waitingOnPeople: 0 }))
    expect(screen.getByTitle('1 build check failed').firstElementChild).toHaveClass(
      'prof-badge',
      'prof-badge--red',
    )
    expect(screen.queryByTitle(/^\d+ checks? failed$/)).toBeNull()

    // A rejected reviewer is not a broken build, and this is the row that used to
    // report it as one.
    rerender(section({ passed: 1, failed: 1, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 }))
    expect(screen.getByTitle('1 check failed')).toBeVisible()
    expect(screen.queryByTitle(/build/)).toBeNull()
  })

  it('marks a row that is ready to merge, in place of the weaker all-clear tick', () => {
    render(
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() =>
          rich({
            checks: { passed: 5, failed: 0, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 },
            readyToMerge: true,
          })
        }
      />,
    )

    expect(screen.getByTitle('Ready to merge')).toBeVisible()
    // Both would be teal ticks side by side saying overlapping things, and the
    // weaker one has nothing to add once the stronger one is up.
    expect(screen.queryByTitle('All checks passed')).toBeNull()
  })

  it('does not mark a blocked row as ready, however many checks passed', () => {
    render(
      <PullRequestSection
        title="Mine"
        rows={[row()]}
        empty="none"
        hydration={() =>
          rich({
            checks: { passed: 5, failed: 0, failedBuilds: 0, running: 0, waiting: 0, waitingOnPeople: 0 },
            blocked: true,
          })
        }
      />,
    )

    expect(screen.queryByTitle('Ready to merge')).toBeNull()
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

  // Filtered to fewer than it holds, the heading has to say so — a section that
  // silently shrinks reads as pull requests having gone away.
  it('says how many of the section it is showing when a filter has narrowed it', () => {
    render(<PullRequestSection title="Mine" rows={[row({ id: 1 })]} total={9} empty="none" />)

    expect(screen.getByRole('heading')).toHaveAccessibleName('Mine, 1 of 9 pull requests')
    expect(screen.getByText('1 of 9')).toBeVisible()
  })

  it('leaves the count alone when nothing has been filtered out', () => {
    render(<PullRequestSection title="Mine" rows={[row({ id: 1 })]} total={1} empty="none" />)

    expect(screen.getByRole('heading')).toHaveAccessibleName('Mine, 1 pull requests')
  })

  describe('the pipeline callout action', () => {
    const section = (props: {
      hydration?: () => HydrationResult
      onResolveCallout?: (row: PullRequestRow, threads: readonly number[]) => Promise<void>
    }) =>
      render(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={props.hydration}
          onResolveCallout={props.onResolveCallout}
        />,
      )

    const resolve = () => screen.getByRole('button', { name: /Resolve/ })

    it('appears only on a row that carries one', () => {
      section({ hydration: () => rich(), onResolveCallout: vi.fn() })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('names how many comments it will close', () => {
      const { rerender } = section({
        hydration: () => rich({ pipelineThreads: [9] }),
        onResolveCallout: vi.fn(),
      })

      expect(resolve()).toHaveAccessibleName('Resolve the Azure Pipelines comment')

      rerender(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={() => rich({ pipelineThreads: [9, 12, 15] })}
          onResolveCallout={vi.fn()}
        />,
      )
      expect(resolve()).toHaveAccessibleName('Resolve 3 Azure Pipelines comments')
    })

    // The history page and every standalone render: a section that was not given
    // the write must not draw a control that cannot do anything.
    it('is absent when the section was given no way to write', () => {
      section({ hydration: () => rich({ pipelineThreads: [9] }) })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('hands the write the row and the threads hydration found', async () => {
      const onResolveCallout = vi.fn().mockResolvedValue(undefined)
      section({ hydration: () => rich({ pipelineThreads: [9, 12] }), onResolveCallout })

      await userEvent.click(resolve())

      expect(onResolveCallout).toHaveBeenCalledWith(
        expect.objectContaining({ id: 3302 }),
        [9, 12],
      )
    })

    // A second press would start the same sequence of writes over threads the
    // first press is still closing.
    it('stays disabled until the write comes back', async () => {
      let finish = () => {}
      const onResolveCallout = vi.fn(
        () =>
          new Promise<void>((done) => {
            finish = done
          }),
      )
      section({ hydration: () => rich({ pipelineThreads: [9] }), onResolveCallout })

      await userEvent.click(resolve())
      expect(resolve()).toBeDisabled()
      expect(resolve()).toHaveAttribute('aria-busy', 'true')

      finish()
      await waitFor(() => expect(resolve()).toBeEnabled())
      expect(onResolveCallout).toHaveBeenCalledTimes(1)
    })

    // On the button and not in the row: the row's width is reserved so badges
    // cannot move the rows under it, and a legible error message would.
    it('says what Azure DevOps refused, without changing the shape of the row', async () => {
      const onResolveCallout = vi.fn().mockRejectedValue(new Error('Thread 9 is already closed.'))
      section({ hydration: () => rich({ pipelineThreads: [9] }), onResolveCallout })

      await userEvent.click(resolve())

      await waitFor(() =>
        expect(screen.getByTitle('Thread 9 is already closed.')).toBeInTheDocument(),
      )
      expect(screen.getByRole('alert')).toHaveTextContent('Thread 9 is already closed.')
      expect(resolve()).toBeEnabled()
    })
  })

  describe('the requeue action', () => {
    const EVALUATION = '44444444-4444-4444-4444-444444444444'

    const section = (props: {
      hydration?: () => HydrationResult
      onRequeue?: (row: PullRequestRow, evaluations: readonly string[]) => Promise<void>
    }) =>
      render(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={props.hydration}
          onRequeue={props.onRequeue}
        />,
      )

    const requeue = () => screen.getByRole('button', { name: /Requeue/ })

    it('appears only on a row with a build to run again', () => {
      section({ hydration: () => rich(), onRequeue: vi.fn() })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('is absent when the section was given no way to write', () => {
      section({ hydration: () => rich({ requeueIds: [EVALUATION] }) })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('names how many policies it will queue', () => {
      const { rerender } = section({
        hydration: () => rich({ requeueIds: [EVALUATION] }),
        onRequeue: vi.fn(),
      })

      expect(requeue()).toHaveAccessibleName('Requeue the build policy')

      rerender(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={() => rich({ requeueIds: [EVALUATION, 'b', 'c'] })}
          onRequeue={vi.fn()}
        />,
      )
      expect(requeue()).toHaveAccessibleName('Requeue 3 build policies')
    })

    it('hands the write the row and the evaluations hydration found', async () => {
      const onRequeue = vi.fn().mockResolvedValue(undefined)
      section({ hydration: () => rich({ requeueIds: [EVALUATION] }), onRequeue })

      await userEvent.click(requeue())

      expect(onRequeue).toHaveBeenCalledWith(expect.objectContaining({ id: 3302 }), [EVALUATION])
    })

    it('stays disabled until the write comes back', async () => {
      let finish = () => {}
      const onRequeue = vi.fn(
        () =>
          new Promise<void>((done) => {
            finish = done
          }),
      )
      section({ hydration: () => rich({ requeueIds: [EVALUATION] }), onRequeue })

      await userEvent.click(requeue())
      expect(requeue()).toBeDisabled()
      expect(requeue()).toHaveAttribute('aria-busy', 'true')

      finish()
      await waitFor(() => expect(requeue()).toBeEnabled())
      expect(onRequeue).toHaveBeenCalledTimes(1)
    })

    it('says what Azure DevOps refused, without changing the shape of the row', async () => {
      const onRequeue = vi.fn().mockRejectedValue(new Error('TF401027: You need Contribute.'))
      section({ hydration: () => rich({ requeueIds: [EVALUATION] }), onRequeue })

      await userEvent.click(requeue())

      await waitFor(() =>
        expect(screen.getByTitle('TF401027: You need Contribute.')).toBeInTheDocument(),
      )
      expect(screen.getByRole('alert')).toHaveTextContent('TF401027: You need Contribute.')
      expect(requeue()).toBeEnabled()
    })

    // A pull request whose build broke and whose pipeline commented on the
    // coverage carries both, and the two acts are not the same act.
    it('stands beside the callout button rather than replacing it', async () => {
      const onRequeue = vi.fn().mockResolvedValue(undefined)
      const onResolveCallout = vi.fn().mockResolvedValue(undefined)
      render(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={() => rich({ pipelineThreads: [9], requeueIds: [EVALUATION] })}
          onResolveCallout={onResolveCallout}
          onRequeue={onRequeue}
        />,
      )

      await userEvent.click(requeue())

      expect(onRequeue).toHaveBeenCalledTimes(1)
      expect(onResolveCallout).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Resolve/ })).toBeEnabled()
    })
  })

  describe('the squash merge action', () => {
    const section = (props: {
      hydration?: () => HydrationResult
      onMerge?: (row: PullRequestRow) => void
    }) =>
      render(
        <PullRequestSection
          title="Mine"
          rows={[row()]}
          empty="none"
          hydration={props.hydration}
          onMerge={props.onMerge}
        />,
      )

    const merge = () => screen.getByRole('button', { name: 'Squash and merge' })

    it('appears only on a row the table calls ready to merge', () => {
      section({ hydration: () => rich(), onMerge: vi.fn() })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('is absent when the page offers no dialog to open', () => {
      section({ hydration: () => rich({ readyToMerge: true }) })

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('hands the page the row it was pressed on', async () => {
      const onMerge = vi.fn()
      section({ hydration: () => rich({ readyToMerge: true }), onMerge })

      await userEvent.click(merge())

      expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 3302 }))
    })

    // It opens a dialog rather than completing anything, so there is no write to
    // wait for and nothing on the row to go busy. A row that disabled itself here
    // would be a row waiting on a press that already finished.
    it('writes nothing itself, and leaves the row as it found it', async () => {
      section({ hydration: () => rich({ readyToMerge: true }), onMerge: vi.fn() })

      await userEvent.click(merge())

      expect(merge()).toBeEnabled()
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  describe('the reviewer faces', () => {
    const person = (displayName: string, vote = 0) => ({
      id: displayName,
      displayName,
      vote,
      isContainer: false,
      avatarHref: null,
    })

    it('draws a face per person and names each one with their vote', () => {
      render(
        <PullRequestSection
          title="Mine"
          rows={[row({ reviewers: [person('Naveen Angali', 10), person('Ana Ruiz', -5)] })]}
          empty="none"
        />,
      )

      // The faces are `aria-hidden` by `Avatar`'s contract, so the words are the
      // only thing a reader who cannot see them gets.
      expect(
        screen.getByText('Reviewers: Naveen Angali (approved), Ana Ruiz (waiting for author)'),
      ).toBeInTheDocument()
      expect(screen.getByText('NA')).toBeInTheDocument()
    })

    // The ring is the whole signal for "somebody said yes", and it was invisible
    // while it was a 1.5px teal stroke standing next to a 1.5px navy one.
    it('draws an approved face in marker and leaves the rest in pen', () => {
      render(
        <PullRequestSection
          title="Mine"
          rows={[row({ reviewers: [person('Naveen Angali', 10), person('Ana Ruiz', 0)] })]}
          empty="none"
        />,
      )

      expect(screen.getByText('NA')).toHaveClass('border-[2.5px]', 'border-pen-green')
      expect(screen.getByText('AR')).not.toHaveClass('border-[2.5px]')
    })

    it('leaves the teams out, because a team is not somebody you can go and ask', () => {
      render(
        <PullRequestSection
          title="Mine"
          rows={[
            row({
              reviewers: [
                { ...person('[SaaS]\\DevOps Team'), isContainer: true },
                person('Naveen Angali'),
              ],
            }),
          ]}
          empty="none"
        />,
      )

      expect(screen.getByText('Reviewers: Naveen Angali (no vote)')).toBeInTheDocument()
    })

    it('counts the people it ran out of room for rather than dropping them silently', () => {
      render(
        <PullRequestSection
          title="Mine"
          rows={[row({ reviewers: ['A One', 'B Two', 'C Three', 'D Four', 'E Five'].map((n) => person(n)) })]}
          empty="none"
        />,
      )

      expect(screen.getByText('+2')).toBeVisible()
      // Every name is still read out, including the two with no face: the cap is
      // a width, not a decision about who is on the review.
      expect(screen.getByText(/D Four \(no vote\), E Five \(no vote\)$/)).toBeInTheDocument()
    })

    it('says there are none rather than leaving a reader on an empty box', () => {
      render(<PullRequestSection title="Mine" rows={[row({ reviewers: [] })]} empty="none" />)

      expect(screen.getByText('No reviewers')).toBeInTheDocument()
    })
  })
})

describe('a grouped section', () => {
  const grouped = (rows: readonly PullRequestRow[]) =>
    render(<PullRequestSection title="Mine" rows={rows} grouped empty="none" />)

  // The repository name and nothing else: the project is a word every heading in
  // a project would repeat.
  it('draws one headed list per repository, alphabetically, named without the project', () => {
    grouped([
      row({ id: 1, project: 'SaaS', repository: 'PC.IAC.Modules' }),
      row({ id: 2, project: 'Products', repository: 'zzz-service' }),
      row({ id: 3, project: 'SaaS', repository: 'PC.IAC.Modules' }),
    ])

    expect(screen.getAllByRole('heading', { level: 3 }).map((one) => one.textContent)).toEqual([
      'PC.IAC.Modules2',
      'zzz-service1',
    ])
    expect(screen.getAllByRole('list')).toHaveLength(2)
  })

  it('counts each repository beside its heading, for a reader who cannot see the sheet', () => {
    grouped([
      row({ id: 1, project: 'Products', repository: 'platform' }),
      row({ id: 2, project: 'Products', repository: 'platform' }),
    ])

    expect(screen.getByRole('heading', { level: 3 })).toHaveAccessibleName(
      'platform, 2 pull requests',
    )
  })

  // The one place the project is still reachable, for the inbox that holds two
  // repositories of the same name.
  it('keeps the project on the heading as a hover', () => {
    grouped([row({ id: 1, project: 'Products', repository: 'platform' })])

    expect(screen.getByRole('heading', { level: 3 })).toHaveAttribute(
      'title',
      'Products/platform',
    )
  })

  // The section heading is still the section's, not the sum of the groups shown.
  it('keeps the section heading and its count', () => {
    grouped([
      row({ id: 1, project: 'SaaS', repository: 'a' }),
      row({ id: 2, project: 'SaaS', repository: 'b' }),
    ])

    expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName('Mine, 2 pull requests')
  })

  it('draws every row exactly once', () => {
    grouped([
      row({ id: 1, project: 'SaaS', repository: 'a' }),
      row({ id: 2, project: 'Products', repository: 'b' }),
      row({ id: 3, project: 'SaaS', repository: 'a' }),
    ])

    expect(screen.getAllByRole('listitem').map((one) => one.dataset.prId)).toEqual([
      '1',
      '3',
      '2',
    ])
  })

  it('says why it is empty rather than drawing a heading with no repositories', () => {
    render(<PullRequestSection title="Mine" rows={[]} grouped empty="Nothing here." />)

    expect(screen.getByText('Nothing here.')).toBeVisible()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })
})

describe('a closed pull request', () => {
  // Exactly 26 days before `NOW`, so the age below is not sitting on a rounding
  // boundary.
  const closed = (outcome: 'completed' | 'abandoned', at = '2026-07-01T12:00:00Z') =>
    row({ closed: { at, outcome } })

  const list = (rows: readonly PullRequestRow[]) =>
    render(<PullRequestSection title="Closed" rows={rows} empty="none" />)

  it('says which of the two it was, in colour as well as in words', () => {
    // Two finished pull requests are not the same news, and a reader scanning a
    // page of them is reading the colour before the word.
    const { rerender } = list([closed('completed')])
    expect(screen.getByText('completed')).toHaveClass('prof-badge--teal')

    rerender(<PullRequestSection title="Closed" rows={[closed('abandoned')]} empty="none" />)
    const abandoned = screen.getByText('abandoned')
    expect(abandoned).toHaveClass('prof-badge--red')
    expect(abandoned).not.toHaveClass('prof-badge--teal')
  })

  it('measures the age from when it closed, not from when it opened', () => {
    // Otherwise the page would be sorted by one date and labelled with another.
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    list([closed('completed')])

    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    expect(link.lastElementChild).toHaveTextContent('26d ago')
    expect(link.lastElementChild).toHaveAttribute('title', '2026-07-01T12:00:00Z')
    now.mockRestore()
  })

  it('puts the outcome and the day in the row description, for a reader who cannot see the badge', () => {
    list([closed('abandoned')])

    expect(screen.getByRole('link', { name: /disable sql auditing/ })).toHaveAccessibleDescription(
      /· abandoned 2026-07-01$/,
    )
  })

  it('drops an open pull request\'s badges, which are all about work still to do', () => {
    // The outcome takes the cell hydration would have filled — and a merge
    // conflict on an abandoned PR is not news, it is why it was abandoned.
    list([row({ conflicted: true, closed: { at: '2026-07-01T00:00:00Z', outcome: 'abandoned' } })])

    expect(screen.queryByTitle('Merge conflicts')).toBeNull()
    expect(screen.getByText('abandoned')).toBeVisible()
  })

  it('still opens in the app, exactly as an inbox row does', () => {
    list([closed('completed')])

    expect(screen.getByRole('link', { name: /disable sql auditing/ })).toHaveAttribute(
      'href',
      '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
    )
  })

  it('still names the outcome when Azure DevOps sent no closed date', () => {
    list([closed('completed', '')])

    expect(screen.getByText('completed')).toBeVisible()
    const link = screen.getByRole('link', { name: /disable sql auditing/ })
    // Blank rather than "NaN ago", and no dangling date in the description.
    expect(link.lastElementChild).toBeEmptyDOMElement()
    expect(link).toHaveAccessibleDescription(/· completed$/)
  })
})

/**
 * The inbox as the keyboard sees it: two sections, one selection.
 *
 * "Mine" first, in both the array and the markup, because that is the order the
 * page renders — and the tests below are the only thing that would notice the
 * two drifting apart.
 */
function Sections({
  assigned,
  mine,
}: {
  assigned: readonly PullRequestRow[]
  mine: readonly PullRequestRow[]
}) {
  const selectedId = useInboxSelection([...mine, ...assigned])

  return (
    <>
      <PullRequestSection title="Mine" rows={mine} empty="none" selectedId={selectedId} />
      <PullRequestSection
        title="Assigned to me"
        rows={assigned}
        empty="none"
        selectedId={selectedId}
      />
    </>
  )
}

function Inbox(props: { assigned: readonly PullRequestRow[]; mine: readonly PullRequestRow[] }) {
  return (
    <CommandProvider>
      <Sections {...props} />
    </CommandProvider>
  )
}

/** The selected row's id, read the way a reader would: off what is marked. */
const selected = (): string | null =>
  document.querySelector('[aria-current="true"]')?.getAttribute('data-pr-id') ?? null

describe('useInboxSelection', () => {
  it('moves j and k across both sections as one list, and stops at the ends', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 }), row({ id: 2 })]} mine={[row({ id: 3 })]} />)

    expect(selected()).toBeNull()

    // The top of the page is the top of "Mine", so `j` from nowhere lands there.
    await user.keyboard('j')
    expect(selected()).toBe('3')
    await user.keyboard('j')
    // Off the end of "Mine" and onto the top of "Assigned to me".
    expect(selected()).toBe('1')
    await user.keyboard('j')
    expect(selected()).toBe('2')
    await user.keyboard('j')
    expect(selected()).toBe('2')

    await user.keyboard('kk')
    expect(selected()).toBe('3')
    await user.keyboard('k')
    expect(selected()).toBe('3')
  })

  it('starts from the bottom when the first key pressed is k', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[row({ id: 2 })]} />)

    await user.keyboard('k')

    // The bottom of the page is the bottom of "Assigned to me", which now renders
    // second.
    expect(selected()).toBe('1')
  })

  it('focuses the selected row, so the keyboard and the screen reader agree', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[]} />)

    await user.keyboard('j')

    const item = screen.getByRole('listitem')
    expect(document.activeElement).toBe(within(item).getByRole('link', { name: /disable sql/ }))
  })

  it('opens the selected row on Enter', async () => {
    const user = userEvent.setup()
    const { router } = render(<Inbox assigned={[row({ id: 3302 })]} mine={[]} />)

    await user.keyboard('j{Enter}')

    await waitFor(() => {
      expect(router.history.location.pathname).toBe(
        '/pr/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/3302',
      )
    })
  })

  it('opens an unaddressable row in Azure DevOps on Enter, as clicking it would', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    const { router } = render(<Inbox assigned={[row({ projectId: null })]} mine={[]} />)

    await user.keyboard('j{Enter}')

    expect(open).toHaveBeenCalledWith(
      'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
      '_blank',
      'noreferrer',
    )
    expect(router.history.location.pathname).toBe('/')
    open.mockRestore()
  })

  it('clears the selection on Escape', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row({ id: 1 })]} mine={[]} />)

    await user.keyboard('j')
    expect(selected()).toBe('1')

    await user.keyboard('{Escape}')

    expect(selected()).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('lights the navigation shortcuts up in the ? sheet, because they now do something', async () => {
    const user = userEvent.setup()
    render(<Inbox assigned={[row()]} mine={[]} />)

    await user.keyboard('?')
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    const bound = [...sheet.querySelectorAll('[data-slot="shortcut"][data-bound="true"] dt')].map(
      (entry) => entry.textContent,
    )
    // Nothing dimmed: the shell's `?` and `t` plus the four this surface claims
    // is the whole registry.
    expect(bound).toEqual([
      'Next item',
      'Previous item',
      'Open',
      'Back',
      'Light or dark',
      'Keyboard shortcuts',
    ])
  })
})
