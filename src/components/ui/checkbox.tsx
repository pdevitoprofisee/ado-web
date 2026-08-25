import * as React from "react"
import {
  Checkbox as CheckboxPrimitive,
  composeRenderProps,
} from "react-aria-components"

import { cn } from "@/lib/utils"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

/**
 * A checkbox and its label, as one hit target.
 *
 * The box is a drawn `<span>`, not the input: `react-aria-components` hides the
 * real one so the label, the keyboard and the screen reader keep working, which
 * also puts it out of reach of the app's `:focus-visible` rule. So the teal ring
 * is painted here on the visible box, from the same `--focus-ring` token — a
 * `ring-*` utility would draw a hard-edged box, which Prof does not have.
 *
 * `items-start` because the label is allowed to be a sentence: an override on a
 * merge has to say what it overrides, and that wraps onto a second line.
 */
function Checkbox({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CheckboxPrimitive>, "children"> & {
  children: React.ReactNode
}) {
  return (
    <CheckboxPrimitive
      data-slot="checkbox"
      className={composeRenderProps(className, (className) =>
        cn(
          "group flex items-start gap-2 text-sm leading-snug text-foreground select-none data-disabled:pointer-events-none data-disabled:opacity-50",
          className
        )
      )}
      {...props}
    >
      {({ isSelected, isFocusVisible }) => (
        <>
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border-[1.5px] border-input bg-popover transition-colors",
              isSelected && "border-ink bg-primary text-primary-foreground",
              isFocusVisible && "shadow-[var(--focus-ring)]"
            )}
          >
            {isSelected ? (
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.8} />
            ) : null}
          </span>
          {children}
        </>
      )}
    </CheckboxPrimitive>
  )
}

export { Checkbox }
