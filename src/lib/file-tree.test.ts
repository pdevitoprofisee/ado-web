import { describe, expect, it } from 'vitest'

import { buildFileTree, treeFiles } from './file-tree'

import type { DirNode, TreeNode } from './file-tree'
import type { ChangedFile } from '@/server/pull-request'

const file = (path: string): ChangedFile => ({
  path,
  changeType: ['edit'],
  originalPath: null,
  objectId: 'a'.repeat(40),
  originalObjectId: 'b'.repeat(40),
})

/** The tree as `dir/ [children]` and `file`, which is what these tests are about. */
function shape(nodes: readonly TreeNode[]): unknown[] {
  return nodes.map((node) => (node.kind === 'dir' ? [`${node.name}/`, shape(node.children)] : node.name))
}

const dirs = (nodes: readonly TreeNode[]): DirNode[] =>
  nodes.filter((node): node is DirNode => node.kind === 'dir')

describe('buildFileTree', () => {
  it('nests by path segment, directories above files', () => {
    const tree = buildFileTree([
      file('/README.md'),
      file('/src/log.ts'),
      file('/src/deep/sink.ts'),
    ])

    expect(shape(tree)).toEqual([['src/', [['deep/', ['sink.ts']], 'log.ts']], 'README.md'])
  })

  it('collapses a chain of only-children into one row', () => {
    // The reason: on this org a real path is
    // `/CrewChief/CrewChief.Web/DefaultReferenceData/drive-map.refkv.json`, and
    // three rows of indentation before the first readable thing is three rows of
    // nothing.
    const tree = buildFileTree([file('/src/components/diff/view.tsx')])

    expect(shape(tree)).toEqual([['src/components/diff/', ['view.tsx']]])
    // The deepest path, not the outermost: a node has to be identifiable while
    // the row it renders as stands for four segments at once.
    expect(dirs(tree)[0]?.path).toBe('/src/components/diff')
  })

  it('stops collapsing where the chain forks', () => {
    const tree = buildFileTree([file('/src/a/one.ts'), file('/src/b/two.ts')])

    expect(shape(tree)).toEqual([['src/', [['a/', ['one.ts']], ['b/', ['two.ts']]]]])
  })

  it('does not collapse a directory that holds a file as well as a directory', () => {
    const tree = buildFileTree([file('/src/log.ts'), file('/src/deep/sink.ts')])

    expect(shape(tree)).toEqual([['src/', [['deep/', ['sink.ts']], 'log.ts']]])
  })

  it('counts every file underneath, so a shut directory says what it is hiding', () => {
    const tree = buildFileTree([
      file('/src/a/one.ts'),
      file('/src/a/two.ts'),
      file('/src/b/three.ts'),
      file('/README.md'),
    ])

    const src = dirs(tree)[0]!
    expect(src.files).toBe(3)
    expect(dirs(src.children).map((node) => [node.name, node.files])).toEqual([
      ['a', 2],
      ['b', 1],
    ])
  })

  it('keeps a file whose path has no directory at all', () => {
    expect(shape(buildFileTree([file('/CHANGELOG.md')]))).toEqual(['CHANGELOG.md'])
  })

  it('drops a path with no file in it rather than rendering a nameless row', () => {
    expect(buildFileTree([file('/')])).toEqual([])
  })
})

describe('treeFiles', () => {
  it('reads the tree out depth first, which is the order the diff list renders in', () => {
    // The two have to agree: the sidebar's fourth row is the fourth panel down,
    // or clicking it lands somewhere in the middle of the page.
    const paths = ['/README.md', '/src/log.ts', '/src/deep/sink.ts', '/lib/util.ts']

    expect(treeFiles(buildFileTree(paths.map(file))).map((entry) => entry.path)).toEqual([
      '/lib/util.ts',
      '/src/deep/sink.ts',
      '/src/log.ts',
      '/README.md',
    ])
  })
})
