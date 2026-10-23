import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Deadlines while they load: the view tabs and deadline rows at their real height. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <Skeleton className="mb-4 h-10 w-72 max-w-full rounded-lg" />
      <div className="rounded-lg border border-border bg-surface">
        <div className="px-4 pt-4 pb-3 md:px-5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-4 w-56" />
        </div>
        <ul className="divide-y divide-border/70 px-4 pb-3 md:px-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="flex flex-col gap-2 py-3.5">
              <div className="flex justify-between gap-3">
                <Skeleton className="h-5 w-56 max-w-[70%]" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-4 w-[85%]" />
              <Skeleton className="h-4 w-40" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
