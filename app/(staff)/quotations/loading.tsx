import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Quotations while they load: sub-navigation, header, the four figures, filter bar and the table (§3.4). */
export default function QuotationsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-4 h-9 w-80 max-w-full rounded-lg" />
      <SkeletonPageHeader />
      <SkeletonKpiStrip className="mb-4" labels={["Waiting for approval", "Out with clients", "Follow-ups to hand off", "Accepted, not yet a client"]} />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-28", "w-32"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
        <Skeleton className="h-8 w-28 md:ml-auto" />
      </div>
      <SkeletonTable headers={["Quotation", "For", "Status", "Total", "Issued", "Valid until", "Sent", "Opened"]} rows={10} />
    </div>
  )
}
