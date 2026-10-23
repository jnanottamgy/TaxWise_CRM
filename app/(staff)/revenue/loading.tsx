import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Revenue while it loads: the header with its period, the three views, the totals, the ledger and the exports at their real size (§3.4). */
export default function RevenueLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex gap-1 border-b border-border pb-2">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-24" />
        </div>
        <SkeletonKpiStrip labels={["Billed", "Fees (taxable)", "GST", "Received", "Outstanding"]} />
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
            <Skeleton className="h-9 w-full md:w-72" />
          </div>
          <SkeletonTable headers={["Invoice", "Date", "Client", "Taxable", "Total", "Outstanding", "Status"]} rows={10} />
        </div>
      </div>
      <SkeletonCard title="Exports" rows={2} />
    </div>
  )
}
