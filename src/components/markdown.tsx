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
 */
const PRE = 'bg-muted mb-2 overflow-x-auto rounded-md p-3 text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit'

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
  code: ({ children }) => (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => <pre className={PRE}>{children}</pre>,
  // A new tab, because the app is a single page you are half way down a diff on
  // and a work-item link should not take that away. `noreferrer` covers `opener`
  // too, so a linked page cannot reach back through `window.opener`.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground mb-2 border-l-2 pl-3 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border/60 my-3" />,
  table: ({ children }) => (
    <div className="mb-2 w-full overflow-x-auto last:mb-0">
      <table className="border-border/60 w-full border-collapse border text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-border/60 border px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-border/60 border px-2 py-1 align-top">{children}</td>,
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
