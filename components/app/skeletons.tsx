import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Loading states shaped like the real content, at its real size, with no shimmer gradient and no
 * layout shift when the data lands (DESIGN.md §3). Real labels and headers show at once; only the
 * values are bars. Server-safe: use them in loading.tsx and Suspense fallbacks.
 *
 *   <SkeletonPageHeader />
 *   <SkeletonKpiStrip labels={["Outstanding", "Overdue", "Collected this month", "Unbilled"]} />
 *   <SkeletonTable headers={["Client", "Code", "Status", "Due", "Fee"]} rows={10} />
 *   <SkeletonCard title="Due this week" rows={5} />
 *   <SkeletonDetailHeader />
 */

function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="sr-only">
      {label}…
    </span>
  )
}

export function SkeletonPageHeader({ withAction = true, className }: { withAction?: boolean; className?: string }) {
  return (
    <div aria-busy="true" className={cn("flex items-start justify-between gap-6 pb-4 md:pb-6", className)}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {withAction ? <Skeleton className="h-9 w-28" /> : null}
      <Loading />
    </div>
  )
}

export function SkeletonKpiStrip({
  count,
  labels,
  className,
}: {
  count?: number
  /** Real labels show at once; only the values are bars. */
  labels?: string[]
  className?: string
}) {
  const n = labels?.length ?? count ?? 4
  const md = n === 2 ? "md:grid-cols-2" : n === 3 ? "md:grid-cols-3" : n === 5 ? "md:grid-cols-5" : n === 6 ? "md:grid-cols-6" : "md:grid-cols-4"
  return (
    <div aria-busy="true" className={cn("grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface", md, className)}>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className="border-border px-4 py-3 md:border-l md:px-5 md:py-4 md:first:border-l-0 max-md:[&:last-child:nth-child(odd)]:col-span-2 max-md:[&:nth-child(even)]:border-l max-md:[&:nth-child(n+3)]:border-t"
        >
          {labels?.[i] ? <div className="text-sm leading-5 text-text-muted">{labels[i]}</div> : <Skeleton className="my-0.5 h-4 w-24" />}
          <Skeleton className="mt-2 h-6 w-28" />
          <Skeleton className="mt-2 h-4 w-20" />
        </div>
      ))}
      <Loading />
    </div>
  )
}

const WIDTHS = ["w-[70%]", "w-[45%]", "w-[60%]", "w-[35%]", "w-[55%]", "w-[40%]"]

export function SkeletonTable({
  headers,
  columns,
  rows = 8,
  className,
}: {
  headers?: string[]
  columns?: number
  rows?: number
  className?: string
}) {
  const n = headers?.length ?? columns ?? 5
  return (
    <div aria-busy="true" className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}>
      <div className="flex h-11 items-center border-b border-border px-4">
        <Skeleton className="h-4 w-28" />
      </div>
      {/* Desktop: table rows at the real row height. */}
      <table className="hidden w-full table-fixed md:table">
        <thead>
          <tr className="h-9 bg-surface-2">
            {Array.from({ length: n }, (_, c) => (
              <th key={c} scope="col" className={cn("px-3 text-left text-xs font-medium text-text-muted", c === 0 && "w-[34%]")}>
                {headers?.[c] ?? <Skeleton className="h-3 w-16" />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="h-(--row-height) border-t border-border/70">
              {Array.from({ length: n }, (_, c) => (
                <td key={c} className="px-3">
                  <Skeleton className={cn("h-3.5", c === 0 ? "w-[75%]" : WIDTHS[(r + c) % WIDTHS.length])} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Phone: stacked cards. */}
      <ul className="md:hidden">
        {Array.from({ length: Math.min(rows, 6) }, (_, r) => (
          <li key={r} className="flex flex-col gap-2 border-t border-border/70 px-4 py-3 first:border-t-0">
            <div className="flex justify-between gap-4">
              <Skeleton className="h-4 w-[55%]" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-3 w-[40%]" />
          </li>
        ))}
      </ul>
      <div className="flex h-12 items-center justify-between border-t border-border px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Loading />
    </div>
  )
}

export function SkeletonCard({
  title,
  rows = 4,
  className,
}: {
  title?: string
  rows?: number
  className?: string
}) {
  return (
    <div aria-busy="true" className={cn("rounded-lg border border-border bg-surface", className)}>
      <div className="px-4 pt-4 pb-3 md:px-5">
        {title ? <div className="text-md leading-6 font-semibold text-text">{title}</div> : <Skeleton className="my-1 h-4 w-36" />}
      </div>
      <ul className="px-4 pb-4 md:px-5">
        {Array.from({ length: rows }, (_, r) => (
          <li key={r} className="flex h-11 items-center justify-between gap-4 border-t border-border/70 first:border-t-0">
            <div className="flex w-[60%] flex-col gap-1.5">
              <Skeleton className="h-3.5 w-[80%]" />
              <Skeleton className="h-3 w-[45%]" />
            </div>
            <Skeleton className="h-3.5 w-16" />
          </li>
        ))}
      </ul>
      <Loading />
    </div>
  )
}

export function SkeletonDetailHeader({ className }: { className?: string }) {
  return (
    <div aria-busy="true" className={cn("@container rounded-lg border border-border bg-surface p-4 md:p-5", className)}>
      <Skeleton className="h-3.5 w-40" />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-3 @md:grid-cols-2 @3xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-32 max-w-full" />
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Loading />
    </div>
  )
}
