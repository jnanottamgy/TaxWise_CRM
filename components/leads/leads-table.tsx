"use client"

import * as React from "react"
import { TargetIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY, formatDateTime, formatTimeAgo } from "@/lib/format"
import { LEAD_SOURCE_LABELS, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { lostCategoryLabel } from "@/lib/schemas/leads"
import type { LeadListRow } from "@/lib/data/leads"

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

const SERVICE_SHORT: Record<string, string> = {
  gst: "GST",
  income_tax: "IT",
  tds: "TDS",
  payroll: "Payroll",
  bookkeeping: "Books",
  audit: "Audit",
  company_law: "ROC",
  incorporation: "Inc.",
  other: "Other",
}

/**
 * The leads table (§7.5.1 "table"): lead, number, stage, source, services, estimated value, owner,
 * next follow-up, last activity and open quotations; sorted, filtered and paged in SQL. Row click
 * opens the lead. Phone: stacked cards with the lead, stage and the next follow-up.
 */
export function LeadsTable(props: { rows: LeadListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; now: string; emptyAction?: React.ReactNode }) {
  const { rows, total, page, pageSize, sort, dir, now, emptyAction } = props
  const nowDate = React.useMemo(() => new Date(now), [now])
  const columns = React.useMemo<DataTableColumn<LeadListRow>[]>(
    () => [
      {
        id: "name",
        header: "Lead",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "26%",
        cell: (r) => (
          <span className="flex min-w-0 flex-col leading-5">
            <span className="truncate font-medium">{r.company || r.name}</span>
            {r.company ? <span className="truncate text-xs text-text-muted">{r.name}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.company || r.name,
      },
      { id: "lead_number", header: "Number", sortable: true, hideBelow: "xl", cell: (r) => <MonoId value={r.lead_number} copy label="lead number" /> },
      {
        id: "status",
        header: "Stage",
        sortable: true,
        mobile: "trailing",
        cell: (r) => (
          <span className="flex flex-col items-start leading-5">
            <StatusChip kind="lead_status" value={r.status} />
            {r.status === "lost" ? <span className="max-w-48 truncate text-xs text-text-muted" title={r.lost_reason ?? undefined}>{lostCategoryLabel(r.lost_category)}</span> : null}
          </span>
        ),
      },
      { id: "source", header: "Source", sortable: true, hideBelow: "lg", cell: (r) => <span className="text-text-muted">{LEAD_SOURCE_LABELS[r.source]}{r.source_detail ? ` · ${r.source_detail}` : ""}</span> },
      {
        id: "services",
        header: "Services",
        hideBelow: "2xl",
        cell: (r) =>
          r.services_required.length ? (
            <span className="inline-flex items-center gap-1" title={r.services_required.map((s) => SERVICE_TYPE_LABELS[s]).join(", ")}>
              {r.services_required.slice(0, 3).map((s) => (
                <span key={s} className="flex-none rounded-full border border-border px-1.5 text-xs leading-5 text-text">
                  {SERVICE_SHORT[s] ?? s}
                </span>
              ))}
              {r.services_required.length > 3 ? <span className="text-xs text-text-muted">+{r.services_required.length - 3}</span> : null}
            </span>
          ) : (
            <Muted />
          ),
      },
      { id: "estimated_value", header: "Est. value / yr", sortable: true, align: "right", cell: (r) => <Money value={r.estimated_value} /> },
      { id: "assigned_name", header: "Assigned to", sortable: true, mobile: "secondary", cell: (r) => (r.assigned_name ? <span className="text-text-muted">{r.assigned_name}</span> : <Muted>Not assigned</Muted>) },
      {
        id: "next_follow_up_at",
        header: "Next follow-up",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) =>
          r.next_follow_up_at && r.status !== "won" && r.status !== "lost" ? (
            <span className={r.follow_up_overdue ? "num text-warning-text tabular-nums" : "num tabular-nums"} title={r.follow_up_overdue ? "The follow-up time has passed." : undefined}>
              {formatDateTime(r.next_follow_up_at)}
            </span>
          ) : (
            <Muted />
          ),
        mobileCell: (r) => (r.next_follow_up_at && r.status !== "won" && r.status !== "lost" ? `Follow up ${formatDateTime(r.next_follow_up_at)}` : "No follow-up set"),
      },
      {
        id: "last_activity_at",
        header: "Last activity",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) => (
          <span className={r.is_stale ? "text-warning-text" : "text-text-muted"} title={r.is_stale ? "No call, note, stage change or quotation for 14 days." : formatDateTime(r.last_activity_at)}>
            {formatTimeAgo(r.last_activity_at, nowDate)}
          </span>
        ),
      },
      {
        id: "open_quotations",
        header: "Open quotations",
        align: "right",
        hideBelow: "xl",
        cell: (r) =>
          r.open_quotations ? (
            <span className="inline-flex flex-col items-end leading-5">
              <span className="num tabular-nums">{r.open_quotations}</span>
              <Money value={r.open_quotation_value} className="text-xs text-text-muted" />
            </span>
          ) : (
            <span className="num text-text-muted tabular-nums">0</span>
          ),
      },
    ],
    [nowDate],
  )

  return (
    <DataTable
      id="leads"
      caption="Leads"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/leads/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "last_activity_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "lead" : "leads"}`}
      columnChooser
      empty={<EmptyState icon={<TargetIcon />} message="No leads yet. Add the first enquiry to start the pipeline." action={emptyAction} />}
    />
  )
}
