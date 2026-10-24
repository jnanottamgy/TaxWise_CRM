import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The audit list while it loads: header, the five figures, the filter bar and the table at its real size (§3.4). */
export default function AuditsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Not archived", "At acceptance", "File assembly due", "Assembly overdue", "Report signed, no UDIN"]} className="mb-4" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-16", "w-16", "w-12", "w-36", "w-16"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Client", "Audit", "Stage", "Engagement partner", "Report date", "File assembly"]} rows={10} />
    </div>
  )
}
