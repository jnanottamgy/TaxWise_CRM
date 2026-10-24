"use client"

import * as React from "react"
import { FileSpreadsheetIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { FS_LIST_DEFAULT_SORT, FS_STATUS_META, type FsStatus } from "@/lib/schemas/financial-statements"
import type { StatementListRow } from "@/lib/data/financial-statements"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

/** `plain` inside a link (Client 360 rows): the label only, since the chip can't be a button there. */
export function FsStatusChip({ status, variant = "dot", plain = false }: { status: FsStatus; variant?: "dot" | "pill"; plain?: boolean }) {
  const m = FS_STATUS_META[status]
  return plain ? <StatusChip label={m.label} tone={m.tone} variant={variant} /> : <StatusChip label={m.label} tone={m.tone} meaning={m.meaning} variant={variant} />
}

export function ChecksCell({ row, plain = false }: { row: Pick<StatementListRow, "all_checks_passed" | "failed_checks" | "unmapped_count" | "ledger_count">; plain?: boolean }) {
  if (row.ledger_count === 0) return <span className="text-text-muted">No trial balance</span>
  if (row.all_checks_passed) {
    const meaning = "Checks pass: the trial balance agrees, the balance sheet balances, every ledger is mapped and the profit ties to the movement in capital and reserves."
    return plain ? <StatusChip label="Checks pass" tone="success" /> : <StatusChip label="Checks pass" tone="success" meaning={meaning} />
  }
  const parts = [row.failed_checks ? `${row.failed_checks} failing` : null, row.unmapped_count ? `${row.unmapped_count} unmapped` : null].filter(Boolean).join(" · ")
  const meaning = "Checks fail: open the statement to see which check fails and what to fix. A statement is final only when every check passes."
  return plain ? <StatusChip label={parts || "Checks fail"} tone="danger" /> : <StatusChip label={parts || "Checks fail"} tone="danger" meaning={meaning} />
}

/**
 * The statements list (§7.8.3): client, financial year, status (Draft → Reviewed → Final), the
 * checks, the profit and the totals, who prepared and reviewed it. Server-paged and sorted; a row
 * opens the statement. Below 768px each row is a card: client, FY, status, checks.
 */
export function StatementsTable(props: { rows: StatementListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; showClient?: boolean }) {
  const { showClient = true } = props
  const columns = React.useMemo<DataTableColumn<StatementListRow>[]>(() => {
    const cols: DataTableColumn<StatementListRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        rowLink: true,
        width: "26%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      { id: "financial_year", header: "FY", sortable: true, mobile: showClient ? "secondary" : "primary", rowLink: !showClient, cell: (r) => <span className="num whitespace-nowrap">FY {r.financial_year}</span> },
      { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <FsStatusChip status={r.status} /> },
      { id: "checks", header: "Checks", mobile: "secondary", cell: (r) => <ChecksCell row={r} /> },
      { id: "profit", header: "Profit / (loss)", align: "right", hideBelow: "lg", cell: (r) => <PaiseAmount value={r.profit_paise} brackets /> },
      { id: "assets", header: "Total assets", align: "right", hideBelow: "xl", cell: (r) => <PaiseAmount value={r.total_assets_paise} /> },
      { id: "ledgers", header: "Ledgers", align: "right", hideBelow: "xl", cell: (r) => <span className="num tabular-nums">{r.ledger_count}</span> },
      {
        id: "people",
        header: "Prepared · reviewed",
        hideBelow: "2xl",
        cell: (r) => (
          <span className="text-sm text-text-muted">
            {r.prepared_by_name ?? "—"}
            {r.reviewed_by_name ? ` · ${r.reviewed_by_name}` : ""}
          </span>
        ),
      },
      { id: "updated_at", header: "Updated", sortable: true, align: "right", cell: (r) => <DateText date={r.updated_at} /> },
    )
    return cols
  }, [showClient])
  return (
    <DataTable
      id={showClient ? "financial-statements" : "client-financial-statements"}
      caption="Financial statements"
      columns={columns}
      rows={props.rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/workpapers/financial-statements/${r.id}`}
      total={props.total}
      page={props.page}
      pageSize={props.pageSize}
      sort={props.sort}
      dir={props.dir}
      defaultSort={FS_LIST_DEFAULT_SORT}
      countLabel={(n, t) => `${n} ${t === 1 ? "statement" : "statements"}`}
      columnChooser
      empty={<EmptyState icon={<FileSpreadsheetIcon />} message="No financial statements yet. Start one from a client's trial balance." />}
    />
  )
}
