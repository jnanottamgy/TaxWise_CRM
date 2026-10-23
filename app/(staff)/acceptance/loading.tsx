import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The acceptance register while it loads: sub-navigation, header, the four figures, filters and the table (§3.4). */
export default function AcceptanceLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <Skeleton className="mb-4 h-9 w-80 max-w-full rounded-lg" />
      <SkeletonPageHeader />
      <SkeletonKpiStrip className="mb-4" labels={["Pending a decision", "Accepted", "Declined", "With matches"]} />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-24", "w-24", "w-40"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
        <Skeleton className="h-8 w-28 md:ml-auto" />
      </div>
      <SkeletonTable headers={["Checked", "Prospect", "Matches", "Decision", "Decided", "For"]} rows={10} />
    </div>
  )
}
