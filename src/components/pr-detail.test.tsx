import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as renderBare, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { PullRequestDetailView as Detail } from './pr-detail'
import { mergeBlocker } from '@/lib/merge'
import { CommandProvider } from '@/commands/command-provider'
import { fileAnchor } from '@/lib/file-anchor'
import { voteWord } from '@/lib/people'
import { viewedKey } from '@/lib/viewed-key'
import {
  abandonPullRequest,
  iterationChangesQuery,
  publishPullRequest,
  reactivatePullRequest,
  renamePullRequest,
  requeuePolicy,
  setMyVote,
  squashMerge,
  withdrawReviewer,
} from '@/server/pull-request-fn'
import { startThread, threadsQuery } from '@/server/threads-fn'
import { markViewed, viewedQuery } from '@/server/viewed-fn'

import type { ComponentProps, ReactElement, ReactNode } from 'react'
import type { DetailTab } from './pr-detail'
import type { Comment, Thread, ThreadList } from '@/lib/comment-contract'
import type { SonarFinding } from '@/lib/sonar-contract'
import type { SonarReportResult } from '@/server/sonar-fn'
import type { ThreadsResult } from '@/server/threads-fn'
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
// `requeuePolicy` is mocked for `useRequeue`'s sake — the checklist closes over
// it whether or not a test presses anything, and an unmocked module would drag
// the real server function into a jsdom bundle with no fetch to send it with.
vi.mock('@/server/pull-request-fn', () => ({
  requeuePolicy: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  // Same reason as the requeue: `useRename` is called by the header on every
  // render, whether or not a test presses anything.
  renamePullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  // Mocked for the same reason, and with more riding on it: this is the one write
  // in the app that would complete a real pull request, so the module must not
  // reach a bundle that could send it.
  squashMerge: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  // The header's three new writes, mocked for the same two reasons: `useVote`,
  // `useAbandon` and `useReactivate` are called on every render of the header, and
  // one of them abandons a real pull request.
  setMyVote: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  abandonPullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  reactivatePullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  publishPullRequest: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  // The reviewer writes, closed over by `ReviewerList` on every render of the
  // Reviewers section — and the pair that would put somebody's name on a real
  // colleague's pull request, or take it off.
  inviteReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  withdrawReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
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

// The conversation, which the page now reads for itself. Mocked to the empty
// answer so the tests above it — none of which are about comments — see the page
// they were written against; the ones below override the read per test.
//
// Every write is mocked too, and not because anything here calls one: `useConversation`
// closes over every one of them, so an unmocked module would drag the real server functions
// into a jsdom bundle that has no fetch to send them with.
vi.mock('@/server/threads-fn', () => ({
  threadsQuery: vi.fn(async () => ({
    threads: { threads: [], openCount: 0, doneCount: 0, systemCount: 0, botCount: 0, votes: [] },
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })),
  startThread: vi.fn(async () => ok()),
  replyToThread: vi.fn(async () => ok()),
  changeThreadStatus: vi.fn(async () => ok()),
  editThreadComment: vi.fn(async () => ok()),
  deleteThreadComment: vi.fn(async () => ok()),
  likeThreadComment: vi.fn(async () => ok()),
}))

// The checks panel, which reads for itself the way the conversation does. Mocked
// to "nothing has run", which is the answer none of the tests here are about: the
// panel draws one sentence and no rows, so the page they were written against is
// the page they see.
//
// The module has to be mocked whether or not anything reads it, and for a reason
// the mocks above do not have: `checks-fn` validates with `pullRequestRef` from
// `@/server/pull-request-fn`, which is itself mocked here — so an unmocked
// `checks-fn` fails at *import* time on the missing export, before a single test
// runs. Mocking the module the panel imports keeps the real one out of the bundle
// and leaves the mock above listing only what the page actually calls.
vi.mock('@/server/checks-fn', () => ({
  checksReportQuery: vi.fn(async () => ({
    report: null,
    error: null,
    connected: true,
    rateLimit: null,
  })),
  // `useCheckDetail` and `useRetryBuild` are closed over by the panel on every
  // render, the same way the writes above are. Neither is reachable without a row
  // to open, and there are no rows.
  checkDetailQuery: vi.fn(),
  retryBuildRun: vi.fn(),
}))

// The work items panel, mocked for both of `checks-fn`' reasons: it reads for
// itself, and `work-items-fn` validates with the `pullRequestRef` the mock above
// does not export. Answered as "none attached", which draws one sentence.
vi.mock('@/server/work-items-fn', () => ({
  workItemsQuery: vi.fn(async () => ({ items: [], total: 0, error: null, connected: true })),
  // Closed over by the picker, which is behind a press and never pressed here.
  workItemSearchQuery: vi.fn(),
  attachWorkItem: vi.fn(),
}))

// `useSonarResolve` for the same import-time reason as `checks-fn`: the header
// closes over it on every render, and `sonar-fn` validates with the
// `pullRequestRef` the mock above does not export.
vi.mock('@/server/sonar-fn', () => ({
  sonarReportQuery: vi.fn(),
  resolveSonarFinding: vi.fn(),
}))

/**
 * What a write answers with when it worked.
 *
 * A `function` and not a `const`: the factory above runs on the first import of
 * the mocked module, which is before this file's own bindings are initialised, so
 * an arrow assigned to a const would be in its temporal dead zone.
 */
function ok() {
  return { ok: true, error: null, connected: true, rateLimit: null }
}

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

/** One evaluation of one policy, which is what a requeue addresses. */
const EVALUATION = '33333333-3333-3333-3333-333333333333'

/**
 * The source branch's tip as ADO last saw it. A real 40-hex sha rather than a
 * token, because the merge request is validated by shape on the way out.
 */
const SOURCE_TIP = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'

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
      {/* The find box claims `/`, and `useCommand` throws without this — the
          same shell the app mounts once in the root route. */}
      <CommandProvider>{children}</CommandProvider>
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
  author: { id: 'author-1', displayName: 'Paul DeVito', avatarHref: null },
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  status: 'active',
  sourceBranch: 'refs/heads/feature/logging-sink',
  targetBranch: 'refs/heads/main',
  merge: { status: 'succeeded', conflicted: false, conflicts: [] },
  lastMergeSourceCommit: SOURCE_TIP,
  reviewers: [],
  policies: [],
  commits: [],
  files: { files: [], iterationId: 2, iterations: [], truncated: false },
  project: 'Products',
  repository: 'utilities',
  url: 'https://dev.azure.com/Profisee/Products/_git/utilities/pullrequest/24698',
  viewerId: 'author-1',
  // `null` is the shape of "nobody has hydrated this pull request", which is the
  // state most of these tests are in and the one that must draw nothing.
  approvalReset: null,
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
  waitsOnPeople: false,
  clearedBySquash: false,
  // Whether a row is one to requeue is `toPolicies`' decision, tested there. The
  // rows here are given one or not given one, which is all this side knows.
  requeueId: null,
  ...over,
})

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  id: 'rev-1',
  displayName: 'Naveen Angali',
  vote: 0,
  isContainer: false,
  isRequired: true,
  votedFor: [],
  avatarHref: null,
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
    // Destination first, and the arrow still pointing at it.
    expect(screen.getByText('main ← feature/logging-sink')).toBeVisible()
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

describe('PullRequestDetailView rename', () => {
  beforeEach(() => {
    vi.mocked(renamePullRequest).mockClear()
  })

  /** Opens the editor and hands back the field, which is where every test starts. */
  async function edit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Rename this pull request' }))

    return screen.getByRole('textbox', { name: 'Pull request title' })
  }

  it('sends the trimmed title, and does not touch the heading until ADO has it', async () => {
    const user = userEvent.setup()
    render(<PullRequestDetailView pr={detail()} />)

    const field = await edit(user)
    await user.clear(field)
    await user.type(field, '  point the sink at its own account  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(vi.mocked(renamePullRequest)).toHaveBeenCalledWith({
      data: { ...REF, title: 'point the sink at its own account' },
    })
    // The heading is still the title the page was handed, because nothing here is
    // optimistic — the new one arrives on the re-read, which in this test is a
    // mocked server function that answers the same fixture.
    expect(
      await screen.findByRole('heading', { name: 'move the logging sink off the shared account' }),
    ).toBeVisible()
  })

  it('saves on Enter and abandons on Escape', async () => {
    const user = userEvent.setup()
    render(<PullRequestDetailView pr={detail()} />)

    const field = await edit(user)
    await user.clear(field)
    await user.type(field, 'renamed with the keyboard{Enter}')

    expect(vi.mocked(renamePullRequest)).toHaveBeenCalledWith({
      data: { ...REF, title: 'renamed with the keyboard' },
    })

    const second = await edit(user)
    await user.clear(second)
    await user.type(second, 'typed and thought better of{Escape}')

    expect(vi.mocked(renamePullRequest)).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: 'Pull request title' })).toBeNull()
    // And reopening starts from ADO's title rather than from the abandoned draft.
    expect(await edit(user)).toHaveValue('move the logging sink off the shared account')
  })

  it('refuses an empty title without asking Azure DevOps about it', async () => {
    const user = userEvent.setup()
    render(<PullRequestDetailView pr={detail()} />)

    const field = await edit(user)
    await user.clear(field)
    await user.type(field, '   ')

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Enter does not go around the disabled button.
    await user.type(field, '{Enter}')
    expect(vi.mocked(renamePullRequest)).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Pull request title' })).toBeVisible()
  })

  it('treats saving the same title as nothing to do', async () => {
    const user = userEvent.setup()
    render(<PullRequestDetailView pr={detail()} />)

    await edit(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(vi.mocked(renamePullRequest)).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Pull request title' })).toBeNull()
  })

  it('shows what ADO said and keeps what was typed when the rename is refused', async () => {
    vi.mocked(renamePullRequest).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    const user = userEvent.setup()
    render(<PullRequestDetailView pr={detail()} />)

    const field = await edit(user)
    await user.clear(field)
    await user.type(field, 'a rename this account may not make')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // ADO's own sentence, beside the field, unedited — this project cannot predict
    // its permission model and does not try to paraphrase its refusals.
    expect(await screen.findByRole('alert')).toHaveTextContent('TF401027')
    // The text survives, and the refused title is nowhere on the page as the pull
    // request's own — closing the field brings back the one Azure DevOps still
    // holds, because that is the only title the header ever renders.
    expect(field).toHaveValue('a rename this account may not make')
    expect(screen.queryByRole('heading', { name: 'a rename this account may not make' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('heading', { name: 'move the logging sink off the shared account' }),
    ).toBeVisible()
  })

  it('is not offered on a pull request that is no longer active', async () => {
    render(<PullRequestDetailView pr={detail({ status: 'completed' })} />)

    expect(screen.queryByRole('button', { name: 'Rename this pull request' })).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'move the logging sink off the shared account' }),
    ).toBeVisible()
  })
})

