import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Settings → Templates while it loads (§3.4): the header and the two cards with their figures. */
export default function TemplatesSettingsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      {[0, 1].map((card) => (
        <div key={card} className="rounded-lg border border-border bg-surface">
          <div className="px-4 py-3.5 md:px-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3.5 w-96 max-w-full" />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border border-t border-border">
            {[0, 1].map((i) => (
              <div key={i} className="px-4 py-3 md:px-5">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="mt-2 h-6 w-10" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
