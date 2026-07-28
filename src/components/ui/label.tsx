import {
  LabelContext,
  Label as LabelPrimitive,
  type LabelProps,
} from "react-aria-components"

import { cn } from "@/lib/utils"

function Label({ className, htmlFor, slot, ...props }: LabelProps) {
  const label = (
    <LabelPrimitive
      data-slot="label"
      // Full-strength ink, not secondary: a label names the field you are
      // filling in, so it is body text, not a caption. Deliberately *not*
      // `.annotation` — every Label in this app is a sentence-case field name
      // ("Personal access token"), and Prof reserves the tiny uppercase mono
      // for section labels that shout ("FILES", "3 COMMENTS").
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-data-disabled:opacity-50",
        className
      )}
      {...props}
      htmlFor={htmlFor}
      slot={slot}
    />
  )

  if (htmlFor && slot === undefined) {
    return <LabelContext.Provider value={null}>{label}</LabelContext.Provider>
  }

  return label
}

export { Label }
