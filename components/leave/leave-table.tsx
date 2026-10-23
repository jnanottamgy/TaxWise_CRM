"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarOffIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import type { SortDir } from "@/components/app/data-table/params"
import type { AppRole } from "@/lib/auth/roles"
import { LEAVE_TYPE_LABELS } from "@/lib/domain/enums"
import { canCancelLeave, canDecideLeaveFor, formatLeaveRange } from "@/lib/domain/leave"
import { formatDate } from "@/lib/format"
import type { LeaveRow } from "@/lib/data/leave"
import type { PersonOption } from "@/lib/data/people"
import { canManagePerson } from "@/lib/schemas/people"
import { cancelLeave } from "@/server/actions/leave"
import { DecideLeaveButtons } from "@/components/leave/leave-decision"
import { PersonLink } from "@/components/people/people-bits"

export interface LeaveViewer {
  role: AppRole
  employeeId: string | null
  today: string
}

export function leaveActions(row: LeaveRow, viewer: LeaveViewer): { decide: boolean; cancel: boolean } {
  const own = viewer.employeeId !== null && row.employee_id === viewer.employeeId
  const decide =
    row.status === "requested" &&
    !!row.employee_role &&
    canDecideLeaveFor({ role: viewer.role, employeeId: viewer.employeeId }, { role: row.employee_role, employeeId: row.employee_id }).ok
  const cancel = own
    ? canCancelLeave({ startDate: row.start_date, endDate: row.end_date, status: row.status }, viewer.today).ok
    : (row.status === "requested" || row.status === "approved") && !!row.employee_role && canManagePerson(viewer.role, row.employee_role)
  return { decide, cancel }
}

/** Cancel a leave (§7.11.3): yours before it starts, or as the approver. Clears On leave days still ahead. */
export function CancelLeaveButton({ row, own }: { row: LeaveRow; own: boolean }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <XIcon aria-hidden="true" />
        Cancel
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={own ? "Cancel your leave?" : `Cancel ${row.employee_name}'s leave?`}
        description={
          row.status === "approved"
            ? `The approved leave ${formatLeaveRange(row.start_date, row.end_date, row.half_day)} is cancelled. Days still ahead go back to normal attendance, and covers set up for it end.`
            : `The request ${formatLeaveRange(row.start_date, row.end_date, row.half_day)} is withdrawn.`
        }
        confirmLabel="Cancel leave"
        cancelLabel="Keep it"
        destructive
        onConfirm={async () => {
          const r = await cancelLeave({ id: row.id, updated_at: row.updated_at })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success("Leave cancelled.")
          router.refresh()
        }}
      />
    </>
  )
}

function buildColumns(viewer: LeaveViewer, staff: PersonOption[], showPerson: boolean): DataTableColumn<LeaveRow>[] {
  return [
    ...(showPerson
      ? [
          {
            id: "person",
            header: "Person",
            hideable: false,
            mobile: "primary" as const,
            width: "22%",
            cell: (r: LeaveRow) => <PersonLink id={r.employee_id} name={r.employee_name} />,
            mobileCell: (r: LeaveRow) => r.employee_name,
          },
        ]
      : []),
    {
      id: "start_date",
      header: "Dates",
      sortable: true,
      hideable: false,
      mobile: showPerson ? ("secondary" as const) : ("primary" as const),
      cell: (r) => (
        <span className="num">
          {formatDate(r.start_date)}
          {r.end_date !== r.start_date ? ` – ${formatDate(r.end_date)}` : r.half_day ? " (half day)" : ""}
        </span>
      ),
    },
    { id: "type", header: "Type", mobile: "secondary", cell: (r) => LEAVE_TYPE_LABELS[r.type] },
    { id: "days", header: "Working days", align: "right", cell: (r) => r.working_days },
    { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <StatusChip kind="leave_status" value={r.status} /> },
    {
      id: "decision",
      header: "Decision",
      hideBelow: "lg",
      cell: (r) =>
        r.decided_by_name ? (
          <span className="text-sm text-text-muted" title={r.decision_note ?? undefined}>
            {r.decided_by_name}
            {r.decision_note ? `: ${r.decision_note.length > 40 ? `${r.decision_note.slice(0, 37)}…` : r.decision_note}` : ""}
            {r.status === "approved" && r.no_cover_needed ? " · no cover needed" : ""}
          </span>
        ) : r.reason ? (
          <span className="text-sm text-text-muted" title={r.reason}>
            {r.reason.length > 40 ? `${r.reason.slice(0, 37)}…` : r.reason}
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      hideable: false,
      cell: (r) => {
        const a = leaveActions(r, viewer)
        if (!a.decide && !a.cancel) return null
        return (
          <div className="flex items-center justify-end gap-1" data-row-click-ignore>
            {a.decide ? <DecideLeaveButtons leave={r} actorRole={viewer.role} staff={staff} /> : null}
            {a.cancel ? <CancelLeaveButton row={r} own={r.employee_id === viewer.employeeId} /> : null}
          </div>
        )
      },
    },
  ]
}

/** The leave list (§7.11.3): server-side search, filters, sort and paging. */
export function LeaveTable(props: {
  rows: LeaveRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  viewer: LeaveViewer
  staff: PersonOption[]
  showPerson: boolean
  emptyMessage: string
}) {
  const { viewer, staff, showPerson, emptyMessage, ...table } = props
  const columns = React.useMemo(() => buildColumns(viewer, staff, showPerson), [viewer, staff, showPerson])
  return (
    <DataTable
      id={showPerson ? "leave-all" : "leave-mine"}
      caption="Leave"
      columns={columns}
      getRowId={(r) => r.id}
      countLabel={(n, total) => `${n} ${total === 1 ? "leave" : "leaves"}`}
      defaultSort={{ sort: "start_date", dir: "desc" }}
      empty={<EmptyState icon={<CalendarOffIcon />} message={emptyMessage} />}
      {...table}
    />
  )
}
