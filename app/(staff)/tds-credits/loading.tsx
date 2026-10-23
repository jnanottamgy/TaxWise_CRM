import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** TDS credits while they load: the header, the four totals, the view tabs and the register at their real size (§3.4). */
export default function TdsCreditsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <SkeletonKpiStrip labels={["Expected", "Reflected", "Claimed", "Without a TAN"]} />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex gap-1 border-b border-border pb-2">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-24" />
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
            <Skeleton className="h-9 w-full md:w-72" />
            <Skeleton className="h-8 w-56 flex-none" />
          </div>
          <SkeletonTable headers={["Client", "Invoice", "Paid on", "Quarter", "TDS", "Status"]} rows={8} />
        </div>
      </div>
    </div>
  )
}
