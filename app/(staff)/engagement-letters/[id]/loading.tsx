import { SkeletonCard, SkeletonDetailHeader } from "@/components/app/skeletons"

/** The letter while it loads: its terms, schedule and details at their real size (§3.4). */
export default function LetterLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonDetailHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Terms" rows={5} />
          <SkeletonCard title="Services and fees" rows={3} />
        </div>
        <SkeletonCard title="Details" rows={8} />
      </div>
    </div>
  )
}
