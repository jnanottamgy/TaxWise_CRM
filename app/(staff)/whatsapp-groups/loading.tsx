import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The WhatsApp groups page while it loads: header, the status strip, linked PCs, filters and the table at their real sizes. */
export default function WhatsAppGroupsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader withAction={false} className="pb-0 md:pb-0" />
      <SkeletonKpiStrip labels={["No group yet", "To create", "Active", "Closed"]} />
      <div className="rounded-lg border border-border bg-surface px-4 py-3 md:px-5">
        <p className="text-sm font-medium text-text">PCs linked per number</p>
        <div className="mt-2 flex flex-wrap gap-6">
          {["w-36", "w-40", "w-44"].map((w) => (
            <Skeleton key={w} className={`h-4 ${w}`} />
          ))}
        </div>
      </div>
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
          <Skeleton className="h-9 w-full md:w-72" />
          <div className="flex gap-2">
            {["w-20", "w-28", "w-20"].map((w, i) => (
              <Skeleton key={i} className={`h-8 flex-none ${w}`} />
            ))}
          </div>
        </div>
        <SkeletonTable headers={["Client", "Status", "Members", "Checklist", "Last opened", "Created"]} rows={10} />
      </div>
    </div>
  )
}
