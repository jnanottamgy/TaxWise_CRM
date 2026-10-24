import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The notices register while it loads: header, the five figures, the filter bar and the table at their real size (§3.4). */
export default function NoticesLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Replies overdue", "Replies due in 7 days", "Hearings in 7 days", "Appeals to file", "Open notices"]} className="mb-4" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-32", "w-16", "w-24"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Client", "Notice", "Status", "Next date", "Demand", "Assigned to"]} rows={10} />
    </div>
  )
}
