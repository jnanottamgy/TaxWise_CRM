import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The client list while it loads: header, filter bar and the table at its real size (§3.4). */
export default function ClientsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-20", "w-20", "w-20", "w-16", "w-14", "w-20"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
        <div className="flex gap-2 md:ml-auto">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <SkeletonTable headers={["Client", "Code", "Status", "Priority", "Owner", "Services", "Next deadline", "Open tasks", "Actions"]} rows={10} />
    </div>
  )
}
