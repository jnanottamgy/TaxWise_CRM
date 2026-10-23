import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** The calendar while it loads: header, filters, the view controls and a month at its real size (§3.4). */
export default function CalendarLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="flex gap-2 pb-3">
        {["w-20", "w-20", "w-16", "w-16"].map((w, i) => (
          <Skeleton key={i} className={`h-8 flex-none ${w}`} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="ml-1 h-5 w-36" />
        </div>
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-7 border-b border-border bg-surface-2 text-xs text-text-muted md:grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5">
              {w}
            </div>
          ))}
        </div>
        <div className="hidden grid-cols-7 md:grid">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className={`min-h-28 border-b border-border p-1.5 ${i % 7 !== 0 ? "border-l" : ""}`}>
              <Skeleton className="size-6 rounded-full" />
              {i % 3 === 0 ? <Skeleton className="mt-2 h-8 w-full" /> : null}
              {i % 5 === 0 ? <Skeleton className="mt-1 h-8 w-full" /> : null}
            </div>
          ))}
        </div>
        <div className="divide-y divide-border md:hidden">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3 px-3 py-3">
              <Skeleton className="h-8 w-12" />
              <Skeleton className="h-8 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
