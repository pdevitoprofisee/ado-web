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
 *
 * Drawn the way that renderer draws it, down to the string: the sunken sheet, the
 * pen at construction weight round it, and `font-mono` on the `pre` itself so a
 * bare block does not fall back to the browser's generic monospace instead of the
 * one this system draws in. A rule's compliant/non-compliant pair is the same kind
 * of object as a stack trace in a description — something pasted into the page —
 * and the outline is doing work here that it is not doing there, because the
 * `data-diff-*` attributes that used to pair those blocks are dropped by the
 * sanitiser. A drawn box each is what is left to say "two snippets, not one".
 */
const PRE =
  'bg-muted border-border mb-2 overflow-x-auto rounded-md border-[1.5px] p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit'

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
  // `rounded-sm`, not bare `rounded`: the sketch radii are mapped onto the named
  // steps of the scale and bare `rounded` is the one that still resolves to
  // `--radius`, which puts a machine corner on every `<code>` in a sentence.
  code: ({ children }) => (
    <code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => <pre className={PRE}>{children}</pre>,
  // A new tab and `noreferrer`, exactly as the description renderer does it: a
  // rule's "Resources" section is a list of links to OWASP and CWE, and losing
  // half-read diff to one of them is not on offer. `rel` and `target` are added
  // here rather than allowed through the schema, so they cannot be overridden by
  // the incoming markup.
  //
  // Brand navy at the pen's 1.5px with the stroke lifted to 3px, as every other
  // link in the app is drawn — a "Resources" list is a dozen of these in a row,
  // and inheriting the body colour left them looking like underlined prose.
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
  // The margin mark in ink at the pen's weight, as the description renderer draws
  // it: the line down the side is the whole of what says "this is quoted", so it
  // should look drawn rather than like a 2px rule in the border colour.
  blockquote: ({ children }) => (
    <blockquote className="border-ink text-muted-foreground mb-2 border-l-[1.5px] pl-3 last:mb-0">
      {children}
    </blockquote>
  ),
  // A drawn rule — 6px where the border was 1px, hence the shorter margin. Worth
  // its height here in a way it would not be inside a thread card: a rule
  // contributor writing an `<hr>` into a description means a chapter break, and
  // there is at most a handful in a page of prose.
  hr: () => <hr className="sketch-rule my-2" />,
  table: ({ children }) => (
    <div className="mb-2 w-full overflow-x-auto last:mb-0">
      {/* Stripes on the body rows and no fill under the header, exactly as
          `markdown.tsx` sets the same table out — a rule's tables are short lists
          of values, and annotation headers plus an alternating body is enough
          structure without tinting two things the same paper. `tbody tr`, or the
          header row counts itself into the alternation. */}
      <table className="border-border w-full border-collapse border text-xs [&_tbody_tr:nth-child(odd)]:bg-muted">
        {children}
      </table>
    </div>
  ),
  // `.annotation` is what this system calls a column label, and it does the
  // separating a header fill would otherwise have to do.
  th: ({ children }) => (
    <th className="annotation border-border border px-2 py-1 text-left">{children}</th>
  ),
  td: ({ children }) => <td className="border-border border px-2 py-1 align-top">{children}</td>,
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
