import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** A task while it loads: the header, the action row, then the two columns at their real size (§3.4). */
export default function TaskLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-3 h-4 w-40" />
      <SkeletonPageHeader />
      <div className="mb-4 flex flex-wrap gap-2">
        {["w-44", "w-28", "w-24", "w-36", "w-28"].map((w, i) => (
          <Skeleton key={i} className={`h-9 ${w}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="flex flex-col gap-4 lg:col-span-2 lg:gap-6">
          <SkeletonCard title="Details" rows={6} />
          <SkeletonCard title="Checklist" rows={5} />
          <SkeletonCard title="Comments" rows={3} />
        </div>
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="Time" rows={2} />
          <SkeletonCard title="Dependencies" rows={2} />
          <SkeletonCard title="History" rows={4} />
        </div>
      </div>
    </div>
  )
}
