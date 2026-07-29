import { render as renderBare, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from './composer'
import { directoryQuery } from '@/server/identity-fn'

import type { ReactElement, ReactNode } from 'react'
import type { DirectoryResult } from '@/server/identity-fn'

// T-026. The three things a composer has to get right: the preview has to match
// what will be posted, the keys have to work, and a failed submit must not eat
// the paragraph.
//
// T-035 added a fourth: the `@mention` picker, which is a keyboard feature first.
// Everything below `mentions` is a key, because a picker that only answers a
// mouse is a picker half the reviewers on this team cannot use.

/**
 * The directory is eight `GET`s on the other side of a server function. Mocked to
 * `DirectoryResult`'s own shape, with **lower-cased** identity ids on purpose:
 * ADO stores a mention as `@<UPPERCASE-GUID>` and renders nothing for any other
 * case, so a test whose fixture was already upper case would pass whether the
 * composer upper-cased or not.
 */
vi.mock('@/server/identity-fn', () => ({ directoryQuery: vi.fn() }))

const JORDAN = 'fbfd3dd4-1a1a-4b4b-8c8c-0d0d0d0d0d0d'
const MARJORIE = 'aa11bb22-3c3c-4d4d-9e9e-5f5f5f5f5f5f'

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
  ],
  total: 2,
  complete: true,
  error: null,
  connected: true,
  rateLimit: null,
  ...over,
})

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

const box = () => screen.getByRole('textbox', { name: 'Comment' })

/** The list, once the directory has arrived. */
const options = async () => {
  await screen.findByRole('option', { name: /Jordan Vincent/ })

  // The name of the option is the display name and the mail address together, so
  // the first span is what is actually being offered.
  return screen.getAllByRole('option').map((option) => option.querySelector('span')?.textContent)
}

beforeEach(() => {
  // Reset and not just re-stubbed: two of these tests assert that the directory is
  // *not* asked for, and a call count carried over from the test above would make
  // them pass or fail depending on where in the file they sit.
  vi.mocked(directoryQuery).mockReset()
  vi.mocked(directoryQuery).mockResolvedValue(directory())
})

describe('Composer', () => {
  it('sends what was typed and clears itself once it lands', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'This needs a null check.')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(onSubmit).toHaveBeenCalledWith('This needs a null check.')
    expect(box()).toHaveValue('')
  })

  it('will not send whitespace', async () => {
    // `Markdown` renders nothing for it either, so a blank comment would be a
    // comment with no body and no way to fix it.
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()

    await userEvent.type(box(), '   \n  ')

    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps every character when the submit fails, and says why', async () => {
    // The worst outcome available to this component is losing a paragraph to a
    // 503, so the text stays and the same button is the retry.
    const onSubmit = vi.fn().mockRejectedValue(new Error('Azure DevOps answered 503.'))
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'A long and considered review.')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Azure DevOps answered 503.')
    expect(box()).toHaveValue('A long and considered review.')

    onSubmit.mockResolvedValue(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(onSubmit).toHaveBeenLastCalledWith('A long and considered review.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says something even when what rejected was not an Error', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn().mockRejectedValue('nope')} />)

    await userEvent.type(box(), 'text')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps did not take that comment.',
    )
  })

  it('submits on Ctrl+Enter and on Cmd+Enter', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'ctrl')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).toHaveBeenLastCalledWith('ctrl')

    await userEvent.type(box(), 'meta')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenLastCalledWith('meta')
  })

  it('leaves a bare Enter alone, because a comment has paragraphs in it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'first{Enter}second')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(box()).toHaveValue('first\nsecond')
  })

  it('abandons the draft on Escape, and does not let the shell hear it', async () => {
    // `nav.back` is bound to Escape at the shell. Abandoning a draft must not
    // also go back a page.
    const onCancel = vi.fn()
    const heard = vi.fn()
    render(
      <div onKeyDown={heard}>
        <Composer label="Comment" onSubmit={vi.fn()} onCancel={onCancel} />
      </div>,
    )

    box().focus()
    await userEvent.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
  })

  it('has nothing to cancel when nobody is listening for it', async () => {
    const heard = vi.fn()
    render(
      <div onKeyDown={heard}>
        <Composer label="Comment" onSubmit={vi.fn()} />
      </div>,
    )

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

    box().focus()
    await userEvent.keyboard('{Escape}')

    // Not swallowed either: an Escape this composer has no use for belongs to
    // whatever is above it.
    expect(heard).toHaveBeenCalled()
  })

  it('previews through the same renderer that will render the comment', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '- one{Enter}- two')
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two'])
    // The textarea is gone, not hidden, so there is one source of truth for the text.
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument()
  })

  it('escapes HTML in the preview, exactly as the comment will', async () => {
    // `rehype-raw` is deliberately not installed. A preview that parsed markup
    // the comment will escape would be a preview that lies.
    const { container } = render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '<script>alert(1)</script>')
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(container.querySelector('script')).toBeNull()
    expect(container).toHaveTextContent('<script>alert(1)</script>')
  })

  it('has something to say about an empty preview', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument()
  })

  it('starts from the text an edit is editing', () => {
    render(
      <Composer
        label="Comment"
        initial="The original wording."
        submitLabel="Save"
        onSubmit={vi.fn()}
      />,
    )

    expect(box()).toHaveValue('The original wording.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('offers no way to double-submit while a submit is in flight', async () => {
    let settle = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    render(<Composer label="Comment" onSubmit={onSubmit} onCancel={vi.fn()} />)

    await userEvent.type(box(), 'once')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).toHaveBeenCalledTimes(1)

    settle()
    expect(await screen.findByRole('button', { name: 'Comment' })).toBeInTheDocument()
  })
})

