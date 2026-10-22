import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonPageHeader } from "@/components/app/skeletons"

/**
 * A settings section while it loads (§3.4): the page header, then two form cards with their fields
 * as bars at the real size, and the save footer. Labels are unknown here, so they are bars too.
 */
export default function SettingsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      {[6, 4].map((fields, card) => (
        <div key={card} className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3.5 md:px-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 md:grid-cols-2 md:px-5 md:py-5">
            {Array.from({ length: fields }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 md:px-5">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="h-9 w-32" />
      </div>
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  )
}
