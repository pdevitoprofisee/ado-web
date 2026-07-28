# Prof — the design system this app is drawn in

Source of truth: `src/styles.css`. This document explains what the tokens in
that file mean and how to reach for them, so that every surface in the app
speaks the same vocabulary.

## The idea

Ink on paper. Light is a pen on warm stock; dark is chalk on a deep board.

Prof's signature is not its palette — plenty of systems are navy and teal. It
is **linework**: corners that don't agree with each other, 1.5px pen strokes,
fills made of hatching rather than flat colour, rules and underlines that drift
off true across their length, and a grain over everything. A screen built in
Prof should look like a page someone drew on, not a page a printer produced.

Two consequences worth stating up front:

- **Prefer a drawn mark over a border.** Where the old design put `border-t`,
  Prof puts `.sketch-rule`. Where it underlined an active tab with a 2px
  border, Prof puts `.prof-tab__ink`.
- **Prefer a tint plus a hatch over a solid block.** A solid `bg-teal-500`
  shouts; `bg-teal-100 hatch-teal` reads as something filled in by hand.

## Palette

Reach for the *semantic* name when the role is generic and the *Prof* name when
you want a specific pen. Both are available as Tailwind utilities.

### Paper — surfaces, brightening as they rise

| Token | Utility | Use |
| --- | --- | --- |
| `--paper-0` | `bg-paper-0`, `bg-background` | the app itself |
| `--paper-1` | `bg-paper-1`, `bg-muted`, `bg-secondary` | sunken wells, table stripes, gutters |
| `--paper-2` | `bg-paper-2`, `bg-card` | a raised card |
| `--paper-3` | `bg-paper-3`, `bg-popover` | inputs, popovers — the brightest sheet |

In dark these invert in *meaning*, not in name: `--paper-1` is deeper than the
app (still "sunken"), `--paper-2` and `--paper-3` are lighter (still "raised").
`--muted` is the one token re-pointed under `.dark`, from `--paper-1` to
`--paper-2`, because a muted panel on a board reads as lifted rather than cut in.

### Ink — one navy family

| Token | Utility | Use |
| --- | --- | --- |
| `--ink-900` | `text-foreground`, `text-ink-900` | headings, body |
| `--ink-700` | `text-ink`, `text-primary`, `border-ink` | **the brand navy** — every deliberate pen stroke, links, emphasis |
| `--ink-500` | `text-muted-foreground`, `text-ink-500` | secondary text, captions |
| `--ink-300` | `text-ink-300` | placeholders, disabled |
| `--ink-150` | `text-ink-150`, `border-ink-150` | faint construction lines |

### Teal — the one non-ink brand colour

`teal-600` `teal-500` `teal-300` `teal-100`, as `text-teal-600`,
`bg-teal-100`, `border-teal-500`, … `--ring` is `teal-500`, so every focus ring
is already teal. `bg-accent` is `teal-100` — shadcn's hover surface and Prof's
faintest wash are the same thing here.

### Coloured pens — status

Each pen comes with the wash it lays down. Never use a raw red/amber/green from
Tailwind's default palette; they are not in this system.

| Pen | Wash | Meaning |
| --- | --- | --- |
| `pen-red` (`text-destructive`) | `pen-red-tint` | failure, rejection, deletion |
| `pen-amber` | `pen-amber-tint` | waiting, caution, draft |
| `pen-green` (= `teal-600`) | `pen-green-tint` | success, approval, addition |

**A pen is not automatically a text colour.** Measured against `--paper-0`, the
app's sheet: `pen-red` is 4.65:1, `pen-green` 4.01, `pen-amber` 3.39. Ink is
7.91 and secondary ink (`text-muted-foreground`, `--ink-500`) 4.92. Every one of
them clears the **3:1** a border, an icon or any other non-text mark owes; only
red, ink and secondary ink clear the **4.5:1** a word owes. So:

- amber and green are for **strokes, washes and icons** — `border-pen-amber`,
  `bg-pen-green-tint`, a `<Check className="text-pen-green">`;
- when the same status has to be a *word*, put the colour on the stroke or the
  wash and leave the type in ink. `pr-detail`'s draft chip is the pattern:
  `border-pen-amber bg-pen-amber-tint text-ink`, which is 7.2:1 and still the
  one amber thing on the row.

A pen on its own tint is worse than on paper, not better — `pen-red` drops from
4.65 to **4.08** on `pen-red-tint`. `ui/alert.tsx` accepts that for a whole
surface you are meant to notice; a single must-read sentence should stay on
paper. Recompute before assuming, and put the number in the comment.

