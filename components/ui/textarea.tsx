import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-md border border-text-muted/30 bg-surface px-3 py-2 text-base text-text transition-[color,border-color,box-shadow] duration-150 outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted aria-invalid:border-danger aria-invalid:ring-danger/20 max-md:text-md",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
