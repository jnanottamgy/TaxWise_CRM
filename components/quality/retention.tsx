"use client"

import * as React from "react"
import { FileSearchIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { formatCount } from "@/components/app/data-table/params"
import { EMPTY } from "@/lib/format"
import type { DisposalRow, RetentionYear } from "@/lib/data/quality"
import { cn } from "@/lib/utils"

/**
 * Documents by the year their retention ends (§7.15.4 "Retention summary: documents by retention
 * year"), each row's thin grey bar its share of the busiest year, with how many are already past
 * it. A table, so the figures read without the bars (§13).
 */
export function RetentionSummary({ years, thisYear }: { years: RetentionYear[]; thisYear: number }) {
  const max = Math.max(1, ...years.map((y) => y.documents))
  if (!years.length) return <p className="px-4 pb-4 text-sm text-text-muted md:px-5">No document has a retention date yet.</p>
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Documents by the year their retention ends</caption>
      <thead>
        <tr className="text-left text-xs text-text-muted">
          <th scope="col" className="px-4 py-2 font-normal md:px-5">Retention ends</th>
          <th scope="col" className="px-3 py-2 text-right font-normal">Documents</th>
          <th scope="col" className="px-4 py-2 text-right font-normal md:px-5">Past retention</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border border-t border-border">
        {years.map((y) => (
          <tr key={y.year}>
            <td className="px-4 py-2 md:px-5">
              <span className={cn("num", y.year === thisYear ? "font-medium text-text" : "text-text")}>{y.year}</span>
              <span aria-hidden="true" className="mt-1 block h-0.5 rounded-full bg-text-muted/40" style={{ width: `${Math.max(2, Math.round((y.documents / max) * 88))}%` }} />
            </td>
            <td className="num px-3 py-2 text-right">{formatCount(y.documents)}</td>
            <td className={cn("num px-4 py-2 text-right md:px-5", y.past_retention > 0 ? "text-warning-text" : "text-text-muted")}>{formatCount(y.past_retention)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The "review for disposal" list (§6.8): documents past `retention_until`, oldest first, marked
 * when they sit in an archived audit file. Nothing is deleted automatically; a Partner deletes a
 * document from the client's vault and purges it from the recycle bin once satisfied.
 */
export function DisposalTable(props: { rows: DisposalRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string }) {
  const { rows, total, page, pageSize, sort, dir, today } = props
  const columns = React.useMemo<DataTableColumn<DisposalRow>[]>(
    () => [
      {
        id: "title",
        header: "Document",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "32%",
        rowLink: true,
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate">{r.title ?? EMPTY}</span>
            <span className="truncate text-xs text-text-muted">{r.file_name}</span>
          </span>
        ),
        mobileCell: (r) => r.title ?? EMPTY,
      },
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name ?? EMPTY,
      },
      { id: "category", header: "Category", hideBelow: "lg", cell: (r) => <span className="text-text-muted capitalize">{(r.category ?? "").replace(/_/g, " ")}</span> },
      { id: "financial_year", header: "FY", hideBelow: "xl", cell: (r) => (r.financial_year ? <span className="num">{r.financial_year}</span> : <span className="text-text-muted">{EMPTY}</span>) },
      {
        id: "retention_until",
        header: "Retention ended",
        sortable: true,
        align: "right",
        mobile: "trailing",
        cell: (r) => <DateText date={r.retention_until} withRelative today={today} stacked />,
        mobileCell: (r) => <DateText date={r.retention_until} />,
      },
      {
        id: "in_audit_file",
        header: "Audit file",
        hideBelow: "lg",
        cell: (r) => (r.in_audit_file ? <StatusChip label="Archived audit file" tone="violet" meaning="Part of an archived audit file. Its retention ran from the report date (SQC 1)." /> : <span className="text-text-muted">{EMPTY}</span>),
      },
    ],
    [today]
  )
  return (
    <DataTable
      id="disposal"
      caption="Documents past retention"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id ?? ""}
      getRowHref={(r) => (r.client_id ? `/clients/${r.client_id}?tab=documents` : null)}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "retention_until", dir: "asc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "document" : "documents"} past retention`}
      empty={<EmptyState icon={<FileSearchIcon />} message="No document is past its retention date. They appear here when it passes; nothing is deleted automatically." />}
    />
  )
}
