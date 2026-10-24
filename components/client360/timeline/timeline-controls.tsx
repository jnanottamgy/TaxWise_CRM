"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { FilterBar, type FilterOption } from "@/components/app/filter-bar"
import { TablePagination } from "@/components/app/data-table/pagination"
import { PAGE_SIZES } from "@/components/app/data-table/params"
import { useTableUrlState } from "@/hooks/use-table-url-state"
import { isDateString } from "@/lib/domain/fy"

/**
 * The Timeline tab's filters (§7.3.3 "filterable"): search in the titles, the kind of event, and a
 * date range in IST days (`?from=&to=`, the link the cover-ended notice opens, §4.7). All of it
 * lives in the URL and is applied in SQL; every change goes back to page 1.
 */
export function TimelineFilters({ groups }: { groups: FilterOption[] }) {
  const url = useTableUrlState({ filters: ["type", "from", "to"] })
  const from = url.filters.from?.[0] ?? ""
  const to = url.filters.to?.[0] ?? ""
  const fromId = React.useId()
  const toId = React.useId()
  const set = (name: "from" | "to", value: string) => url.setFilter(name, value && isDateString(value) ? [value] : null)

  return (
    <FilterBar
      searchLabel="Search the timeline"
      searchPlaceholder="Search event titles"
      filters={[{ id: "type", label: "Kind of event", options: groups }]}
      actions={
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center" role="group" aria-label="Date range">
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <label htmlFor={fromId} className="text-sm text-text-muted">
              From
            </label>
            <Input id={fromId} type="date" value={from} max={to || undefined} onChange={(e) => set("from", e.target.value)} className="num h-9 w-full tabular-nums sm:h-8 sm:w-auto" />
          </div>
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <label htmlFor={toId} className="text-sm text-text-muted">
              To
            </label>
            <Input id={toId} type="date" value={to} min={from || undefined} onChange={(e) => set("to", e.target.value)} className="num h-9 w-full tabular-nums sm:h-8 sm:w-auto" />
          </div>
        </div>
      }
    />
  )
}

export function TimelinePagination({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const url = useTableUrlState()
  // Nothing to page through: every event is on the first page at the smallest page size.
  if (page === 1 && total <= PAGE_SIZES[0]) return null
  return <TablePagination page={page} pageSize={pageSize} total={total} onPage={url.setPage} onPageSize={url.setPageSize} disabled={url.isPending} />
}
