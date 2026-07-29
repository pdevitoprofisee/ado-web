import { Alert02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

import { cn } from '@/lib/utils'

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
 * `rehype-sanitize`'s GitHub schema, plus **two attributes on one element** and
 * nothing else. The base schema is a measured decision rather than laziness:
 * every tag the description corpus uses is already on its allowlist — `<p>`,
 * `<code>`, `<h1>`…`<h6>`, `<pre>`, `<ul>`, `<ol>`, `<li>`, `<table>` and
 * friends, `<a>` — while `<script>`, `<style>`, `<iframe>`, every `on*` handler,
 * inline `style` and any `href` outside `http`/`https`/`mailto`/`irc`/`xmpp` are
 * already off it.
 *
 * The extension is `data-diff-id` and `data-diff-type` on `<pre>`, which is how
 * Sonar pairs a non-compliant example with its compliant answer. Named, on one
 * element — not `data*` and not a widened schema: a wildcard would let a rule
 * contributor hang arbitrary attributes on anything, to recover two borders.
 *
 * **The names here are hast property names, not HTML attribute names.**
 * `hast-util-sanitize` filters the parsed tree, where `data-diff-id` is
 * `dataDiffId`, so spelling these the way the markup does drops them again and
 * silently — nothing errors, the borders just never appear. The component below
 * reads the same two attributes back under their *DOM* names, which is the other
 * half of the same trap.
 */
export const RULE_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    pre: [...(defaultSchema.attributes?.pre ?? []), 'dataDiffId', 'dataDiffType'],
  },
}

/**
 * `pre > code` is styled through the `pre` for the same reason `markdown.tsx`
 * does it: react-markdown gives inline code and fenced code the same `code`
 * component, so the parent is the only thing that knows which one this is.
 *
 * Drawn the way that renderer draws it, down to the string: the sunken sheet, the
 * pen at construction weight round it, and `font-mono` on the `pre` itself so a
 * bare block does not fall back to the browser's generic monospace instead of the
 * one this system draws in.
 *
 * The pen colour is not in here, because on a `data-diff-type` pair it is the one
 * thing that changes. Everything else about the two blocks is identical.
 */
const PRE =
  'bg-muted mb-2 overflow-x-auto rounded-md border-[1.5px] p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit'

/**
 * Sonar's two `data-diff-type` values, and how each one is drawn.
 *
 * The labels are Sonar's own headings for these blocks, so a rule reads in-app
 * the way it reads on the rule page. **The label is not decoration.** `pen-green`
 * and `pen-red` are 4.01:1 and 4.65:1 on this sheet — fine for a stroke, and no
 * use at all to a reader who cannot tell the two hues apart, which is most of the
 * point of a "do this, not this" pair. The word says which is which; the pen and
 * the glyph only make it quicker to see.
 *
 * A value that is not one of these two falls through to the neutral block: Sonar
 * writes these attributes, and a third value would be Sonar saying something this
 * renderer has not measured.
 */
const DIFF_TYPES: Record<
  string,
  { readonly border: string; readonly pen: string; readonly icon: typeof Tick02Icon; readonly label: string }
> = {
  compliant: {
    border: 'border-pen-green',
    pen: 'text-pen-green',
    icon: Tick02Icon,
    label: 'Compliant solution',
  },
  noncompliant: {
    border: 'border-pen-red',
    pen: 'text-destructive',
    icon: Alert02Icon,
    label: 'Noncompliant code example',
  },
}

/**
 * `data-diff-type`, read back under the name it actually arrives with.
 *
 * The other half of the trap in `RULE_HTML_SCHEMA`: the schema allowlists the
 * hast property (`dataDiffType`), and react-markdown then hands the component the
 * *attribute* (`data-diff-type`). Two spellings of one thing, and reading the
 * wrong one gives `undefined` rather than an error. The cast is because React's
 * `<pre>` props do not type arbitrary `data-*`.
 */
const attribute = (props: object, name: string): string | undefined => {
  const value = (props as Record<string, unknown>)[name]

  return typeof value === 'string' ? value : undefined
}

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
  // `...rest` and not just `children`: destructuring only the children is how the
  // attributes get dropped a second time, after the schema has already let them
  // through. `data-diff-id` is carried onto the element rather than read, because
  // it is what says *which* pair a block belongs to — a rule with two examples of
  // two kinds has four of these blocks — and the labels below only say which half.
  pre: ({ children, ...rest }) => {
    const type = DIFF_TYPES[attribute(rest, 'data-diff-type') ?? '']
    const id = attribute(rest, 'data-diff-id')

    if (type === undefined) return <pre className={cn(PRE, 'border-border')}>{children}</pre>

    return (
      <div data-diff-id={id}>
        {/* `.annotation` is this system's label type, which is what a caption over
            a code block is. Outside the `<pre>`, because everything inside one is
            preformatted text and a heading is not. */}
        <p className="annotation mb-1 flex items-center gap-1.5">
          <HugeiconsIcon icon={type.icon} size={12} className={cn('shrink-0', type.pen)} aria-hidden />
          {type.label}
        </p>
        <pre className={cn(PRE, type.border)}>{children}</pre>
      </div>
    )
  },
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