describe('PullRequestDetailView copying the source branch', () => {
  /**
   * `userEvent.setup()` installs a clipboard stub of its own, so this has to be
   * called after it — and the property it installs is configurable, which is the
   * only reason either of these tests can say what the clipboard is.
   */
  function stubClipboard(clipboard: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  }

  afterEach(() => {
    // Back to jsdom's own navigator, which has no clipboard at all — otherwise the
    // absence one test arranges is still there for the next file's `setup()`.
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('copies the source branch and says which one it took', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    stubClipboard({ writeText })

    render(<PullRequestDetailView pr={detail()} />)

    // The name says the branch, because "copy" beside two of them does not.
    await user.click(screen.getByRole('button', { name: 'Copy source branch feature/logging-sink' }))

    expect(writeText).toHaveBeenCalledWith('feature/logging-sink')
    // The acknowledgement in both channels: the name that gets spoken, and — since
    // an icon has no text to assert on — the `data-state` the tick is drawn from.
    expect(
      await screen.findByRole('button', { name: 'Copied source branch feature/logging-sink' }),
    ).toHaveAttribute('data-state', 'copied')
  })

  it('says it failed rather than throwing when the clipboard refuses', async () => {
    const user = userEvent.setup()
    stubClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('Write permission denied.'))) })

    render(<PullRequestDetailView pr={detail()} />)
    await user.click(screen.getByRole('button', { name: 'Copy source branch feature/logging-sink' }))

    expect(
      await screen.findByRole('button', { name: 'Failed to copy source branch feature/logging-sink' }),
    ).toHaveAttribute('data-state', 'failed')
  })

  it('says it failed when there is no clipboard to write to', async () => {
    const user = userEvent.setup()
    // What a plain-http origin looks like: the API is simply not there. The button
    // must still be a button that answers, not one that throws a TypeError into the
    // page for reading a property of `undefined`.
    stubClipboard(undefined)

    render(<PullRequestDetailView pr={detail()} />)
    await user.click(screen.getByRole('button', { name: 'Copy source branch feature/logging-sink' }))

    expect(
      await screen.findByRole('button', { name: 'Failed to copy source branch feature/logging-sink' }),
    ).toHaveAttribute('data-state', 'failed')
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
    // The banner's own sentences, specifically. `/merge/i` used to do here, and
    // cannot any more: the squash control underneath says "merge" all day, which
    // is not the thing this test is about.
    expect(screen.queryByText(/conflicts with its target/i)).toBeNull()
    expect(screen.queryByText(/has not tested this merge/i)).toBeNull()
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
    expect(screen.queryByText(/conflicts with its target/i)).toBeNull()
    expect(screen.queryByText(/has not tested this merge/i)).toBeNull()
  })
})

/**
 * Every state that keeps the button off, with the sentence it is kept off with.
 * Written as a table because the sentences *are* the feature — a disabled control
 * that will not say why is the thing this replaces — so a reason that changes
 * silently should fail here.
 */
const BLOCKED: ReadonlyArray<[string, Partial<PullRequestDetail>, string]> = [
  ['a completed pull request', { status: 'completed' }, 'This pull request has already been completed.'],
  ['an abandoned one', { status: 'abandoned' }, 'This pull request has been abandoned.'],
  // ADO's word, passed through rather than guessed at.
  ['a status nobody wrote a case for', { status: 'notSet' }, 'Azure DevOps says this pull request is notSet, not active.'],
  ['a status ADO omitted', { status: '' }, 'Azure DevOps says this pull request is in a state it did not name, not active.'],
  ['a draft', { isDraft: true }, 'This is a draft. Publish it before merging.'],
  [
    'a conflicted branch',
    { merge: { status: 'conflicts', conflicted: true, conflicts: [] } },
    'This branch conflicts with its target.',
  ],
  [
    'a merge nobody has attempted',
    { merge: { status: 'queued', conflicted: false, conflicts: [] } },
    'Azure DevOps has not tested this merge yet, so it cannot be completed from here.',
  ],
  [
    'a merge status ADO omitted',
    { merge: { status: '', conflicted: false, conflicts: [] } },
    'Azure DevOps did not say whether this branch merges cleanly.',
  ],
  [
    'a merge status we have never seen',
    { merge: { status: 'failure', conflicted: false, conflicts: [] } },
    'Azure DevOps says the merge is failure.',
  ],
  [
    'one unsatisfied blocking policy',
    { policies: [policy({ blocking: true })] },
    'One blocking policy is not satisfied yet.',
  ],
  [
    'a required reviewer who has not voted',
    { reviewers: [reviewer({ displayName: 'Patrick Mize', vote: 0 })] },
    'Patrick Mize is a required reviewer and has not approved.',
  ],
  [
    'a required reviewer waiting on the author',
    { reviewers: [reviewer({ displayName: 'Patrick Mize', vote: -5 })] },
    'Patrick Mize is a required reviewer and has not approved.',
  ],
  [
    'a required reviewer who rejected it',
    { reviewers: [reviewer({ displayName: 'Patrick Mize', vote: -10 })] },
    'Patrick Mize is a required reviewer and has not approved.',
  ],
  // A required *group* is a requirement too, and it is the one most pull requests
  // on this org carry — see `awaitedReviewers`.
  [
    'a required group nobody in it has voted for',
    {
      reviewers: [
        reviewer({ displayName: '[Products]\\Contributors', isContainer: true, vote: 0 }),
      ],
    },
    '[Products]\\Contributors is a required reviewer and has not approved.',
  ],
  [
    'a source tip ADO did not name',
    { lastMergeSourceCommit: null },
    'Azure DevOps did not say which commit the source branch is on, so merging from here could merge work this page never showed.',
  ],
]

/** The two refusals Azure DevOps' own override clears. */
const OVERRIDABLE: ReadonlyArray<[string, Partial<PullRequestDetail>]> = [
  ['a blocking policy', { policies: [policy({ blocking: true })] }],
  ['a required reviewer who has not approved', { reviewers: [reviewer({ vote: 0 })] }],
]

/** Refusals no override reaches, so no box is drawn beside them. */
const FINAL: ReadonlyArray<[string, Partial<PullRequestDetail>]> = [
  ['a completed pull request', { status: 'completed' }],
  ['a draft', { isDraft: true }],
  ['a conflicted branch', { merge: { status: 'conflicts', conflicted: true, conflicts: [] } }],
  ['a merge nobody has attempted', { merge: { status: 'queued', conflicted: false, conflicts: [] } }],
  ['a source tip ADO did not name', { lastMergeSourceCommit: null }],
]

