import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** A quotation while it loads: header, the document, and the tracking, follow-ups, related, sends and history cards (§3.4). */
export default function QuotationLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-4 h-9 w-80 max-w-full rounded-lg" />
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-5 md:px-8 md:py-7">
          <div className="flex flex-col justify-between gap-4 border-b-2 border-border pb-4 sm:flex-row">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
              <Skeleton className="h-3.5 w-48" />
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3.5 w-36" />
            </div>
          </div>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-60" />
          <div className="flex flex-col gap-2 pt-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <div className="flex justify-end">
            <div className="flex w-full flex-col gap-2 md:w-[40%]">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="Tracking" rows={5} />
          <SkeletonCard title="Follow-ups" rows={3} />
          <SkeletonCard title="Related" rows={3} />
        </div>
      </div>
    </div>
  )
}
