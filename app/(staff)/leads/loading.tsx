import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Leads while they load: the sub-navigation, header, view tabs, filter bar and pipeline columns at their real size (§3.4). */
export default function LeadsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-4 h-9 w-80 max-w-full rounded-lg" />
      <SkeletonPageHeader />
      <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
      <div className="mt-3 flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-20", "w-24", "w-32"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }, (_, c) => (
          <div key={c} className="flex w-64 flex-none flex-col gap-2 rounded-lg border border-border bg-surface-2/60 p-2">
            <Skeleton className="h-6 w-28" />
            {Array.from({ length: 3 }, (_, r) => (
              <Skeleton key={r} className="h-24 w-full rounded-md" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
