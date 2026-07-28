import * as React from "react"
import {
  composeRenderProps,
  Input as InputPrimitive,
} from "react-aria-components"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  ...props
}: React.ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={composeRenderProps(className, (className) =>
        cn(
          // `bg-popover` is the brightest sheet in the paper stack, which is
          // what a field you can type into should be — it was `bg-transparent`
          // with a `bg-input/30` dark override, and `--input` is a *stroke*
          // colour in Prof, never a fill. Disabled drops to the sunken sheet
          // instead: nothing to type into any more.
          // Placeholders are `ink-300`, a step fainter than secondary text, so
          // a hint never competes with a real value.
          "h-8 w-full min-w-0 rounded-sm border-[1.5px] border-input bg-popover px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-300 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
          className
        )
      )}
      {...props}
    />
  )
}

export { Input }
