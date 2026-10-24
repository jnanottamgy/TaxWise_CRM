import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"
import { QUALITY_TABS } from "@/lib/schemas/quality"

/** The quality module while it loads: the section list (real labels), the header and a list at its size (§3.4). */
export default function QualityLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 lg:flex-row lg:gap-8">
      <aside className="hidden lg:flex lg:w-52 lg:flex-none lg:flex-col lg:gap-0.5">
        {QUALITY_TABS.map((t) => (
          <span key={t.id} className="flex h-8 items-center px-3 text-sm text-text-muted">
            {t.label}
          </span>
        ))}
      </aside>
      <div className="flex gap-1 overflow-hidden lg:hidden">
        {QUALITY_TABS.slice(0, 5).map((t) => (
          <span key={t.id} className="flex h-9 flex-none items-center px-3 text-sm text-text-muted">
            {t.label}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <SkeletonPageHeader withAction={false} />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-9 w-24" />
        </div>
        <SkeletonTable headers={["Area", "State", "Section"]} rows={11} />
      </div>
    </div>
  )
}
