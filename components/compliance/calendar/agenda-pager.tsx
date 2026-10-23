"use client"

import { TablePagination } from "@/components/app/data-table/pagination"
import { useTableUrlState } from "@/hooks/use-table-url-state"

/** The agenda's footer: "1–25 of 312", pages and the 25/50/100 size, written to the URL. */
export function AgendaPager({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const url = useTableUrlState({})
  return <TablePagination page={page} pageSize={pageSize} total={total} onPage={url.setPage} onPageSize={url.setPageSize} disabled={url.isPending} />
}
