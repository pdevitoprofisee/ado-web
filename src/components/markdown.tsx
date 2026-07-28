import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

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

/** Markdown text, rendered. Whitespace-only input renders nothing; the caller decides what to say about that. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="w-full text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
