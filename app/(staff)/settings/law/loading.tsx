import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { LAW_TABS } from "@/components/settings/law/law-tabs"

/** Law & rules while it loads: the review stamp, the tabs (real labels) and the table at its size. */
export default function LawLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3.5 md:px-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="min-w-0">
        <div className="flex gap-1 overflow-hidden border-b border-border">
          {LAW_TABS.map((t) => (
            <span key={t.id} className="flex h-10 items-center px-3 text-sm whitespace-nowrap text-text-muted">
              {t.label}
            </span>
          ))}
        </div>
        <div className="pt-4">
          <div className="flex gap-2 pb-3">
            <Skeleton className="h-9 w-72 max-w-full" />
            <Skeleton className="h-9 w-32" />
          </div>
          <SkeletonTable headers={["Parameter", "Value", "In force", "Source", "Confirmation", "Actions"]} rows={10} />
        </div>
      </div>
    </div>
  )
}
