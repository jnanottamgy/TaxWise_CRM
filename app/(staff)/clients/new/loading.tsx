import { SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Add client while the team, the next client code and the settings load (§3.4): the wizard frame at its real size. */
export default function NewClientLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="flex min-h-[min(36rem,70dvh)] overflow-hidden rounded-xl border border-border bg-surface">
        <div className="hidden w-64 flex-none flex-col gap-2 border-r border-border p-3 lg:flex">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-5 sm:p-6">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </div>
      </div>
      <span role="status" className="sr-only">
        Loading the wizard…
      </span>
    </div>
  )
}
