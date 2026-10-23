import { SkeletonCard, SkeletonDetailHeader } from "@/components/app/skeletons"

/** The invoice page while it loads: the invoice and the settlement column at their real size (§3.4). */
export default function InvoiceLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonDetailHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Invoice" rows={6} />
          <SkeletonCard title="Receipts" rows={2} />
          <SkeletonCard title="Sending history" rows={2} />
        </div>
        <div className="flex flex-col gap-4">
          <SkeletonCard title="Settlement" rows={5} />
          <SkeletonCard title="Details" rows={4} />
        </div>
      </div>
    </div>
  )
}
