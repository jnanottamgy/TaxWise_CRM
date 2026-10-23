import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The invoice list while it loads: header, the three figures, the filter bar and the table at its real size (§3.4). */
export default function InvoicesLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Outstanding", "Overdue", "Awaiting approval"]} className="mb-4" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-14", "w-28", "w-24", "w-16"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
        <Skeleton className="h-8 w-24 md:ml-auto" />
      </div>
      <SkeletonTable headers={["Number", "Date", "Client", "Total", "Received", "Outstanding", "Due", "Status"]} rows={10} />
    </div>
  )
}
