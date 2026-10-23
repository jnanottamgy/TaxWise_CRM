"use client"

import Link from "next/link"
import { TimerIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOptionalShell } from "@/components/shell/shell-context"
import { TimerPanelControls, type PanelRunning } from "@/components/timesheet/timer-panel-controls"
import { TimerButton } from "@/components/timesheet/timer-button"
import { formatDate } from "@/lib/format"
import type { TimerShortcut } from "@/lib/data/timesheet"

const SHORTCUTS = 3

/**
 * My day → Timer (§7.2 "start/stop on a task", §7.10): the running timer with its note and Stop, or,
 * with none running, one tap to start on the next few of the person's tasks. Anything else (a client,
 * internal work) opens the shell's timer sheet, the same one the top bar and the phone's tab bar open.
 */
export function TimerCard({ running, shortcuts }: { running: PanelRunning; shortcuts: TimerShortcut[] }) {
  const shell = useOptionalShell()
  const runningRef = running ? { entryId: running.id, taskId: running.task?.id ?? null, clientId: running.client?.id ?? null, startedAt: running.startedAt } : null
  const other = shell ? (
    <Button type="button" variant="ghost" size="sm" className="self-start pointer-coarse:h-11" onClick={() => shell.setOpen("timer", true)}>
      <TimerIcon aria-hidden="true" />
      {running ? "Switch to something else" : "Time a client or internal work"}
    </Button>
  ) : null

  if (running) {
    return (
      <div className="flex flex-col gap-2">
        <TimerPanelControls running={running} shortcuts={[]} compact />
        {other}
      </div>
    )
  }

  const next = shortcuts.slice(0, SHORTCUTS)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">No timer is running.{next.length ? " Start on one of your tasks:" : ""}</p>
      {next.length ? (
        <ul className="divide-y divide-border/70">
          {next.map((t) => (
            <li key={t.id} className="flex min-h-11 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <Link href={`/work/${t.id}`} className="block truncate text-sm font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {t.title}
                </Link>
                <p className="truncate text-xs text-text-muted">
                  <span className="font-mono">{t.task_number}</span>
                  {t.client_name ? ` · ${t.client_name}` : ""}
                  {t.due_date ? <span className={t.is_overdue ? "text-danger-text" : undefined}>{` · ${t.is_overdue ? "overdue since" : "due"} ${formatDate(t.due_date)}`}</span> : null}
                </p>
              </div>
              <TimerButton task={{ id: t.id, label: `${t.task_number} · ${t.title}` }} running={runningRef} size="sm" />
            </li>
          ))}
        </ul>
      ) : null}
      {other}
    </div>
  )
}
