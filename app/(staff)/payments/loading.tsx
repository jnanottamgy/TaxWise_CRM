import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The payments dashboard while it loads: the figures, the two charts and the two lists at their real size (§3.4). */
export default function PaymentsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <SkeletonPageHeader withAction={false} className="pb-0 md:pb-0" />
      <SkeletonKpiStrip labels={["Outstanding", "Overdue", "Collected this month", "Collection rate", "Days sales outstanding", "Unbilled time"]} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="rounded-lg border border-border bg-surface p-4 lg:col-span-2 md:p-5">
          <div className="text-md font-semibold text-text">Collections by month</div>
          <Skeleton className="mt-2 h-4 w-64" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 md:p-5">
          <div className="text-md font-semibold text-text">Receivables ageing</div>
          <Skeleton className="mt-2 h-4 w-48" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        <SkeletonCard title="Top 10 debtors" rows={6} />
        <SkeletonCard title="Promised and received" rows={5} />
      </div>
    </div>
  )
}
