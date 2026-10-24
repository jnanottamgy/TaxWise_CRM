import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The reconciliation list while it loads: header, the month's four figures, filters and the table at its real size (§3.4). */
export default function GstReconLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["ITC at risk", "Unclaimed ITC", "Clients reconciled", "Open lines"]} className="mb-4" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-16", "w-24", "w-16", "w-14"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Client", "Month", "Matched", "Mismatch", "Not in 2B", "ITC at risk", "Open", "State"]} rows={10} />
    </div>
  )
}
