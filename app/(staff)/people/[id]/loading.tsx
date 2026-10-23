import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonCard } from "@/components/app/skeletons"

/** A person's page while it loads (§3.4): the header, key facts, the tab row and two section cards. */
export default function PersonLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3.5 w-40" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 rounded-full max-sm:hidden" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3 md:grid-cols-2 md:px-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
      <div className="flex gap-4 border-b border-border pb-2.5">
        {["Profile", "Work", "Time", "Attendance", "Leave", "Activity", "Performance"].map((t) => (
          <span key={t} className="text-sm font-medium text-text-muted">
            {t}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SkeletonCard title="Details" rows={6} />
        <SkeletonCard title="Access and rates" rows={5} />
      </div>
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  )
}
