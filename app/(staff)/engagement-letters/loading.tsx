import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Engagement letters while they load: header, the FY's five figures, the views, filters and list at their real size (§3.4). */
export default function EngagementLettersLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["No letter", "Issued, not signed", "Signed", "Drafts", "Expiring in 30 days"]} className="mb-4" />
      <div className="mb-4 flex h-10 items-end gap-1 overflow-hidden border-b border-border">
        {["w-16", "w-36", "w-36"].map((w, i) => (
          <Skeleton key={i} className={`mb-2 h-4 flex-none ${w}`} />
        ))}
      </div>
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-20", "w-16", "w-14"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Client", "FY", "Services", "Fee (excl. GST)", "Status", "Expires"]} rows={10} />
    </div>
  )
}
