import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Messages while they load: the conversation list and the open thread at their real sizes (§3.4). */
export default function MessagesLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-surface">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex min-h-16 items-start gap-2.5 border-b border-border/70 px-4 py-2.5 last:border-b-0">
              <span className="mt-2 size-2 flex-none" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex justify-between gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-3.5 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden rounded-lg border border-border bg-surface lg:block">
          <div className="border-b border-border px-5 py-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-1.5 h-3.5 w-64" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-20 w-3/5" />
            <Skeleton className="ml-auto h-24 w-3/5" />
            <Skeleton className="h-16 w-full" />
          </div>
          <div className="border-t border-border px-5 py-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="mt-3 h-28 w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
