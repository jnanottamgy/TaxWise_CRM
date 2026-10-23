import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Fee realisation while it loads: the header, the four figures, the engagement table and the leakage list at their real size (§3.4). */
export default function FeeRealisationLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <SkeletonKpiStrip labels={["Realisation", "Billing", "Agreed so far", "Not invoiced"]} />
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
          <Skeleton className="h-9 w-full md:w-72" />
          <Skeleton className="h-8 w-28 flex-none" />
        </div>
        <SkeletonTable headers={["Client", "Engagement", "Agreed", "Invoiced", "Billing %", "Realisation %", "Not invoiced"]} rows={10} />
      </div>
      <SkeletonCard title="Periods not invoiced" rows={4} />
    </div>
  )
}
