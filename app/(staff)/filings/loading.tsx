import { SkeletonKpiStrip, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]

/** The filings grid while it loads: header, tabs, controls, the summary and the grid at its real size (§3.4). */
export default function FilingsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="mb-4 flex h-10 items-end gap-4 border-b border-border">
        <Skeleton className="mb-2 h-4 w-12" />
        <Skeleton className="mb-2 h-4 w-28" />
      </div>
      <div className="flex flex-wrap items-end gap-3 pb-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-44" />
      </div>
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <SkeletonKpiStrip labels={["Filed", "Overdue", "Under review", "Not started or in progress"]} className="mb-4" />
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex border-b border-border bg-surface-2">
          <div className="w-40 flex-none px-3 py-2 text-xs text-text-muted md:w-52 md:px-4">Client</div>
          {MONTHS.map((m) => (
            <div key={m} className="flex w-[4.25rem] flex-none flex-col items-center gap-1 py-2 text-xs text-text-muted">
              {m}
              <Skeleton className="h-3 w-8" />
            </div>
          ))}
        </div>
        {Array.from({ length: 10 }, (_, r) => (
          <div key={r} className="flex border-b border-border last:border-b-0">
            <div className="flex w-40 flex-none flex-col gap-1 px-3 py-2 md:w-52 md:px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            {MONTHS.map((m) => (
              <div key={m} className="w-[4.25rem] flex-none px-1 py-2">
                <Skeleton className="h-7 w-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
