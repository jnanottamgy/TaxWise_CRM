import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Messages while they load: alternating bubbles and the composer at their real size. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-3 py-4 sm:px-5">
        {[false, true, false, true].map((mine, i) => (
          <div key={i} className={mine ? "flex flex-col items-end gap-1" : "flex flex-col items-start gap-1"}>
            <Skeleton className="h-3 w-32" />
            <Skeleton className={mine ? "h-14 w-[60%] rounded-lg" : "h-20 w-[72%] rounded-lg"} />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-surface p-3 sm:p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-2 h-20 w-full" />
        <div className="mt-3 flex justify-between">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </div>
  )
}
