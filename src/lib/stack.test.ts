import { describe, expect, it } from 'vitest'

import { buildStacks } from './stack'

import type { StackNode } from './stack'

const REPO = 'repo-a'
const OTHER_REPO = 'repo-b'

const pr = (
  id: number,
  sourceBranch: string,
  targetBranch: string,
  over: Partial<StackNode> = {},
): StackNode => ({
  id,
  repositoryId: REPO,
  sourceBranch,
  targetBranch,
  title: `PR ${id}`,
  isDraft: false,
  createdAt: `2026-07-${String(id).padStart(2, '0')}T00:00:00Z`,
  ...over,
})

const NO_DEFAULTS: ReadonlyMap<string, string> = new Map()

/** Each member as `id@depth`, in drawing order. */
const drawn = (nodes: StackNode[], id: number, defaults = NO_DEFAULTS) =>
  buildStacks(nodes, defaults)
    .get(id)
    ?.members.map((member) => `${member.id}@${member.depth}`) ?? null

describe('buildStacks', () => {
  it.each([
    {
      name: 'a linear chain of three, top first',
      nodes: [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b')],
      id: 2,
      members: ['3@2', '2@1', '1@0'],
    },
    {
      name: 'a fork, each child drawn above its siblings older than it',
      nodes: [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'a'), pr(4, 'd', 'b')],
      id: 1,
      members: ['3@1', '4@2', '2@1', '1@0'],
    },
    {
      name: 'cross-repo pull requests with the same branch names',
      nodes: [pr(1, 'a', 'main'), pr(2, 'b', 'a', { repositoryId: OTHER_REPO })],
      id: 2,
      members: null,
    },
    {
      name: 'a lone pull request',
      nodes: [pr(1, 'a', 'main'), pr(2, 'b', 'main')],
      id: 1,
      members: null,
    },
  ])('draws $name', ({ nodes, id, members }) => {
    expect(drawn(nodes, id)).toEqual(members)
  })

  it.each([1, 2, 3])('never stacks on a pull request from the default branch (!%i)', (id) => {
    const nodes = [pr(1, 'main', 'release'), pr(2, 'f1', 'main'), pr(3, 'f2', 'main')]

    expect(drawn(nodes, id, new Map([[REPO.toUpperCase(), 'main']]))).toBeNull()
  })

  it('still stacks on a branch that is only the default of another repository', () => {
    const nodes = [pr(1, 'main', 'release'), pr(2, 'f1', 'main')]

    expect(drawn(nodes, 2, new Map([[OTHER_REPO, 'main']]))).toEqual(['2@1', '1@0'])
  })

  it('names the trunk, the position, and the parent', () => {
    const stack = buildStacks(
      [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b')],
      NO_DEFAULTS,
    ).get(3)

    expect(stack).toMatchObject({ trunk: 'main', position: 3, parent: { id: 2, title: 'PR 2' } })
  })

  it('gives the base of the stack no parent', () => {
    const stack = buildStacks([pr(1, 'a', 'main'), pr(2, 'b', 'a')], NO_DEFAULTS).get(1)

    expect(stack).toMatchObject({ position: 1, parent: null })
  })

  it('picks the oldest pull request when two share a source branch', () => {
    const stacks = buildStacks(
      [
        pr(5, 'a', 'main', { createdAt: '2026-07-02T00:00:00Z' }),
        pr(4, 'a', 'main', { createdAt: '2026-07-02T00:00:00Z' }),
        pr(3, 'a', 'main', { createdAt: '2026-07-03T00:00:00Z' }),
        pr(9, 'b', 'a'),
      ],
      NO_DEFAULTS,
    )

    expect(stacks.get(9)?.parent?.id).toBe(4)
    expect(stacks.get(3)).toBeUndefined()
  })

  it('breaks a cycle at its oldest member and still draws every pull request once', () => {
    const stacks = buildStacks([pr(2, 'b', 'a'), pr(1, 'a', 'c'), pr(3, 'c', 'b')], NO_DEFAULTS)

    expect(stacks.get(1)).toMatchObject({ trunk: 'c', parent: null })
    expect(drawn([pr(2, 'b', 'a'), pr(1, 'a', 'c'), pr(3, 'c', 'b')], 3)).toEqual([
      '3@2',
      '2@1',
      '1@0',
    ])
  })
})
