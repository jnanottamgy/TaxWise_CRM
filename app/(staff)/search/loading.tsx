import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Search while it loads: the header, the box, the type tabs and two result groups at their real size (§3.4). */
export default function SearchLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader withAction={false} className="pb-0 md:pb-0" />
      <Skeleton className="h-10 w-full md:max-w-xl" />
      <div className="flex gap-5 border-b border-border pb-2.5">
        {["w-10", "w-16", "w-14", "w-20"].map((w, i) => (
          <Skeleton key={i} className={`h-4 ${w}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <div key={card} className="rounded-lg border border-border bg-surface">
            <div className="flex items-center justify-between px-4 pt-4 pb-3 md:px-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-12" />
            </div>
            <ul className="border-t border-border/70">
              {Array.from({ length: 5 }, (_, r) => (
                <li key={r} className="flex h-12 items-center gap-3 border-b border-border/70 px-4 last:border-b-0 md:px-5">
                  <Skeleton className="size-4 rounded-sm" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className={r % 2 ? "h-3.5 w-[50%]" : "h-3.5 w-[65%]"} />
                    <Skeleton className="h-3 w-[40%]" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  )
}
