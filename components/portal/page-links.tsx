import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { pageCount, rangeLabel } from "@/components/app/data-table/params"

/**
 * Paging for a portal list that isn't a table (§2.3: paged in SQL): "1–25 of 60" with Previous and
 * Next as links that keep the rest of the URL. Server-safe.
 */
export function PageLinks({
  pathname,
  params,
  page,
  pageSize,
  total,
  className,
}: {
  pathname: string
  /** The other search params to keep (view, fy…). */
  params: Record<string, string | null | undefined>
  page: number
  pageSize: number
  total: number
  className?: string
}) {
  const count = pageCount(total, pageSize)
  if (total <= pageSize) return null
  const current = Math.min(Math.max(page, 1), count)
  const href = (p: number) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
    if (p > 1) sp.set("page", String(p))
    const qs = sp.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }
  const linkClass =
    "inline-flex h-8 items-center gap-1 rounded-md border border-text-muted/30 bg-surface px-3 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"
  const off = "inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-sm text-text-muted opacity-60 pointer-coarse:h-11"
  return (
    <nav aria-label="Pagination" className={cn("flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-sm text-text-muted md:px-5", className)}>
      <span className="num tabular-nums">{rangeLabel(current, pageSize, total)}</span>
      <span className="flex items-center gap-2">
        {current > 1 ? (
          <Link href={href(current - 1)} className={linkClass} scroll={false}>
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
            Previous
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
            Previous
          </span>
        )}
        {current < count ? (
          <Link href={href(current + 1)} className={linkClass} scroll={false}>
            Next
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            Next
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </span>
        )}
      </span>
    </nav>
  )
}
