import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as renderBare, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ReviewerPicker } from './reviewer-picker'
import { inviteReviewer } from '@/server/pull-request-fn'
import { directoryQuery } from '@/server/identity-fn'

import type { ReactElement, ReactNode } from 'react'
import type { DirectoryResult } from '@/server/identity-fn'
import type { PullRequestRef, Reviewer } from '@/server/pull-request'

// T-034. The field is a keyboard feature — `composer.test.tsx`' reason for the
// `@mention` picker, and the same list underneath — plus two things that are this
// component's alone: the directory must not be read until the button is pressed,
// and what leaves for ADO must be an identity GUID with `isRequired: false`.

/** `composer.test.tsx`' arrangement: eight `GET`s behind one server function. */
vi.mock('@/server/identity-fn', () => ({ directoryQuery: vi.fn() }))

vi.mock('@/server/pull-request-fn', () => ({
  inviteReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
  withdrawReviewer: vi.fn(async () => ({ ok: true, error: null, connected: true })),
}))

const REF: PullRequestRef = {
  projectId: '11111111-1111-1111-1111-111111111111',
  repositoryId: '22222222-2222-2222-2222-222222222222',
  id: 24698,
}

const JORDAN = 'fbfd3dd4-1a1a-4b4b-8c8c-0d0d0d0d0d0d'
const MARJORIE = 'aa11bb22-3c3c-4d4d-9e9e-5f5f5f5f5f5f'
const NAVEEN = 'cc33dd44-5e5e-6f6f-7a7a-8b8b8b8b8b8b'

const directory = (over: Partial<DirectoryResult> = {}): DirectoryResult => ({
  people: [
    {
      identityId: JORDAN,
      descriptor: 'aad.amFja3Nvbg',
      kind: 'user',
      displayName: 'Jordan Vincent',
      uniqueName: 'jordan.vincent@profisee.com',
      avatarHref: '',
    },
    {
      identityId: MARJORIE,
      descriptor: 'aad.bWFyam9yaWU',
      kind: 'user',
      displayName: 'Marjorie Chen',
      uniqueName: 'marjorie.chen@profisee.com',
      avatarHref: '',
    },
    {
      identityId: NAVEEN,
      descriptor: 'aad.bmF2ZWVu',
      kind: 'user',
      displayName: 'Naveen Rao',
      uniqueName: 'naveen.rao@profisee.com',
      avatarHref: '',
    },
  ],
  total: 3,
  complete: true,
  error: null,
  connected: true,
  rateLimit: null,
  ...over,
})

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  id: JORDAN,
  displayName: 'Jordan Vincent',
  vote: 0,
  isContainer: false,
  isRequired: false,
  votedFor: [],
  avatarHref: null,
  ...over,
})

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

const render = (ui: ReactElement) => renderBare(ui, { wrapper: Providers })

const picker = (reviewers: readonly Reviewer[] = []) =>
  render(<ReviewerPicker prRef={REF} reviewers={reviewers} />)

const ask = () => screen.getByRole('button', { name: 'Ask somebody to review' })
const field = () => screen.getByRole('combobox', { name: 'Ask somebody to review' })

/**
 * The names on offer, in order.
 *
 * `:not([aria-hidden])` because the avatar is the option's first span and holds the
 * monogram — `JV` is not what is being offered, and it is hidden from the
 * accessibility tree for exactly that reason.
 */
const names = () =>
  screen
    .getAllByRole('option')
    .map((option) => option.querySelector('span:not([aria-hidden])')?.textContent)

/** The list, once the directory has arrived. */
const offered = async () => {
  await screen.findByRole('option', { name: /Jordan Vincent/ })

  return names()
}

beforeEach(() => {
  // Reset rather than re-stubbed, `composer.test.tsx`' reason: the first test below
  // asserts the directory is *not* asked for, and a call carried over from another
  // test would make it pass or fail depending on where in the file it sits.
  vi.mocked(directoryQuery).mockReset()
  vi.mocked(directoryQuery).mockResolvedValue(directory())
  vi.mocked(inviteReviewer).mockClear()
})

