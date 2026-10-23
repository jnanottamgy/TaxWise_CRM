import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonCard } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The timesheet while it loads: header, the week switch, the week's figures, the grid and the entries (§3.4). */
export default function TimesheetLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="mb-3 flex items-center gap-1">
        <Skeleton className="size-8" />
        <Skeleton className="mx-2 h-5 w-44" />
        <Skeleton className="size-8" />
      </div>
      <div className="flex flex-col gap-4 lg:gap-6">
        <SkeletonKpiStrip count={4} />
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3 md:px-5">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="mt-1.5 h-4 w-80 max-w-full" />
          </div>
          <div className="flex flex-col gap-2 p-4 md:px-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-9 w-40 flex-none md:w-60" />
                <Skeleton className="hidden h-9 flex-1 md:block" />
                <Skeleton className="h-9 w-24 md:hidden" />
              </div>
            ))}
          </div>
        </div>
        <SkeletonCard rows={5} />
      </div>
    </div>
  )
}