describe('mergeBlocker', () => {
  it.each(BLOCKED)('refuses %s', (_state, over, reason) => {
    expect(mergeBlocker(detail(over), {})?.reason).toBe(reason)
  })

  it('counts the blocking policies rather than saying "some"', () => {
    expect(
      mergeBlocker(
        detail({
          policies: [
            policy({ id: '1', blocking: true }),
            policy({ id: '2', blocking: true }),
            // Required and satisfied is not blocking, so it is not counted.
            policy({ id: '3', status: 'approved', blocking: false }),
          ],
        }),
        {},
      )?.reason,
    ).toBe('2 blocking policies are not satisfied yet.')
  })

  it('refuses when the policies are the part that did not load', () => {
    // "We do not know" is not "yes". A page that offers the merge here is a page
    // that offers it on a pull request three policies are refusing.
    expect(mergeBlocker(detail(), { policies: true })?.reason).toBe(
      'The branch policies could not be loaded, so whether this may merge is unknown.',
    )
  })

  // The shape of PR 24949, which is what sent us here: seven policies, every one
  // of them `approved`, and Azure DevOps still refusing to complete it because a
  // reviewer marked required on the pull request had not voted. A required
  // reviewer is not a policy evaluation, so the checklist cannot see this one.
  it('refuses a required reviewer even when every policy passed', () => {
    expect(
      mergeBlocker(
        detail({
          policies: [
            policy({ id: '1', name: 'Build', status: 'approved', blocking: false }),
            policy({ id: '2', name: 'Required reviewers', status: 'approved', blocking: false }),
          ],
          reviewers: [
            reviewer({ id: 'rev-1', displayName: 'Chuck Thompson', vote: 10 }),
            reviewer({ id: 'rev-2', displayName: 'Patrick Mize', vote: 0 }),
          ],
        }),
        {},
      )?.reason,
    ).toBe('Patrick Mize is a required reviewer and has not approved.')
  })

  it('names two and counts three', () => {
    const waiting = (count: number) =>
      mergeBlocker(
        detail({
          reviewers: Array.from({ length: count }, (_unused, index) =>
            reviewer({ id: `rev-${index}`, displayName: `Reviewer ${index}`, vote: 0 }),
          ),
        }),
        {},
      )?.reason

    expect(waiting(2)).toBe('Reviewer 0 and Reviewer 1 are required reviewers and have not approved.')
    expect(waiting(3)).toBe('3 required reviewers have not approved.')
  })

  it('takes both approvals as approval, and ignores an optional reviewer', () => {
    // "Approved with suggestions" satisfies the requirement — that is the whole
    // difference between it and "waiting for author". And an optional reviewer who
    // never voted is the state most pull requests on this org are in.
    expect(
      mergeBlocker(
        detail({
          reviewers: [
            reviewer({ id: 'rev-1', vote: 10 }),
            reviewer({ id: 'rev-2', vote: 5 }),
            reviewer({ id: 'rev-3', vote: 0, isRequired: false }),
          ],
        }),
        {},
      ),
    ).toBeNull()
  })

  // Which refusals carry the override, and it is not a ranking of severity:
  // `bypassPolicy` suspends the branch policies and the required reviewers, and
  // nothing else.
  it.each(OVERRIDABLE)('offers the override against %s', (_state, over) => {
    expect(mergeBlocker(detail(over), {})?.overridable).toBe(true)
  })

  it.each(FINAL)('offers no override against %s', (_state, over) => {
    expect(mergeBlocker(detail(over), {})?.overridable).toBe(false)
  })

  it('offers no override on a policy list that never loaded', () => {
    // "Override the rules I could not read" is not a thing to offer.
    expect(mergeBlocker(detail(), { policies: true })?.overridable).toBe(false)
  })

  it('allows it when nothing we can see is in the way', () => {
    expect(mergeBlocker(detail({ policies: [policy({ status: 'approved', blocking: false })] }), {})).toBeNull()
  })
})

describe('PullRequestDetailView squash merge', () => {
  beforeEach(() => {
    vi.mocked(squashMerge).mockClear()
    vi.mocked(squashMerge).mockResolvedValue({ ok: true, error: null, connected: true })
  })

  const section = () => screen.getByRole('region', { name: 'Merge' })
  const trigger = () => within(section()).getByRole('button', { name: 'Squash and merge' })
  const confirm = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Squash and merge' })
  // Scoped to the section: the page has a comment composer and a "Description"
  // section of its own, and these two fields are the merge's.
  const subject = () => within(section()).getByRole('textbox', { name: 'Merge commit message' })
  const body = () => within(section()).getByRole('textbox', { name: 'Description' })

  /** Replaces what a field holds, the way somebody retyping it would. */
  const retype = async (field: HTMLElement, text: string) => {
    await userEvent.clear(field)
    if (text !== '') await userEvent.type(field, text)
  }

  it('offers the title and the description, and lets them be changed', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    // The title as written, with no `Merged PR 24698: ` in front of it: that
    // prefix is what makes a Conventional Commits title unparseable in `main`.
    expect(subject()).toHaveValue('move the logging sink off the shared account')
    expect(body()).toHaveValue('why this exists')

    await retype(subject(), 'chore: move the logging sink')

    expect(subject()).toHaveValue('chore: move the logging sink')
  })

  it('offers no message at all while the merge is blocked', () => {
    // A field that invites a commit message on an abandoned pull request offers
    // something that cannot happen.
    render(<PullRequestDetailView pr={detail({ status: 'abandoned' })} />)

    expect(within(section()).queryByRole('textbox')).toBeNull()
  })

  it('opens a confirmation rather than merging, and names what would be merged', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    // The whole point of the confirmation: the press that reaches the button is
    // not the press that merges.
    expect(squashMerge).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('!24698 move the logging sink off the shared account')
    expect(dialog).toHaveTextContent('Every commit on feature/logging-sink becomes one commit on main')
    expect(dialog).toHaveTextContent('cannot be undone')
    // The deletion said out loud, with where the work went and the way back.
    expect(dialog).toHaveTextContent(
      'feature/logging-sink is deleted — its work lives on in the squashed commit, and Azure DevOps can restore the branch afterwards. No policy is bypassed.',
    )
  })

  it('quotes the message it is about to commit, so the confirmation cannot disagree with the fields', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await retype(subject(), 'chore: move the logging sink')
    await retype(body(), 'the shared account is going away')
    await userEvent.click(trigger())

    // The composed message, not the fields' contents side by side: the blank line
    // between them is part of what gets written.
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'chore: move the logging sink the shared account is going away',
    )
  })

  it('sends the pull request, the tip it was read at and the message, once confirmed', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    await userEvent.click(confirm())

    // The sha is the guard, not decoration: without it ADO would merge whatever
    // the branch has grown since this page was drawn.
    expect(squashMerge).toHaveBeenCalledWith({
      data: {
        ...REF,
        lastMergeSourceCommit: SOURCE_TIP,
        commitMessage: 'move the logging sink off the shared account\n\nwhy this exists',
      },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sends the message as it was edited, subject and body', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await retype(subject(), 'chore: move the logging sink')
    await retype(body(), 'the shared account is going away')
    await userEvent.click(trigger())
    await userEvent.click(confirm())

    expect(squashMerge).toHaveBeenCalledWith({
      data: {
        ...REF,
        lastMergeSourceCommit: SOURCE_TIP,
        commitMessage: 'chore: move the logging sink\n\nthe shared account is going away',
      },
    })
  })

  it('sends the subject alone when the description has been emptied', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await retype(body(), '')
    await userEvent.click(trigger())
    await userEvent.click(confirm())

    expect(squashMerge).toHaveBeenCalledWith({
      data: {
        ...REF,
        lastMergeSourceCommit: SOURCE_TIP,
        // No trailing blank line: an empty body is no body.
        commitMessage: 'move the logging sink off the shared account',
      },
    })
  })

  it('will not merge with no commit message, and says which line is missing', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await retype(subject(), '')

    expect(trigger()).toBeDisabled()
    expect(trigger()).toHaveAccessibleDescription(
      'A commit needs a message. Write its first line above.',
    )

    await userEvent.click(trigger())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(squashMerge).not.toHaveBeenCalled()
  })

  it('merges nothing when the confirmation is cancelled', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(squashMerge).not.toHaveBeenCalled()
  })

  it('shows a refusal in Azure DevOps own words, and stays open', async () => {
    vi.mocked(squashMerge).mockResolvedValue({
      ok: false,
      error: 'TF401028: The pull request cannot be completed: the source branch has been updated.',
      connected: true,
    })
    render(<PullRequestDetailView pr={detail()} />)

    // Held rather than re-queried: the modal hides the page behind it from the
    // accessibility tree, so the field cannot be found by role while it is open.
    const field = subject()
    await retype(field, 'chore: move the logging sink')
    await userEvent.click(trigger())
    await userEvent.click(confirm())

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(
      'Azure DevOps did not merge it: TF401028: The pull request cannot be completed: the source branch has been updated.',
    )
    // Still standing, because the message is the reason the reviewer pressed it.
    expect(screen.getByRole('dialog')).toBeVisible()
    // And the typed message is still typed. A refusal is often the moment somebody
    // wants to reword it, and it is behind the dialog rather than gone.
    expect(field).toHaveValue('chore: move the logging sink')
  })

  it('disables the button with the reason as its description', async () => {
    render(<PullRequestDetailView pr={detail({ isDraft: true })} />)

    const button = trigger()
    expect(button).toBeDisabled()
    // On the page for the eye, and on the control for anything that reads it out.
    expect(button).toHaveAccessibleDescription(
      'This is a draft. Publish it before merging.',
    )

    await userEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(squashMerge).not.toHaveBeenCalled()
  })
})

