import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

import { mentionTag, splitMentions } from '@/lib/people'

import type { Components } from 'react-markdown'

// Markdown as Azure DevOps writes it. Descriptions are authored in ADO's editor,
// which is GitHub-flavoured — tables, `- [ ]` checklists, strikethrough and bare
// URLs all appear in real descriptions — so `remark-gfm` is not optional here.
//
// `remark-breaks` is the other half, and it is the difference between rendering a
// description and mangling one. CommonMark folds a single newline into a space,
// which is right for prose and wrong for the thing people actually write in that
// box: a stack of one-line notes and an `AB#1234` footer, none of it indented,
// none of it a bullet. Folded, that becomes a paragraph nobody wrote. This is the
// rule GitHub applies to comments and pull request bodies for the same reason,
// and it keeps every line exactly where the old `whitespace-pre-wrap` put it.
//
// **Raw HTML is deliberately not rendered.** `rehype-raw` is not installed, so
// react-markdown escapes `html` nodes instead of parsing them: a description
// containing `<script>` shows the eleven characters `<script>` and nothing runs.
// This is text from another person's pull request, and the one thing this page
// must never do is let that text become markup. Escaping beats dropping, too —
// the tags stay visible, so a description that was trying to say something in
// HTML still says it, just plainly.
//
// The heading scale is flattened on purpose. A description sits inside a section
// that already has its own heading, and `## Summary` in an ADO description means
// "here is a paragraph break", not "start a new document" — rendering it at
// display size makes the description shout over the merge banner above it.

/**
 * `pre > code` is styled through the `pre`, because react-markdown gives inline
 * code and fenced code the same `code` component and dropped the `inline` prop
 * in v9. The parent knows which one it is, so the parent undoes the chip.
 *
 * The block is a sunken well with a pen around it: a fenced block in an ADO
 * description is usually a stack trace or a config snippet, and it needs to read
 * as a thing pasted into the page rather than as a paragraph that happens to be
 * grey. `font-mono` here as well as on the `code` inside, because a bare `pre`
 * would otherwise fall back to the browser's generic monospace rather than the
 * one this system draws in.
 */
const PRE =
  'bg-muted border-border mb-2 overflow-x-auto rounded-md border-[1.5px] p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit'

const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  // `rounded-sm` and not bare `rounded`: the sketch radii are mapped onto the
  // named steps of the scale, and bare `rounded` is the one that still resolves
  // to `--radius` — a square corner in the middle of a sentence.
  code: ({ children }) => (
    <code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => <pre className={PRE}>{children}</pre>,
  // A new tab, because the app is a single page you are half way down a diff on
  // and a work-item link should not take that away. `noreferrer` covers `opener`
  // too, so a linked page cannot reach back through `window.opener`.
  //
  // Drawn in the brand navy at the pen's 1.5px, and lifted to a 3px offset so
  // the stroke clears the descenders in a `feature/some-branch` link instead of
  // running through them.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline decoration-[1.5px] underline-offset-[3px]"
    >
      {children}
    </a>
  ),
  // A quoted passage gets the pen's weight in the brand navy rather than 2px of
  // border colour: the mark down the margin is the whole of what says "somebody
  // else wrote this", so it should look drawn.
  blockquote: ({ children }) => (
    <blockquote className="border-ink text-muted-foreground mb-2 border-l-[1.5px] pl-3 last:mb-0">
      {children}
    </blockquote>
  ),
  // A drawn rule, which is 6px tall where the border was 1px — hence the shorter
  // margin. `.sketch-rule` tiles a 600px drawing, so it stays a hand-drawn line
  // at any width instead of stretching into a smooth one.
  hr: () => <hr className="sketch-rule my-2" />,
  table: ({ children }) => (
    <div className="mb-2 w-full overflow-x-auto last:mb-0">
      {/* Stripes on the body rows and no fill on the header: a description's
          tables are usually three columns of short values, and a striped body
          under uppercase headers is enough structure without tinting two things
          the same paper. `tbody tr` and not `tr`, or the header row would count
          itself into the alternation. */}
      <table className="border-border w-full border-collapse border text-xs [&_tbody_tr:nth-child(odd)]:bg-muted">
        {children}
      </table>
    </div>
  ),
  // `.annotation` is what this system calls a column label, and it does the
  // separating a fill would otherwise have to do.
  th: ({ children }) => (
    <th className="annotation border-border border px-2 py-1 text-left">{children}</th>
  ),
  td: ({ children }) => <td className="border-border border px-2 py-1 align-top">{children}</td>,
  // GFM's task lists. Disabled because ticking one here would change nothing in
  // Azure DevOps, and a checkbox that does not stick is worse than a read-only one.
  input: ({ type, checked }) =>
    type === 'checkbox' ? (
      <input type="checkbox" checked={checked} disabled readOnly className="mr-1.5 align-middle" />
    ) : null,
}

// @mentions, from here down.
//
// ADO stores a tag as `@<GUID>` in the body — the name is not in the text at all
// — so `cc @<FBFD3DD4-…>` is what a comment literally says and what this page
// showed until the names started arriving beside it. `lib/people.ts` owns the
// pattern; the server owns the lookup; this is where a resolved name becomes
// something you can read.
//
// **A remark plugin rather than a pass over the string**, because a substitution
// on the source text cannot see markdown: a GUID inside a fenced block or an
// inline code span is a literal somebody pasted on purpose, and rewriting it
// there would be editing their code sample. Working on the tree means only prose
// is touched — at the cost of having to reassemble the mentions the parser breaks
// in half on the way, which `replaceMentions` below is mostly about.
//
// Hand-written rather than a dependency, and no `unist-util-visit`: the whole
// walk is the twenty lines below, and it has to rebuild `children` anyway, which
// is not what a visitor is for.

