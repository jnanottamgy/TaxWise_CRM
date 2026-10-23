import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Help while it loads: the questions and the contact card. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader withAction={false} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="rounded-lg border border-border bg-surface lg:col-span-2">
          <div className="px-4 pt-4 pb-3 text-md leading-6 font-semibold text-text md:px-5">Questions</div>
          <ul className="divide-y divide-border/70 border-t border-border">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="flex min-h-12 items-center justify-between px-4 md:px-5">
                <Skeleton className="h-4 w-[70%]" />
                <Skeleton className="size-4" />
              </li>
            ))}
          </ul>
        </div>
        <SkeletonCard title="Contact us" rows={5} />
      </div>
    </div>
  )
}
