import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The work tracker while it loads: header, the strip, the view switch, the filters and the table at their real size (§3.4). */
export default function WorkLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Open tasks", "Overdue", "Due this week", "Data awaited", "Waiting for acceptance"]} className="mb-4" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center md:justify-between">
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-24", "w-24", "w-16", "w-20", "w-20", "w-14", "w-24"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Task", "Client", "Status", "Priority", "Assignee", "Due", "Checklist"]} rows={10} />
    </div>
  )
}
