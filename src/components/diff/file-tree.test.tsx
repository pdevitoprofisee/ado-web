import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from './file-tree'
import { buildFileTree } from '@/lib/file-tree'
import { fileAnchor } from '@/lib/file-anchor'

import type { ChangedFile } from '@/server/pull-request'

// The sidebar's own tests. The builder is covered next to itself in
// `src/lib/file-tree.test.ts`; what is left here is the two things only the
// component does — shutting a directory, and moving the page to a file.

const file = (path: string, changeType: string[] = ['edit']): ChangedFile => ({
  path,
  changeType,
  originalPath: null,
  objectId: 'aa',
  originalObjectId: 'bb',
})

const FILES: readonly ChangedFile[] = [
  file('/src/lib/log.ts'),
  file('/src/lib/sink.ts', ['edit', 'rename']),
  file('/src/new.ts', ['add']),
  file('/README.md', ['delete']),
]

function draw(over: Partial<Parameters<typeof FileTree>[0]> = {}) {
  return render(
    <FileTree
      nodes={buildFileTree(FILES)}
      viewed={() => false}
      conflicted={new Set()}
      {...over}
    />,
  )
}

const tree = () => within(screen.getByRole('navigation', { name: 'File tree' }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FileTree', () => {
  it('opens every directory, and says how many files each is holding', () => {
    // Shut by default would hide the thing the sidebar was opened to see. The
    // count is what makes shutting one worth doing.
    draw()

    // `src/lib` and not `src` then `lib`: an only-child chain is one row.
    expect(tree().getByTitle('/src/lib')).toHaveTextContent('lib2')
    expect(tree().getByTitle('/src/lib')).toHaveAttribute('aria-expanded', 'true')
    expect(tree().getByTitle('/src/lib/log.ts')).toBeVisible()
  })

  it('hides a directory’s files when it is shut, and brings them back', async () => {
    draw()

    await userEvent.click(tree().getByTitle('/src/lib'))

    expect(tree().getByTitle('/src/lib')).toHaveAttribute('aria-expanded', 'false')
    expect(tree().queryByTitle('/src/lib/log.ts')).toBeNull()
    // The sibling that is not underneath it stays where it was.
    expect(tree().getByTitle('/src/new.ts')).toBeVisible()

    await userEvent.click(tree().getByTitle('/src/lib'))
    expect(tree().getByTitle('/src/lib/log.ts')).toBeVisible()
  })

  it('spells the change out in one letter, rename ahead of the edit it rides on', () => {
    // The rename is the half a diff body cannot show, so it wins over `edit`.
    draw()

    expect(tree().getByTitle('/src/lib/log.ts')).toHaveTextContent('Mlog.ts')
    expect(tree().getByTitle('/src/lib/sink.ts')).toHaveTextContent('Rsink.ts')
    expect(tree().getByTitle('/src/new.ts')).toHaveTextContent('Anew.ts')
    expect(tree().getByTitle('/README.md')).toHaveTextContent('DREADME.md')
  })

  it('strikes a file that has already been read, without hiding it', () => {
    // Progress has to be legible from the sidebar — that is most of what the
    // sidebar is for on a 294-file diff — but a file that vanishes when it is
    // marked cannot be gone back to.
    draw({ viewed: (candidate) => candidate.path === '/src/new.ts' })

    expect(within(tree().getByTitle('/src/new.ts')).getByText('new.ts')).toHaveClass('line-through')
    expect(within(tree().getByTitle('/src/lib/log.ts')).getByText('log.ts')).not.toHaveClass(
      'line-through',
    )
  })

  it('marks the conflicting file here too, where the next file gets picked', () => {
    draw({ conflicted: new Set(['/src/lib/log.ts']) })

    expect(tree().getByTitle('/src/lib/log.ts')).toHaveTextContent('!')
    expect(tree().getByTitle('/src/lib/sink.ts')).not.toHaveTextContent('!')
  })

  it('moves the page to the panel a file belongs to', async () => {
    // The panels are somebody else's children, so the jump goes through the id
    // `changed-file.tsx` puts on each of them rather than through a ref.
    const panel = document.createElement('div')
    panel.id = fileAnchor('/src/new.ts')
    document.body.append(panel)
    const scroll = vi.fn()
    panel.scrollIntoView = scroll

    draw()
    await userEvent.click(tree().getByTitle('/src/new.ts'))

    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    panel.remove()
  })

  it('survives a click when nothing on the page implements scrolling', async () => {
    // jsdom implements neither `scrollIntoView` nor the panel being there at all,
    // and a sidebar row that throws is worse than one that does nothing.
    draw()

    await expect(
      userEvent.click(tree().getByTitle('/src/new.ts')),
    ).resolves.toBeUndefined()
  })
})
