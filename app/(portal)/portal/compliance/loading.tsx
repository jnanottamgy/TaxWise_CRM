import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Compliance while it loads: the year's figures, the filters and the filing table at their real size. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Returns and deadlines", "Filed", "Still to file", "Overdue"]} className="mb-4 md:mb-6" />
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:justify-between">
        <Skeleton className="h-10 w-96 max-w-full rounded-lg" />
        <Skeleton className="h-9 w-40" />
      </div>
      <SkeletonTable headers={["Return", "Period", "Due", "Status", "Filed on", "Acknowledgement no.", "Download"]} rows={8} />
    </div>
  )
}
