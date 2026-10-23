import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Client groups while they load (§3.4): header, search and the table at its real size. */
export default function ClientGroupsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="pb-3">
        <Skeleton className="h-9 w-full md:w-72" />
      </div>
      <SkeletonTable headers={["Group", "Clients", "Open tasks", "Next deadline", "Outstanding", "Updated"]} rows={8} />
    </div>
  )
}
