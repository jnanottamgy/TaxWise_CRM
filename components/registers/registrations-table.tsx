"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BadgeCheckIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { EMPTY } from "@/lib/format"
import { diffDays } from "@/lib/domain/fy"
import { registrationTypeLabel } from "@/lib/schemas/registers"
import type { RegistrationRow } from "@/lib/data/registers"
import { deleteRegistration } from "@/server/actions/registrations"
import { AddRegistrationButton, RegistrationDialog } from "@/components/registers/registration-dialog"
import { RowMenu, toastResult } from "@/components/registers/shared"

/**
 * Statutory registrations (§7.15.1): client, type, number, jurisdiction, issue and expiry dates with
 * the days left, status (Active past its expiry reads Expired, §0.1 rule 10), and for a DIN the next
 * DIR-3 KYC Web (every third FY, by 30 June). Partners and Managers add, edit and remove; Employees
 * read their own clients' rows (§4.1).
 */
export function RegistrationsTable(props: {
  rows: RegistrationRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  canManage: boolean
  showClient?: boolean
  fixedClient?: { id: string; name: string } | null
  compact?: boolean
}) {
  const { rows, today, canManage, showClient = true, fixedClient = null, compact = false } = props
  const router = useRouter()
  const [dialog, setDialog] = React.useState<{ kind: "edit" | "delete"; row: RegistrationRow } | null>(null)

  const columns = React.useMemo<DataTableColumn<RegistrationRow>[]>(() => {
    const cols: DataTableColumn<RegistrationRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        hideable: false,
        mobile: "primary",
        width: "24%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => `${r.client_name} · ${registrationTypeLabel(r.registration_type)}`,
      })
    }
    cols.push(
      {
        id: "registration_type",
        header: "Type",
        sortable: !compact,
        hideable: false,
        mobile: showClient ? undefined : "primary",
        // Long names ("Professional tax enrolment certificate") wrap rather than widen the table.
        className: "whitespace-normal min-w-[8rem]",
        cell: (r) => <span className="font-medium text-text">{registrationTypeLabel(r.registration_type)}</span>,
      },
      { id: "registration_number", header: "Number", mobile: "secondary", cell: (r) => <MonoId value={r.registration_number} copy label={`${registrationTypeLabel(r.registration_type)} number`} /> },
      { id: "jurisdiction", header: "Jurisdiction", hideBelow: "2xl", cell: (r) => (r.jurisdiction ? <span className="text-text-muted">{r.jurisdiction}</span> : <span className="text-text-muted">{EMPTY}</span>) },
      { id: "issue_date", header: "Issued", align: "right", hideBelow: "2xl", cell: (r) => <DateText date={r.issue_date} /> },
      {
        id: "expiry_date",
        header: "Expires",
        sortable: !compact,
        align: "right",
        mobile: "secondary",
        cell: (r) => <DateText date={r.expiry_date} withRelative={r.status === "active" && !!r.expiry_date && r.in_reminder_window} stacked today={today} />,
        mobileCell: (r) => (r.expiry_date ? <DateText date={r.expiry_date} withRelative={r.status === "active" && r.in_reminder_window} today={today} /> : "No expiry"),
      },
      {
        id: "next_dir3_kyc_due",
        header: "DIR-3 KYC",
        sortable: !compact,
        align: "right",
        hideBelow: "lg",
        cell: (r) => {
          if (r.registration_type !== "DIN") return <span className="text-text-muted">{EMPTY}</span>
          if (!r.next_dir3_kyc_due) return <span className="text-warning-text">Last KYC not on record</span>
          // The relative text only when it is close (or past): a date two years out needs no urgency.
          const soon = diffDays(r.next_dir3_kyc_due, today) <= 90
          return (
            <span className="inline-flex flex-col items-end leading-5" title={r.last_dir3_kyc_fy ? `Last filed in FY ${r.last_dir3_kyc_fy}` : undefined}>
              <DateText date={r.next_dir3_kyc_due} withRelative={soon} today={today} />
              <span className="text-xs text-text-muted">FY {r.next_dir3_kyc_fy}</span>
            </span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        mobile: "trailing",
        cell: (r) => <StatusChip kind="registration_status" value={r.display_status} />,
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
            label={`Actions for ${registrationTypeLabel(r.registration_type)} ${r.registration_number}`}
            items={[
              { key: "edit", label: "Edit registration", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "edit", row: r }) },
              { key: "delete", label: "Remove from the register", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog({ kind: "delete", row: r }), danger: true },
            ]}
          />
        ),
      })
    }
    return cols
  }, [showClient, canManage, compact, today])

  const d = dialog
  return (
    <>
      <DataTable
        id={showClient ? "register-registrations" : "client-registrations"}
        caption="Statutory registrations"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "client_name", dir: "asc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "registration" : "registrations"}`}
        columnChooser={!compact}
        maxHeight={compact ? "none" : "viewport"}
        rowClassName={(r) => (r.status === "surrendered" || r.status === "cancelled" ? "text-text-muted" : undefined)}
        empty={
          <EmptyState
            icon={<BadgeCheckIcon />}
            message={fixedClient ? "No registrations recorded for this client yet." : "No registrations recorded yet. Add a client's GSTIN, PT, Udyam or DIN to get reminded before each one expires."}
            action={canManage && !compact ? <AddRegistrationButton fixedClient={fixedClient} /> : undefined}
          />
        }
      />
      {d?.kind === "edit" ? <RegistrationDialog key={d.row.id} open onOpenChange={(o) => !o && setDialog(null)} row={d.row} /> : null}
      <ConfirmDialog
        open={d?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={d ? `Remove ${registrationTypeLabel(d.row.registration_type)} ${d.row.registration_number}?` : "Remove this registration?"}
        description="It leaves the register and its expiry reminders stop. To keep the history, mark it Surrendered or Cancelled instead."
        confirmLabel="Remove registration"
        destructive
        onConfirm={async () => {
          if (!d) return
          const r = await deleteRegistration({ id: d.row.id, updatedAt: d.row.updated_at })
          if (!toastResult(r, "Registration removed")) return false
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
