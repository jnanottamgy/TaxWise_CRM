import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Job templates while they load: header, the view switch, the filters and the list (§3.4). */
export default function JobTemplatesLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <Skeleton className="mb-3 h-9 w-64" />
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <Skeleton className="h-8 w-20" />
      </div>
      <SkeletonCard rows={6} />
    </div>
  )
}
