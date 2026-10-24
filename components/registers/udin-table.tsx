"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileBadgeIcon, PencilIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { Explain } from "@/components/app/explain"
import { EMPTY } from "@/lib/format"
import { reportFormLabel } from "@/lib/schemas/registers"
import type { UdinRow } from "@/lib/data/registers"
import { deleteUdin } from "@/server/actions/udin"
import { LogUdinButton, UdinDialog, type SigningMember } from "@/components/registers/udin-dialog"
import { RowMenu, toastResult } from "@/components/registers/shared"

const AUDIT_SHORT: Record<string, string> = {
  statutory_companies_act: "Statutory audit",
  tax_audit: "Tax audit",
  gst_audit: "GST audit",
  internal: "Internal audit",
  bank_branch: "Bank branch audit",
  stock: "Stock audit",
  certification: "Certification",
  other: "Audit",
}

function Warn({ text, label }: { text: string; label: string }) {
  return (
    <Explain content={text}>
      <button type="button" aria-label={label} className="inline-flex size-5 items-center justify-center rounded text-warning-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
      </button>
    </Explain>
  )
}

/**
 * The UDIN register (§7.15.1): UDIN, client, document and report form, signed and generated dates
 * (flagged past 60 days), the signing partner (flagged when characters 3–8 aren't their membership
 * number [verify]), whether it counts towards the tax-audit ceiling, the linked filing or audit
 * engagement, and revised. Partners and Managers edit and remove; an Employee who signs logs their
 * own (§4.1).
 */
export function UdinTable(props: {
  rows: UdinRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canManage: boolean
  isPartner: boolean
  members: SigningMember[]
  showClient?: boolean
  fixedClient?: { id: string; name: string } | null
  compact?: boolean
}) {
  const { rows, canManage, isPartner, members, showClient = true, fixedClient = null, compact = false } = props
  const router = useRouter()
  const [dialog, setDialog] = React.useState<{ kind: "edit" | "delete"; row: UdinRow } | null>(null)

  const columns = React.useMemo<DataTableColumn<UdinRow>[]>(() => {
    const cols: DataTableColumn<UdinRow>[] = [
      { id: "udin", header: "UDIN", sortable: !compact, hideable: false, mobile: "primary", width: "13rem", cell: (r) => <MonoId value={r.udin} copy label="UDIN" />, mobileCell: (r) => <span className="font-mono">{r.udin}</span> },
    ]
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        mobile: "secondary",
        width: "20%",
        cell: (r) =>
          r.client_name ? (
            <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code ?? ""} · ${r.client_name}`}>
              <span className="truncate">{r.client_name}</span>
              <span className="text-xs text-text-muted">{r.client_code}</span>
            </span>
          ) : (
            <span className="text-text-muted">Firm-level</span>
          ),
        mobileCell: (r) => r.client_name ?? "Firm-level",
      })
    }
    cols.push(
      {
        id: "document_type",
        header: "Document",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate">{r.document_type}</span>
            {r.report_form ? <span className="truncate text-xs text-text-muted">{reportFormLabel(r.report_form)}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.document_type,
      },
      { id: "signed_on", header: "Signed", sortable: !compact, align: "right", mobile: "secondary", cell: (r) => <DateText date={r.signed_on} /> },
      {
        id: "generated_on",
        header: "Generated",
        sortable: !compact,
        align: "right",
        hideBelow: "lg",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <DateText date={r.generated_on} />
            <span className={r.generated_late ? "text-xs text-danger-text" : "text-xs text-text-muted"}>
              {r.days_to_generate === 0 ? "Same day" : `${r.days_to_generate} ${r.days_to_generate === 1 ? "day" : "days"} after`}
              {r.generated_late ? `, over ${r.generation_days}` : ""}
            </span>
          </span>
        ),
      },
      {
        id: "signing_partner_name",
        header: "Signed by",
        sortable: !compact,
        hideBelow: "lg",
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <span className="truncate">{r.signing_partner_name ?? EMPTY}</span>
            {r.membership_mismatch ? <Warn label="Membership number doesn't match" text={`Characters 3 to 8 of this UDIN aren't ${r.signing_partner_name ?? "the partner"}'s membership number (${r.signing_membership_no}). Check the UDIN or the signing partner.`} /> : null}
          </span>
        ),
      },
      {
        id: "counts",
        header: "Ceiling",
        hideBelow: "xl",
        cell: (r) =>
          r.is_revised ? (
            <span className="text-text-muted">Revised</span>
          ) : r.counts_towards_tax_audit_ceiling === true ? (
            <span className="inline-flex flex-col leading-5">
              <span className="text-text">Counts · FY {r.signed_fy}</span>
              {r.ceiling_confirmed_at ? <span className="text-xs text-danger-text">Over the ceiling, confirmed</span> : null}
            </span>
          ) : r.counts_towards_tax_audit_ceiling === false ? (
            <span className="text-text-muted">Not counted</span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
      {
        id: "linked",
        header: "Linked to",
        hideBelow: "2xl",
        cell: (r) =>
          r.filing_form ? (
            <span className="text-text-muted">
              {r.filing_form}
              {r.filing_period ? ` · ${r.filing_period}` : ""}
              {r.filing_financial_year ? ` · FY ${r.filing_financial_year}` : ""}
            </span>
          ) : r.engagement_audit_type ? (
            <span className="text-text-muted">
              {AUDIT_SHORT[r.engagement_audit_type] ?? "Audit"} · FY {r.engagement_financial_year}
            </span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
    )
    if (canManage) {
      cols.push({
        id: "actions",
        header: "Actions",
        align: "right",
        hideable: false,
        mobile: "trailing",
        width: "3.5rem",
        cell: (r) => (
          <RowMenu
            label={`Actions for UDIN ${r.udin}`}
            items={[
              { key: "edit", label: "Edit UDIN", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "edit", row: r }) },
              { key: "delete", label: "Remove from the register", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog({ kind: "delete", row: r }), danger: true },
            ]}
          />
        ),
      })
    }
    return cols
  }, [showClient, canManage, compact])

  const d = dialog
  return (
    <>
      <DataTable
        id={showClient ? "register-udin" : "client-udin"}
        caption="UDIN register"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "signed_on", dir: "desc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "UDIN" : "UDINs"}`}
        columnChooser={!compact}
        maxHeight={compact ? "none" : "viewport"}
        empty={
          <EmptyState
            icon={<FileBadgeIcon />}
            message={fixedClient ? "No UDINs logged for this client yet." : "No UDINs logged yet. Log each report and certificate a partner signs, within 60 days of signing."}
            action={members.length > 0 && !compact ? <LogUdinButton members={members} isPartner={isPartner} fixedClient={fixedClient} /> : undefined}
          />
        }
      />
      {d?.kind === "edit" ? <UdinDialog key={d.row.id} open onOpenChange={(o) => !o && setDialog(null)} row={d.row} members={members} isPartner={isPartner} /> : null}
      <ConfirmDialog
        open={d?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={d ? `Remove UDIN ${d.row.udin}?` : "Remove this UDIN?"}
        description="It leaves the register and stops counting towards the signing partner's tax audits. A linked audit engagement keeps its own record."
        confirmLabel="Remove UDIN"
        destructive
        onConfirm={async () => {
          if (!d) return
          const r = await deleteUdin({ id: d.row.id, updatedAt: d.row.updated_at })
          if (!toastResult(r, "UDIN removed")) return false
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
