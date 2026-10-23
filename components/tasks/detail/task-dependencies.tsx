"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { Combobox } from "@/components/app/form/combobox"
import type { TaskStatus } from "@/lib/domain/enums"
import { addTaskDependency, removeTaskDependency } from "@/server/actions/task-dependencies"
import { searchTasks } from "@/server/actions/tasks"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * Blocked by / blocking (§7.6.6): the tasks this one waits for, and the tasks waiting for it. A task
 * can't move to In progress, Under review or Filed/Done while any blocker isn't Filed/Done; loops
 * are refused by the database. Partners and Managers add and remove links.
 */

export type DependencyRow = {
  dependency_id: string
  direction: "blocked_by" | "blocking"
  task_id: string
  task_number: string
  title: string
  status: TaskStatus
  due_date: string | null
  client_name: string | null
  visible: boolean
}

function Row({ d, canManage, onRemove }: { d: DependencyRow; canManage: boolean; onRemove?: () => void }) {
  return (
    <li className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        {d.visible ? (
          <Link href={`/work/${d.task_id}`} className="block truncate text-sm font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {d.title}
          </Link>
        ) : (
          <span className="block truncate text-sm font-medium text-text">{d.title}</span>
        )}
        <span className="block truncate text-xs text-text-muted">
          <span className="font-mono">{d.task_number}</span>
          {d.client_name ? ` · ${d.client_name}` : ""}
        </span>
      </div>
      <StatusChip kind="task_status" value={d.status} />
      {canManage && onRemove ? (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove the link to ${d.task_number}`} onClick={onRemove}>
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  )
}

export function TaskDependencies({ taskId, deps, canManage }: { taskId: string; deps: DependencyRow[]; canManage: boolean }) {
  const router = useRouter()
  const blockedBy = deps.filter((d) => d.direction === "blocked_by")
  const blocking = deps.filter((d) => d.direction === "blocking")
  const open = blockedBy.filter((d) => d.status !== "filed_done").length
  const [picking, setPicking] = React.useState<string | null>(null)
  const id = React.useId()

  const remove = async (d: DependencyRow) => {
    const r = await removeTaskDependency({ id: d.dependency_id })
    if (toastResult(r, "Link removed.")) router.refresh()
  }

  return (
    <SectionCard title="Dependencies" description={open ? `Waiting on ${open} ${open === 1 ? "task" : "tasks"}` : blockedBy.length ? "Every blocker is Filed/Done" : undefined}>
      <h3 className="text-xs font-medium text-text-muted">Blocked by</h3>
      {blockedBy.length ? (
        <ul className="mb-3 divide-y divide-border/70">
          {blockedBy.map((d) => (
            <Row key={d.dependency_id} d={d} canManage={canManage} onRemove={() => void remove(d)} />
          ))}
        </ul>
      ) : (
        <p className="mb-3 py-1.5 text-sm text-text-muted">Nothing. It can move freely.</p>
      )}
      {canManage ? (
        <div className="mb-4">
          <label htmlFor={id} className="sr-only">
            Add a blocking task
          </label>
          <Combobox
            id={id}
            value={picking}
            clearable={false}
            placeholder="Add a task this one waits for"
            searchPlaceholder="Task number, title or client"
            loadOptions={async (q) => {
              const r = await searchTasks({ q, clientId: null, excludeId: taskId, openOnly: true })
              return r.ok ? r.data.filter((o) => !deps.some((d) => d.task_id === o.value)) : []
            }}
            onChange={async (v) => {
              setPicking(null)
              if (!v) return
              const r = await addTaskDependency({ task_id: taskId, blocker_task_id: v })
              if (toastResult(r, "Blocker added.")) router.refresh()
            }}
          />
        </div>
      ) : null}
      <h3 className="text-xs font-medium text-text-muted">Blocking</h3>
      {blocking.length ? (
        <ul className="divide-y divide-border/70">
          {blocking.map((d) => (
            <Row key={d.dependency_id} d={d} canManage={false} />
          ))}
        </ul>
      ) : (
        <p className="py-1.5 text-sm text-text-muted">No task waits for this one.</p>
      )}
    </SectionCard>
  )
}
