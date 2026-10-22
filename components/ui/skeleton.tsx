import { cn } from "@/lib/utils"

/**
 * A placeholder at the real size of the content (DESIGN.md §3). A tint of the text colour, not
 * --surface-2, so it reads on the page background as well as on cards and the table header band.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-text/[0.07] motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
