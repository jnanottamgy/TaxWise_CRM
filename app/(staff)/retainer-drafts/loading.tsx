import { SkeletonCard, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The retainer queue while it loads: the run summary, the filter bar and the table at their real size (§3.4). */
export default function RetainerDraftsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <SkeletonCard title="Daily run" rows={2} />
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
          <Skeleton className="h-9 w-full md:w-72" />
          <Skeleton className="h-8 w-40 flex-none" />
        </div>
        <SkeletonTable headers={["Client", "Engagement", "Period", "Billing date", "Total", "Status"]} rows={8} />
      </div>
    </div>
  )
}
