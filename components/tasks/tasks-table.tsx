"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CalendarClockIcon, FlagIcon, ListChecksIcon, UserCheckIcon, UserRoundIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { PriorityChip } from "@/components/app/priority-chip"
import { StatusChip } from "@/components/app/status-chip"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { formatDate } from "@/lib/format"
import type { TaskListRow } from "@/lib/data/tasks"
import { exportTasks } from "@/server/actions/tasks"
import { BulkDialog, type BulkKind } from "@/components/tasks/bulk-dialog"
import { ChecklistCell, PersonCell, TimeCell, downloadBase64 } from "@/components/tasks/task-ui"
import { BulkReminderLauncher } from "@/components/bulk-queue"
import type { StaffPick } from "@/components/tasks/task-form"

/**
 * The work tracker's table (§7.6.1 Table, §3.4): server-paginated, sortable, searchable and
 * filtered by the URL; status as a chip with what it means; the due date with its relative urgency
 * (none once filed); checklist progress and time against the estimate. Partners and Managers
 * select rows for the bulk changes (§7.6.7). Below 768px rows become cards.
 */

function AcceptanceLine({ row }: { row: TaskListRow }) {
  if (!row.assigned_employee_id && row.acceptance_status !== "declined") return null
  if (row.acceptance_status === "pending") return <span className="text-xs text-warning-text">Waiting for acceptance</span>
  if (row.acceptance_status === "declined") return <span className="text-xs text-danger-text">Declined{row.declined_by_name ? ` by ${row.declined_by_name}` : ""}</span>
  return null
}

export function taskColumns(today: string): DataTableColumn<TaskListRow>[] {
  return [
    {
      id: "title",
      header: "Task",
      sortable: true,
      hideable: false,
      mobile: "primary",
      width: "30%",
      cell: (r) => (
        <span className="flex min-w-0 flex-col leading-5">
          <span className="truncate font-medium">{r.title}</span>
          <span className="truncate text-xs font-normal text-text-muted">
            <span className="font-mono">{r.task_number}</span>
            {r.period_label ? ` · ${r.period_label}` : ""}
            {r.open_blockers ? ` · blocked by ${r.open_blockers}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "client_name",
      header: "Client",
      sortable: true,
      mobile: "secondary",
      width: "18%",
      cell: (r) => <span className="block max-w-[14rem] truncate">{r.client_name ?? "—"}</span>,
    },
    {
      id: "status",
      header: "Status",
      sortable: true,
      mobile: "trailing",
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusChip kind="task_status" value={r.status} />
          <AcceptanceLine row={r} />
        </span>
      ),
    },
    { id: "priority", header: "Priority", sortable: true, hideBelow: "lg", cell: (r) => <PriorityChip kind="task_priority" value={r.priority} /> },
    { id: "assignee_name", header: "Assignee", sortable: true, mobile: "secondary", cell: (r) => <PersonCell name={r.assignee_name} /> },
    { id: "reviewer_name", header: "Reviewer", hideBelow: "xl", cell: (r) => <PersonCell name={r.reviewer_name} empty="Any Manager" /> },
    {
      id: "due_date",
      header: "Due",
      sortable: true,
      align: "right",
      mobile: "secondary",
      cell: (r) => <DateText date={r.due_date} withRelative={r.status !== "filed_done"} stacked today={today} />,
      mobileCell: (r) => (r.due_date ? `Due ${formatDate(r.due_date)}` : "No due date"),
    },
    { id: "checklist", header: "Checklist", align: "right", hideBelow: "lg", cell: (r) => <ChecklistCell done={r.checklist_done} total={r.checklist_total} /> },
    { id: "time", header: "Time", align: "right", hideBelow: "xl", cell: (r) => <TimeCell logged={r.logged_minutes} estimate={r.estimated_minutes} /> },
    { id: "service", header: "Service", defaultHidden: true, cell: (r) => (r.service_type ? SERVICE_TYPE_LABELS[r.service_type] : <span className="text-text-muted">—</span>) },
    { id: "financial_year", header: "FY", defaultHidden: true, cell: (r) => r.financial_year ?? <span className="text-text-muted">—</span> },
    { id: "updated_at", header: "Updated", sortable: true, align: "right", defaultHidden: true, cell: (r) => <DateText date={r.updated_at} /> },
  ]
}

export function TasksTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  today,
  canManage,
  staff,
  reviewers,
  emptyMessage,
  emptyAction,
  caption = "Tasks",
}: {
  rows: TaskListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  canManage: boolean
  staff: StaffPick[]
  reviewers: StaffPick[]
  emptyMessage: string
  emptyAction?: React.ReactNode
  caption?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [bulk, setBulk] = React.useState<{ kind: BulkKind; ids: string[]; clear: () => void } | null>(null)
  const columns = React.useMemo(() => taskColumns(today), [today])

  const onExport = async () => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("page")
    params.delete("size")
    const r = await exportTasks({ query: params.toString() })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return
    }
    downloadBase64(r.data)
    toast.success(r.data.truncated ? `Exported the first ${r.data.rows.toLocaleString("en-IN")} tasks. Narrow the filters for the rest.` : `Exported ${r.data.rows.toLocaleString("en-IN")} ${r.data.rows === 1 ? "task" : "tasks"}.`)
  }

  return (
    <>
      <DataTable
        id="work-tasks"
        caption={caption}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/work/${r.id}`}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "due_date", dir: "asc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "task" : "tasks"}`}
        columnChooser
        exportCsv={{ onExport }}
        selectable={canManage}
        bulkActions={
          canManage
            ? ({ selectedIds, clear }) => (
                <>
                  <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "assignee", ids: selectedIds, clear })}>
                    <UserRoundIcon aria-hidden="true" />
                    Assign
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "reviewer", ids: selectedIds, clear })}>
                    <UserCheckIcon aria-hidden="true" />
                    Reviewer
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "due_date", ids: selectedIds, clear })}>
                    <CalendarClockIcon aria-hidden="true" />
                    Due date
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setBulk({ kind: "priority", ids: selectedIds, clear })}>
                    <FlagIcon aria-hidden="true" />
                    Priority
                  </Button>
                  {/* §7.13.2 bulk reminders: one WhatsApp draft per Data awaited task, sent by a person. */}
                  <DataAwaitedReminder ids={selectedIds} rows={rows} />
                </>
              )
            : undefined
        }
        empty={<EmptyState icon={<ListChecksIcon />} message={emptyMessage} action={emptyAction} />}
      />
      {bulk ? (
        <BulkDialog
          kind={bulk.kind}
          ids={bulk.ids}
          staff={staff}
          reviewers={reviewers}
          onClose={() => setBulk(null)}
          onDone={() => {
            bulk.clear()
            setBulk(null)
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}

/** The selected tasks that are waiting on the client (Data awaited); the reminder asks for what's missing. */
function DataAwaitedReminder({ ids, rows }: { ids: string[]; rows: TaskListRow[] }) {
  const selected = new Set(ids)
  const waiting = rows.filter((r) => selected.has(r.id) && r.status === "data_awaited").map((r) => r.id)
  return (
    <BulkReminderLauncher
      source={waiting.length ? { kind: "tasks", ids: waiting } : { kind: "tasks", ids }}
      label={waiting.length && waiting.length < ids.length ? `Remind ${waiting.length} on WhatsApp` : "Remind on WhatsApp"}
      title="Ask for the data on WhatsApp"
      disabled={waiting.length === 0}
      disabledReason="Select tasks in Data awaited: the reminder asks the client for what's still missing."
    />
  )
}
