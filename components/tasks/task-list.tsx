import Link from "next/link"
import { cn } from "@/lib/utils"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import type { TaskListRow } from "@/lib/data/tasks"
import { AcceptDecline } from "@/components/tasks/acceptance"
import { TimerButton, type RunningRef } from "@/components/timesheet/timer-button"
import { MetaLine } from "@/components/tasks/meta-line"

/**
 * A compact list of tasks for overviews and phones (My day, Client 360, dashboards): the title and
 * status on line one; the task number, client and due date (with its relative urgency) on line
 * two; and the one action the row needs: Accept / Decline while it waits for the viewer, otherwise
 * Start timer. Rows are at least 44px tall for touch. Server-safe; the actions are client islands.
 *
 *   <TaskList rows={rows} today={today} running={running} viewerEmployeeId={user.employeeId} />
 */
export function TaskList({
  rows,
  today,
  running,
  viewerEmployeeId,
  showClient = true,
  actions = true,
  waitingNote = true,
  emptyMessage = "No tasks here.",
  className,
}: {
  rows: TaskListRow[]
  today: string
  running: RunningRef
  viewerEmployeeId: string | null
  showClient?: boolean
  /** Show the row's action (Accept / Decline or the timer). */
  actions?: boolean
  /** Say "waiting for you to accept" on such rows (off in a list that holds nothing else). */
  waitingNote?: boolean
  emptyMessage?: string
  className?: string
}) {
  if (rows.length === 0) return <EmptyState size="compact" message={emptyMessage} className={className} />
  return (
    <ul className={cn("divide-y divide-border/70", className)}>
      {rows.map((r) => {
        const mine = Boolean(viewerEmployeeId && r.assigned_employee_id === viewerEmployeeId)
        const waiting = mine && r.acceptance_status === "pending"
        const filed = r.status === "filed_done"
        return (
          <li key={r.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/work/${r.id}`} className="min-w-0 truncate text-base font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {r.title}
                </Link>
                <StatusChip kind="task_status" value={r.status} className="flex-none" />
              </div>
              <MetaLine className="mt-0.5">
                <span className="font-mono text-xs">{r.task_number}</span>
                {showClient && r.client_name ? <span>{r.client_name}</span> : null}
                {r.due_date ? (
                  <span className="whitespace-nowrap">
                    <DateText date={r.due_date} withRelative={!filed} today={today} />
                  </span>
                ) : null}
                {waiting && waitingNote ? <span className="text-warning-text">waiting for you to accept</span> : null}
              </MetaLine>
            </div>
            {actions && !filed ? (
              <div className="flex-none">
                {waiting ? (
                  <AcceptDecline task={{ id: r.id, task_number: r.task_number, title: r.title }} quiet />
                ) : viewerEmployeeId ? (
                  <TimerButton task={{ id: r.id, label: `${r.task_number} · ${r.title}` }} running={running} size="sm" />
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
