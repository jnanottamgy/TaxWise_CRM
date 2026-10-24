import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** One report while it loads: header, the filter bar, the headline figures and its first sections (§3.4). */
export default function ReportLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <div className="flex gap-2 overflow-hidden">
        {["w-44", "w-28", "w-20", "w-24", "w-20"].map((w, i) => (
          <Skeleton key={i} className={`h-8 flex-none ${w}`} />
        ))}
      </div>
      <Skeleton className="h-4 w-64 max-w-full" />
      <SkeletonKpiStrip count={4} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <SkeletonCard rows={6} className="lg:col-span-7" />
        <SkeletonCard rows={6} className="lg:col-span-5" />
      </div>
      <SkeletonTable columns={6} rows={8} />
    </div>
  )
}
