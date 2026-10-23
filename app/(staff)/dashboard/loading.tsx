import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The dashboard while it loads: a strip of figures and the first rows of cards, at their real sizes
 * (DESIGN.md §3). The role isn't known yet, so the labels are left as bars.
 */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="flex flex-col gap-4 lg:gap-6">
        <SkeletonKpiStrip count={6} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={4} className="lg:col-span-2" />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <div aria-busy="true" className="rounded-lg border border-border bg-surface p-4 md:p-5 lg:col-span-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-64 max-w-full" />
            <Skeleton className="mt-4 h-[200px] w-full" />
          </div>
          <SkeletonCard rows={4} />
        </div>
      </div>
    </div>
  )
}
