"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { pageCount, rangeLabel } from "@/components/app/data-table/params"

/**
 * Previous / next links for a list inside a tab that pages with its own search param (so it never
 * disturbs the page's other lists): "26–50 of 112".
 */
export function TablePaginationLinks({ page, pageSize, total, param }: { page: number; pageSize: number; total: number; param: string }) {
  const pathname = usePathname()
  const sp = useSearchParams()
  const count = pageCount(total, pageSize)
  if (count <= 1) return null
  const href = (p: number) => {
    const next = new URLSearchParams(sp.toString())
    if (p <= 1) next.delete(param)
    else next.set(param, String(p))
    const qs = next.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 md:px-5">
      <span className="num text-sm text-text-muted">{rangeLabel(page, pageSize, total)}</span>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={href(page - 1)} scroll={false}>
              <ChevronLeftIcon aria-hidden="true" />
              Newer
            </Link>
          </Button>
        ) : null}
        {page < count ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={href(page + 1)} scroll={false}>
              Older
              <ChevronRightIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>
    </nav>
  )
}
