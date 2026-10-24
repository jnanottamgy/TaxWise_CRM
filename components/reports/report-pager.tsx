"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { TablePagination } from "@/components/app/data-table/pagination"

/**
 * The page control for a report's one long list (§2.3: paged on the server). Writes `?page` and
 * `?size` and keeps every filter.
 */
export function ReportPager({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }
  return (
    <TablePagination
      page={page}
      pageSize={pageSize}
      total={total}
      disabled={pending}
      onPage={(p) => go({ page: p > 1 ? String(p) : null })}
      onPageSize={(s) => go({ size: s === 25 ? null : String(s), page: null })}
    />
  )
}