describe('ReviewerPicker', () => {
  it('reads nothing until the button is pressed', async () => {
    // The whole reason the field is a separate component: the directory is eight
    // calls and about 450 KB, and most visits to a pull request never add anybody.
    picker()

    expect(ask()).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(vi.mocked(directoryQuery)).not.toHaveBeenCalled()

    await userEvent.click(ask())

    await waitFor(() => expect(vi.mocked(directoryQuery)).toHaveBeenCalledTimes(1))
    expect(field()).toHaveFocus()
  })

  it('offers everybody in the organisation before anything is typed', async () => {
    picker()
    await userEvent.click(ask())

    // An empty query is the top of the alphabet, not an empty list: pressing the
    // button is itself a request to be shown who is there.
    expect(await offered()).toEqual(['Jordan Vincent', 'Marjorie Chen', 'Naveen Rao'])
  })

  it('does not offer somebody who is already a reviewer', async () => {
    picker([reviewer()])
    await userEvent.click(ask())

    await screen.findByRole('option', { name: /Marjorie Chen/ })
    expect(screen.queryByRole('option', { name: /Jordan Vincent/ })).not.toBeInTheDocument()
  })

  it('matches a surname, which is what the local list is for', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'vincent')

    // `subjectquery` finds nobody for this — it matches a prefix of the whole
    // display name — so a field driven by ADO's own search could not do it.
    expect(names()).toEqual(['Jordan Vincent'])
  })

  it('matches a mail address too', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'naveen.rao@')

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Naveen Rao/ })).toBeInTheDocument()
  })

  it('sends the identity id and never asks for a required reviewer', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'marjorie{Enter}')

    // `isRequired: false` pinned, not merely present: a required reviewer is a merge
    // gate, and this list must not put one up on the same `Enter` that picks a name.
    expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
      data: { ...REF, reviewerId: MARJORIE, isRequired: false },
    })
  })

  it('walks the list with the arrow keys and wraps around', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    const active = () =>
      screen
        .getAllByRole('option')
        .find((option) => option.getAttribute('aria-selected') === 'true')?.textContent

    expect(active()).toContain('Jordan Vincent')

    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(active()).toContain('Naveen Rao')

    // Wrapping rather than stopping, so holding the key never leaves the highlight
    // parked on the last row.
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toContain('Jordan Vincent')

    await userEvent.keyboard('{ArrowUp}')
    expect(active()).toContain('Naveen Rao')

    await userEvent.keyboard('{Enter}')
    expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
      data: { ...REF, reviewerId: NAVEEN, isRequired: false },
    })
  })

  it('picks with Tab as well as Enter', async () => {
    // The composer's picker takes Tab for the same reason: it is what a person who
    // has used any other completion field will reach for.
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.keyboard('{Tab}')

    expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
      data: { ...REF, reviewerId: JORDAN, isRequired: false },
    })
  })

  it('picks with the mouse', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.click(screen.getByRole('option', { name: /Naveen Rao/ }))

    expect(vi.mocked(inviteReviewer)).toHaveBeenCalledWith({
      data: { ...REF, reviewerId: NAVEEN, isRequired: false },
    })
  })

  it('stays open after an add, and clears what was typed', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'naveen{Enter}')

    // "Who else has not seen this" is usually more than one person, so the field
    // stays. Nothing is drawn optimistically — the row appears when the re-read
    // says it is there.
    expect(field()).toHaveValue('')
    expect(field()).toBeInTheDocument()
  })

  it('closes on Escape without taking the page with it', async () => {
    // Escape at the shell is `nav.back`, so this handler stops the event as well as
    // preventing it. A field that closed the pull request on the way out would be
    // worse than one with no Escape at all.
    const away = vi.fn()
    render(
      <div onKeyDown={away}>
        <ReviewerPicker prRef={REF} reviewers={[]} />
      </div>,
    )

    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(ask()).toBeInTheDocument()
    expect(away).not.toHaveBeenCalled()
  })

  it('closes when Done is pressed', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('names who it is waiting on', async () => {
    let land: (result: { ok: boolean; error: string | null; connected: boolean }) => void = () => {}
    vi.mocked(inviteReviewer).mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve
      }),
    )

    picker()
    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Enter}')

    await screen.findByText('Asking Jordan Vincent…')

    land({ ok: true, error: null, connected: true })
    await waitFor(() =>
      expect(screen.queryByText('Asking Jordan Vincent…')).not.toBeInTheDocument(),
    )
  })

  it('says what Azure DevOps said, and lets it be dismissed', async () => {
    vi.mocked(inviteReviewer).mockResolvedValueOnce({
      ok: false,
      error: 'Azure DevOps answered 403. (TF401027: You need the Contribute permission.)',
      connected: true,
    })

    picker()
    await userEvent.click(ask())
    await offered()
    await userEvent.keyboard('{Enter}')

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent('Azure DevOps did not add them:')
    expect(refusal).toHaveTextContent('TF401027')

    // Dismissable because the field stays open across several adds, and a refusal
    // from two people ago sitting under it reads as this person's.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so while the directory is still being read', async () => {
    vi.mocked(directoryQuery).mockReturnValueOnce(new Promise(() => {}))

    picker()
    await userEvent.click(ask())

    expect(await screen.findByText('Looking up who is in the organisation…')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('repeats the directorys own failure rather than showing an empty list', async () => {
    vi.mocked(directoryQuery).mockResolvedValue(
      directory({ people: [], total: 0, error: 'Azure DevOps answered 401.', connected: true }),
    )

    picker()
    await userEvent.click(ask())

    expect(await screen.findByText('Azure DevOps answered 401.')).toBeInTheDocument()
  })

  it('admits when the list may be short, and when people were lost', async () => {
    // The two admissions `DirectoryResult` exists to make. The person typing is the
    // only one who can tell that the colleague they wanted is missing.
    vi.mocked(directoryQuery).mockResolvedValue(directory({ complete: false, total: 5 }))

    picker()
    await userEvent.click(ask())
    await offered()

    expect(
      screen.getByText('Azure DevOps returned a full page of people, so this list may be short.'),
    ).toBeInTheDocument()
    expect(screen.getByText('2 of 5 people could not be looked up.')).toBeInTheDocument()
  })

  it('says nobody matches, rather than leaving the list blank', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'zzz')

    expect(await screen.findByText('Nobody matches “zzz”.')).toBeInTheDocument()
  })

  it('says when everybody is already on the pull request', async () => {
    picker([reviewer(), reviewer({ id: MARJORIE }), reviewer({ id: NAVEEN })])
    await userEvent.click(ask())

    expect(await screen.findByText('Everybody in the list is already on this.')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('does nothing on Enter when there is nobody to pick', async () => {
    picker()
    await userEvent.click(ask())
    await offered()

    await userEvent.type(field(), 'zzz{Enter}')

    expect(vi.mocked(inviteReviewer)).not.toHaveBeenCalled()
    expect(field()).toHaveValue('zzz')
  })
})
