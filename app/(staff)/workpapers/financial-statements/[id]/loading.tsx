import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** A statement while it loads: header, the four figures, the checks, the tabs and the balance sheet at their real size (§3.4). */
export default function FinancialStatementLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-3 h-4 w-56" />
      <SkeletonPageHeader />
      <Skeleton className="mb-4 h-4 w-80 max-w-full" />
      <SkeletonKpiStrip labels={["Profit for the year", "Total income", "Total assets", "Ledgers mapped"]} className="mb-4" />
      <div className="mb-6 rounded-lg border border-border bg-surface px-4 py-4 md:px-5">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      <div className="mb-4 flex gap-1 overflow-hidden border-b border-border pb-2">
        {["w-28", "w-28", "w-16", "w-32", "w-40"].map((w, i) => (
          <Skeleton key={i} className={`h-6 flex-none ${w}`} />
        ))}
      </div>
      <SkeletonTable headers={["Particulars", "Note", "This year", "Last year"]} rows={12} />
    </div>
  )
}
