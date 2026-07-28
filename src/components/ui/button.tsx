import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  Button as ButtonPrimitive,
  Link as LinkPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
  type LinkProps as LinkPrimitiveProps,
} from "react-aria-components"

import { cn } from "@/lib/utils"

// A Prof control is a 1.5px pen stroke around four corners that don't agree with
// each other. That geometry decides two things here.
//
// Radius: every size stays on `rounded-sm`. The per-size
// `rounded-[min(var(--radius-md),Npx)]` shrinkers can't exist — arithmetic on a
// multi-value radius drops the declaration outright — and aren't wanted anyway,
// because `rounded-lg` now resolves to the *panel* radius, which reads visibly
// round on a 32px control. The `in-data-[slot=button-group]:rounded-lg` opt-outs
// go with them: there is no ButtonGroup in this app, and rounding a 24px button
// to a panel radius would be the wrong answer if there were.
//
// Focus: no `ring-*` anywhere. styles.css draws the teal ring as a box-shadow
// precisely so it follows those corners; a ring would box them back up. Invalid
// state is the red pen on the control's own edge for the same reason.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-sm border-[1.5px] border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all duration-[var(--duration-fast)] ease-settle outline-none select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // The stack, quietest to loudest: nothing (ghost), a soft division on a
      // sunken sheet (secondary), a deliberate ink outline on a raised one
      // (outline), the navy filled in (default), the red pen (destructive).
      variant: {
        // Bordered in its own fill so the 1.5px edge doesn't read as an inset
        // gap under `bg-clip-padding`; hover deepens to the strongest ink,
        // which brightens under `.dark` for free rather than fading the fill.
        default:
          "border-primary bg-primary text-primary-foreground hover:border-ink-900 hover:bg-ink-900",
        // `bg-card`, not `bg-background`: an outlined control is a thing lying
        // on the page, so it sits one sheet above it. Hover picks up the
        // faintest teal wash rather than dropping to the sunken sheet.
        outline:
          "border-ink bg-card hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        // Outlined in the red pen over its own wash, and filled in on hover —
        // the destructive action should look drawn round, not pre-committed.
        destructive:
          "border-destructive bg-pen-red-tint text-destructive hover:bg-destructive hover:text-on-ink",
        // Deliberately *not* `.sketch-underline`: it costs 8px of
        // padding-bottom, which a fixed-height control can't spend without the
        // label jumping on hover.
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: Omit<ButtonPrimitiveProps, "className"> &
  React.RefAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    className?: string
  }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

function LinkButton({
  className,
  variant = "default",
  size = "default",
  ...props
}: Omit<LinkPrimitiveProps, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string
  }) {
  return (
    <LinkPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, LinkButton, buttonVariants }
