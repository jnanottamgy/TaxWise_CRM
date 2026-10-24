import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** The new-computation editor while it loads: the input sections and the comparison rail at their real size (§3.4). */
export default function NewItrLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="Client and year" rows={3} />
          <SkeletonCard title="Income" rows={5} />
          <SkeletonCard title="Deductions (old regime only)" rows={4} />
        </div>
        <SkeletonCard title="Comparison" rows={4} />
      </div>
    </div>
  )
}