describe('PullRequestDetailView vote', () => {
  beforeEach(() => {
    vi.mocked(setMyVote).mockClear()
    vi.mocked(setMyVote).mockResolvedValue({ ok: true, error: null, connected: true })
  })

  /**
   * The viewer on the reviewer list, which is what makes a vote theirs to cast.
   * The fixture's viewer is its author, so one reviewer row with that id is a
   * person reviewing their own pull request — which ADO allows, and which is not
   * what any of these tests are about.
   */
  const votable = (over: Partial<PullRequestDetail> = {}) =>
    detail({ reviewers: [reviewer({ id: 'author-1', displayName: 'Paul DeVito' })], ...over })

  const group = () => screen.getByRole('group', { name: 'Your vote' })
  const press = (name: string) => userEvent.click(screen.getByRole('button', { name }))

  // Every value on ADO's scale, and no other: the wire numbers are the one part of
  // this feature a reader cannot check by looking at the page.
  it.each([
    ['Approve', 10],
    ['Approve with suggestions', 5],
    ['No vote', 0],
    ['Wait for author', -5],
    ['Reject', -10],
  ])('sends %s as %d', async (label, vote) => {
    render(<PullRequestDetailView pr={votable()} />)

    await press(label)

    expect(setMyVote).toHaveBeenCalledWith({ data: { ...REF, vote } })
  })

  it('asks nothing first, because voting again is the correction', async () => {
    render(<PullRequestDetailView pr={votable()} />)

    await press('Approve')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(setMyVote).toHaveBeenCalledTimes(1)
  })

  it('draws the vote it last read as the one that is held down, in words as well', () => {
    render(<PullRequestDetailView pr={votable({ reviewers: [reviewer({ id: 'author-1', vote: -5 })] })} />)

    expect(screen.getByRole('button', { name: 'Wait for author' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'false')
    // The state said in words too, and not only by which button is filled in.
    expect(group().parentElement).toHaveTextContent('waiting for author')
  })

  it('surfaces a refused vote in Azure DevOps own words', async () => {
    vi.mocked(setMyVote).mockResolvedValue({
      ok: false,
      error: 'You are not a reviewer on this pull request, so there is no vote of yours to set.',
      connected: true,
    })
    render(<PullRequestDetailView pr={votable()} />)

    await press('Approve')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not record your vote: You are not a reviewer on this pull request, so there is no vote of yours to set.',
    )
  })

  it('keeps the reset notice up after a vote, because only a re-read can take it down', async () => {
    render(<PullRequestDetailView pr={votable({ approvalReset: true })} />)

    const notice = 'A push reset your approval, so it is not standing until you vote again.'
    expect(screen.getByText(notice)).toBeVisible()

    await press('Approve')
    await waitFor(() => expect(setMyVote).toHaveBeenCalled())

    // The whole point: the page does not redraw the vote as freshly cast. Until
    // the pull request is read again, "your approval was reset" is still true.
    expect(screen.getByText(notice)).toBeVisible()
  })

  it('says nothing about a reset when nothing has hydrated the pull request', () => {
    render(<PullRequestDetailView pr={votable()} />)

    expect(screen.queryByText(/reset your approval/)).toBeNull()
  })

  it('refuses with a reason rather than hiding, on a completed pull request', async () => {
    render(<PullRequestDetailView pr={votable({ status: 'completed' })} />)

    expect(group()).toHaveAccessibleDescription(
      'This pull request has been completed, so its votes are a record of what happened.',
    )
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()

    await press('Approve')
    expect(setMyVote).not.toHaveBeenCalled()
  })

  it('refuses when the viewer is not a reviewer at all', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(group()).toHaveAccessibleDescription(
      'You are not a reviewer on this pull request, so there is no vote of yours to set.',
    )
  })

  it('offers a vote when a team is the reviewer, which is how most reviewing arrives', () => {
    render(
      <PullRequestDetailView
        pr={detail({ reviewers: [reviewer({ id: 'team-1', displayName: 'Contributors', isContainer: true })] })}
      />,
    )

    expect(group()).toHaveAccessibleDescription('')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })
})

