import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The recycle bin while it loads: header, the filter bar and the table at its real size (§3.4). */
export default function RecycleBinLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-16", "w-20", "w-24"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Record", "Type", "Client or lead", "Deleted", "Deleted by", "Actions"]} rows={10} />
    </div>
  )
}
