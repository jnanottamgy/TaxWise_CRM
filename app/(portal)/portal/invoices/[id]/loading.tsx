import { SkeletonCard, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"

/** One invoice while it loads: the header, the lines and the payment column at their real size. */
export default function Loading() {
  return (
    <div className="flex min-w-0 flex-col" aria-busy="true">
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SkeletonTable headers={["Service", "SAC", "GST", "Amount"]} rows={4} />
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Payment" rows={4} />
          <SkeletonCard title="Receipts" rows={2} />
        </div>
      </div>
    </div>
  )
}
