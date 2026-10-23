"use client"

import { ClockIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { formatMinutes, formatNumber } from "@/lib/format"
import type { UnbilledClientRow } from "@/lib/data/timesheet"

/**
 * Unbilled time by client (§7.10, Partners and Managers): billable time not on an invoice yet, with
 * its ₹ value (minutes × the person's billing rate), feeding invoices (§7.9.2). Time by someone
 * without a billing rate counts in the time but has no value; the row says how much.
 */

const columns: DataTableColumn<UnbilledClientRow>[] = [
  {
    id: "client_name",
    header: "Client",
    sortable: true,
    hideable: false,
    mobile: "primary",
    width: "34%",
    cell: (r) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-text">{r.client_name}</span>
        {r.client_code ? <span className="font-mono text-xs text-text-muted">{r.client_code}</span> : null}
      </span>
    ),
    mobileCell: (r) => <span className="font-medium text-text">{r.client_name}</span>,
  },
  { id: "minutes", header: "Time", align: "right", sortable: true, mobile: "secondary", cell: (r) => <span className="num tabular-nums">{formatMinutes(r.minutes)}</span> },
  { id: "entries", header: "Entries", align: "right", hideBelow: "lg", cell: (r) => <span className="num tabular-nums">{formatNumber(r.entries)}</span> },
  { id: "people", header: "People", align: "right", hideBelow: "lg", cell: (r) => <span className="num tabular-nums">{formatNumber(r.people)}</span> },
  { id: "oldest_started_at", header: "Oldest", align: "right", sortable: true, mobile: "secondary", cell: (r) => <DateText date={r.oldest_started_at} /> },
  {
    id: "amount",
    header: "Value",
    align: "right",
    sortable: true,
    mobile: "trailing",
    cell: (r) => (
      <span className="inline-flex flex-col items-end">
        <Money value={r.amount ?? (r.unrated_minutes === r.minutes ? null : "0")} />
        {r.unrated_minutes > 0 ? <span className="num text-xs text-text-muted tabular-nums">{formatMinutes(r.unrated_minutes)} without a rate</span> : null}
      </span>
    ),
  },
]

export function UnbilledTable({ rows, total, page, pageSize, sort, dir, hrefFor }: { rows: UnbilledClientRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; hrefFor: Record<string, string> }) {
  return (
    <DataTable
      id="unbilled-time"
      caption="Unbilled time by client"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.client_id}
      getRowHref={(r) => hrefFor[r.client_id] ?? null}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "amount", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "client" : "clients"}`}
      empty={<EmptyState icon={<ClockIcon />} message="No unbilled time. Billable time on client work shows here until it is put on an invoice." />}
    />
  )
}