/**
 * As much of an mdast node as this walk touches.
 *
 * Structural, because `@types/mdast` is not installed — `node_modules/@types`
 * holds `node`, `react` and `react-dom` and nothing else — so `import type
 * { Root }` would not resolve. Only `type`, `value` and `children` are read, and
 * `data` is written, so a narrow local shape says more here than the real union
 * would anyway.
 */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

/**
 * A tagged person, in a sentence.
 *
 * Deliberately not `.prof-badge`: a badge is a ~22px pill and this sits inside a
 * 20px line of prose, so it would push the line it is in apart. The teal wash and
 * the brand navy are the badge's colours at text height — the same pair
 * `bg-accent` marks a chosen control with — and `font-medium` rather than the
 * label's uppercase, because a name is a name.
 *
 * `rounded-sm` for the reason the inline `code` chip above has it: bare `rounded`
 * is the one step of the scale the sketch radii are not mapped onto, which would
 * put a machine corner in the middle of a sentence.
 */
const MENTION_CHIP = 'bg-accent text-primary rounded-sm px-1 font-medium'

/**
 * The chip as an mdast node.
 *
 * `strong` and not a made-up type, with `data.hName` overriding what it compiles
 * to: that pair is mdast-util-to-hast's documented way to emit an arbitrary
 * element, and it means every plugin downstream still sees a node type it knows.
 * Inventing `type: 'mention'` would work until something asked what phrasing
 * content it was.
 */
function chip(name: string): MdNode {
  return {
    type: 'strong',
    data: { hName: 'span', hProperties: { className: MENTION_CHIP } },
    children: [{ type: 'text', value: `@${name}` }],
  }
}

/**
 * Every mention in the tree, cut out and replaced.
 *
 * Two passes over each child, because a mention arrives in one of two shapes. In
 * a `text` node it is whole and `splitMentions` finds it. But `<GUID>` is a legal
 * HTML tag name when the GUID starts with a letter, so remark pulls that half out
 * into an `html` node of its own and the `@` is left as the last character of the
 * text before it — the halves have to be put back together. `mentionTag` in
 * `lib/people.ts` explains the parse; `queryByText` on a real comment is what
 * found it.
 */
function replaceMentions(node: MdNode, names: Readonly<Record<string, string>>): void {
  const children = node.children
  if (children === undefined) return

  const out: MdNode[] = []
  for (const child of children) {
    // The split mention. `out` and not `children`, so the `@` looked at is the one
    // this pass has already rebuilt — and only ever a `text` node, which is what
    // keeps `` `x` <GUID> `` from being read as a tag hanging off a code span.
    const id = child.type === 'html' ? mentionTag(child.value ?? '') : null
    const before = out[out.length - 1]
    if (id !== null && before?.type === 'text' && before.value?.endsWith('@') === true) {
      const name = names[id]
      if (name !== undefined) {
        before.value = before.value.slice(0, -1)
        if (before.value === '') out.pop()
        out.push(chip(name))
        continue
      }
    }

    // `inlineCode`, `code` and `html` all carry a `value` and none of them is
    // prose — the type test is what keeps a GUID in a code sample intact.
    if (child.type !== 'text' || child.value === undefined) {
      replaceMentions(child, names)
      out.push(child)
      continue
    }

    for (const piece of splitMentions(child.value)) {
      if (typeof piece === 'string') {
        out.push({ type: 'text', value: piece })
        continue
      }

      const name = names[piece.id]
      // No name means the lookup did not answer for that id. Put back exactly as
      // ADO wrote it: a chip is a claim about who this is, and a chip with a GUID
      // in it is worse than the GUID on its own.
      out.push(name === undefined ? { type: 'text', value: piece.raw } : chip(name))
    }
  }

  node.children = out
}

/**
 * The plugin, closed over the names this body resolved.
 *
 * `unknown` on the transformer's parameter rather than a `Root`: unified types the
 * tree through the processor's generics, this file has no mdast types to satisfy
 * them with, and the cast is honest about that — the walk reads three fields and
 * ignores everything it does not recognise.
 */
function remarkMentions(names: Readonly<Record<string, string>>) {
  return () => (tree: unknown) => {
    replaceMentions(tree as MdNode, names)
  }
}

const PLUGINS = [remarkGfm, remarkBreaks]
const FILE_PLUGINS = [remarkGfm]

/** Markdown text, rendered. Whitespace-only input renders nothing; the caller decides what to say about that. */
export function Markdown({
  children,
  mentions = {},
  lineBreaks = true,
}: {
  children: string
  /**
   * Display names for the `@<GUID>` mentions in this text, keyed by lower-cased
   * GUID — `Comment.mentions`, straight through.
   *
   * Empty is the normal case (a description, a composer preview, a body that
   * tags nobody) and skips the walk entirely, so the rendering of every existing
   * caller is untouched.
   */
  mentions?: Readonly<Record<string, string>>
  /**
   * Keep each single newline as a line break. Turn it off for a `.md` file from
   * a repository, where hard-wrapped prose is one paragraph.
   */
  lineBreaks?: boolean
}) {
  const base = lineBreaks ? PLUGINS : FILE_PLUGINS
  const plugins =
    Object.keys(mentions).length === 0 ? base : [...base, remarkMentions(mentions)]

  return (
    <div className="w-full text-sm break-words">
      <ReactMarkdown remarkPlugins={plugins} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
