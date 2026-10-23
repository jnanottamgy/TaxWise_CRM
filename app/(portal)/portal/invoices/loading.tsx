import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Invoices while they load: what is due, the views and the invoice table at their real size. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <SkeletonKpiStrip labels={["Amount due", "Overdue", "Earliest due date"]} className="mb-4 md:mb-6" />
      <Skeleton className="mb-4 h-10 w-80 max-w-full rounded-lg" />
      <div className="mb-3 flex justify-between gap-3">
        <Skeleton className="h-10 w-48 rounded-lg" />
        <Skeleton className="h-9 w-36" />
      </div>
      <SkeletonTable headers={["Invoice", "Date", "Due", "Total", "Due now", "Status", "Actions"]} rows={6} />
    </div>
  )
}
