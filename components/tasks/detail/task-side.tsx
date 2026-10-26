"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SectionCard } from "@/components/app/section-card"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { formatMinutes } from "@/lib/format"
import { budgetState } from "@/lib/schemas/timesheet"
import { deleteTask, updateTaskRemarks } from "@/server/actions/tasks"
import { EditTaskDialog, type EditableTask, type TaskFormOptions } from "@/components/tasks/task-form"
import { TimeEntryDialog } from "@/components/timesheet/time-entry-dialog"
import { ThinBar, toastResult } from "@/components/tasks/task-ui"

/**
 * The task page's client pieces: Edit and Delete (Partners and Managers), Log time, the time
 * logged against the estimate (§7.6.6 "(bar)"), and the remarks the assignee keeps (§4.6).
 */

export function TaskManageMenu({ task, options }: { task: EditableTask & { task_number: string; title: string }; options: TaskFormOptions }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  return (
    <>
      <Button variant="outline" onClick={() => setEditing(true)}>
        <PencilIcon aria-hidden="true" />
        Edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions">
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDeleting(true)} className="text-danger-text focus:text-danger-text">
            <Trash2Icon aria-hidden="true" />
            Move to recycle bin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing ? <EditTaskDialog open={editing} onOpenChange={setEditing} task={task} options={options} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Move ${task.task_number} to the recycle bin?`}
        description="The task leaves every list, with its checklist, comments and time. A Partner or Manager can restore it from the recycle bin."
        confirmLabel="Move to recycle bin"
        destructive
        onConfirm={async () => {
          const r = await deleteTask({ id: task.id, expected_updated_at: task.updated_at })
          if (!toastResult(r, `${task.task_number} moved to the recycle bin.`)) return false
          router.push("/work")
        }}
      />
    </>
  )
}

export function LogTimeButton({ task, client, size = "default" }: { task: { id: string; label: string }; client: { id: string; label: string } | null; size?: "default" | "sm" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Log time
      </Button>
      {open ? <TimeEntryDialog open={open} onOpenChange={setOpen} initial={{ task, client, billable: Boolean(client) }} /> : null}
    </>
  )
}

export function TaskTimeCard({
  logged,
  estimate,
  byPerson,
  showPeople,
  task,
  client,
}: {
  logged: number
  estimate: number | null
  byPerson: Array<{ employee_id: string; name: string | null; minutes: number }>
  showPeople: boolean
  task: { id: string; label: string }
  client: { id: string; label: string } | null
}) {
  const b = budgetState(estimate, logged)
  return (
    <SectionCard title="Time" action={<LogTimeButton task={task} client={client} size="sm" />}>
      <p className="num font-serif text-[30px] leading-9 font-[450] tracking-[-0.01em] text-text tabular-nums">
        {formatMinutes(logged)}
        {estimate ? <span className="text-base font-normal text-text-muted"> of {formatMinutes(estimate)} estimated</span> : null}
      </p>
      {estimate ? (
        <div className="mt-2">
          <ThinBar percent={b.percent ?? 0} tone={b.state === "over" ? "danger" : b.state === "near" ? "warning" : "primary"} label={`Time logged: ${b.percent}% of the estimate`} />
          <p className={b.state === "over" ? "mt-1 text-sm text-danger-text" : "mt-1 text-sm text-text-muted"}>
            {b.state === "over" ? `${formatMinutes(logged - estimate)} over the estimate` : `${formatMinutes(estimate - logged)} left of the estimate`}
          </p>
        </div>
      ) : (
        <p className="mt-1 text-sm text-text-muted">No estimate set.</p>
      )}
      {showPeople && byPerson.length ? (
        <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">
          {byPerson.map((p) => (
            <li key={p.employee_id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="truncate text-text">{p.name ?? "A colleague"}</span>
              <span className="num text-text-muted tabular-nums">{formatMinutes(p.minutes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  )
}

export function RemarksCard({ taskId, remarks, updatedAt, canEdit }: { taskId: string; remarks: string | null; updatedAt: string; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(remarks ?? "")
  const [pending, setPending] = React.useState(false)
  const id = React.useId()
  if (!canEdit && !remarks) return null
  return (
    <SectionCard
      title="Remarks"
      action={
        canEdit && !editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden="true" />
            {remarks ? "Edit" : "Add"}
          </Button>
        ) : null
      }
    >
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setPending(true)
            try {
              const r = await updateTaskRemarks({ id: taskId, remarks: value, expected_updated_at: updatedAt })
              if (toastResult(r, "Remarks saved.")) {
                setEditing(false)
                router.refresh()
              }
            } finally {
              setPending(false)
            }
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={id} className="sr-only">
            Remarks
          </label>
          <Textarea id={id} value={value} onChange={(e) => setValue(e.target.value)} rows={4} maxLength={2000} autoFocus />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setValue(remarks ?? "")
                setEditing(false)
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
              {pending ? <Spinner /> : null}
              Save remarks
            </Button>
          </div>
        </form>
      ) : remarks ? (
        <p className="text-base whitespace-pre-wrap text-text">{remarks}</p>
      ) : (
        <p className="text-sm text-text-muted">Notes on where the work stands, for whoever picks it up next.</p>
      )}
    </SectionCard>
  )
}
