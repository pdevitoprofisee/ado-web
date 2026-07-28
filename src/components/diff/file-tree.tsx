import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { fileAnchor } from '@/lib/file-anchor'
import { cn } from '@/lib/utils'

import type { DirNode, TreeNode } from '@/lib/file-tree'
import type { ChangedFile } from '@/server/pull-request'

// The sidebar. What changed, as a shape rather than as a list of paths, and a
// way to get to any of it without scrolling past the rest.
//
// Deliberately not `role="tree"`. That role comes with a keyboard contract —
// arrows to move and to open, home and end, typeahead — and a widget that claims
// the role without honouring it is worse to a screen reader than the nested list
// this actually is. Directories are buttons with `aria-expanded`, files are
// buttons that move the page, and the whole thing is one labelled `nav`.

/**
 * One letter for a change, in the order that answers the question first.
 *
 * `changeType` is a flag set, so a file can be an edit *and* a rename; the rename
 * is the part you cannot see in the diff body, so it wins. Delete and add come
 * before it because a file that is not there afterwards is not a file you read
 * for its changes.
 */
function changeLetter(file: ChangedFile): string {
  const types = new Set(file.changeType)
  if (types.has('delete')) return 'D'
  if (types.has('add')) return 'A'
  if (types.has('rename')) return 'R'
  if (types.has('edit')) return 'M'

  return '·'
}

/** Colour carries the same thing the letter does, for the same reason the diff body has colours. */
const LETTER_TONE: Record<string, string> = {
  A: 'text-diff-add-fg',
  D: 'text-diff-delete-fg',
}

function Row({
  depth,
  children,
  onPress,
  expanded,
  title,
  dim,
}: {
  depth: number
  children: React.ReactNode
  onPress: () => void
  expanded?: boolean
  title?: string
  dim?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-expanded={expanded}
      title={title}
      // Indent by padding rather than by margin so the hover band still reaches
      // the full width of the sidebar at every depth.
      style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
      className={cn(
        'hover:bg-muted flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left font-mono text-xs',
        dim === true && 'text-muted-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Directory({
  node,
  depth,
  viewed,
  conflicted,
}: {
  node: DirNode
  depth: number
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
}) {
  // Open by default, every one of them. A tree that starts shut hides the thing
  // the reader opened the sidebar to see, and the count on the row is only worth
  // anything as an answer to "is this one worth shutting".
  const [open, setOpen] = useState(true)

  return (
    <li>
      <Row depth={depth} onPress={() => setOpen(!open)} expanded={open} title={node.path}>
        {open ? (
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        )}
        <span className="truncate">{node.name}</span>
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{node.files}</span>
      </Row>
      {open ? <Nodes nodes={node.children} depth={depth + 1} viewed={viewed} conflicted={conflicted} /> : null}
    </li>
  )
}

function File({
  file,
  name,
  depth,
  read,
  conflicted,
}: {
  file: ChangedFile
  name: string
  depth: number
  read: boolean
  conflicted: boolean
}) {
  const letter = changeLetter(file)

  return (
    <li>
      <Row
        depth={depth}
        title={file.path}
        dim={read}
        onPress={() => {
          // Found by id rather than held as a ref: the panels are somebody
          // else's children and threading a ref for each of 294 of them through
          // two components buys nothing over asking the document once.
          //
          // `scrollIntoView` is optional-chained because jsdom does not
          // implement it — a missing scroll is not worth a thrown click.
          document.getElementById(fileAnchor(file.path))?.scrollIntoView?.({ block: 'start' })
        }}
      >
        <span
          aria-hidden
          className={cn('w-3 shrink-0 text-center', LETTER_TONE[letter] ?? 'text-muted-foreground')}
        >
          {letter}
        </span>
        <span className={cn('truncate', read && 'line-through')}>{name}</span>
        {conflicted ? <span className="text-destructive ml-auto shrink-0">!</span> : null}
      </Row>
    </li>
  )
}

function Nodes({
  nodes,
  depth,
  viewed,
  conflicted,
}: {
  nodes: readonly TreeNode[]
  depth: number
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
}) {
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <Directory key={node.path} node={node} depth={depth} viewed={viewed} conflicted={conflicted} />
        ) : (
          <File
            key={node.file.path}
            file={node.file}
            name={node.name}
            depth={depth}
            read={viewed(node.file)}
            conflicted={conflicted.has(node.file.path)}
          />
        ),
      )}
    </ul>
  )
}

export function FileTree({
  nodes,
  viewed,
  conflicted,
}: {
  nodes: readonly TreeNode[]
  /** Whether a file is one of the read ones — the same predicate the list uses, passed in rather than recomputed. */
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
}) {
  return (
    // Sticky and scrolling on its own: the diff beside it is thousands of rows
    // long, and a tree that leaves the top of the window is a tree you have to
    // scroll back up to use.
    <nav
      aria-label="File tree"
      className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-64 shrink-0 overflow-y-auto lg:block"
    >
      <Nodes nodes={nodes} depth={0} viewed={viewed} conflicted={conflicted} />
    </nav>
  )
}
