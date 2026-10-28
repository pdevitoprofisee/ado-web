import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as renderReact, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MergeDialog } from './merge-dialog'
import { pullRequestQuery, squashMerge } from '@/server/pull-request-fn'

import type { ReactNode } from 'react'
import type { AddressableRow } from './pr-list'
import type { Policy, PullRequestDetail, Reviewer } from '@/server/pull-request'
import type { PullRequestDetailResult } from '@/server/pull-request-fn'

// The write is mocked for the reason `pr-detail.test.tsx` records: this is the one
// call in the app that would complete a real pull request, so the module must not
// reach a bundle that could send it. `requeuePolicy` rides along because
// `lib/requeue.ts` — where the query key lives — closes over it.
vi.mock('@/server/pull-request-fn', () => ({
  pullRequestQuery: vi.fn(),
  squashMerge: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  requeuePolicy: vi.fn(),
}))

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const SOURCE_TIP = '4f3c9a1b2d7e5068c1a4b39f7e2d05c8a6b1f394'

/**
 * The description as the *list* endpoint sends it: 400 characters, cut where the
 * count ran out. A body prefilled from this is a commit missing its end, which is
 * the reason the dialog reads the pull request instead.
 */
const TRUNCATED = `${'a'.repeat(390)}the sen`

const row = (over: Partial<AddressableRow> = {}): AddressableRow => ({
  id: 3302,
  title: 'disable sql auditing',
  description: TRUNCATED,
  project: 'SaaS',
  repository: 'PC.IAC.Modules',
  author: 'Naveen Angali',
  targetBranch: 'main',
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  commitId: 'abc123',
  url: 'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
  viaTeam: null,
  projectId: PROJECT,
  repositoryId: REPOSITORY,
  conflicted: false,
  myVote: 0,
  reviewers: [],
  closed: null,
  ...over,
})

const detail = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  id: 3302,
  title: 'disable sql auditing',
  description: `${TRUNCATED}tence the list cut off`,
  author: { id: 'author-1', displayName: 'Naveen Angali', avatarHref: null },
  createdAt: '2026-07-20T00:00:00Z',
  isDraft: false,
  status: 'active',
  sourceBranch: 'refs/heads/feature/no-auditing',
  targetBranch: 'refs/heads/main',
  merge: { status: 'succeeded', conflicted: false, conflicts: [] },
  lastMergeSourceCommit: SOURCE_TIP,
  reviewers: [],
  policies: [],
  commits: [],
  files: { files: [], iterationId: 1, iterations: [], truncated: false },
  project: 'SaaS',
  repository: 'PC.IAC.Modules',
  url: 'https://dev.azure.com/Profisee/SaaS/_git/PC.IAC.Modules/pullrequest/3302',
  viewerId: 'me',
  approvalReset: null,
  errors: { policies: null, commits: null, files: null, conflicts: null },
  ...over,
})

/** A policy in the one state that refuses a merge: required, and not satisfied. */
const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 'cfg-1',
  name: 'Build',
  status: 'queued',
  blocking: true,
  detail: null,
  url: null,
  waitsOnPeople: false,
  clearedBySquash: false,
  requeueId: null,
  ...over,
})

/** Required, and no vote yet — the refusal that never shows up as a policy row. */
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

const read = (over: Partial<PullRequestDetailResult> = {}): PullRequestDetailResult => ({
  pullRequest: detail(),
  error: null,
  connected: true,
  notFound: false,
  failed: { policies: false, commits: false, files: false },
  rateLimit: null,
  ...over,
})

/**
 * The dialog as the inbox holds it: mounted whether or not a row is chosen, and
 * closing means the page stopped passing one.
 *
 * A harness rather than the component alone, because two of the things worth
 * testing here are about the page around it — that a dismissal does not throw
 * away a typed message, and that a merge reports the row it merged.
 */
function Table({ onMerged = vi.fn() }: { onMerged?: (row: AddressableRow) => void }) {
  const [open, setOpen] = useState<AddressableRow | null>(row())

  return (
    <>
      <button type="button" onClick={() => setOpen(row())}>
        Reopen
      </button>
      <MergeDialog
        row={open}
        onClose={() => setOpen(null)}
        onMerged={(merged) => {
          setOpen(null)
          onMerged(merged)
        }}
      />
    </>
  )
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  )
}

