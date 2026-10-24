import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The dashboard while it loads (DESIGN.md §3): the first screen at its real size, before the role is
 * known. A card beside a 3 × 3 block of figures (Approvals and the firm's figures for Partners; the
 * first queue lists for Managers sit at the same height), then a list beside a wider list, then a
 * chart. Flat bars, no shimmer, labels left as bars.
 */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="flex flex-col gap-4 lg:gap-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <SkeletonCard rows={4} />
          <div aria-busy="true" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 lg:col-span-2">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className={i === 0 ? "bg-surface px-4 py-3 max-md:col-span-2 md:px-5" : "bg-surface px-4 py-3 md:px-5"}>
                <Skeleton className="my-0.5 h-4 w-24" />
                <Skeleton className={i === 0 ? "mt-2 h-8 w-32" : "mt-2 h-6 w-24"} />
                <Skeleton className="mt-2 h-4 w-28" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={4} className="lg:col-span-2" />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          <div aria-busy="true" className="rounded-lg border border-border bg-surface p-4 md:p-5 lg:col-span-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-64 max-w-full" />
            <Skeleton className="mt-4 h-[200px] w-full" />
          </div>
          <div aria-busy="true" className="rounded-lg border border-border bg-surface p-4 md:p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-2 h-3 w-48 max-w-full" />
            <Skeleton className="mt-4 h-[200px] w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
