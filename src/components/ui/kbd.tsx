import { Keyboard as KbdPrimitive } from "react-aria-components"

import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <KbdPrimitive
      data-slot="kbd"
      // A drawn key rather than a grey chip: mono legend in the brand pen, a
      // 1.5px stroke, and `shadow-card` for the one graphite offset that makes
      // it read as lifted off the paper. `text-2xs` because these sit inline in
      // running prose ("<Kbd>Esc</Kbd> to go back") and mono runs wide — at
      // `text-xs` the key outgrows the sentence around it.
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border-[1.5px] border-ink bg-card px-1 font-mono text-2xs font-medium text-ink shadow-card select-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <KbdPrimitive
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
