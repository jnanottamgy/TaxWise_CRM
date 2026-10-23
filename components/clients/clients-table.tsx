"use client"

import * as React from "react"
import Link from "next/link"
import { Building2Icon, FolderTreeIcon, PlusIcon, RefreshCwIcon, UserRoundCogIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { PriorityChip } from "@/components/app/priority-chip"
import { MonoId } from "@/components/app/mono-id"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import type { ComboOption } from "@/components/app/form/combobox"
import { Button } from "@/components/ui/button"
import { EMPTY, formatTimeAgo } from "@/lib/format"
import { WHATSAPP_GROUP_LABELS } from "@/lib/schemas/clients"
import type { ClientListRow } from "@/lib/data/clients"
import { ClientRowActions, type MessagingProps, type RowContact } from "@/components/clients/client-row-actions"
import { ClientStatusDialog, type StatusTarget } from "@/components/clients/client-status-dialog"
import { DeleteClientDialog } from "@/components/clients/delete-client-dialog"
import { BulkGroupDialog, BulkOwnerDialog } from "@/components/clients/bulk-dialogs"
import { ClientExportMenu } from "@/components/clients/export-menu"
import { ENTITY_SHORT, SERVICE_SHORT, entityLabel, serviceTitle } from "@/components/clients/client-ui"

/** `cover_badge`: "Covering for Ravi · until Sat 25 Oct, 11:59 pm" when the viewer covers this client (§4.7). */
export type ClientTableRow = ClientListRow & { contact: RowContact; cover_badge?: string | null }

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

function NameCell({ r }: { r: ClientTableRow }) {
  const entity = r.entity_type ? ENTITY_SHORT[r.entity_type] : null
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">{r.display_name}</span>
      {entity ? (
        <span
          title={entityLabel(r.entity_type, r.entity_type_other) ?? undefined}
          className="flex-none rounded-full border border-border bg-surface-2 px-1.5 text-xs leading-5 font-normal text-text-muted"
        >
          {entity}
        </span>
      ) : null}
      {r.cover_badge ? (
        <span title="You're covering this client for a colleague. Access ends by itself at the time shown (§4.7)." className="flex-none rounded-full bg-info-soft px-1.5 text-xs leading-5 font-normal text-info-text">
          {r.cover_badge}
        </span>
      ) : r.covered_now ? (
        <span title="Someone is covering this client while its owner or team member is away (§4.7)." className="flex-none text-xs font-normal text-info-text">
          Covered
        </span>
      ) : null}
    </span>
  )
}

function ServiceChips({ services }: { services: ClientTableRow["service_types"] }) {
  if (!services.length) return <Muted />
  const shown = services.slice(0, 3)
  return (
    <span className="inline-flex items-center gap-1" title={services.map(serviceTitle).join(", ")}>
      {shown.map((s) => (
        <span key={s} className="flex-none rounded-full border border-border px-1.5 text-xs leading-5 text-text">
          {SERVICE_SHORT[s]}
        </span>
      ))}
      {services.length > shown.length ? <span className="text-xs text-text-muted">+{services.length - shown.length}</span> : null}
    </span>
  )
}

function WhatsAppGroupCell({ status }: { status: string }) {
  if (status === "none") return <Muted>{WHATSAPP_GROUP_LABELS.none}</Muted>
  return <StatusChip kind="whatsapp_group_status" value={status} />
}

/**
 * The client list table (§7.3.1). Columns: client (with entity badge), code, PAN, GSTIN, status,
 * priority, owner, group, services, next deadline, open tasks, outstanding (Partner/Manager only),
 * last contact, portal, WhatsApp group (optional). Row actions: WhatsApp, email, open, new task,
 * new invoice (Partner/Manager), change status, delete (Partner). Bulk actions (Partner/Manager):
 * assign owner, add to group, change status, export.
 */
