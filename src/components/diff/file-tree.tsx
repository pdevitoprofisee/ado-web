import { useState } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon, Comment01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { fileAnchor } from '@/lib/file-anchor'
import { treeFiles } from '@/lib/file-tree'
import { NO_THREADS, anyThreads, sumThreads } from '@/lib/thread-counts'
import { cn } from '@/lib/utils'

import type { DirNode, TreeNode } from '@/lib/file-tree'
import type { ThreadCount } from '@/lib/thread-counts'
import type { ChangedFile } from '@/server/pull-request'

// The sidebar. What changed, as a shape rather than as a list of paths, and a
// way to get to any of it without scrolling past the rest.
//
// Deliberately not `role="tree"`. That role comes with a keyboard contract —
// arrows to move and to open, home and end, typeahead — and a widget that claims
// the role without honouring it is worse to a screen reader than the nested list
// this actually is. Directories are buttons with `aria-expanded`, files are
// buttons that move the page, and the whole thing is one labelled `nav`.

export type ChangeKind = 'add' | 'delete' | 'rename' | 'edit'

/**
 * One kind for a change, in the order that answers the question first.
 *
 * `changeType` is a flag set, so a file can be an edit *and* a rename; the rename
 * is the part you cannot see in the diff body, so it wins. Delete and add come
 * before it because a file that is not there afterwards is not a file you read
 * for its changes.
 *
 * Exported because the file header states the same thing as a badge, and one
 * precedence rule stated twice is one that will disagree with itself.
 */
export function changeKind(file: ChangedFile): ChangeKind | null {
  const types = new Set(file.changeType)
  if (types.has('delete')) return 'delete'
  if (types.has('add')) return 'add'
  if (types.has('rename')) return 'rename'
  if (types.has('edit')) return 'edit'

  return null
}

const LETTER: Record<ChangeKind, string> = { add: 'A', delete: 'D', rename: 'R', edit: 'M' }

/**
 * Colour carries the same thing the letter does, for the same reason the diff
 * body has colours — and in the same pens, so the sidebar and the header a file
 * scrolls to agree. A rename gets the brand navy rather than the chrome grey an
 * edit sits in: it is the one kind whose change is invisible in the diff body.
 */
const KIND_TONE: Record<ChangeKind, string> = {
  add: 'text-diff-add-fg',
  delete: 'text-diff-delete-fg',
  rename: 'text-ink',
  edit: 'text-ink-500',
}

/**
 * How much conversation is on a row: a bubble, and how many threads.
 *
 * The number is every thread on the file and the colour is whether any of them
 * are still open, because those are two different questions and a reader has
 * both. Amber is the pen this design system already spends on "somebody is
 * waiting"; a file whose comments are all resolved keeps the bubble in the same
 * grey the tree's other secondary marks use, so it reads as history rather than
 * as work.
 */
function Comments({ count }: { count: ThreadCount }) {
  const total = count.open + count.done

  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-0.5 tabular-nums',
        count.open > 0 ? 'text-pen-amber' : 'text-ink-300',
      )}
      aria-label={
        count.open > 0
          ? `${total} ${total === 1 ? 'comment' : 'comments'}, ${count.open} unresolved`
          : `${total} ${total === 1 ? 'comment' : 'comments'}, all resolved`
      }
    >
      <HugeiconsIcon icon={Comment01Icon} size={11} className="shrink-0" aria-hidden />
      {total}
    </span>
  )
}

