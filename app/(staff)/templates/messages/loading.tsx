import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Message templates while they load: header, filters and the list at its real size (§3.4). */
export default function MessageTemplatesLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-8 w-20" />
      </div>
      <SkeletonTable headers={["Template", "Type", "Channel", "Last changed", "Status"]} rows={10} />
    </div>
  )
}
