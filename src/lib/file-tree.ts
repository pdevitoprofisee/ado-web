import type { ChangedFile } from '@/server/pull-request'

// The changed files as a directory tree.
//
// A flat list of paths is the wrong shape for the question a reviewer actually
// asks — "what parts of the system did this touch" — and it gets worse the
// bigger the pull request is. Measured on the org: a 294-file diff spread over
// 60-odd directories, with paths like
// `/CrewChief/CrewChief.Web/DefaultReferenceData/drive-map.refkv.json` where the
// first 60 characters are the same on forty rows and the last twenty are the
// only part that differs.
//
// Two things come out of here, deliberately from one place: the tree for the
// sidebar, and `treeFiles` for the list beside it. Building the list separately
// — sorting the paths and hoping the two agree — is how a sidebar ends up in a
// different order from the thing it navigates.

export interface FileNode {
  readonly kind: 'file'
  /** Last segment. The full path is on `file`. */
  readonly name: string
  readonly file: ChangedFile
}

export interface DirNode {
  readonly kind: 'dir'
  /**
   * The segments this node stands for — `src/components/diff` when a chain of
   * only-children collapsed into one row, the way every file browser worth using
   * does it. Without that, the tree of a .NET repository is four rows of
   * indentation before the first thing you can read.
   */
  readonly name: string
  /** Unique among all nodes: the React key, and the handle collapse state is kept by. */
  readonly path: string
  readonly children: readonly TreeNode[]
  /** Files underneath at any depth, so a shut directory can still say how much it is hiding. */
  readonly files: number
}

export type TreeNode = FileNode | DirNode

/** Directories above files, each alphabetical — a file browser's order, because that is what this is. */
function byName(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return left.name.localeCompare(right.name)
}

interface Level {
  readonly dirs: Map<string, Level>
  readonly files: ChangedFile[]
}

const level = (): Level => ({ dirs: new Map(), files: [] })

function count(nodes: readonly TreeNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === 'dir' ? node.files : 1), 0)
}

function childrenOf(at: Level, prefix: string): readonly TreeNode[] {
  const nodes: TreeNode[] = []

  for (const [name, child] of at.dirs) nodes.push(directory(name, `${prefix}/${name}`, child))
  for (const file of at.files) {
    nodes.push({ kind: 'file', name: file.path.slice(file.path.lastIndexOf('/') + 1), file })
  }

  return nodes.sort(byName)
}

function directory(name: string, path: string, at: Level): DirNode {
  const children = childrenOf(at, path)
  const only = children.length === 1 ? children[0] : undefined

  // `src` holding nothing but `components` is one row reading `src/components`,
  // not two. The child's own path is kept as the node's, so collapse state
  // survives a file arriving later and splitting the chain back apart.
  if (only !== undefined && only.kind === 'dir') return { ...only, name: `${name}/${only.name}` }

  return { kind: 'dir', name, path, children, files: count(children) }
}

export function buildFileTree(files: readonly ChangedFile[]): readonly TreeNode[] {
  const root = level()

  for (const file of files) {
    // ADO paths are absolute — `/src/log.ts` — so the leading empty segment is
    // dropped rather than becoming a nameless root directory.
    const segments = file.path.split('/').filter((segment) => segment !== '')
    const name = segments.pop()
    // Nothing but slashes: no file in it to show. Never seen live, skipped
    // rather than rendered as a row with no name.
    if (name === undefined) continue

    let at = root
    for (const segment of segments) {
      let next = at.dirs.get(segment)
      if (next === undefined) {
        next = level()
        at.dirs.set(segment, next)
      }
      at = next
    }

    at.files.push(file)
  }

  return childrenOf(root, '')
}

/**
 * The tree's files, depth first.
 *
 * What the diff list renders, so that clicking the fourth row of the sidebar
 * lands on the fourth panel down rather than somewhere in the middle. The
 * grouping this replaced was by change type, which reads well on its own and
 * fights a tree: the sidebar would say `src/a.ts` then `src/b.ts` while the list
 * had them in different sections a screen apart.
 */
export function treeFiles(nodes: readonly TreeNode[]): readonly ChangedFile[] {
  return nodes.flatMap((node) => (node.kind === 'dir' ? treeFiles(node.children) : [node.file]))
}
