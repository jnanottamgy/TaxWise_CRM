"use client"

import * as React from "react"
import { BookOpenCheckIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY } from "@/lib/format"
import { istDateOf, taxYearLabel } from "@/lib/domain/fy"
import { auditYearLabel } from "@/lib/schemas/audits"
import type { AuditListRow } from "@/lib/data/audits"
import { assemblyWords, auditTypeLabel, stageChip } from "@/components/audits/audit-ui"
import { fileAssemblyCountdown } from "@/lib/domain/audit-stages"

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

/**
 * The audit engagement list (§7.15.5): client, the audit and its year (AY or tax year for a tax
 * audit, §6.1), the stage with how much of its checklist is signed, the engagement partner, the
 * report date, the UDIN and the SA 230 assembly countdown. Server-paged and sorted; a row opens the
 * engagement. Below 768px each row is a card: client, stage, audit and year, assembly.
 */
export function AuditsTable(props: {
  rows: AuditListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  empty: React.ReactNode
}) {
  const { rows, total, page, pageSize, sort, dir, today, empty } = props
  const columns = React.useMemo<DataTableColumn<AuditListRow>[]>(
    () => [
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "24%",
        rowLink: true,
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code ?? ""} · ${r.client_name ?? ""}`}>
            <span className="truncate">{r.client_name ?? EMPTY}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name ?? EMPTY,
      },
      {
        id: "financial_year",
        header: "Audit",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span>{auditTypeLabel(r.audit_type)}</span>
            <span className="text-xs text-text-muted">{r.financial_year ? auditYearLabel(r.audit_type ?? "", r.financial_year, taxYearLabel) : EMPTY}</span>
          </span>
        ),
        mobileCell: (r) => `${auditTypeLabel(r.audit_type)} · ${r.financial_year ? auditYearLabel(r.audit_type ?? "", r.financial_year, taxYearLabel) : ""}`,
      },
      {
        id: "stage",
        header: "Stage",
        sortable: true,
        mobile: "trailing",
        cell: (r) => {
          const chip = stageChip(r.stage)
          return (
            <span className="inline-flex flex-col items-start leading-5">
              <StatusChip label={chip.label} tone={chip.tone} meaning={chip.meaning} />
              {r.stage !== "archived" && (r.stage_steps ?? 0) > 0 ? (
                <span className="num text-xs text-text-muted">
                  {r.stage_steps_done ?? 0} of {r.stage_steps} steps signed
                </span>
              ) : null}
            </span>
          )
        },
      },
      { id: "engagement_partner_name", header: "Engagement partner", hideBelow: "lg", cell: (r) => (r.engagement_partner_name ? <span>{r.engagement_partner_name}</span> : <Muted />) },
      { id: "report_date", header: "Report date", sortable: true, align: "right", hideBelow: "xl", cell: (r) => (r.report_date ? <DateText date={r.report_date} /> : <Muted />) },
      { id: "udin", header: "UDIN", hideBelow: "2xl", cell: (r) => (r.udin ? <MonoId value={r.udin} truncate={10} /> : r.report_date && !r.archived_at ? <span className="text-warning-text">Not linked</span> : <Muted />) },
      {
        id: "file_assembly_due",
        header: "File assembly",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => {
          if (!r.report_date) return <Muted />
          const c = fileAssemblyCountdown({ reportDate: r.report_date, archivedOn: r.archived_at ? istDateOf(r.archived_at) : null, today })
          const w = assemblyWords(c)
          return (
            <span className="inline-flex flex-col items-end leading-5">
              <DateText date={r.file_assembly_due} />
              <span className={w.tone === "danger" ? "text-xs text-danger-text" : w.tone === "warning" ? "text-xs text-warning-text" : "text-xs text-text-muted"}>{w.label}</span>
            </span>
          )
        },
        mobileCell: (r) => {
          if (!r.report_date) return "No report yet"
          return assemblyWords(fileAssemblyCountdown({ reportDate: r.report_date, archivedOn: r.archived_at ? istDateOf(r.archived_at) : null, today })).label
        },
      },
      { id: "updated_at", header: "Updated", sortable: true, align: "right", defaultHidden: true, cell: (r) => <DateText date={r.updated_at} /> },
    ],
    [today]
  )

  return (
    <DataTable
      id="audits"
      caption="Audit engagements"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id ?? ""}
      getRowHref={(r) => (r.id ? `/audits/${r.id}` : null)}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "updated_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "engagement" : "engagements"}`}
      columnChooser
      rowClassName={(r) => (r.archived_at ? "text-text-muted" : undefined)}
      empty={empty ?? <EmptyState icon={<BookOpenCheckIcon />} message="No audit engagements yet." />}
    />
  )
}
