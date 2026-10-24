import { SkeletonCard, SkeletonDetailHeader } from "@/components/app/skeletons"

/** One notice while it loads: its facts, the log, the next date and the documents at their real size (§3.4). */
export default function NoticeLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonDetailHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="The notice" rows={7} />
          <SkeletonCard title="Log" rows={4} />
        </div>
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="Next" rows={2} />
          <SkeletonCard title="Documents" rows={3} />
        </div>
      </div>
    </div>
  )
}
