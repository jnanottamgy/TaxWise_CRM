"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangleIcon, PlayIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { useOptionalShell } from "@/components/shell/shell-context"
import { formatDate, formatMinutes, formatTime } from "@/lib/format"
import { LONG_TIMER_HOURS, formatElapsed } from "@/lib/schemas/timesheet"
import { startTimer, stopTimer } from "@/server/actions/timesheet"
import { searchTaskClients } from "@/server/actions/tasks"
import { TimerButton, useNow } from "@/components/timesheet/timer-button"
import type { TimerShortcut } from "@/lib/data/timesheet"

/**
 * The timer sheet's body (§7.10): the running timer with its ticking time and Stop (with an
 * optional note of what was done), a warning when it has run for more than 10 hours, then one tap
 * to start on one of the person's open tasks, on a client, or on internal work. Starting another
 * stops the running one; the server keeps the timer, so it survives reloads and devices.
 */

export type PanelRunning = {
  id: string
  startedAt: string
  description: string | null
  task: { id: string; task_number: string; title: string } | null
  client: { id: string; name: string; code: string | null } | null
} | null

function reportFailure(r: { ok: false; error: string; ref?: string | null }) {
  toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
}

export function TimerPanelControls({ running, shortcuts, compact = false }: { running: PanelRunning; shortcuts: TimerShortcut[]; /** Only the running timer (the timesheet page shows it above the grid). */ compact?: boolean }) {
  const router = useRouter()
  const shell = useOptionalShell()
  const closeSheet = () => shell?.setOpen("timer", false)
  const now = useNow(running !== null)
  const [note, setNote] = React.useState(running?.description ?? "")
  const [stopping, setStopping] = React.useState(false)
  const [clientId, setClientId] = React.useState<string | null>(null)
  const [clientLabel, setClientLabel] = React.useState("")
  const [starting, setStarting] = React.useState<"client" | "internal" | null>(null)
  const noteId = React.useId()

  const noteSource = `${running?.id ?? ""}|${running?.description ?? ""}`
  const [seenNote, setSeenNote] = React.useState(noteSource)
  if (seenNote !== noteSource) {
    setSeenNote(noteSource)
    setNote(running?.description ?? "")
  }

  const runningRef = running ? { entryId: running.id, taskId: running.task?.id ?? null, clientId: running.client?.id ?? null, startedAt: running.startedAt } : null
  const elapsed = running ? now - new Date(running.startedAt).getTime() : 0
  const long = elapsed >= LONG_TIMER_HOURS * 3_600_000

  const stop = async () => {
    setStopping(true)
    try {
      const r = await stopTimer({ description: note.trim() || null })
      if (!r.ok) return reportFailure(r)
      toast.success(`Timer stopped: ${formatMinutes(r.data.minutes)} logged.`)
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setStopping(false)
    }
  }

  const start = async (kind: "client" | "internal") => {
    setStarting(kind)
    try {
      const r = await startTimer({ client_id: kind === "client" ? clientId : null, task_id: null })
      if (!r.ok) return reportFailure(r)
      const on = kind === "client" ? clientLabel || "this client" : "internal work"
      toast.success(r.data.stopped_minutes !== null ? `Timer started on ${on}. The previous one stopped after ${formatMinutes(r.data.stopped_minutes)}.` : `Timer started on ${on}.`)
      setClientId(null)
      setClientLabel("")
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setStarting(null)
    }
  }

  const runningBlock = running ? (
    <div className={compact ? undefined : "rounded-lg border border-border bg-surface px-4 py-3"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-text-muted">Running since {formatTime(running.startedAt)}{elapsed >= 86_400_000 ? `, ${formatDate(running.startedAt)}` : ""}</p>
          {running.task ? (
            <Link href={`/work/${running.task.id}`} onClick={closeSheet} className="mt-0.5 block truncate text-base font-medium text-text hover:underline">
              {running.task.title}
            </Link>
          ) : (
            <p className="mt-0.5 truncate text-base font-medium text-text">{running.client ? running.client.name : "Internal work"}</p>
          )}
          <p className="truncate text-sm text-text-muted">
            {running.task ? <span className="font-mono text-xs">{running.task.task_number}</span> : null}
            {running.task && running.client ? " · " : null}
            {running.task && running.client ? running.client.name : null}
            {!running.task && running.client ? "No task" : null}
            {!running.task && !running.client ? "Not billable" : null}
          </p>
        </div>
        <p className="num flex-none text-2xl leading-9 font-semibold tabular-nums text-text" suppressHydrationWarning>
          <span className="sr-only">Running for </span>
          {formatElapsed(elapsed)}
        </p>
      </div>
      {long ? (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
          <span>
            This timer has run for over {LONG_TIMER_HOURS} hours. If you forgot to stop it, stop it now and correct the time on{" "}
            <Link href="/timesheet" onClick={closeSheet} className="font-medium underline">
              your timesheet
            </Link>
            .
          </span>
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor={noteId} className="text-sm font-medium text-text">
          What you worked on
        </Label>
        <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional note for the entry" />
      </div>
      <Button type="button" className="mt-3 w-full" onClick={stop} disabled={stopping} aria-busy={stopping}>
        {stopping ? <Spinner /> : <SquareIcon aria-hidden="true" className="fill-current" />}
        Stop timer
      </Button>
    </div>
    ) : null

  if (compact) return runningBlock

  return (
    <div className="flex flex-col gap-5">
      {running ? (
        <section aria-label="Running timer">{runningBlock}</section>
      ) : (
        <p className="text-base text-text-muted">No timer is running. Start one on a task below, on a client, or on internal work.</p>
      )}

      {shortcuts.length ? (
        <section aria-labelledby="timer-shortcuts">
          <h3 id="timer-shortcuts" className="mb-1 text-sm font-semibold text-text">
            {running ? "Switch to one of your tasks" : "Your open tasks"}
          </h3>
          <ul className="divide-y divide-border/70">
            {shortcuts.map((t) => (
              <li key={t.id} className="flex min-h-11 items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/work/${t.id}`} onClick={closeSheet} className="block truncate text-sm font-medium text-text hover:underline">
                    {t.title}
                  </Link>
                  <p className="truncate text-xs text-text-muted">
                    <span className="font-mono">{t.task_number}</span>
                    {t.client_name ? ` · ${t.client_name}` : ""}
                    {t.due_date ? (
                      <span className={t.is_overdue ? "text-danger-text" : undefined}>
                        {` · ${t.is_overdue ? "overdue since" : "due"} ${formatDate(t.due_date)}`}
                      </span>
                    ) : null}
                  </p>
                </div>
                <TimerButton task={{ id: t.id, label: `${t.task_number} · ${t.title}` }} running={runningRef} size="sm" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="timer-other" className="flex flex-col gap-2">
        <h3 id="timer-other" className="text-sm font-semibold text-text">
          Other work
        </h3>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Combobox
            aria-label="Client to time"
            value={clientId}
            onChange={(v, o?: ComboOption) => {
              setClientId(v)
              setClientLabel(o?.label ?? "")
            }}
            selectedLabel={clientLabel}
            placeholder="Choose a client"
            searchPlaceholder="Name or code"
            loadOptions={async (q) => {
              const r = await searchTaskClients({ q })
              return r.ok ? r.data : []
            }}
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="outline" onClick={() => void start("client")} disabled={!clientId || starting !== null} aria-busy={starting === "client"}>
            {starting === "client" ? <Spinner /> : <PlayIcon aria-hidden="true" />}
            Start on client
          </Button>
        </div>
        <Button type="button" variant="ghost" className="self-start" onClick={() => void start("internal")} disabled={starting !== null} aria-busy={starting === "internal"}>
          {starting === "internal" ? <Spinner /> : <PlayIcon aria-hidden="true" />}
          Start on internal work (not billable)
        </Button>
      </section>
    </div>
  )
}
