import { Skeleton } from "@/components/ui/skeleton"

/** The client's quotation while it loads: the title row, then the document's letterhead, lines and totals (§3.4). */
export default function PublicQuotationLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-10 w-40" />
      </div>
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-5 md:px-8 md:py-7">
        <div className="flex flex-col justify-between gap-4 border-b-2 border-border pb-4 sm:flex-row">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3.5 w-40" />
          </div>
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
        <div className="flex justify-end">
          <Skeleton className="h-16 w-full md:w-[40%]" />
        </div>
      </div>
    </div>
  )
}