function Row({
  depth,
  children,
  onPress,
  expanded,
  title,
  dim,
  className,
}: {
  depth: number
  children: React.ReactNode
  onPress: () => void
  expanded?: boolean
  title?: string
  dim?: boolean
  className?: string
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
        // `rounded-sm`, not `rounded`: Tailwind's bare `rounded` is still a
        // mechanical 4px, and only the named steps are mapped onto Prof's
        // asymmetric corners. A row is a control, so it takes the control
        // radius — which the global focus ring then follows, being a shadow.
        //
        // The wash is on hover rather than on a selected row because this tree
        // has no selection to paint: a click scrolls the page and the row does
        // not stay lit. `bg-accent` is the faintest teal, so the band reads as
        // "this one" without competing with the change letters.
        'hover:bg-accent flex w-full items-center gap-1 rounded-sm py-0.5 pr-1 text-left font-mono text-xs',
        dim === true && 'text-muted-foreground',
        className,
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
  comments,
}: {
  node: DirNode
  depth: number
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
  comments: (file: ChangedFile) => ThreadCount
}) {
  // Open by default, every one of them. A tree that starts shut hides the thing
  // the reader opened the sidebar to see, and the count on the row is only worth
  // anything as an answer to "is this one worth shutting".
  const [open, setOpen] = useState(true)

  // Rolled up from the files underneath, and drawn only while the directory is
  // shut. Open, every one of those files is on screen saying it for itself, and
  // a second copy on the parent row is one more number to read past. Shut, this
  // is the only thing left that says a comment is in there.
  const inside = open ? NO_THREADS : sumThreads(treeFiles(node.children).map(comments))

  return (
    <li>
      {/* Directories are the scaffolding, not the content: secondary ink throughout
          so the files inside them are what the eye lands on first. */}
      <Row
        depth={depth}
        onPress={() => setOpen(!open)}
        expanded={open}
        title={node.path}
        className="text-ink-500"
      >
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={12}
          className="shrink-0"
          aria-hidden
        />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {anyThreads(inside) ? <Comments count={inside} /> : null}
          <span className="text-ink-300 tabular-nums">{node.files}</span>
        </span>
      </Row>
      {open ? (
        <Nodes
          nodes={node.children}
          depth={depth + 1}
          viewed={viewed}
          conflicted={conflicted}
          comments={comments}
        />
      ) : null}
    </li>
  )
}

function File({
  file,
  name,
  depth,
  read,
  conflicted,
  comments,
}: {
  file: ChangedFile
  name: string
  depth: number
  read: boolean
  conflicted: boolean
  comments: ThreadCount
}) {
  const kind = changeKind(file)

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
          className={cn(
            'w-3 shrink-0 text-center',
            kind === null ? 'text-ink-300' : KIND_TONE[kind],
          )}
        >
          {kind === null ? '·' : LETTER[kind]}
        </span>
        <span className={cn('truncate', read && 'line-through')}>{name}</span>
        {/* Both marks live in one right-hand group so a file that is commented
            *and* conflicted keeps them side by side, rather than two `ml-auto`
            children fighting over the same edge. Outside the struck-through
            name, because marking a file read does not answer its comments. */}
        {anyThreads(comments) || conflicted ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {anyThreads(comments) ? <Comments count={comments} /> : null}
            {conflicted ? <span className="text-destructive">!</span> : null}
          </span>
        ) : null}
      </Row>
    </li>
  )
}

function Nodes({
  nodes,
  depth,
  viewed,
  conflicted,
  comments,
}: {
  nodes: readonly TreeNode[]
  depth: number
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
  comments: (file: ChangedFile) => ThreadCount
}) {
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <Directory
            key={node.path}
            node={node}
            depth={depth}
            viewed={viewed}
            conflicted={conflicted}
            comments={comments}
          />
        ) : (
          <File
            key={node.file.path}
            file={node.file}
            name={node.name}
            depth={depth}
            read={viewed(node.file)}
            conflicted={conflicted.has(node.file.path)}
            comments={comments(node.file)}
          />
        ),
      )}
    </ul>
  )
}

/** A tree with no conversation behind it, for the views that have none to give. */
const NO_COMMENTS = () => NO_THREADS

export function FileTree({
  nodes,
  viewed,
  conflicted,
  comments = NO_COMMENTS,
}: {
  nodes: readonly TreeNode[]
  /** Whether a file is one of the read ones — the same predicate the list uses, passed in rather than recomputed. */
  viewed: (file: ChangedFile) => boolean
  conflicted: ReadonlySet<string>
  /**
   * How many threads are on a file. Optional because a branch or a commit diff
   * has no pull request behind it and therefore no conversation to count — those
   * trees draw no bubbles rather than a column of zeroes.
   */
  comments?: (file: ChangedFile) => ThreadCount
}) {
  return (
    // Sticky and scrolling on its own: the diff beside it is thousands of rows
    // long, and a tree that leaves the top of the window is a tree you have to
    // scroll back up to use.
    <nav
      aria-label="File tree"
      className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-64 shrink-0 overflow-y-auto lg:block"
    >
      {/* `aria-hidden` because the `nav` is already labelled "File tree"; this is
          the same label drawn for the eye, and a screen reader hearing it twice
          learns nothing. `.annotation` is Prof's answer to every small caps label,
          and it also gives the tree a top edge — without one the first row floats
          against the header above it. */}
      <p aria-hidden className="annotation px-1 pb-1">
        Files
      </p>
      <Nodes nodes={nodes} depth={0} viewed={viewed} conflicted={conflicted} comments={comments} />
    </nav>
  )
}
