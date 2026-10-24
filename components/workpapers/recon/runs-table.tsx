"use client"

import * as React from "react"
import { GitCompareArrowsIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { formatCount } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { periodLabel, RUN_LIST_DEFAULT_SORT } from "@/lib/schemas/gst-recon"
import type { RunListRow } from "@/lib/data/gst-recon"

function Count({ n, tone }: { n: number; tone?: "danger" | "warning" }) {
  if (n === 0) return <span className="num text-text-muted tabular-nums">0</span>
  return <span className={tone === "danger" ? "num font-medium text-danger-text tabular-nums" : tone === "warning" ? "num text-warning-text tabular-nums" : "num tabular-nums"}>{formatCount(n)}</span>
}

export function RunStateChip({ row, plain = false }: { row: Pick<RunListRow, "open_count" | "follow_up_count" | "gstin_mismatch" | "is_latest">; plain?: boolean }) {
  const s = !row.is_latest
    ? { label: "Earlier run", tone: "muted" as const, meaning: "Earlier run: a later reconciliation of this client and month replaced it. It stays for the history." }
    : row.gstin_mismatch
      ? { label: "GSTIN differs", tone: "danger" as const, meaning: "GSTIN differs: the GSTR-2B file is for another GSTIN than the client's. Check the file before relying on the results." }
      : row.open_count === 0
        ? { label: "All settled", tone: "success" as const, meaning: "All settled: every difference is settled or ignored. Nothing carries into next month." }
        : row.follow_up_count === row.open_count
          ? { label: "Waiting on suppliers", tone: "info" as const, meaning: "Waiting on suppliers: every open line is being followed up. They carry into next month until the suppliers file." }
          : { label: "Open lines", tone: "warning" as const, meaning: "Open lines: differences nobody has settled yet. They carry into next month's reconciliation." }
  // Inside a link (Client 360 rows) the chip can't be a button of its own: label only.
  return plain ? <StatusChip label={s.label} tone={s.tone} /> : <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
}

/**
 * The reconciliation runs (§7.8.1 "Runs are saved, with history per client and period"): client,
 * month, the four buckets, ITC at risk and unclaimed, open lines and who ran it. Server-paged and
 * sorted; a row opens the run. Below 768px each row is a card: client, month, ITC at risk, state.
 */
export function RunsTable(props: { rows: RunListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; showClient?: boolean; empty?: React.ReactNode }) {
  const { showClient = true } = props
  const columns = React.useMemo<DataTableColumn<RunListRow>[]>(() => {
    const cols: DataTableColumn<RunListRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        rowLink: true,
        width: "24%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_gstin ?? r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      { id: "period_start", header: "Month", sortable: true, mobile: showClient ? "secondary" : "primary", rowLink: !showClient, cell: (r) => <span className="whitespace-nowrap">{periodLabel(r.period)}</span> },
      { id: "matched", header: "Matched", align: "right", hideBelow: "lg", cell: (r) => <Count n={r.matched_count} /> },
      { id: "mismatch", header: "Mismatch", align: "right", cell: (r) => <Count n={r.mismatch_count} tone="danger" /> },
      { id: "missing_in_2b", header: "Not in 2B", align: "right", cell: (r) => <Count n={r.missing_in_2b_count} tone="danger" /> },
      { id: "missing_in_books", header: "Not in books", align: "right", hideBelow: "lg", cell: (r) => <Count n={r.missing_in_books_count} tone="warning" /> },
      { id: "itc_at_risk_paise", header: "ITC at risk", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_at_risk_paise} /> },
      { id: "unclaimed_itc_paise", header: "Unclaimed ITC", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <PaiseAmount value={r.unclaimed_itc_paise} /> },
      { id: "open_count", header: "Open", sortable: true, align: "right", cell: (r) => <Count n={r.open_count} /> },
      { id: "state", header: "State", mobile: "trailing", cell: (r) => <RunStateChip row={r} /> },
      {
        id: "created_at",
        header: "Run",
        sortable: true,
        align: "right",
        hideBelow: "xl",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <DateText date={r.created_at} />
            <span className="text-xs text-text-muted">{r.created_by_name ?? "—"}</span>
          </span>
        ),
        mobileCell: (r) => <DateText date={r.created_at} />,
      },
    )
    return cols
  }, [showClient])

  return (
    <DataTable
      id={showClient ? "gst-recon-runs" : "client-gst-recon-runs"}
      caption="GST reconciliations"
      columns={columns}
      rows={props.rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/workpapers/gst-recon/${r.id}`}
      total={props.total}
      page={props.page}
      pageSize={props.pageSize}
      sort={props.sort}
      dir={props.dir}
      defaultSort={RUN_LIST_DEFAULT_SORT}
      countLabel={(n, t) => `${n} ${t === 1 ? "reconciliation" : "reconciliations"}`}
      columnChooser
      rowClassName={(r) => (r.is_latest ? undefined : "text-text-muted")}
      empty={props.empty ?? <EmptyState icon={<GitCompareArrowsIcon />} message="No reconciliations yet. Reconcile a client's GSTR-2B with their purchase register." />}
    />
  )
}
