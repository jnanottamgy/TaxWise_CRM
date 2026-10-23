import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** A draft quotation while it loads: who it's for and the dates side by side, then the lines and notes (§3.4). */
export default function EditQuotationLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <SkeletonCard title="Who it's for" rows={4} />
        <SkeletonCard title="Dates" rows={2} />
      </div>
      <SkeletonCard className="mt-4 lg:mt-6" title="Line items" rows={3} />
      <SkeletonCard className="mt-4 lg:mt-6" title="Notes and terms" rows={2} />
    </div>
  )
}
