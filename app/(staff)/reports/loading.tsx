import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

const GROUPS = [
  { title: "Delivery and compliance", cards: 3 },
  { title: "Fees and collections", cards: 2 },
  { title: "Clients and growth", cards: 2 },
  { title: "Team", cards: 1 },
]

/** The reports centre while it loads: the group headings at once, the cards at their real size (§3.4). */
export default function ReportsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-6">
      <SkeletonPageHeader withAction={false} className="pb-0 md:pb-0" />
      {GROUPS.map((g) => (
        <div key={g.title} className="flex flex-col gap-3">
          <div className="text-sm font-semibold text-text-muted">{g.title}</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: g.cards }, (_, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 md:p-5">
                <div className="flex h-6 items-center gap-2">
                  <Skeleton className="size-4 rounded-sm" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-4 w-[85%]" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-[70%]" />
                <Skeleton className="mt-2 h-4 w-36" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  )
}
