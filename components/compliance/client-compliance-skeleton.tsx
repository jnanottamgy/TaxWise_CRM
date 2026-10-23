import { SkeletonCard, SkeletonKpiStrip } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Client 360 → Compliance while it streams in (§3.4): the actions, the summary strip, the status
 * per period and the calendar at their real size. For components/client360/tab-skeletons.tsx.
 * Server-safe.
 */
export function ClientComplianceSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-4 w-80 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      <SkeletonKpiStrip labels={["Next deadline", "Overdue", "Filed so far", "Still to come"]} />
      <SkeletonCard title="Status per period" rows={4} />
      <SkeletonCard title="Calendar" rows={6} />
    </div>
  )
}
