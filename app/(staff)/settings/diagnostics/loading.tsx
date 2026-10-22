import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonPageHeader } from "@/components/app/skeletons"

/** Diagnostics while the page itself loads (the checks then run one at a time on the page). */
export default function DiagnosticsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3.5 md:px-5">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-28" />
      </div>
      <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {Array.from({ length: 10 }, (_, i) => (
          <li key={i} className="flex items-center justify-between gap-4 px-4 py-3.5 md:px-5">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-6">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3.5 w-80 max-w-full" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </li>
        ))}
      </ol>
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  )
}
