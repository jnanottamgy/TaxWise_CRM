import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Workpapers while it loads (§3.4): the header, then the four workpaper cards, each with its title,
 * one line of description and its row of figures, at their real size.
 */
export default function WorkpapersLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        {[2, 3, 3, 3].map((figures, card) => (
          <div key={card} className="rounded-lg border border-border bg-surface">
            <div className="px-4 py-3.5 md:px-5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-2 h-3.5 w-80 max-w-full" />
            </div>
            <div className="grid grid-cols-2 divide-x divide-border border-t border-border sm:grid-cols-3">
              {Array.from({ length: figures }, (_, i) => (
                <div key={i} className="px-4 py-3 md:px-5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="mt-2 h-6 w-12" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
