import { describe, expect, it } from 'vitest'
import { render as renderReact, screen, within } from '@testing-library/react'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { StackMark, StackTree } from './stack'

import type { ReactNode } from 'react'
import type { PullRequestStack } from '@/lib/stack'
import type { PullRequestRef } from '@/server/pull-request'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const REPOSITORY = '22222222-2222-2222-2222-222222222222'
const REF: PullRequestRef = { projectId: PROJECT, repositoryId: REPOSITORY, id: 24698 }

function render(ui: ReactNode) {
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/' }),
      createRoute({ getParentRoute: () => root, path: '/pr/$projectId/$repositoryId/$prId' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return renderReact(ui, {
    wrapper: ({ children }) => (
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    ),
  })
}

const member = (id: number, depth: number, parentId: number | null, isDraft = false) => ({
  id,
  title: `PR ${id}`,
  isDraft,
  sourceBranch: `feature/${id}`,
  depth,
  parentId,
})

const STACK: PullRequestStack = {
  trunk: 'main',
  members: [member(25000, 2, 24698, true), member(24698, 1, 24000), member(24000, 0, null)],
  position: 2,
  parent: { id: 24000, title: 'PR 24000' },
}

const href = (id: number) => `/pr/${PROJECT}/${REPOSITORY}/${id}`

describe('StackTree', () => {
  it('draws the stack top first and the trunk last', () => {
    render(<StackTree stack={STACK} prRef={REF} />)

    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      '!25000PR 25000draft',
      '!24698PR 24698this pull request',
      '!24000PR 24000',
      'main',
    ])
  })

  it('links the other pull requests and marks this one without a link', () => {
    render(<StackTree stack={STACK} prRef={REF} />)

    expect(screen.getByRole('link', { name: /PR 25000/ })).toHaveAttribute('href', href(25000))
    expect(screen.getByRole('link', { name: /PR 24000/ })).toHaveAttribute('href', href(24000))
    expect(screen.queryByRole('link', { name: /PR 24698/ })).toBeNull()

    const current = screen.getAllByRole('listitem')[1]
    expect(within(current).getByText('PR 24698').closest('[aria-current="page"]')).not.toBeNull()
  })
})

describe('StackMark', () => {
  it('links the parent pull request', () => {
    render(<StackMark stack={STACK} prRef={REF} />)

    expect(screen.getByRole('link', { name: '!24000' })).toHaveAttribute('href', href(24000))
  })

  it('says the base of the stack has nothing under it', () => {
    render(<StackMark stack={{ ...STACK, position: 1, parent: null }} prRef={REF} />)

    expect(screen.getByText('base of stack')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
