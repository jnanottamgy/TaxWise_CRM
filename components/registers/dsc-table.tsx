"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilIcon, Trash2Icon, UsbIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { EMPTY } from "@/lib/format"
import { DSC_CLASS_LABEL, DSC_ALERT_DAYS, custodyLabel } from "@/lib/schemas/registers"
import type { DscRow } from "@/lib/data/registers"
import { deleteDsc } from "@/server/actions/dsc"
import { AddDscButton, DscDialog } from "@/components/registers/dsc-dialog"
import { RowMenu, toastResult } from "@/components/registers/shared"

/**
 * The DSC register (§7.15.1): client, holder (with PAN), class, issuer and serial, expiry with the
 * days left (urgent inside 30 days, when the alerts start), custody and status. Partners and Managers
 * edit; Employees read their own clients' DSCs.
 */
export function DscTable(props: {
  rows: DscRow[]
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
  const [dialog, setDialog] = React.useState<{ kind: "edit" | "delete"; row: DscRow } | null>(null)
  const alertWindow = Math.max(...DSC_ALERT_DAYS)

  const columns = React.useMemo<DataTableColumn<DscRow>[]>(() => {
    const cols: DataTableColumn<DscRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        hideable: false,
        width: "22%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
      })
    }
    cols.push(
      {
        id: "holder_name",
        header: "Holder",
        sortable: !compact,
        hideable: false,
        mobile: "primary",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate font-medium text-text">{r.holder_name}</span>
            {r.holder_pan ? <span className="font-mono text-xs text-text-muted">{r.holder_pan}</span> : null}
          </span>
        ),
        mobileCell: (r) => (showClient ? `${r.holder_name} · ${r.client_name}` : r.holder_name),
      },
      { id: "dsc_class", header: "Class", hideBelow: "xl", cell: (r) => <span className="text-text-muted">{DSC_CLASS_LABEL[r.dsc_class] ?? r.dsc_class}</span> },
      {
        id: "issued_by",
        header: "Issuer and serial",
        hideBelow: "lg",
        cell: (r) =>
          r.issued_by || r.serial_number ? (
            <span className="inline-flex flex-col leading-5">
              <span className="text-text-muted">{r.issued_by ?? EMPTY}</span>
              {r.serial_number ? <MonoId value={r.serial_number} truncate={14} className="text-xs" /> : null}
            </span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
      {
        id: "expiry_date",
        header: "Expires",
        sortable: !compact,
        align: "right",
        mobile: "secondary",
        cell: (r) => <DateText date={r.expiry_date} withRelative={r.status === "active" && r.days_to_expiry <= alertWindow} stacked today={today} />,
        mobileCell: (r) => <DateText date={r.expiry_date} withRelative={r.status === "active" && r.days_to_expiry <= alertWindow} today={today} />,
      },
      {
        id: "custody",
        header: "Custody",
        mobile: "secondary",
        cell: (r) => (r.custody ? <span className="text-text">{custodyLabel(r.custody)}</span> : <span className="text-warning-text">Not recorded</span>),
        mobileCell: (r) => (r.custody ? `With ${custodyLabel(r.custody)}` : "Custody not recorded"),
      },
      { id: "status", header: "Status", mobile: "trailing", cell: (r) => <StatusChip kind="dsc_status" value={r.display_status} /> },
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
            label={`Actions for the DSC of ${r.holder_name}`}
            items={[
              { key: "edit", label: "Edit DSC", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "edit", row: r }) },
              { key: "delete", label: "Remove from the register", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog({ kind: "delete", row: r }), danger: true },
            ]}
          />
        ),
      })
    }
    return cols
  }, [showClient, canManage, compact, today, alertWindow])

  const d = dialog
  return (
    <>
      <DataTable
        id={showClient ? "register-dsc" : "client-dsc"}
        caption="DSC register"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "expiry_date", dir: "asc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "DSC" : "DSCs"}`}
        columnChooser={!compact}
        maxHeight={compact ? "none" : "viewport"}
        rowClassName={(r) => (r.status === "revoked" ? "text-text-muted" : undefined)}
        empty={
          <EmptyState
            icon={<UsbIcon />}
            message={fixedClient ? "No DSCs recorded for this client yet." : "No DSCs recorded yet. Add each director's or proprietor's DSC to be told before it expires."}
            action={canManage && !compact ? <AddDscButton fixedClient={fixedClient} /> : undefined}
          />
        }
      />
      {d?.kind === "edit" ? <DscDialog key={d.row.id} open onOpenChange={(o) => !o && setDialog(null)} row={d.row} /> : null}
      <ConfirmDialog
        open={d?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={d ? `Remove the DSC of ${d.row.holder_name}?` : "Remove this DSC?"}
        description="It leaves the register and its expiry alerts stop. To keep the history, mark it Revoked instead."
        confirmLabel="Remove DSC"
        destructive
        onConfirm={async () => {
          if (!d) return
          const r = await deleteDsc({ id: d.row.id, updatedAt: d.row.updated_at })
          if (!toastResult(r, "DSC removed")) return false
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