### Lines — by intent, not by colour

| Token | Utility | Use |
| --- | --- | --- |
| `--line-strong` (= `--ink-700`) | `border-line-strong`, `border-ink` | a **deliberate outline** — the drawn box, a control's own edge |
| `--line-soft` | `border-border`, `border-line-soft` | a quiet division between neighbours |
| `--line-faint` | `border-line-faint` | a construction line you're barely meant to see |

`--border` and `--input` are both `--line-soft`. **`--input` is a stroke
colour, never a fill** — if you find `bg-input/30` or similar, replace it with
`bg-muted`.

## Geometry — the sketch radii

```
--radius-sketch-sm  --radius-sketch-md  --radius-sketch-lg  --radius-pill  --radius-blob
```

Every one is asymmetric on both axes, so no two corners of a box agree. That
asymmetry *is* the hand-drawn read.

Tailwind's radius scale is mapped onto them, so existing `rounded-*` classes are
already organic:

| Class | Resolves to | Use for |
| --- | --- | --- |
| `rounded-sm`, `rounded-md` | `sketch-sm` | **controls** — anything ≤ 40px tall: buttons, inputs, badges, rows |
| `rounded-lg` | `sketch-md` | panels, cards, file headers |
| `rounded-xl` | `sketch-lg` | dialogs, the largest surfaces |
| `rounded-pill` | `pill` | pills and progress tracks |
| `rounded-blob` | `blob` | avatars, dots |

**Hazard.** A multi-value radius is only legal in the `border-radius`
*shorthand*. These will silently drop the whole declaration:

- directional variants — `rounded-t-lg`, `rounded-b-xl`, `rounded-l-md`, …
- arithmetic — `rounded-[min(var(--radius-md),10px)]`, `calc(…)`

If a surface needs square corners on one edge, don't reach for a directional
class: either round the whole thing, or write the four corner longhands
explicitly with single values.

## Strokes and geometry constants

`--stroke-hair: 1px` · `--stroke-pen: 1.5px` · `--stroke-marker: 2.5px`

A Prof outline is `1.5px`, not `1px`. In Tailwind that is `border-[1.5px]`, or
just use `.sketch-box` which sets it. `--control-sm/md/lg` are `2/2.5/3rem`.

## Typography

- `font-sans` → **Hanken Grotesk** (variable, 100–900). UI, prose, headings.
- `font-mono` → **Spline Sans Mono** (variable, 300–700). Code, figures,
  filenames, counts, annotations.

Both are vendored in `src/fonts/` and declared in `src/styles.css` — this app
runs on localhost with no network egress, so a font CDN is not an option.

**Tailwind's size scale is unchanged.** Prof's own scale is close but not
identical, and this app is dense and tuned to Tailwind's; imposing Prof's would
resize every surface for no design gain. What changed is the *faces*, which is
the visible half. One addition: `text-2xs` (11px) for annotation-scale type.

Use `.annotation` for any small uppercase label ("FILES", "REVIEWERS",
"3 COMMENTS"): tiny mono, `0.08em` tracking, uppercase, secondary ink. It is
Prof's answer to every all-caps label in the app.

## The utility classes

From `src/styles.css`, `@layer components`:

| Class | What it does |
| --- | --- |
| `.paper-grain` | fractal-noise grain overlay. Already on `<body>`; add `--local` only if a panel needs its own |
| `.sketch-box` | the drawn card: pen outline, `sketch-md` corners, graphite lift. `--sm` / `--lg` change the corners; `--quiet` drops to `line-soft` and no shadow |
| `.sketch-rule` | a drawn horizontal rule. **6px tall** — it needs vertical room a 1px border doesn't |
| `.sketch-underline` | a drawn underline under an emphasised word. **Costs 8px of `padding-bottom`.** `--teal` for the teal pen |
| `.hatch-navy` `.hatch-teal` `.hatch-red` `.hatch-amber` `.hatch-cross` | hatch tiles. Pair with a tint background: the tint carries the colour, the hatch makes it read as drawn |
| `.annotation` | tiny uppercase mono label |
| `.prof-badge` (+ `__dot`, `--teal` `--navy` `--red` `--amber`) | hand-drawn status pill |
| `.prof-tabs` / `.prof-tab` (+ `--active`, `__ink`, `__count`) | tabs marked by drawn ink underneath, not a border. The strip owns its 24px gap and the tab owns its padding — **don't add `flex`/`gap-*` at the call site**, a `flex` tab is a block-level box and stacks |
| `.prof-avatar` | blob avatar with a pen outline |
| `.prof-progress` (+ `__fill`, `--red` `--amber` `--navy`) | hatched fill in a drawn pill |

