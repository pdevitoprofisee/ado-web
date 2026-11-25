/** What a pull request needs to say to be placed in a stack. */
export interface StackNode {
  readonly id: number
  readonly repositoryId: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly title: string
  readonly isDraft: boolean
  readonly createdAt: string
}

export interface StackMember {
  readonly id: number
  readonly title: string
  readonly isDraft: boolean
  readonly sourceBranch: string
  /** 0 for the base of the stack. */
  readonly depth: number
  readonly parentId: number | null
}

/**
 * One pull request's place in its stack. A pull request with no parent and no
 * children is not stacked, and gets `null` instead of one of these.
 */
export interface PullRequestStack {
  /** The branch the base of the stack merges into. */
  readonly trunk: string
  /** The whole tree, top of stack first and the base last. */
  readonly members: readonly StackMember[]
  /** 1 for the base of the stack. */
  readonly position: number
  readonly parent: { readonly id: number; readonly title: string } | null
}

const older = (a: StackNode, b: StackNode): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id - b.id

const branchKey = (repositoryId: string, branch: string): string => `${repositoryId}\0${branch}`

/**
 * Places every pull request in its stack. The parent of a pull request is the
 * one in the same repository whose source branch is its target branch.
 *
 * @param defaultBranches Each repository's default branch, by repository id. A
 * pull request from that branch, such as `main` into `release`, is never a parent.
 */
export function buildStacks(
  nodes: readonly StackNode[],
  defaultBranches: ReadonlyMap<string, string>,
): ReadonlyMap<number, PullRequestStack> {
  const sorted = [...new Map(nodes.map((node) => [node.id, node])).values()].sort(older)
  // ADO spells one repository GUID in different cases on different endpoints.
  const trunks = new Set(
    [...defaultBranches].map(([repositoryId, branch]) =>
      branchKey(repositoryId.toLowerCase(), branch),
    ),
  )

  // Sorted oldest first, so the first claim on a branch is the parent that wins.
  const bySource = new Map<string, StackNode>()
  for (const node of sorted) {
    if (trunks.has(branchKey(node.repositoryId.toLowerCase(), node.sourceBranch))) continue
    const at = branchKey(node.repositoryId, node.sourceBranch)
    if (!bySource.has(at)) bySource.set(at, node)
  }

  const parentOf = new Map<number, StackNode | null>()
  for (const node of sorted) {
    const parent = bySource.get(branchKey(node.repositoryId, node.targetBranch))
    parentOf.set(node.id, parent !== undefined && parent.id !== node.id ? parent : null)
  }

  breakCycles(sorted, parentOf)

  const children = new Map<number, StackNode[]>()
  for (const node of sorted) {
    const parent = parentOf.get(node.id)
    if (!parent) continue
    const siblings = children.get(parent.id) ?? []
    siblings.push(node)
    children.set(parent.id, siblings)
  }

  const stacks = new Map<number, PullRequestStack>()
  for (const root of sorted) {
    if (parentOf.get(root.id) !== null || !children.has(root.id)) continue

    const tree: StackMember[] = []
    const visit = (node: StackNode, depth: number, parentId: number | null): void => {
      tree.push({
        id: node.id,
        title: node.title,
        isDraft: node.isDraft,
        sourceBranch: node.sourceBranch,
        depth,
        parentId,
      })
      for (const child of children.get(node.id) ?? []) visit(child, depth + 1, node.id)
    }
    visit(root, 0, null)

    // Reversed pre-order draws each pull request below its own descendants.
    const members = tree.reverse()
    for (const member of members) {
      const parent = parentOf.get(member.id) ?? null
      stacks.set(member.id, {
        trunk: root.targetBranch,
        members,
        position: member.depth + 1,
        parent: parent && { id: parent.id, title: parent.title },
      })
    }
  }

  return stacks
}

/** In each cycle, the oldest member loses its parent and becomes the base. */
function breakCycles(sorted: readonly StackNode[], parentOf: Map<number, StackNode | null>): void {
  const settled = new Set<number>()

  for (const start of sorted) {
    const path: StackNode[] = []
    const onPath = new Set<number>()
    let at: StackNode | null = start

    while (at && !settled.has(at.id)) {
      const id = at.id
      if (onPath.has(id)) {
        const loop = path.slice(path.findIndex((node) => node.id === id))
        parentOf.set([...loop].sort(older)[0].id, null)
        break
      }
      path.push(at)
      onPath.add(at.id)
      at = parentOf.get(at.id) ?? null
    }

    for (const node of path) settled.add(node.id)
  }
}