describe('Composer mentions', () => {
  it('asks for nobody until an @ is typed', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), 'this looks fine to me')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // The whole reason the picker is a separate component that mounts late: a page
    // of open reply boxes must not be eight identity calls each.
    expect(directoryQuery).not.toHaveBeenCalled()

    await userEvent.type(box(), ' @')

    expect(await options()).toEqual(['Jordan Vincent', 'Marjorie Chen'])
    expect(directoryQuery).toHaveBeenCalledTimes(1)
  })

  it('narrows on a surname, which is the reason the directory is local', async () => {
    // `subjectquery` matches a prefix of the whole display name, so Azure DevOps
    // finds Jordan Vincent 0 times for `vincent`. This list does not.
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), 'cc @vincent')

    expect(await options()).toEqual(['Jordan Vincent'])
  })

  it('does not fire on an @ in the middle of a word', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), 'mail jordan@profisee')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(directoryQuery).not.toHaveBeenCalled()
  })

  it('arrows to a person and commits on Enter, in the upper case ADO stores', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'cc @')
    await options()

    // Down once from the top of the list, so this asserts the arrow moved rather
    // than that Enter took the first row.
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /Marjorie Chen/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await userEvent.keyboard('{Enter}')

    // Upper case, and no newline: the Enter that chose somebody is not also a line
    // break. A lower-cased GUID would post fine and render as literal text in ADO.
    expect(box()).toHaveValue(`cc @<${MARJORIE.toUpperCase()}>`)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('wraps the arrows around the ends of the list', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@')
    await options()

    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { name: /Marjorie Chen/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('commits on Tab without letting focus leave the composer', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@jor')
    await options()
    await userEvent.keyboard('{Tab}')

    expect(box()).toHaveValue(`@<${JORDAN.toUpperCase()}>`)
    expect(box()).toHaveFocus()
  })

  it('commits on a click, and the mousedown does not blur the textarea', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@')
    await options()
    await userEvent.click(screen.getByRole('option', { name: /Jordan Vincent/ }))

    expect(box()).toHaveValue(`@<${JORDAN.toUpperCase()}>`)
  })

  it('puts the caret after the mention, not at the end of the box', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), 'end')
    await userEvent.keyboard('{Home}@jor')
    await options()
    await userEvent.keyboard('{Enter}!')

    // Typed straight after committing, so where the `!` landed is where the caret
    // was: after the closing `>`, and not after the text the mention was put in
    // front of.
    expect(box()).toHaveValue(`@<${JORDAN.toUpperCase()}>!end`)
  })

  it('keeps Ctrl+Enter as submit while the list is open', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<Composer label="Comment" onSubmit={onSubmit} />)

    await userEvent.type(box(), 'cc @jor')
    await options()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(onSubmit).toHaveBeenCalledWith('cc @jor')
  })

  it('closes the list on Escape without abandoning the draft', async () => {
    const onCancel = vi.fn()
    render(<Composer label="Comment" onSubmit={vi.fn()} onCancel={onCancel} />)

    await userEvent.type(box(), 'cc @jor')
    await options()
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box()).toHaveValue('cc @jor')
    expect(onCancel).not.toHaveBeenCalled()

    // The `@` somebody escaped out of is still in the text and still matches, so
    // this is the test that the dismissal is remembered rather than recomputed.
    await userEvent.type(box(), 'd')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // A second Escape has nothing left to close and abandons the draft, which is
    // what Escape means to a composer.
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('reopens for the next @, having only dismissed the one Escape was for', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} onCancel={vi.fn()} />)

    await userEvent.type(box(), 'cc @jor')
    await options()
    await userEvent.keyboard('{Escape}')
    await userEvent.type(box(), ' and @')

    expect(await options()).toEqual(['Jordan Vincent', 'Marjorie Chen'])
  })

  it('says so when nobody matches, and leaves Enter alone', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@nobodyhere')

    expect(await screen.findByText('Nobody matches “nobodyhere”.')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)

    // Nothing to choose, so Enter is a newline like it is everywhere else.
    await userEvent.keyboard('{Enter}')
    expect(box()).toHaveValue('@nobodyhere\n')
  })

  it('admits it when the directory may be short', async () => {
    vi.mocked(directoryQuery).mockResolvedValue(directory({ complete: false, total: 3 }))
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@')
    await options()

    expect(
      screen.getByText('Azure DevOps returned a full page of people, so this list may be short.'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 of 3 people could not be looked up.')).toBeInTheDocument()
  })

  it('carries what a failed directory said, without a list under it', async () => {
    vi.mocked(directoryQuery).mockResolvedValue(
      directory({ people: [], total: 0, error: 'Azure DevOps answered 403 for _apis/graph/users.' }),
    )
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), '@jor')

    expect(
      await screen.findByText('Azure DevOps answered 403 for _apis/graph/users.'),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('points the textarea at the option it has highlighted', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    // Nothing on a plain reply box: the field is a textbox with no list attached.
    expect(box()).not.toHaveAttribute('aria-expanded')
    expect(box()).not.toHaveAttribute('aria-controls')
    expect(box()).not.toHaveAttribute('aria-activedescendant')

    await userEvent.type(box(), '@')
    const list = await screen.findByRole('listbox', { name: 'People to mention' })

    expect(box()).toHaveAttribute('aria-expanded', 'true')
    expect(box()).toHaveAttribute('aria-controls', list.id)
    expect(box()).toHaveAttribute('aria-autocomplete', 'list')

    // The one attribute a screen reader needs to read out the highlighted row of a
    // list that does not have focus — and it has to follow the arrows.
    await waitFor(() =>
      expect(box()).toHaveAttribute(
        'aria-activedescendant',
        screen.getByRole('option', { name: /Jordan Vincent/ }).id,
      ),
    )

    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /Marjorie Chen/ }).id,
    )

    await userEvent.keyboard('{Escape}')
    expect(box()).not.toHaveAttribute('aria-activedescendant')
  })

  it('previews a just-picked mention as a name rather than a GUID', async () => {
    render(<Composer label="Comment" onSubmit={vi.fn()} />)

    await userEvent.type(box(), 'cc @jor')
    await options()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(screen.getByText('@Jordan Vincent')).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(JORDAN, 'i'))).not.toBeInTheDocument()
  })
})
