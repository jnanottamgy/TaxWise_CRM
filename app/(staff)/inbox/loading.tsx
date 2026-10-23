import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The Inbox while it loads: the action list and the updates at their real sizes (§3.4). */
export default function InboxLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between px-4 pt-4 pb-3 md:px-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
        {Array.from({ length: 2 }, (_, g) => (
          <div key={g} className="border-t border-border">
            <Skeleton className="mx-4 mt-3 mb-2 h-3.5 w-36 md:mx-5" />
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-2 md:px-5">
                <span className="size-2 flex-none" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-64 max-w-full" />
                  <Skeleton className="h-3.5 w-80 max-w-full" />
                </div>
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-6 mb-3 flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="mb-3 h-9 w-full md:w-72" />
      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-start gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
            <Skeleton className="mt-1 size-4" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-72 max-w-full" />
              <Skeleton className="h-3.5 w-full max-w-xl" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}
