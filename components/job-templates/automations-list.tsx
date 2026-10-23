"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { MoreHorizontalIcon, PencilIcon, RepeatIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { formatDate } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import { describeSchedule } from "@/lib/schemas/job-templates"
import type { AutomationRow } from "@/lib/data/job-templates"
import { deleteAutomation, setAutomationActive } from "@/server/actions/task-automations"
import { AutomationDialog, NewAutomationButton, type AutomationOptions } from "@/components/job-templates/automation-form"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * Recurring tasks (§7.6.7): what each creates, for which client, on what schedule, when it runs
 * next and how many tasks it has made. Partners and Managers pause, edit and delete them.
 */
export function AutomationsList({
  automations,
  options,
  client,
  showClient = true,
}: {
  automations: AutomationRow[]
  options: AutomationOptions
  client?: { id: string; label: string } | null
  showClient?: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<AutomationRow | null>(null)
  const [deleting, setDeleting] = React.useState<AutomationRow | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const toggle = async (a: AutomationRow) => {
    setBusy(a.id)
    try {
      const r = await setAutomationActive({ id: a.id, is_active: !a.is_active })
      if (toastResult(r, a.is_active ? "Paused. No tasks are created until you resume it." : "Resumed from the next date.")) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  if (automations.length === 0) {
    return (
      <EmptyState
        icon={<RepeatIcon />}
        message={client ? "No recurring tasks for this client. Set one up for returns that come every period." : "No recurring tasks yet. Each one creates a client's task every period, such as GSTR-3B on the 1st of every month."}
        action={<NewAutomationButton options={options} client={client} />}
      />
    )
  }

  return (
    <>
      <ul className="divide-y divide-border/70">
        {automations.map((a) => {
          const schedule = { frequency: a.frequency, run_day: a.config.run_day, run_month: a.config.run_month, run_weekday: a.config.run_weekday, period_offset: a.config.period_offset, due_after_days: a.config.due_after_days }
          return (
            <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 md:px-5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium text-text">{a.config.title}</p>
                <p className="text-sm text-text-muted">
                  {showClient ? (
                    <>
                      <Link href={`/clients/${a.client_id}?tab=tasks`} className="text-text hover:underline">
                        {a.client_name ?? "Client"}
                      </Link>
                      {" · "}
                    </>
                  ) : null}
                  {describeSchedule(schedule)}
                </p>
                <p className="text-xs text-text-muted">
                  {a.assignee_name ? `For ${a.assignee_name}` : "Unassigned"}
                  {a.template_name ? ` · ${a.template_name}` : ""}
                  {` · ${a.tasks_created} ${a.tasks_created === 1 ? "task" : "tasks"} so far`}
                  {a.last_run_at ? ` · last ran ${formatDate(a.last_run_at)}` : ""}
                </p>
              </div>
              <div className="flex flex-none items-center gap-3">
                <span className="num text-right text-sm tabular-nums">
                  {a.is_active && a.next_run_at ? (
                    <>
                      <span className="block text-xs text-text-muted">Next</span>
                      {formatDate(istDateOf(a.next_run_at))}
                    </>
                  ) : null}
                </span>
                <StatusChip
                  label={a.is_active ? "Active" : "Paused"}
                  tone={a.is_active ? "success" : "muted"}
                  meaning={a.is_active ? "Active: it creates the next task on its date." : "Paused: nothing is created until it is resumed."}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.config.title}`} disabled={busy === a.id}>
                      {busy === a.id ? <Spinner /> : <MoreHorizontalIcon aria-hidden="true" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(a)}>
                      <PencilIcon aria-hidden="true" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void toggle(a)}>{a.is_active ? "Pause" : "Resume"}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setDeleting(a)} className="text-danger-text focus:text-danger-text">
                      <Trash2Icon aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          )
        })}
      </ul>
      {editing ? (
        <AutomationDialog
          open
          onOpenChange={(o) => (!o ? setEditing(null) : undefined)}
          options={options}
          automation={{ id: editing.id, client_id: editing.client_id, client_label: `${editing.client_code ? `${editing.client_code} · ` : ""}${editing.client_name ?? ""}`, frequency: editing.frequency, config: editing.config, is_active: editing.is_active, updated_at: editing.updated_at }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title="Delete this recurring task?"
        description={`“${deleting?.config.title ?? ""}” stops creating tasks. The ${deleting?.tasks_created ?? 0} tasks it already made stay as they are.`}
        confirmLabel="Delete recurring task"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          const r = await deleteAutomation({ id: deleting.id })
          if (!toastResult(r, "Recurring task deleted.")) return false
          setDeleting(null)
          router.refresh()
        }}
      />
    </>
  )
}
