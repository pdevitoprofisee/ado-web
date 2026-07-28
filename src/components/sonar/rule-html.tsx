import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

import type { Components } from 'react-markdown'
import type { Options as SanitizeSchema } from 'rehype-sanitize'

// A Sonar rule description, rendered as the markup it actually is.
//
// This is the deliberate mirror image of `markdown.tsx`, and the two have to
// stay separate components because their requirements are opposite. A pull
// request description is a colleague's typing, so `rehype-raw` is *not*
// installed there and raw HTML is escaped: a `<script>` in a description shows
// as eleven characters and nothing is ever created. A rule description is HTML
// — `descriptionSections[].content` measured as `<p>`, `<code>`, `<h3>` and
// `<h4>` in §11 of the inventory, and `mdDesc` came back **byte-identical** to
// `htmlDesc` on all 3 rules that had a description, so there is no markdown
// path to prefer and no way to opt out. Escaped, it reads as a page of angle
// brackets.
//
// So the HTML is parsed and then filtered, by a library, in that order:
// `rehype-raw` turns the raw nodes into real hast, and `rehype-sanitize` runs
// **after** it against an allowlist. The order is the entire safety property —
// sanitising first would inspect one text node, find nothing that looks like an
// element, and pass a `<script>` straight through to `rehype-raw` to parse.
// Nothing here uses `dangerouslySetInnerHTML`, and nothing here hand-rolls a
// filter: an allowlist is a corpus of edge cases (`<svg>` foreign content,
// `<math>` namespace confusion, attribute-value escapes) and a hand-rolled one
// is a list of the cases its author thought of.
//
// Sanitising is not a statement about sonarcloud.io. It is that the descriptions
// are authored by rule contributors, arrive over a channel this app does not
// control, and land in a page holding a credential-backed session — and the cost
// of allowlisting them is one dependency and no measurable render time.

/**
 * What a rule description is allowed to be.
 *
 * `rehype-sanitize`'s GitHub schema, unextended, and that is a measured decision
 * rather than laziness: every tag the description corpus uses is already on its
 * allowlist — `<p>`, `<code>`, `<h1>`…`<h6>`, `<pre>`, `<ul>`, `<ol>`, `<li>`,
 * `<table>` and friends, `<a>` — while `<script>`, `<style>`, `<iframe>`, every
 * `on*` handler, inline `style` and any `href` outside
 * `http`/`https`/`mailto`/`irc`/`xmpp` are already off it. Extending a schema
 * for tags nothing measured needs is an extension nobody can justify later.
 *
 * What this costs: Sonar hangs `data-diff-id` and `data-diff-type` on the
 * `<pre>` pairs it uses to show compliant against non-compliant code, and those
 * attributes are dropped. The code blocks still render, in order, with their
 * surrounding prose — the pairing is described in the text rather than drawn.
 * Allowing arbitrary `data-*` back in to recover a border is not a trade this
 * renderer makes.
 */
export const RULE_HTML_SCHEMA: SanitizeSchema = defaultSchema

/**
 * `pre > code` is styled through the `pre` for the same reason `markdown.tsx`
 * does it: react-markdown gives inline code and fenced code the same `code`
 * component, so the parent is the only thing that knows which one this is.
 */
const PRE =
  'bg-muted mb-2 overflow-x-auto rounded-md p-3 text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit'

// The heading scale is flattened harder than the description renderer's, because
// a rule reads at a deeper indent: it is inside an expanded finding group, which
// is inside a panel, which already has the page's `h2`. Sonar writes `<h2>`
// through `<h4>` inside a single section's content, so all three land small and
// the nesting survives only as one step of size.
const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  h2: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  h3: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-3 mb-1 font-medium first:mt-0">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-3 mb-1 font-medium first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 font-medium first:mt-0">{children}</h6>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  code: ({ children }) => (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => <pre className={PRE}>{children}</pre>,
  // A new tab and `noreferrer`, exactly as the description renderer does it: a
  // rule's "Resources" section is a list of links to OWASP and CWE, and losing
  // half-read diff to one of them is not on offer. `rel` and `target` are added
  // here rather than allowed through the schema, so they cannot be overridden by
  // the incoming markup.
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
}

/**
 * One blob of rule HTML, parsed and filtered.
 *
 * The markdown pipeline is doing the parsing because that is where `rehype-raw`
 * lives, not because anything here is markdown — HTML blocks pass through the
 * markdown phase untouched, and a rule description is HTML from its first
 * character.
 */
export function RuleHtml({ children }: { children: string }) {
  return (
    <div className="w-full text-sm break-words">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, [rehypeSanitize, RULE_HTML_SCHEMA]]}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