Shadows: `shadow-card`, `shadow-raised`, `shadow-popover`. All graphite — a hard
1px offset like a sheet lifted off the page, then a wide soft cast. Never gloss,
never coloured.

Motion: `--duration-fast/base/slow` (120/200/320ms) with `ease-settle`.
`ease-settle` is a real Tailwind utility (`--ease-*` is a theme namespace);
**the durations are not** — v4 has no `--duration-*` namespace, so write
`duration-[var(--duration-fast)]`. No `@utility` shorthand exists for them
because almost nothing in this app animates: it's keyboard-driven, and a 120ms
settle on a row highlight trails behind `j`/`k` and lies about where the cursor
is. If you're reaching for a duration on a selection or navigation surface,
that's usually the wrong instinct rather than a missing utility.

## Focus

`src/styles.css` already applies `--focus-ring` to every focusable element on
`:focus-visible`: a 2px gap in paper, then 2px of teal, drawn as a **box-shadow
so it follows the organic corners** instead of boxing them. Don't add
`ring-*`/`outline-*` per component unless a control genuinely needs something
different, and if you do, keep it teal.

## Themes

Light (paper) is the default. Dark (chalk on a board) lives behind `.dark` on
`<html>` — the same class Tailwind's `dark:` variant is wired to. Prof's own
source uses `[data-theme="dark"]`; this app keeps `.dark` so the variant keeps
working.

`src/lib/theme.ts` is who puts it there. It is a module-level store read through
`useSyncExternalStore` — `useTheme()` to read, `toggleTheme()` to flip — and it
follows the OS until someone presses the toggle, after which the choice is in
`localStorage` under `ado-web.theme`. There is no third `system` value to cycle
back to: following the OS is what an app does before it has been told anything.

Three things hang off it:

- `THEME_INIT_SCRIPT`, inlined in `__root.tsx`'s `<head>`. It restates those
  four lines in ES5 because it has to run before the bundle exists — the class
  must be on `<html>` before first paint, since here the theme *is* the
  primitives. `<html>` carries `suppressHydrationWarning` for exactly that.
- `color-scheme`, declared in both `:root` and `.dark`. It is the one thing the
  tokens cannot reach: scrollbars, the caret, a `<select>`'s popup.
- The visible control, in the inbox header, and the `t` key, bound in
  `ShellCommands` so the diff has it too.

Because the semantic layer is all indirection through the primitives, **you
almost never need a `dark:` variant.** If you're writing one, first check
whether the token you want already re-resolves. Reach for `dark:` only when the
*design* differs between themes, not when the colour does.

## Diffs

Prof's coloured pens do the work here: **added is the brand teal**, not a
generic green; removed is the red pen. `bg-diff-add` / `bg-diff-delete` for
rows, `text-diff-add-fg` / `text-diff-delete-fg` for text.

`bg-diff-word` is special. `.diff-add` and `.diff-delete` each rebind
`--diff-word`, so a single `bg-diff-word` on an intra-line token renders teal
inside an added row and red inside a removed one without knowing which it's in.
**Don't break that indirection** — it's what lets `line-text.tsx` stay ignorant
of row polarity.

Syntax highlighting is the `vitesse-light` / `vitesse-dark` pair
(`THEME_NAMES` in `src/lib/highlight/bundle.ts`), chosen for warmth against
`--paper-0` and for a board that isn't pure black. The theme is a **parameter**
of `highlight(path, lines, theme)`, not a second colour on every token: a token
carries one resolved hex, so the sheet you are not reading on costs nothing and
switching re-tokenises instead of recolouring. `PLAIN_COLOR` in
`highlight/plain.ts` holds both foregrounds and each must equal its theme's
resolved foreground; `tokenise.test.ts` asserts both. Note dark's is
`#dbd7caee` — eight digits, Shiki's own alpha byte, and legal in CSS.

## House style for the code

Match what's already there. Specifically:

- Dense Tailwind utility classes, composed through `cn()` from `@/lib/utils`.
- Comments explain **why**, at the density the surrounding file already uses.
  This codebase's comments carry reasoning and tradeoffs, not restatements of
  the code. A comment that says what a class does is noise; one that says why
  this surface is sunken and its neighbour is raised is the point.
- Don't touch behaviour: DOM contracts (`data-pr-id` and friends), keyboard
  bindings via `useCommand`, `aria-label`s, virtualisation measurements, and
  component public APIs stay exactly as they are. This is a restyle.
- Don't change a test's expectations to match new markup unless the markup had
  to change; if it did, update the test in the same edit.
