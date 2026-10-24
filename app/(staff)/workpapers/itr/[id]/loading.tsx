import { SkeletonCard, SkeletonDetailHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** One computation while it loads: the comparison, the sheet and the record at their real size (§3.4). */
export default function ItrLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonDetailHeader />
      <div className="mb-4 flex gap-2 border-b border-border pb-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-6">
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Recommended regime" rows={5} />
          <SkeletonCard title="Computation, both regimes" rows={12} />
        </div>
        <SkeletonCard title="Record" rows={8} />
      </div>
    </div>
  )
}
