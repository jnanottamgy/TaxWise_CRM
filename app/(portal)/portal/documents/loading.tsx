import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Documents while they load: a request card with its items, then the shared documents table. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <div className="mb-3 text-md font-semibold text-text">What we&apos;ve asked for</div>
      <div className="mb-6 rounded-lg border border-border bg-surface md:mb-8">
        <div className="border-b border-border px-4 py-3.5 md:px-5">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="mt-2 h-4 w-40" />
        </div>
        <ul className="divide-y divide-border/70 px-4 md:px-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="flex flex-col gap-2 py-3.5">
              <div className="flex justify-between gap-3">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-14 w-full rounded-lg" />
            </li>
          ))}
        </ul>
      </div>
      <SkeletonTable headers={["Document", "Type", "Year", "Shared on", "Open"]} rows={5} />
    </div>
  )
}
