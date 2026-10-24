import { SkeletonCard, SkeletonDetailHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"
import { AUDIT_STAGES, AUDIT_STAGE_LABELS } from "@/lib/domain/audit-stages"

/** The engagement page while it loads: the header, the seven-stage tracker with its real labels, the checklist and the side column at their size (§3.4). */
export default function AuditLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonDetailHeader />
      <div className="-mx-4 overflow-x-hidden px-4 md:mx-0 md:px-0">
        <ol className="flex w-max min-w-full divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {AUDIT_STAGES.map((s, i) => (
            <li key={s} className="flex min-w-[9.5rem] flex-1 flex-col gap-1.5 px-3 py-2.5">
              <span className="text-sm text-text-muted">
                {i + 1}. {AUDIT_STAGE_LABELS[s]}
              </span>
              <Skeleton className="h-3 w-24" />
            </li>
          ))}
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Before the next stage" rows={3} />
          <SkeletonCard title="Checklist" rows={7} />
        </div>
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Materiality" rows={4} />
          <SkeletonCard title="Report and UDIN" rows={3} />
          <SkeletonCard title="File assembly" rows={2} />
        </div>
      </div>
    </div>
  )
}