export function ClientsTable(props: {
  rows: ClientTableRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  seesMoney: boolean
  canManage: boolean
  canDelete: boolean
  staff: ComboOption[]
  groups: ComboOption[]
  messaging: MessagingProps
}) {
  const { rows, total, page, pageSize, sort, dir, today, seesMoney, canManage, canDelete, staff, groups, messaging } = props
  const [statusTarget, setStatusTarget] = React.useState<StatusTarget | null>(null)
  const [statusOpen, setStatusOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState<ClientTableRow | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [bulk, setBulk] = React.useState<{ kind: "owner" | "group"; ids: string[]; clear: () => void } | null>(null)
  const clearRef = React.useRef<(() => void) | null>(null)

  const columns = React.useMemo<DataTableColumn<ClientTableRow>[]>(() => {
    const cols: DataTableColumn<ClientTableRow>[] = [
      { id: "display_name", header: "Client", sortable: true, hideable: false, mobile: "primary", width: "26%", cell: (r) => <NameCell r={r} />, mobileCell: (r) => (r.cover_badge ? `${r.display_name} · ${r.cover_badge}` : r.display_name) },
      { id: "client_code", header: "Code", sortable: true, mobile: "secondary", cell: (r) => <MonoId value={r.client_code} copy label="client code" /> },
      { id: "pan", header: "PAN", defaultHidden: true, cell: (r) => <MonoId value={r.pan} copy label="PAN" /> },
      { id: "gstin", header: "GSTIN", defaultHidden: true, cell: (r) => <MonoId value={r.gstin} copy label="GSTIN" /> },
      { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <StatusChip kind="client_status" value={r.status} /> },
      { id: "priority", header: "Priority", sortable: true, hideBelow: "lg", cell: (r) => <PriorityChip kind="client_priority" value={r.priority} /> },
      { id: "owner_name", header: "Owner", sortable: true, mobile: "secondary", cell: (r) => (r.owner_name ? <span className="text-text-muted">{r.owner_name}</span> : <Muted>Unassigned</Muted>) },
      { id: "group_name", header: "Group", sortable: true, defaultHidden: true, cell: (r) => (r.group_name ? <span className="text-text-muted">{r.group_name}</span> : <Muted />) },
      { id: "services", header: "Services", hideBelow: "xl", cell: (r) => <ServiceChips services={r.service_types} /> },
      {
        id: "next_due_date",
        header: "Next deadline",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) =>
          r.next_due_date ? (
            <span className="inline-flex flex-col items-end leading-5" title={r.next_due_title ?? undefined}>
              <DateText date={r.next_due_date} withRelative today={today} />
              <span className="max-w-48 truncate text-xs text-text-muted">{r.next_due_title}</span>
            </span>
          ) : (
            <Muted />
          ),
        mobileCell: (r) => (r.next_due_date ? <DateText date={r.next_due_date} withRelative today={today} /> : "No deadline"),
      },
      {
        id: "open_tasks",
        header: "Open tasks",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <span>{r.open_tasks}</span>
            {r.overdue_tasks ? <span className="text-xs text-danger-text">{r.overdue_tasks} overdue</span> : null}
          </span>
        ),
      },
    ]
    if (seesMoney) {
      cols.push({
        id: "outstanding",
        header: "Outstanding",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <Money value={r.outstanding} />
            {r.has_overdue_invoices ? <span className="text-xs text-danger-text">Overdue</span> : null}
          </span>
        ),
      })
    }
    cols.push(
      {
        id: "last_contact_at",
        header: "Last contact",
        sortable: true,
        align: "right",
        hideBelow: "xl",
        cell: (r) =>
          r.last_contact_at ? (
            <span title={new Date(r.last_contact_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>{formatTimeAgo(r.last_contact_at)}</span>
          ) : r.unreachable ? (
            <span className="text-warning-text">No email or phone</span>
          ) : (
            <Muted>Never</Muted>
          ),
      },
      { id: "portal", header: "Portal", defaultHidden: true, cell: (r) => (r.has_portal ? "Yes" : <Muted>No</Muted>) },
      { id: "whatsapp_group", header: "WhatsApp group", defaultHidden: true, cell: (r) => <WhatsAppGroupCell status={r.whatsapp_group_status} /> },
      {
        id: "actions",
        header: "Actions",
        align: "right",
        hideable: false,
        width: "8.5rem",
        cell: (r) => (
          <ClientRowActions
            client={r}
            contact={r.contact}
            messaging={messaging}
            canManage={canManage}
            canDelete={canDelete}
            onChangeStatus={() => {
              setStatusTarget({ kind: "one", clientId: r.id, name: r.display_name, current: r.status, updatedAt: r.updated_at })
              setStatusOpen(true)
            }}
            onDelete={() => {
              setDeleting(r)
              setDeleteOpen(true)
            }}
          />
        ),
      },
    )
    return cols
  }, [seesMoney, today, messaging, canManage, canDelete])

  return (
    <>
      <DataTable
        id="clients"
        caption="Clients"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/clients/${r.id}`}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "display_name", dir: "asc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "client" : "clients"}`}
        columnChooser
        selectable={canManage}
        bulkActions={({ selectedIds, clear }) => (
          <>
            <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "owner", ids: selectedIds, clear })}>
              <UserRoundCogIcon aria-hidden="true" />
              Assign owner
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "group", ids: selectedIds, clear })}>
              <FolderTreeIcon aria-hidden="true" />
              Add to group
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                clearRef.current = clear
                setStatusTarget({ kind: "many", clientIds: selectedIds })
                setStatusOpen(true)
              }}
            >
              <RefreshCwIcon aria-hidden="true" />
              Change status
            </Button>
            <ClientExportMenu ids={selectedIds} />
          </>
        )}
        empty={
          canManage ? (
            <EmptyState
              icon={<Building2Icon />}
              message="No clients yet. Add your first client to start tracking their deadlines and work."
              action={
                <Button asChild size="sm">
                  <Link href="/clients/new">
                    <PlusIcon aria-hidden="true" />
                    Add client
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState icon={<Building2Icon />} message="No clients are assigned to you yet. A Manager or Partner adds you as owner or to the team." />
          )
        }
      />
      <ClientStatusDialog
        target={statusTarget}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        onDone={() => {
          clearRef.current?.()
          clearRef.current = null
        }}
      />
      <DeleteClientDialog
        client={deleting ? { id: deleting.id, name: deleting.display_name, code: deleting.client_code, updatedAt: deleting.updated_at, openTasks: deleting.open_tasks } : null}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      {bulk?.kind === "owner" ? (
        <BulkOwnerDialog clientIds={bulk.ids} staff={staff} open onOpenChange={(o) => !o && setBulk(null)} onDone={bulk.clear} />
      ) : null}
      {bulk?.kind === "group" ? (
        <BulkGroupDialog clientIds={bulk.ids} groups={groups} open onOpenChange={(o) => !o && setBulk(null)} onDone={bulk.clear} />
      ) : null}
    </>
  )
}
