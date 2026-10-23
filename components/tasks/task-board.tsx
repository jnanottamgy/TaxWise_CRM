"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon, GripVerticalIcon, MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DateText } from "@/components/app/date-text"
import { PriorityChip } from "@/components/app/priority-chip"
import { StatusChip } from "@/components/app/status-chip"
import { formatNumber } from "@/lib/format"
import { getStatus } from "@/lib/status"
import type { AppRole, TaskStatus } from "@/lib/domain/enums"
import type { TaskListRow } from "@/lib/data/tasks"
import { boardMoveOptions, dropCheck } from "@/components/tasks/board-logic"
import { useTaskMover } from "@/components/tasks/status-control"

/**
 * The board (§7.6.1): a column per status. Drag a card to another column, or use its Move menu
 * (the single-pointer and keyboard alternative, WCAG 2.2 "Dragging movements"). A move that needs a
 * reason asks for it; Filed/Done on filing work opens the filing capture; refused moves say why.
 * Every move goes through change_task_status on the server.
 */

type Column = { status: TaskStatus; total: number; rows: TaskListRow[] }

export function TaskBoard({ columns, viewer, today, viewAllHref }: { columns: Column[]; viewer: { role: AppRole; employeeId: string | null }; today: string; viewAllHref: Record<string, string> }) {
  const [dragging, setDragging] = React.useState<TaskListRow | null>(null)
  const [over, setOver] = React.useState<TaskStatus | null>(null)
  const mover = useTaskMover()

  const tryMove = (row: TaskListRow, to: TaskStatus) => {
    const check = dropCheck(row, to, viewer)
    if (!check.ok) {
      toast.error(check.error)
      return
    }
    void mover.move(
      { id: row.id, task_number: row.task_number, title: row.title, status: row.status, service_type: row.service_type, compliance_event_id: row.compliance_event_id, updated_at: row.updated_at },
      to,
      check.requiresReason,
    )
  }

  return (
    <>
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0" role="region" aria-label="Board by status">
        <div className="grid min-w-max auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-3 max-md:snap-x max-md:snap-mandatory">
          {columns.map((col) => {
            const info = getStatus("task_status", col.status)
            const canDrop = dragging ? dropCheck(dragging, col.status, viewer).ok : false
            return (
              <section
                key={col.status}
                aria-label={`${info.label}: ${col.total} tasks`}
                onDragOver={(e) => {
                  if (!dragging || !canDrop) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  if (over !== col.status) setOver(col.status)
                }}
                onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  const row = dragging
                  setDragging(null)
                  if (row) tryMove(row, col.status)
                }}
                className={cn(
                  "flex max-h-[max(28rem,calc(100dvh-16rem))] min-h-48 w-[17rem] flex-col rounded-lg border border-border bg-surface-2/60 max-md:snap-start md:w-auto",
                  dragging && canDrop && "border-dashed border-primary/50",
                  over === col.status && "bg-primary-soft",
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                  <StatusChip kind="task_status" value={col.status} />
                  <span className="num text-sm text-text-muted tabular-nums">{formatNumber(col.total)}</span>
                </header>
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {col.rows.length === 0 ? <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-text-muted">No tasks here.</li> : null}
                  {col.rows.map((row) => (
                    <BoardCard
                      key={row.id}
                      row={row}
                      today={today}
                      viewer={viewer}
                      busy={mover.busy === row.id}
                      onDragStart={() => setDragging(row)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      onMove={(to) => tryMove(row, to)}
                    />
                  ))}
                </ul>
                {col.total > col.rows.length ? (
                  <Link href={viewAllHref[col.status] ?? "/work"} className="border-t border-border px-3 py-2 text-sm font-medium text-text hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                    View all {formatNumber(col.total)} in the table
                  </Link>
                ) : null}
              </section>
            )
          })}
        </div>
      </div>
      {mover.dialogs}
    </>
  )
}

function BoardCard({
  row,
  today,
  viewer,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  row: TaskListRow
  today: string
  viewer: { role: AppRole; employeeId: string | null }
  busy: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: TaskStatus) => void
}) {
  const options = boardMoveOptions(row, viewer)
  const draggable = options.some((o) => o.allowed)
  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id)
        e.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      aria-busy={busy || undefined}
      className={cn("group/card rounded-md border border-border bg-surface p-3 transition-opacity duration-150", busy && "opacity-60", draggable && "cursor-grab active:cursor-grabbing")}
    >
      <div className="flex items-start gap-2">
        {draggable ? <GripVerticalIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-text-muted/60" /> : null}
        <div className="min-w-0 flex-1">
          <Link href={`/work/${row.id}`} className="line-clamp-2 text-base leading-5 font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {row.title}
          </Link>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            <span className="font-mono">{row.task_number}</span>
            {row.client_name ? ` · ${row.client_name}` : ""}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`Move ${row.task_number}`} className="flex-none">
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-medium text-text-muted">Move to</DropdownMenuLabel>
            {options.map((o) => (
              <DropdownMenuItem key={o.status} disabled={!o.allowed} onSelect={() => onMove(o.status)} className="flex-col items-start gap-0.5">
                <span className="flex items-center gap-2">
                  <ArrowRightIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                  {getStatus("task_status", o.status).label}
                </span>
                {!o.allowed && o.error ? <span className="pl-5.5 text-xs text-text-muted">{o.error}</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <DateText date={row.due_date} withRelative={row.status !== "filed_done"} today={today} className="text-xs" />
        <PriorityChip kind="task_priority" value={row.priority} hideLabel />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="truncate">{row.assignee_name ?? "Unassigned"}</span>
        <span className="flex items-center gap-2">
          {row.checklist_total ? (
            <span className="num tabular-nums">
              {row.checklist_done}/{row.checklist_total}
            </span>
          ) : null}
          {row.open_blockers ? <span>Blocked by {row.open_blockers}</span> : null}
        </span>
      </div>
      {row.acceptance_status === "pending" && row.assigned_employee_id ? <p className="mt-1.5 text-xs text-warning-text">Waiting for acceptance</p> : null}
      {row.acceptance_status === "declined" ? <p className="mt-1.5 text-xs text-danger-text">Declined{row.declined_by_name ? ` by ${row.declined_by_name}` : ""}: reassign it</p> : null}
    </li>
  )
}
