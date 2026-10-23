import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** The invoice form while it loads: the two columns at their real size (§3.4). */
export default function NewInvoiceLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <SkeletonCard title="Client and dates" rows={3} />
          <SkeletonCard title="Lines" rows={3} />
          <SkeletonCard title="Notes and terms" rows={2} />
        </div>
        <SkeletonCard title="Invoice total" rows={5} />
      </div>
    </div>
  )
}
