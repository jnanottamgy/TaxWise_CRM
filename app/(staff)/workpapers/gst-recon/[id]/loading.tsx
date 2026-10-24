import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** A reconciliation run while it loads: header, the four ITC figures, the tabs and a table at their real size (§3.4). */
export default function GstReconRunLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-3 h-4 w-56" />
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["ITC at risk", "Unclaimed ITC", "ITC per GSTR-2B", "ITC per books"]} className="mb-4" />
      <div className="mb-4 flex gap-1 overflow-hidden border-b border-border pb-2">
        {["w-20", "w-24", "w-20", "w-24", "w-20", "w-20", "w-24", "w-28"].map((w, i) => (
          <Skeleton key={i} className={`h-6 flex-none ${w}`} />
        ))}
      </div>
      <SkeletonTable headers={["Bucket", "Documents", "GST in 2B", "GST in books", "Difference"]} rows={4} />
    </div>
  )
}
