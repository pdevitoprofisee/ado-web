import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// An alert is where Prof's coloured pens belong: the wash carries the status,
// the pen outlines it, and a hatched bar runs down the margin so it reads as a
// passage someone marked up rather than a printed banner.
//
// The hatch is a 6px margin bar and not the whole field on purpose — the tiles
// are full-strength pen at an 8px pitch, and 14px prose sitting on top of that
// is texture fighting text. `pl-4` buys the bar its room; `overflow-hidden`
// lets the organic corners clip it. The bar is a pseudo-element rather than an
// element so the grid the icon/title/description layout depends on is
// untouched, and it is absolutely positioned so it never becomes a grid item.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 overflow-hidden rounded-lg border-[1.5px] px-2.5 py-2 pl-4 text-left text-sm before:absolute before:inset-y-0 before:left-0 before:w-1.5 has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // `default` carries both "connected" and "not connected yet", so it stays
      // in neutral ink; only a genuine failure gets a coloured pen.
      variant: {
        default: "border-ink bg-card text-card-foreground before:bg-[image:var(--hatch-navy)]",
        // The description takes the pen at full strength, not the `/90` it used
        // to. Prof's own danger surface is `pen-red` type on `pen-red-tint`,
        // which measures 4.08:1 — already short of AA for 14px prose, and
        // fading it to 90% took it to 3.9. Alpha on error text is a dark-theme
        // habit that costs contrast the light theme cannot spare.
        destructive:
          "border-destructive bg-pen-red-tint text-destructive *:[svg]:text-current before:bg-[image:var(--hatch-red)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