const render = (ui: ReactNode) => renderReact(ui, { wrapper: Providers })

const dialog = () => within(screen.getByRole('dialog'))
const subject = () => dialog().getByRole('textbox', { name: 'Merge commit message' })
const body = () => dialog().getByRole('textbox', { name: 'Description' })
const confirm = () => dialog().getByRole('button', { name: 'Squash and merge' })

/** Waits for the read, which every test but the pending one is downstream of. */
const opened = async () => {
  await screen.findByRole('textbox', { name: 'Merge commit message' })
}

/** Replaces what a field holds, the way somebody retyping it would. */
const retype = async (field: HTMLElement, text: string) => {
  await userEvent.clear(field)
  if (text !== '') await userEvent.type(field, text)
}

describe('MergeDialog', () => {
  beforeEach(() => {
    vi.mocked(pullRequestQuery).mockReset()
    vi.mocked(pullRequestQuery).mockResolvedValue(read())
    vi.mocked(squashMerge).mockReset()
    vi.mocked(squashMerge).mockResolvedValue({ ok: true, error: null, connected: true })
  })

  it('draws nothing until a row is chosen', () => {
    render(<MergeDialog row={null} onClose={vi.fn()} onMerged={vi.fn()} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pullRequestQuery).not.toHaveBeenCalled()
  })

  it('names the pull request before the read lands', async () => {
    render(<Table />)

    // From the row, so the confirmation says what it is about immediately. A
    // dialog that does not is a dialog people click through.
    expect(screen.getByRole('dialog')).toHaveTextContent('!3302 disable sql auditing')
    expect(screen.getByText('Reading', { exact: false })).toBeVisible()
    await opened()
  })

  it('offers the title and the description, past the 400 characters the table holds', async () => {
    render(<Table />)
    await opened()

    expect(pullRequestQuery).toHaveBeenCalledWith({
      data: { projectId: PROJECT, repositoryId: REPOSITORY, id: 3302 },
    })
    expect(subject()).toHaveValue('disable sql auditing')
    // The whole description, not the row's copy of it.
    expect(body()).toHaveValue(`${TRUNCATED}tence the list cut off`)
  })

  it('says what would be merged, in branches rather than refs', async () => {
    render(<Table />)
    await opened()

    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveTextContent(
      'Every commit on feature/no-auditing becomes one commit on main',
    )
    expect(sheet).toHaveTextContent('cannot be undone')
    expect(sheet).not.toHaveTextContent('refs/heads')
  })

  it('sends the tip it read and the message as it was edited', async () => {
    render(<Table />)
    await opened()

    await retype(subject(), 'chore: turn sql auditing off')
    await retype(body(), 'the shared server does not need it')
    await userEvent.click(confirm())

    // The sha is the guard, not decoration: without it ADO would merge whatever
    // the branch has grown since this dialog was opened.
    await waitFor(() =>
      expect(squashMerge).toHaveBeenCalledWith({
        data: {
          projectId: PROJECT,
          repositoryId: REPOSITORY,
          id: 3302,
          lastMergeSourceCommit: SOURCE_TIP,
          commitMessage: 'chore: turn sql auditing off\n\nthe shared server does not need it',
          // Nothing was in the way, so nothing is overridden. The flag follows
          // the refusal, never the preference.
          bypassPolicy: false,
        },
      }),
    )
  })

  it('offers no override when nothing is refusing the merge', async () => {
    render(<Table />)
    await opened()

    // A box that would change nothing is a box that says the wrong thing about
    // what this merge does.
    expect(dialog().queryByRole('checkbox')).toBeNull()
  })

  it('overrides a blocking policy once the box is ticked, and says so before merging', async () => {
    vi.mocked(pullRequestQuery).mockResolvedValue(
      read({ pullRequest: detail({ policies: [policy({ blocking: true })] }) }),
    )
    render(<Table />)
    // Not `opened`: the merge is blocked until the box is ticked, so the message
    // fields the helper waits for are not drawn yet.
    const box = await screen.findByRole('checkbox', {
      name: /Override branch policies and enable merge/,
    })
    expect(box).not.toBeChecked()

    await userEvent.click(box)
    await opened()

    // The dialog says which rule is being broken, not only that one is.
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The branch policies are overridden: One blocking policy is not satisfied yet.',
    )
    expect(screen.getByRole('dialog')).not.toHaveTextContent('no policy is bypassed')

    await userEvent.click(confirm())

    await waitFor(() =>
      expect(squashMerge).toHaveBeenCalledWith({
        data: expect.objectContaining({ bypassPolicy: true }),
      }),
    )
  })

  it('leaves the merge blocked while the override is untouched', async () => {
    vi.mocked(pullRequestQuery).mockResolvedValue(
      read({ pullRequest: detail({ reviewers: [reviewer({ displayName: 'Patrick Mize' })] }) }),
    )
    render(<Table />)

    expect(
      await screen.findByRole('checkbox', { name: /Override branch policies and enable merge/ }),
    ).not.toBeChecked()
    expect(confirm()).toBeDisabled()
    expect(confirm()).toHaveAccessibleDescription(
      /Patrick Mize is a required reviewer and has not approved\./,
    )
    expect(squashMerge).not.toHaveBeenCalled()
  })

  it('tells the table which row it merged, once Azure DevOps accepted it', async () => {
    const onMerged = vi.fn()
    render(<Table onMerged={onMerged} />)
    await opened()

    await userEvent.click(confirm())

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(expect.objectContaining({ id: 3302 })))
    // The row leaves the table, so the dialog about it closes.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers no message at all while the merge is blocked, and says why', async () => {
    vi.mocked(pullRequestQuery).mockResolvedValue(read({ pullRequest: detail({ isDraft: true }) }))
    render(<Table />)

    // A field that invites a commit message on a pull request ADO will not take
    // offers something that cannot happen.
    const blocked = await screen.findByText(
      'This is a draft. Publish it before merging.',
    )
    expect(blocked).toBeVisible()
    expect(dialog().queryByRole('textbox')).toBeNull()
    expect(confirm()).toBeDisabled()
    expect(confirm()).toHaveAccessibleDescription(
      'This is a draft. Publish it before merging.',
    )
  })

  it('will not merge with no commit message, and says which line is missing', async () => {
    render(<Table />)
    await opened()

    await retype(subject(), '')

    expect(confirm()).toBeDisabled()
    expect(confirm()).toHaveAccessibleDescription(
      'A commit needs a message. Write its first line above.',
    )
    expect(squashMerge).not.toHaveBeenCalled()
  })

  it('says a refusal in Azure DevOps own words, and stays open with the message typed', async () => {
    vi.mocked(squashMerge).mockResolvedValue({
      ok: false,
      error: 'TF401028: The pull request cannot be completed: the source branch has been updated.',
      connected: true,
    })
    render(<Table />)
    await opened()

    await retype(subject(), 'chore: turn sql auditing off')
    await userEvent.click(confirm())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not merge it: TF401028: The pull request cannot be completed: the source branch has been updated.',
    )
    // Still standing, because the refusal is the reason the reviewer pressed it —
    // and often the moment they want to reword the message.
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(subject()).toHaveValue('chore: turn sql auditing off')
  })

  it('merges nothing when the dialog is dismissed, and keeps what was typed', async () => {
    render(<Table />)
    await opened()

    await retype(body(), 'the shared server does not need it')
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(squashMerge).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    // Escape and Cancel are the way out of a confirmation, not the delete key for
    // a paragraph somebody just wrote.
    await opened()
    expect(body()).toHaveValue('the shared server does not need it')
  })

  it('says the pull request could not be read, rather than offering a merge', async () => {
    vi.mocked(pullRequestQuery).mockResolvedValue(
      read({ pullRequest: null, connected: false, error: 'No Azure DevOps token is stored.' }),
    )
    render(<Table />)

    expect(
      await screen.findByText('There is no Azure DevOps token yet, so this pull request could not be read.'),
    ).toBeVisible()
    expect(dialog().queryByRole('textbox')).toBeNull()
    expect(confirm()).toBeDisabled()
  })

  it('says so when Azure DevOps does not have the pull request any more', async () => {
    vi.mocked(pullRequestQuery).mockResolvedValue(
      read({ pullRequest: null, notFound: true, error: 'Azure DevOps answered 404.' }),
    )
    render(<Table />)

    expect(
      await screen.findByText('Azure DevOps does not have a pull request !3302 here any more.'),
    ).toBeVisible()
    // One sentence, not two: a 404 is the reason, so the raw answer beside it
    // would say the same thing twice.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Azure DevOps did not answer')
  })
})