describe('PullRequestDetailView publish', () => {
  beforeEach(() => {
    vi.mocked(publishPullRequest).mockClear()
    vi.mocked(publishPullRequest).mockResolvedValue({ ok: true, error: null, connected: true })
  })

  it('publishes a draft without asking', async () => {
    render(<PullRequestDetailView pr={detail({ isDraft: true })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(publishPullRequest).toHaveBeenCalledWith({ data: REF })
  })

  it('offers nothing on a pull request that is not a draft', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('offers nothing on an abandoned draft', () => {
    render(<PullRequestDetailView pr={detail({ isDraft: true, status: 'abandoned' })} />)

    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('surfaces a refused publish', async () => {
    vi.mocked(publishPullRequest).mockResolvedValue({
      ok: false,
      error: 'TF401027: You need the Contribute to pull requests permission.',
      connected: true,
    })
    render(<PullRequestDetailView pr={detail({ isDraft: true })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not publish it: TF401027: You need the Contribute to pull requests permission.',
    )
  })
})

describe('PullRequestDetailView abandon and reactivate', () => {
  beforeEach(() => {
    vi.mocked(abandonPullRequest).mockClear()
    vi.mocked(abandonPullRequest).mockResolvedValue({ ok: true, error: null, connected: true })
    vi.mocked(reactivatePullRequest).mockClear()
    vi.mocked(reactivatePullRequest).mockResolvedValue({ ok: true, error: null, connected: true })
  })

  const trigger = () => screen.getByRole('button', { name: 'Abandon' })
  const confirm = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Abandon' })

  it('asks first, and says what abandoning does and does not do', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    expect(abandonPullRequest).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('!24698 move the logging sink off the shared account')
    // Not a delete, in writing: the word sounds like one.
    expect(dialog).toHaveTextContent('The branch, the commits, the comments and the votes all stay')
    expect(dialog).toHaveTextContent('You can reactivate it from this header afterwards.')
  })

  it('abandons the pull request once confirmed', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    await userEvent.click(confirm())

    expect(abandonPullRequest).toHaveBeenCalledWith({ data: REF })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('abandons nothing when the confirmation is cancelled', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(abandonPullRequest).not.toHaveBeenCalled()
  })

  it('shows a refusal in Azure DevOps own words, and leaves the dialog standing', async () => {
    vi.mocked(abandonPullRequest).mockResolvedValue({
      ok: false,
      error: 'TF401027: You need the Contribute to pull requests permission.',
      connected: true,
    })
    render(<PullRequestDetailView pr={detail()} />)

    await userEvent.click(trigger())
    await userEvent.click(confirm())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not abandon it: TF401027: You need the Contribute to pull requests permission.',
    )
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('reactivates an abandoned pull request without asking', async () => {
    render(<PullRequestDetailView pr={detail({ status: 'abandoned' })} />)

    // The two verbs are never both on offer: this one is the only kind of pull
    // request you can reactivate, and it is not one you can abandon.
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reactivatePullRequest).toHaveBeenCalledWith({ data: REF })
  })

  it('surfaces a refused reactivation', async () => {
    vi.mocked(reactivatePullRequest).mockResolvedValue({
      ok: false,
      error: 'TF401398: The pull request has been abandoned by policy.',
      connected: true,
    })
    render(<PullRequestDetailView pr={detail({ status: 'abandoned' })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not reactivate it: TF401398: The pull request has been abandoned by policy.',
    )
  })

  it('refuses on somebody elses pull request, with the reason on the control', async () => {
    render(<PullRequestDetailView pr={detail({ viewerId: 'someone-else' })} />)

    const button = trigger()
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      "Abandoning somebody else's pull request is a decision to make in Azure DevOps.",
    )

    await userEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(abandonPullRequest).not.toHaveBeenCalled()
  })

  it('refuses on a completed pull request rather than hiding the button', () => {
    render(<PullRequestDetailView pr={detail({ status: 'completed' })} />)

    expect(trigger()).toHaveAccessibleDescription('This pull request has already been completed.')
  })
})

describe('PullRequestDetailView policies', () => {
  beforeEach(() => {
    vi.mocked(requeuePolicy).mockClear()
  })

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

  it('offers a requeue only on the rows the server said carry one', async () => {
    render(
      <PullRequestDetailView
        pr={detail({
          policies: [
            policy({
              id: '1',
              name: 'Build',
              detail: 'utilities.logging · build 193288 · ran on an earlier commit',
              requeueId: EVALUATION,
            }),
            policy({ id: '2', name: 'Minimum number of reviewers' }),
          ],
        })}
      />,
    )

    const rows = within(screen.getByRole('list', { name: 'Blocking' })).getAllByRole('listitem')
    // The name carries the policy, so three build rows would be three controls.
    expect(within(rows[0]).getByRole('button', { name: /^Requeue Build/ })).toBeVisible()
    expect(within(rows[1]).queryByRole('button')).toBeNull()

    await userEvent.click(within(rows[0]).getByRole('button', { name: /^Requeue Build/ }))

    expect(vi.mocked(requeuePolicy)).toHaveBeenCalledWith({
      data: { projectId: REF.projectId, evaluationId: EVALUATION },
    })
  })

  it('says so on the row when Azure DevOps refuses the requeue', async () => {
    vi.mocked(requeuePolicy).mockResolvedValueOnce({
      ok: false,
      error: 'TF401027: You need the Contribute permission.',
      connected: true,
    })

    render(
      <PullRequestDetailView
        pr={detail({ policies: [policy({ id: '1', name: 'Build', requeueId: EVALUATION })] })}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /^Requeue Build/ }))

    expect(await screen.findByText(/You need the Contribute permission/)).toBeVisible()
    // And the button comes back, because the thing it asked for did not happen.
    expect(screen.getByRole('button', { name: /^Requeue Build/ })).toBeEnabled()
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
    const team = { id: 't1', displayName: '[Products]\\Contributors', avatarHref: null }
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

  it('offers to take a reviewer off, and takes them off when pressed', async () => {
    render(
      <PullRequestDetailView pr={detail({ reviewers: [reviewer({ id: 'rev-1', vote: 0 })] })} />,
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Take Naveen Angali off this pull request' }),
    )

    expect(vi.mocked(withdrawReviewer)).toHaveBeenCalledWith({
      data: { ...REF, reviewerId: 'rev-1', isRequired: false },
    })
  })

  it('will not offer to discard a vote, and says why it will not', () => {
    // `aria-disabled` and not `disabled`, `VoteControl`'s rule: the refusal is the
    // only thing here that explains why the row has no `×`, and a disabled button is
    // one a screen reader skips.
    render(<PullRequestDetailView pr={detail({ reviewers: [reviewer({ vote: 10 })] })} />)

    const refused = screen.getByRole('button', { name: /would discard their vote/ })
    expect(refused).toHaveAttribute('aria-disabled', 'true')
  })

  it('gives a team no control at all, rather than a refusal to press', () => {
    // Most reviewers on this org are containers, and a row of dead buttons down the
    // whole list would read as an app that is broken rather than one that is right.
    render(
      <PullRequestDetailView
        pr={detail({
          reviewers: [
            reviewer({ id: 'rev-1', displayName: '[Products]\\Contributors', isContainer: true }),
            reviewer({ id: 'rev-2', displayName: 'Naveen Angali' }),
          ],
        })}
      />,
    )

    expect(screen.getAllByRole('button', { name: /off this pull request/ })).toHaveLength(1)
  })

  it('neither adds nor removes on a pull request that is no longer being decided', () => {
    // `lifecycleAction`'s reasoning one section down: ADO would take both writes on a
    // completed pull request, and nobody would act on either.
    render(
      <PullRequestDetailView pr={detail({ status: 'completed', reviewers: [reviewer()] })} />,
    )

    expect(screen.queryByRole('button', { name: /off this pull request/ })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Ask somebody to review' }),
    ).not.toBeInTheDocument()
  })

  it('offers the picker on an active one, and reads no directory until it is pressed', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(screen.getByRole('button', { name: 'Ask somebody to review' })).toBeVisible()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
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

  it('owns up to searching none of the files, when none of them were fetched', async () => {
    // jsdom has no `IntersectionObserver`, so no panel here ever came near a
    // viewport and nothing is in the cache — which is the worst case the count
    // has to be honest about, and the one a browser's own find is silent on.
    await drawDiff({ pr: detail({ files }) })
    await userEvent.type(screen.getByRole('searchbox', { name: /^Find in/ }), 'sink')

    expect(screen.getByText('No matching lines · 3 of 3 files not searched')).toBeVisible()
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

  // One choice for the page like the layout, and held here rather than in the
  // route, which is the difference: the route owns the layout because
  // side-by-side widens the page, and `-w` changes nothing about its shape.
  it('offers one ignore-whitespace choice for the whole page', async () => {
    await drawDiff({ pr: detail({ files }) })

    const toggle = screen.getByRole('button', { name: 'Ignore whitespace' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-pressed', 'true')
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

  it('draws the underline under the active tab rather than showing it', async () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    const inkIn = (name: RegExp) =>
      screen.getByRole('tab', { name }).querySelector('.prof-tab__ink')

    // `pathLength="1"` is the contract between this path and the `prof-tab-ink`
    // keyframes: it normalises the curve to one unit, which is the only reason
    // `stroke-dasharray: 1` and an offset of `1` in the stylesheet describe an
    // undrawn stroke at any tab width. Drop it and the dash silently becomes a
    // one-pixel tick on a 72-pixel line. Asserted here even though jsdom loads no
    // stylesheet to run the animation itself, because this is the half of it that
    // lives in the markup.
    expect(inkIn(/Details/)?.querySelector('path')).toHaveAttribute('pathLength', '1')

    // The stroke's colour is deliberately not here: a `var()` in an SVG
    // presentation attribute resolves to nothing in every browser, so it lives in
    // `styles.css` where the theme rebinds it.
    expect(inkIn(/Details/)?.querySelector('path')).not.toHaveAttribute('stroke')

    // Exactly one, and the active tab's — the pen lifts and draws again under the
    // new word rather than sliding across, so two marks at once would mean two
    // tabs claiming to be current.
    await userEvent.click(screen.getByRole('tab', { name: /Combined/ }))
    expect(inkIn(/Details/)).toBeNull()
    expect(inkIn(/Combined/)).not.toBeNull()
    expect(document.querySelectorAll('.prof-tab__ink')).toHaveLength(1)

    // `aria-hidden`, because `aria-selected` on the tab already says this, and a
    // screen reader does not need the decoration twice.
    expect(inkIn(/Combined/)).toHaveAttribute('aria-hidden')
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

// ---------------------------------------------------------------------------

describe('PullRequestDetailView changes since my last review', () => {
  /** Three pushes, so the range this view asks for cannot be mistaken for `id - 1`. */
  const iterations: readonly Iteration[] = [
    ...ITERATIONS,
    { id: 3, subject: 'rebase on main', author: 'Paul DeVito', createdAt: '2026-07-22T00:00:00Z', reason: 'push' },
  ]

  const files = {
    iterationId: 3,
    iterations,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
    ],
  }

  /** `viewerId` on the page under test, and so the identity every signal below is attributed to. */
  const ME = 'author-1'

  const NOTHING: ThreadList = {
    threads: [],
    openCount: 0,
    doneCount: 0,
    systemCount: 0,
    botCount: 0,
    votes: [],
  }

  const empty = (): ThreadsResult => ({
    threads: NOTHING,
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })

  const voted = (at: string, vote = 10, voterId = ME): ThreadsResult => ({
    ...empty(),
    threads: { ...NOTHING, votes: [{ voterId, at, vote }] },
  })

  const commented = (at: string, authorId = ME): ThreadsResult => {
    const said: Thread = {
      id: 900,
      status: 'active',
      resolution: 'open',
      kind: 'human',
      publishedDate: at,
      lastUpdatedDate: null,
      isDeleted: false,
      context: null,
      iterationContext: null,
      comments: [
        {
          id: 1,
          parentCommentId: null,
          author: { id: authorId, displayName: 'Paul DeVito', uniqueName: null, imageUrl: null },
          content: 'the migration needs a rollback note',
          publishedDate: at,
          lastUpdatedDate: null,
          lastContentUpdatedDate: null,
          isDeleted: false,
          commentType: 'text',
          likedBy: [],
          mentions: {},
        },
      ],
      properties: {},
    }

    return { ...empty(), threads: { ...NOTHING, threads: [said], openCount: 1 } }
  }

  const asked = () => vi.mocked(iterationChangesQuery).mock.lastCall?.[0]?.data

  const openSince = async (conversation: ThreadsResult, pr = detail({ files })) => {
    vi.mocked(threadsQuery).mockResolvedValue(conversation)
    await drawDiff({ pr })
    await userEvent.click(screen.getByRole('tab', { name: 'Since my review' }))
  }

  beforeEach(() => {
    vi.mocked(iterationChangesQuery).mockClear()
  })

  // The mock is module-level and every describe below shares it, so a vote left
  // behind here would turn up in somebody else's conversation.
  afterEach(() => {
    vi.mocked(threadsQuery).mockResolvedValue(empty())
  })

  it('offers no such view on a pull request with one update', async () => {
    await drawDiff({ pr: detail({ files: { ...files, iterations: [ITERATIONS[0]!] } }) })

    expect(screen.queryByRole('tab', { name: 'Since my review' })).toBeNull()
  })

  it('asks for the range from the update that was head when I voted', async () => {
    await openSince(voted('2026-07-20T12:00:00Z'))

    const shown = within(await screen.findByRole('list', { name: 'Changed files' }))

    // Update 1 was head at midday on the 20th; update 3 is head now. Not `3` and
    // `2`, which is what "By update" already answers — the two pushes since I
    // approved are one question, and this is the only view that asks it.
    expect(asked()).toEqual({
      projectId: REF.projectId,
      repositoryId: REF.repositoryId,
      id: REF.id,
      iterationId: 3,
      compareTo: 1,
    })
    expect(shown.getByTitle('/src/only-in-update.ts')).toBeVisible()
    expect(shown.queryByTitle('/src/log.ts')).toBeNull()
  })

  it('says what it measured from, because a vote and a remark are not the same claim', async () => {
    await openSince(voted('2026-07-20T12:00:00Z'))

    expect(await screen.findByText(/^Since your approval on 20 July/)).toBeVisible()
  })

  it('measures from a comment when nobody voted, and says that is what it did', async () => {
    // Azure DevOps puts no date on `reviewers[].vote`, so the vote trail is the
    // only dated vote there is — and on a pull request nobody has voted on there
    // is no trail either. A comment is still someone having read the code.
    await openSince(commented('2026-07-21T12:00:00Z'))

    expect(await screen.findByText(/^Since your comment on 21 July/)).toBeVisible()
    expect(asked()).toMatchObject({ iterationId: 3, compareTo: 2 })
  })

  it('gives a reason rather than a date when I have never reviewed', async () => {
    await openSince(commented('2026-07-21T12:00:00Z', 'someone-else'))

    expect(
      await screen.findByText('You have not voted or commented here, so there is nothing to measure from.'),
    ).toBeVisible()
    // The wrong answer here is a range measured from somebody else's review, and
    // the second wrong answer is asking for one at all.
    expect(vi.mocked(iterationChangesQuery)).not.toHaveBeenCalled()
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull()
  })

  it('says nothing has been pushed, rather than showing an empty file list', async () => {
    await openSince(voted('2026-07-23T12:00:00Z'))

    expect(await screen.findByText(/^Nothing has been pushed since your approval on 23 July/)).toBeVisible()
    // `3` against `3` is a pair the server refuses, and it should never be asked
    // for: there is no range, and "no files" is not what the reader needs told.
    expect(vi.mocked(iterationChangesQuery)).not.toHaveBeenCalled()
  })

  it('says the range failed rather than falling back to the whole pull request', async () => {
    vi.mocked(iterationChangesQuery).mockResolvedValueOnce({
      changes: null,
      error: 'TF401019: The Git repository does not exist.',
    })
    await openSince(voted('2026-07-20T12:00:00Z'))

    expect(
      await screen.findByText(/Could not load the changes since your last review\./),
    ).toBeVisible()
    // `$compareTo=999` answers 200 with the complete combined diff, so a wrong
    // answer in this view wears the right label. Showing the combined list on a
    // failure would be doing that on purpose.
    expect(screen.queryByTitle('/src/log.ts')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

// The panel is `sonar/panel.test.tsx`'s subject. What these are about is the one
// thing it cannot do for itself: it sits on the details tab and the files it
// points at are on another one, so the tab strip has to move for a click on a
// finding to land anywhere.
describe('PullRequestDetailView Sonar', () => {
  const SONAR_FILES = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
    ],
  }

  const result = (over: Partial<SonarReportResult> = {}): SonarReportResult => ({
    report: {
      projects: [
        {
          projectKey: 'Profisee_utilities',
          pullRequest: '24698',
          dashboardUrl: 'https://sonarcloud.io/dashboard?id=Profisee_utilities&pullRequest=24698',
        },
      ],
      groups: [
        {
          rule: 'javascript:S4036',
          name: 'Searching OS commands in PATH is security-sensitive',
          severity: 'MEDIUM',
          findings: [
            {
              key: 'AY-1',
              rule: 'javascript:S4036',
              message: 'Make sure the "PATH" variable only contains fixed, unwriteable directories.',
              path: '/src/log.ts',
              textRange: { startLine: 12, endLine: 12, startOffset: 2, endOffset: 30 },
              status: 'OPEN',
              impacts: [{ softwareQuality: 'SECURITY', severity: 'MEDIUM' }],
              cleanCodeAttributeCategory: 'RESPONSIBLE',
              effort: '20min',
              tags: ['cwe'],
              url: 'https://sonarcloud.io/project/issues?id=Profisee_utilities&open=AY-1',
              transitions: ['accept', 'confirm', 'falsepositive'],
            },
          ],
        },
      ],
      gate: { status: 'OK', conditions: [] },
      failed: [],
      truncated: [],
    },
    rules: [],
    error: null,
    connected: true,
    rateLimit: null,
    ...over,
  })

  // jsdom implements no scrolling at all, so the panel optional-chains this and a
  // spy is the only way to see that the jump happened.
  let scrolled: Element['scrollIntoView'] & ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrolled = vi.fn<Element['scrollIntoView']>()
    Element.prototype.scrollIntoView = scrolled
  })

  it('shows nothing while the route has not answered', () => {
    render(<PullRequestDetailView pr={detail()} />)

    expect(screen.queryByRole('region', { name: 'Sonar' })).toBeNull()
  })

  it('shows nothing on a pull request with no SonarCloud status', () => {
    render(
      <PullRequestDetailView
        pr={detail()}
        sonar={result({
          report: { projects: [], groups: [], gate: null, failed: [], truncated: [] },
        })}
      />,
    )

    expect(screen.queryByRole('region', { name: 'Sonar' })).toBeNull()
  })

  // The one state only this side can name: the server reads no token until the
  // pull request has been shown to have a Sonar project, so `connected: false`
  // means this pull request is analysed and the credential is missing.
  it('names the missing credential rather than the findings', () => {
    render(
      <PullRequestDetailView
        pr={detail()}
        sonar={result({ report: null, connected: false, error: 'No SonarCloud token yet.' })}
      />,
    )

    expect(screen.getByText(/Add a token in connections/)).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Sonar' })).toBeNull()
  })

  it('says so when Sonar could not be read', () => {
    render(
      <PullRequestDetailView pr={detail()} sonar={result({ report: null, error: 'SonarCloud answered 503.' })} />,
    )

    expect(screen.getByText(/SonarCloud answered 503\./)).toBeVisible()
  })

  it('crosses to the diff when a finding is clicked', async () => {
    render(<PullRequestDetailView pr={detail({ files: SONAR_FILES })} sonar={result()} />)

    await userEvent.click(screen.getByRole('button', { name: /Searching OS commands/ }))
    await userEvent.click(screen.getByRole('button', { name: '/src/log.ts:12' }))

    // The tab moved, and the scroll waited for the file list rather than firing
    // into a panel that did not exist yet.
    expect(await screen.findByRole('list', { name: 'Changed files' })).toBeVisible()
    expect(scrolled).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

// The cards, the composer and the row model are their own tests. What this is
// about is the page: one read for both tabs, the threads ADO anchors to nothing
// having somewhere to live, and a write leaving with the context of whatever diff
// the reviewer was looking at when they wrote it.
describe('PullRequestDetailView conversation', () => {
  const comment = (over: Partial<Comment> = {}): Comment => ({
    id: 1,
    parentCommentId: null,
    author: {
      id: 'reviewer-1',
      displayName: 'Naveen Angali',
      uniqueName: 'naveen.angali@profisee.com',
      imageUrl: null,
    },
    content: 'this needs a null check',
    publishedDate: '2026-07-22T00:00:00Z',
    lastUpdatedDate: null,
    lastContentUpdatedDate: null,
    isDeleted: false,
    commentType: 'text',
    likedBy: [],
    mentions: {},
    ...over,
  })

  const thread = (over: Partial<Thread> = {}): Thread => ({
    id: 100,
    status: 'active',
    resolution: 'open',
    kind: 'human',
    publishedDate: '2026-07-22T00:00:00Z',
    lastUpdatedDate: null,
    isDeleted: false,
    context: null,
    iterationContext: null,
    comments: [comment()],
    properties: {},
    ...over,
  })

  /** A colleague's comment on a line of the one changed file below. */
  const onLine12 = (): Thread =>
    thread({
      id: 101,
      context: {
        filePath: '/src/log.ts',
        rightStart: { line: 12, offset: 1 },
        rightEnd: { line: 12, offset: 30 },
        leftStart: null,
        leftEnd: null,
      },
      comments: [comment({ id: 2, content: 'this loop is quadratic' })],
    })

  const said = (threads: readonly Thread[], over: Partial<ThreadsResult> = {}): ThreadsResult => ({
    threads: {
      threads,
      openCount: threads.filter((entry) => entry.resolution === 'open').length,
      doneCount: threads.filter((entry) => entry.resolution === 'done').length,
      systemCount: 0,
      botCount: 0,
      votes: [],
    },
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
    ...over,
  })

  const files = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
    ],
  }

  const wrote = () => vi.mocked(startThread).mock.lastCall?.[0]?.data

  beforeEach(() => {
    // `mockResolvedValue` and not `…Once`: the read is polled, and a second tick
    // finding an undefined answer would empty the conversation mid-test.
    vi.mocked(threadsQuery).mockResolvedValue(said([]))
    // Nothing in this file resets the mocks, so every render above this describe
    // has already asked for the conversation; the count below needs a clean slate.
    vi.mocked(threadsQuery).mockClear()
    vi.mocked(startThread).mockClear()
  })

  it('reads the conversation once for the whole page', async () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    expect(await screen.findByText('Nothing has been said about this pull request yet.')).toBeVisible()
    // One call for a page with a details tab and 1 file, and it would be one for
    // 294: the grouping by path happens on this side of the boundary.
    expect(vi.mocked(threadsQuery)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(threadsQuery).mock.lastCall?.[0]?.data).toEqual(REF)
  })

  it('renders the threads Azure DevOps anchors to nothing', async () => {
    vi.mocked(threadsQuery).mockResolvedValue(said([thread()]))
    render(<PullRequestDetailView pr={detail({ files })} />)

    // 44 of 56 sampled threads were these. `fileThreads` cannot place one, so
    // this section is the difference between reading them and losing them.
    expect(await screen.findByText('this needs a null check')).toBeVisible()
    expect(screen.getByText('Naveen Angali')).toBeVisible()
  })

  it('renders the threads that belong on a line, and not a count of them', async () => {
    vi.mocked(threadsQuery).mockResolvedValue(said([thread(), onLine12()]))
    render(<PullRequestDetailView pr={detail({ files })} />)

    // The bug a count cost us: live, every comment a colleague had left was
    // anchored to a line and every one of the reviewer's own was on the pull
    // request, so "1 more thread on lines in the diff" read as "you are the only
    // person who has ever commented here".
    expect(await screen.findByText('this loop is quadratic')).toBeVisible()
    expect(screen.getByRole('button', { name: '/src/log.ts:12' })).toBeVisible()
  })

  it('sends a click on an anchored thread to its file in the diff', async () => {
    vi.mocked(threadsQuery).mockResolvedValue(said([onLine12()]))
    render(<PullRequestDetailView pr={detail({ files })} />)

    await userEvent.click(await screen.findByRole('button', { name: '/src/log.ts:12' }))

    // Rendered here so it is not missed; still read on the line it is about,
    // which is the crossing `SonarPanel`'s findings already make.
    expect(await screen.findByRole('list', { name: 'Changed files' })).toBeVisible()
  })

  it('says what it left out rather than dropping it silently', async () => {
    vi.mocked(threadsQuery).mockResolvedValue({
      ...said([]),
      threads: { threads: [], openCount: 0, doneCount: 0, systemCount: 32, botCount: 3, votes: [] },
    })
    render(<PullRequestDetailView pr={detail({ files })} />)

    // 32 of 56 on the sampled pull request were ADO's own activity trail. Hidden,
    // because a vote and a push are not a conversation — but counted, because
    // "no comments" beside 35 threads is the wrong answer.
    expect(
      await screen.findByText(/32 Azure DevOps status updates and 3 from SonarCloud hidden\./),
    ).toBeVisible()
  })

  it('starts a thread on the pull request with no file and no iteration', async () => {
    render(<PullRequestDetailView pr={detail({ files })} />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Comment on this pull request' }),
    )
    await userEvent.type(
      screen.getByLabelText('New comment on this pull request'),
      'the migration needs a rollback note',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(wrote()).toEqual({
      ...REF,
      content: 'the migration needs a rollback note',
      // Both null on purpose: this is about the pull request, and either field
      // would anchor it to a file it is not about.
      context: null,
      iterationContext: null,
    })
  })

  it('writes a new file thread against the update being read', async () => {
    render(<PullRequestDetailView pr={detail({ files })} initialTab="update" />)
    // Two waits, as `drawDiff` does one: the viewed marks gate the list, and this
    // tab's files are a request of their own.
    await screen.findByRole('list', { name: 'Changed files' })

    // The update tab lands on the latest, so the pair is 1→2 — the same two
    // iterations `useChanges` asked ADO to diff. Without it the comment lands
    // against the latest iteration, and line 40 of update 2 is not line 40 of 5.
    await userEvent.click(
      await list().findByRole('button', { name: 'Comment on this file' }),
    )
    await userEvent.type(
      screen.getByLabelText('New comment on /src/only-in-update.ts'),
      'this file is new to this push',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(wrote()).toEqual({
      ...REF,
      content: 'this file is new to this push',
      context: {
        filePath: '/src/only-in-update.ts',
        rightStart: null,
        rightEnd: null,
        leftStart: null,
        leftEnd: null,
      },
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: 2,
        changeTrackingId: null,
      },
    })
  })

  it('hides resolved threads and says the list is not empty', async () => {
    vi.mocked(threadsQuery).mockResolvedValue(
      said([thread({ status: 'closed', resolution: 'done' })]),
    )
    render(<PullRequestDetailView pr={detail({ files })} />)

    // Stubbed rather than rendered, which is `ThreadCard`'s own rule: a resolved
    // thread stays where it is, one line tall, until somebody asks for it.
    expect(await screen.findByText(/Closed · 1 comment/)).toBeVisible()
    expect(screen.queryByText('this needs a null check')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Hide resolved' }))

    expect(screen.queryByText(/Closed · 1 comment/)).toBeNull()
    // Not "nothing has been said": the difference between a quiet pull request
    // and one whose conversation you have just hidden.
    expect(screen.getByText('Every thread on this pull request is resolved.')).toBeVisible()
  })

  it('costs the conversation and nothing else when the read fails', async () => {
    vi.mocked(threadsQuery).mockResolvedValue({
      threads: null,
      error: 'TF400813: The user is not authorized to access this resource.',
      connected: true,
      notFound: false,
      rateLimit: null,
    })
    await drawDiff({ pr: detail({ files }) })

    // T-023's third criterion, on the tab where it matters: the diff is still
    // there and still readable, with one sentence saying why it has no comments.
    expect(await screen.findByText(/Comments could not be read/)).toBeVisible()
    expect(list().getByTitle('/src/log.ts')).toBeVisible()
    expect(screen.getByText('0 of 1 read')).toBeVisible()
  })
})

// The two seams: a panel and a component that were both finished, tested, and not
// on screen. Everything about either one is tested where it lives — this is only
// about the wiring, which is the part that has no other test and the part that was
// missing for a whole round.
describe('PullRequestDetailView checks and avatars', () => {
  it('draws the checks panel on the details tab', async () => {
    render(<PullRequestDetailView pr={detail()} />)

    // Scoped to the region, because "Checks" as bare text would also be satisfied
    // by a heading with no panel under it. And awaited, because the panel owns its
    // own read: the first paint says "Reading the builds…", which is the seam
    // working — the panel is on screen and asking.
    const checks = within(screen.getByRole('region', { name: 'Checks' }))
    expect(checks.getByText('Reading the builds…')).toBeVisible()
    expect(await checks.findByText('No build policy has run on this pull request.')).toBeVisible()
  })

  it('loads the face when there is one, for the author and the reviewers alike', () => {
    // The credential-free form, which is the only one `Avatar` puts in the DOM.
    const author = 'https://dev.azure.com/Profisee/_apis/GraphProfile/MemberAvatars/aad.YXV0aG9y'
    const rev = 'https://dev.azure.com/Profisee/_apis/GraphProfile/MemberAvatars/aad.cmV2aWV3ZXI'

    const { container } = render(
      <PullRequestDetailView
        pr={detail({
          author: { id: 'author-1', displayName: 'Paul DeVito', avatarHref: author },
          reviewers: [reviewer({ avatarHref: rev })],
        })}
      />,
    )

    // Queried off the container and not by role: every avatar is `aria-hidden`
    // with an empty `alt`, on purpose — the name is already text beside it.
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      author,
      rev,
    ])
    // And the monogram is still under both of them, which is what makes a slow
    // avatar and a missing one look the same.
    expect(screen.getByText('PD')).toBeVisible()
    expect(screen.getByText('NA')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------

// The ordering is `review-stops.test.ts`'s subject. What these are about is the
// two things a keyboard has to get right before any of it can be trusted: every
// key is in the `?` sheet without anybody having listed it there a second time,
// and not one of them fires while somebody is typing into the page.
describe('PullRequestDetailView on the keyboard', () => {
  const files = {
    iterationId: 2,
    iterations: ITERATIONS,
    truncated: false,
    files: [
      { path: '/src/log.ts', changeType: ['edit'], originalPath: null, objectId: 'aa', originalObjectId: 'bb' },
      { path: '/src/sink.ts', changeType: ['edit'], originalPath: null, objectId: 'cc', originalObjectId: 'dd' },
      { path: '/src/new.ts', changeType: ['add'], originalPath: null, objectId: 'ee', originalObjectId: null },
    ],
  }

  /** The tree's order, which is the order every key here steps in. */
  const ORDER = ['/src/log.ts', '/src/new.ts', '/src/sink.ts']

  const onLine = (
    id: number,
    path: string,
    line: number,
    content: string,
    resolution: Thread['resolution'] = 'open',
  ): Thread => ({
    id,
    status: resolution === 'open' ? 'active' : 'closed',
    resolution,
    kind: 'human',
    publishedDate: '2026-07-22T00:00:00Z',
    lastUpdatedDate: null,
    isDeleted: false,
    context: {
      filePath: path,
      rightStart: { line, offset: 1 },
      rightEnd: { line, offset: 30 },
      leftStart: null,
      leftEnd: null,
    },
    iterationContext: null,
    comments: [
      {
        id,
        parentCommentId: null,
        author: {
          id: 'reviewer-1',
          displayName: 'Naveen Angali',
          uniqueName: 'naveen.angali@profisee.com',
          imageUrl: null,
        },
        content,
        publishedDate: '2026-07-22T00:00:00Z',
        lastUpdatedDate: null,
        lastContentUpdatedDate: null,
        isDeleted: false,
        commentType: 'text',
        likedBy: [],
        mentions: {},
      },
    ],
    properties: {},
  })

  const answered = (threads: readonly Thread[]): ThreadsResult => ({
    threads: {
      threads,
      openCount: threads.filter((entry) => entry.resolution === 'open').length,
      doneCount: threads.filter((entry) => entry.resolution === 'done').length,
      systemCount: 0,
      botCount: 0,
      votes: [],
    },
    error: null,
    connected: true,
    notFound: false,
    rateLimit: null,
  })

  const finding = (key: string, path: string, line: number): SonarFinding => ({
    key,
    rule: 'javascript:S4036',
    message: `Something about ${path}.`,
    path,
    textRange: { startLine: line, endLine: line, startOffset: 2, endOffset: 30 },
    status: 'OPEN',
    impacts: [{ softwareQuality: 'SECURITY', severity: 'MEDIUM' }],
    cleanCodeAttributeCategory: 'RESPONSIBLE',
    effort: '20min',
    tags: [],
    url: 'https://sonarcloud.io/project/issues?id=Profisee_utilities&open=AY-1',
    transitions: ['accept', 'confirm', 'falsepositive'],
  })

  const reported = (findings: readonly SonarFinding[]): SonarReportResult => ({
    report: {
      projects: [
        {
          projectKey: 'Profisee_utilities',
          pullRequest: '24698',
          dashboardUrl: 'https://sonarcloud.io/dashboard?id=Profisee_utilities',
        },
      ],
      groups: [
        {
          rule: 'javascript:S4036',
          name: 'Searching OS commands in PATH is security-sensitive',
          severity: 'MEDIUM',
          findings,
        },
      ],
      gate: { status: 'OK', conditions: [] },
      failed: [],
      truncated: [],
    },
    rules: [],
    error: null,
    connected: true,
    rateLimit: null,
  })

  const measured = Element.prototype.getBoundingClientRect

  /** Where each panel sits, since jsdom lays nothing out and answers zero for all of them. */
  let tops = new Map<string, number>()

  /** Put the window at the top of one file, with the rest of the panels above and below it. */
  function reading(path: string) {
    const at = ORDER.indexOf(path)
    tops = new Map(ORDER.map((other, index) => [fileAnchor(other), (index - at) * 600 + 8]))
  }

  /**
   * The panels the page is sent to, in the order it is sent to them.
   *
   * Assigned per element rather than on the prototype, so the array says which
   * file was jumped to and not merely that something was.
   */
  function jumps(): string[] {
    const went: string[] = []
    for (const path of ORDER) {
      const panel = document.getElementById(fileAnchor(path))
      if (panel !== null) {
        panel.scrollIntoView = () => {
          went.push(path)
        }
      }
    }
    return went
  }

  /** Every row of the `?` sheet, by the label the registry gave it. */
  function sheet(): Record<string, string | null> {
    return Object.fromEntries(
      [...document.querySelectorAll('[data-slot="shortcut"]')].map((row) => [
        row.querySelector('dt')?.textContent ?? '',
        row.getAttribute('data-bound'),
      ]),
    )
  }

  beforeEach(() => {
    tops = new Map()
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = tops.get(this.id)
      // Everything else keeps jsdom's own zeroes: React Aria measures elements
      // this file never places, and answering for those would be a lie of a
      // different kind.
      if (top === undefined) return measured.call(this)
      return { x: 0, y: top, top, bottom: top, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
    }
    vi.mocked(threadsQuery).mockResolvedValue(answered([]))
    vi.mocked(markViewed).mockClear()
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = measured
  })

  it('puts every review key in the ? sheet by being registered, not by being listed twice', async () => {
    // The point of the criterion: these labels are the registry's, so a command
    // bound some other way is one this assertion cannot find.
    await drawDiff({ pr: detail({ files }) })
    await userEvent.keyboard('?')
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    expect(sheet()).toMatchObject({
      'Next file': 'true',
      'Previous file': 'true',
      'Next unresolved thread': 'true',
      'Previous unresolved thread': 'true',
      'Mark this file read or unread': 'true',
      'Next Sonar finding': 'true',
      'Previous Sonar finding': 'true',
    })
  })

  it('dims them on a tab with no files to step through', async () => {
    render(<PullRequestDetailView pr={detail({ files })} />)
    await userEvent.keyboard('?')
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    // Still printed, because the sheet is the whole registry — and greyed, which
    // is the sheet's way of saying "not here".
    expect(sheet()).toMatchObject({
      'Next file': 'false',
      'Mark this file read or unread': 'false',
      'Next Sonar finding': 'false',
    })
  })

  it('sends ] to the next file and [ back to the one above', async () => {
    await drawDiff({ pr: detail({ files }) })
    reading('/src/log.ts')
    const went = jumps()

    await userEvent.keyboard(']')

    expect(went).toEqual(['/src/new.ts'])
    expect(screen.getByText('File 2 of 3, /src/new.ts.')).toBeInTheDocument()

    reading('/src/new.ts')
    // Doubled because user-event reads a bare `[` as the start of a key code.
    await userEvent.keyboard('[[')

    expect(went).toEqual(['/src/new.ts', '/src/log.ts'])
    expect(screen.getByText('File 1 of 3, /src/log.ts.')).toBeInTheDocument()
  })

  it('stops at the last file rather than starting over at the first', async () => {
    // The two lists below wrap and this one does not, on purpose: quietly
    // restarting at the top is how a reviewer comes to believe they have been
    // through every file in the change set.
    await drawDiff({ pr: detail({ files }) })
    reading('/src/sink.ts')
    const went = jumps()

    await userEvent.keyboard(']')

    expect(went).toEqual(['/src/sink.ts'])
    expect(screen.getByText('File 3 of 3, /src/sink.ts.')).toBeInTheDocument()
  })

  it('marks the file the window is on read, and unmarks it', async () => {
    // Local SQLite on the other side of `markViewed`, which is why this one key
    // records anything at all: nothing here reaches Azure DevOps.
    await drawDiff({ pr: detail({ files }) })
    reading('/src/sink.ts')

    await userEvent.keyboard('v')

    expect(await screen.findByText('1 of 3 read')).toBeVisible()
    expect(screen.getByText('/src/sink.ts marked read.')).toBeInTheDocument()
    expect(vi.mocked(markViewed).mock.lastCall?.[0]?.data).toMatchObject({
      path: '/src/sink.ts',
      objectId: 'cc',
      viewed: true,
    })

    await userEvent.keyboard('v')

    expect(await screen.findByText('0 of 3 read')).toBeVisible()
    expect(vi.mocked(markViewed).mock.lastCall?.[0]?.data).toMatchObject({ viewed: false })
  })

  it('steps n and p through the unresolved threads, in the order the files are drawn', async () => {
    vi.mocked(threadsQuery).mockResolvedValue(
      answered([
        onLine(101, '/src/sink.ts', 4, 'this reads the disposed handle'),
        onLine(102, '/src/log.ts', 12, 'this loop is quadratic'),
        onLine(103, '/src/log.ts', 3, 'nothing to do here', 'done'),
      ]),
    )
    await drawDiff({ pr: detail({ files }) })
    // No bytes were fetched, so the panels print their threads above the diff —
    // which is also the only sign on this tab that the poll has answered at all.
    await list().findByText('this loop is quadratic')
    const went = jumps()

    await userEvent.keyboard('n')
    expect(screen.getByText('Unresolved thread 1 of 2, /src/log.ts line 12.')).toBeInTheDocument()

    await userEvent.keyboard('n')
    expect(screen.getByText('Unresolved thread 2 of 2, /src/sink.ts line 4.')).toBeInTheDocument()

    // Wrapping, unlike the files: the resolved one on line 3 is not a stop, and
    // two of three threads is the whole of what the key promises.
    await userEvent.keyboard('n')
    expect(screen.getByText('Unresolved thread 1 of 2, /src/log.ts line 12.')).toBeInTheDocument()

    await userEvent.keyboard('p')
    expect(screen.getByText('Unresolved thread 2 of 2, /src/sink.ts line 4.')).toBeInTheDocument()
    expect(went).toEqual(['/src/log.ts', '/src/sink.ts', '/src/log.ts', '/src/sink.ts'])
  })

  it('says there is nowhere to go rather than doing nothing', async () => {
    await drawDiff({ pr: detail({ files }) })

    await userEvent.keyboard('n')

    // A key that silently does nothing is indistinguishable from a broken one.
    expect(screen.getByText('No unresolved threads in this diff.')).toBeInTheDocument()
  })

  it('steps through the Sonar findings this diff can actually show', async () => {
    await drawDiff({
      pr: detail({ files }),
      sonar: reported([
        finding('AY-1', '/src/log.ts', 12),
        // Not in the change set, so the panel offers no button for it and the
        // key must not stop on it either.
        finding('AY-2', '/src/untouched.ts', 3),
        finding('AY-3', '/src/sink.ts', 40),
      ]),
    })
    const went = jumps()

    await userEvent.keyboard('}')
    expect(screen.getByText('Sonar finding 1 of 2, /src/log.ts line 12.')).toBeInTheDocument()

    await userEvent.keyboard('}')
    expect(screen.getByText('Sonar finding 2 of 2, /src/sink.ts line 40.')).toBeInTheDocument()

    // Doubled for the same reason `[` is: user-event reads a bare `{` as the
    // start of a key name.
    await userEvent.keyboard('{{')
    expect(screen.getByText('Sonar finding 1 of 2, /src/log.ts line 12.')).toBeInTheDocument()
    expect(went).toEqual(['/src/log.ts', '/src/sink.ts', '/src/log.ts'])
  })

  it('holds every key while the reviewer is typing in the find box', async () => {
    await drawDiff({ pr: detail({ files }) })
    reading('/src/log.ts')
    const went = jumps()

    const box = screen.getByRole('searchbox', { name: /^Find in/ })
    await userEvent.type(box, 'nv]')

    expect(box).toHaveValue('nv]')
    expect(went).toEqual([])
    expect(vi.mocked(markViewed)).not.toHaveBeenCalled()
  })

  it('holds every key while the reviewer is typing a comment', async () => {
    // The real composer and not a bare `<input>`: what the guard has to
    // understand is a React Aria widget, and a search for `n` in a sentence
    // somebody is writing to a colleague is the worst way to find that out.
    await drawDiff({ pr: detail({ files }) })
    reading('/src/log.ts')
    const went = jumps()

    const [compose] = await list().findAllByRole('button', { name: 'Comment on this file' })
    await userEvent.click(compose as HTMLElement)
    const box = screen.getByLabelText('New comment on /src/log.ts')
    await userEvent.type(box, 'not every n is a shortcut]')

    expect(box).toHaveValue('not every n is a shortcut]')
    expect(went).toEqual([])
    expect(vi.mocked(markViewed)).not.toHaveBeenCalled()
    expect(screen.getByText('0 of 3 read')).toBeVisible()
  })
})
