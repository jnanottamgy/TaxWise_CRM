import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonCard, SkeletonTable } from "@/components/app/skeletons"
import type { DocumentSubtab } from "@/lib/schemas/documents"

/**
 * What each Documents view shows while it loads (§3.4): its own shape at its real size, real labels
 * at once, flat bars for the values, no shimmer. Server-safe.
 */
export function DocumentsTabSkeleton({ subtab }: { subtab: DocumentSubtab }) {
  if (subtab === "requests") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-40" />
        </div>
        <SkeletonCard title="Request" rows={4} />
        <SkeletonCard title="Request" rows={3} />
      </div>
    )
  }
  if (subtab === "checklist") return <SkeletonCard title="Document checklist" rows={7} />
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]" aria-busy="true">
      <div className="hidden flex-col gap-2 lg:flex">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Skeleton className="h-9 w-full max-w-sm" />
        <SkeletonTable headers={["Document", "Category", "FY · period", "Access", "Uploaded", ""]} rows={8} />
      </div>
    </div>
  )
}
