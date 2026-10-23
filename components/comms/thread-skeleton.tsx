import { Skeleton } from "@/components/ui/skeleton"

/**
 * The Communication tab and the /messages thread pane while they stream in (§3.4): the channel
 * chips, three messages at their real sizes and the composer. Server-safe. Client 360 can use it
 * as the `communication` case of its TabSkeleton.
 */
export function CommunicationTabSkeleton() {
  return (
    <div aria-busy="true" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 md:px-5">
        <div className="flex gap-1">
          {["All", "Email", "WhatsApp", "Gmail", "Portal"].map((label) => (
            <span key={label} className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-sm text-text-muted">
              {label}
            </span>
          ))}
        </div>
        <Skeleton className="h-3.5 w-40 max-md:hidden" />
      </div>
      <div className="flex flex-col gap-2 px-3 py-4 md:px-5">
        <Skeleton className="h-20 w-full md:w-3/5" />
        <Skeleton className="h-16 w-full self-end md:w-1/2" />
        <Skeleton className="h-14 w-full" />
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3 md:px-5">
        <div className="flex justify-between">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-8 w-36" />
        </div>
        <Skeleton className="h-9 w-full md:w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}
