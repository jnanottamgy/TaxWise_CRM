"use client"

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PAGE_SIZES, pageCount, pageWindow, rangeLabel, formatCount } from "@/components/app/data-table/params"

/**
 * The table footer (§3.4): "1–25 of 1,284", page controls and the 25/50/100 page-size select.
 * Controlled: the DataTable wires it to the URL.
 *
 *   <TablePagination page={2} pageSize={25} total={1284} onPage={setPage} onPageSize={setPageSize} />
 */
export function TablePagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  disabled,
  className,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  onPageSize?: (size: number) => void
  disabled?: boolean
  className?: string
}) {
  const count = pageCount(total, pageSize)
  const current = Math.min(page, count)
  const pages = pageWindow(current, count)

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-3 py-2 text-sm text-text-muted md:px-4",
        className
      )}
    >
      <p className="num tabular-nums" aria-live="polite">
        {rangeLabel(page, pageSize, total)}
      </p>
      <div className="flex items-center gap-3">
        {onPageSize ? (
          <label className="flex items-center gap-2">
            <span className="max-sm:sr-only">Rows per page</span>
            <select
              value={pageSize}
              disabled={disabled}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="num h-8 cursor-pointer rounded-md border border-text-muted/30 bg-surface px-2 text-sm text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 pointer-coarse:h-11"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={disabled || current <= 1}
            onClick={() => onPage(current - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <ol className="hidden items-center gap-1 md:flex">
            {pages.map((p, i) =>
              p === "gap" ? (
                <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-text-muted">
                  …
                </li>
              ) : (
                <li key={p}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-current={p === current ? "page" : undefined}
                    aria-label={`Page ${p}`}
                    onClick={() => p !== current && onPage(p)}
                    className={cn(
                      "num inline-flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-md px-2 text-sm tabular-nums transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait",
                      p === current ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-2"
                    )}
                  >
                    {formatCount(p)}
                  </button>
                </li>
              )
            )}
          </ol>
          <span className="num px-1 text-text tabular-nums md:hidden">
            {current} / {count}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={disabled || current >= count}
            onClick={() => onPage(current + 1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </nav>
  )
}
