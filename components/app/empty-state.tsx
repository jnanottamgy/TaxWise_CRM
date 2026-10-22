import { cn } from "@/lib/utils"

/**
 * What a list or section shows before it has anything (§3.4): an icon, one sentence on what would
 * be here, and one primary action. No illustrations, no "No data" pictures. Server-safe.
 *
 *   <EmptyState
 *     icon={<UsersIcon />}
 *     message="No clients yet. Add your first client to start tracking their work."
 *     action={<Button asChild><Link href="/clients/new">Add client</Link></Button>}
 *   />
 *   <EmptyState size="compact" message="Nothing due this week." />   // inside a SectionCard
 *
 * For a list that is empty only because of its filters, use <FilteredEmpty /> instead.
 */
export function EmptyState({
  icon,
  message,
  action,
  size = "default",
  className,
}: {
  /** A 20px grey lucide icon (no coloured circle). */
  icon?: React.ReactNode
  /** One sentence. */
  message: React.ReactNode
  /** One primary action (a Button). */
  action?: React.ReactNode
  /** `compact`: a short dashed slot inside a section card. */
  size?: "default" | "compact"
  className?: string
}) {
  if (size === "compact") {
    return (
      <div
        data-slot="empty-state"
        className={cn(
          "flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted",
          className
        )}
      >
        <p className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:flex-none">
          {icon}
          <span>{message}</span>
        </p>
        {action}
      </div>
    )
  }
  return (
    <div
      data-slot="empty-state"
      className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}
    >
      {icon ? <div className="text-text-muted [&_svg]:size-5" aria-hidden="true">{icon}</div> : null}
      <p className="max-w-[46ch] text-base text-balance text-text">{message}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
