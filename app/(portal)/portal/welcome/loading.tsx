import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** The privacy notice while it loads: the notice's column of text and the acknowledgement card. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="rounded-lg border border-border bg-surface px-4 py-5 md:px-6 lg:col-span-2">
          <Skeleton className="h-5 w-48" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[92%]" />
              <Skeleton className="h-4 w-[70%]" />
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-5 md:px-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-[80%]" />
          <Skeleton className="mt-5 h-16 w-full" />
          <Skeleton className="mt-4 h-10 w-full" />
        </div>
      </div>
    </div>
  )
}
