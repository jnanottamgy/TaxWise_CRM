import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonCard, SkeletonKpiStrip } from "@/components/app/skeletons"

/**
 * Client 360 while it loads (§3.4): the header with its chips and actions, the key-facts card, the
 * tab row with the real tab names, and the Overview's shape. Real labels show at once; values are
 * flat bars at their real size, so nothing shifts when the data lands.
 */
export default function ClientLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-40" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-7 w-64 max-w-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-16" />
          </div>
          <div className="hidden gap-2 md:flex">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-20" />
          </div>
          <Skeleton className="h-11 w-full md:hidden" />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface px-4 py-3 md:px-5">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {["Code", "Entity", "Owner", "Group", "PAN", "GSTIN", "TAN"].map((t) => (
            <div key={t} className="flex flex-col gap-1">
              <span className="text-xs leading-4 text-text-muted">{t}</span>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-4 w-48" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-20" />
            ))}
          </div>
        </div>
      </div>

      <div className="-mx-4 overflow-x-hidden px-4 md:mx-0 md:px-0">
        <div className="flex min-w-max gap-0.5 border-b border-border">
          {["Overview", "Profile & contacts", "Tasks", "Compliance", "Documents", "Workpapers", "Registers", "Communication", "WhatsApp group", "Timeline"].map((t) => (
            <span key={t} className="inline-flex h-10 items-center px-3 text-sm font-medium whitespace-nowrap text-text-muted">
              {t}
            </span>
          ))}
        </div>
      </div>

      <SkeletonKpiStrip labels={["Open tasks", "Overdue", "Next deadline", "Last contact"]} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <SkeletonCard title="Open work" rows={5} />
        <SkeletonCard title="Key facts and dates" rows={6} />
      </div>
      <span role="status" className="sr-only">
        Loading the client…
      </span>
    </div>
  )
}
