import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** A lead while it loads: header, timeline, quotations and the contact and details cards (§3.4). */
export default function LeadLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-4 h-9 w-80 max-w-full rounded-lg" />
      <Skeleton className="mb-2 h-4 w-40" />
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <SkeletonCard title="Timeline" rows={6} />
          <SkeletonCard title="Quotations" rows={2} />
          <SkeletonCard title="Conflict checks" rows={1} />
        </div>
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Contact" rows={5} />
          <SkeletonCard title="Details" rows={7} />
        </div>
      </div>
    </div>
  )
}
