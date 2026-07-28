import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Composer } from './composer'

// T-026. The three things a composer has to get right: the preview has to match
// what will be posted, the keys have to work, and a failed submit must not eat
// the paragraph.

const box = () => screen.getByRole('textbox', { name: 'Comment' })

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
