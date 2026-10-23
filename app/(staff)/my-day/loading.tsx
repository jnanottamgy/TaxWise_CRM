import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** My day while it loads: the same grid as the page, the timer first on phones (DESIGN.md §3). */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:grid-rows-[auto_1fr] lg:gap-6">
        <div aria-busy="true" className="min-w-0 rounded-lg border border-border bg-surface p-4 md:p-5 lg:col-start-3 lg:row-start-1">
          <div className="text-md leading-6 font-semibold text-text">Timer</div>
          <Skeleton className="mt-3 h-4 w-40" />
          <Skeleton className="mt-3 h-11 w-full" />
          <Skeleton className="mt-2 h-11 w-full" />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:gap-6">
          <SkeletonCard title="Due today and overdue" rows={4} />
          <SkeletonCard title="Your clients' deadlines" rows={4} />
          <SkeletonCard title="Messages from your clients" rows={2} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-3 lg:row-start-2 lg:gap-6">
          <div aria-busy="true" className="rounded-lg border border-border bg-surface p-4 md:p-5">
            <div className="text-md leading-6 font-semibold text-text">This week</div>
            <Skeleton className="mt-3 h-7 w-32" />
            <Skeleton className="mt-3 h-1.5 w-full" />
            <Skeleton className="mt-3 h-4 w-48" />
          </div>
          <SkeletonCard title="Leave" rows={2} />
        </div>
      </div>
    </div>
  )
}
