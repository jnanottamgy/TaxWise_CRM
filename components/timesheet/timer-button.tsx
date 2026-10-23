"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PlayIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatMinutes } from "@/lib/format"
import { formatElapsed } from "@/lib/schemas/timesheet"
import { startTimer, stopTimer } from "@/server/actions/timesheet"

/**
 * Start timer / Stop timer (§7.10: "start from a task, client or top bar; stop; switching tasks
 * stops the previous one"). The timer lives on the server, so it survives reloads and devices;
 * after a change the page (and the shell's timer panel) refresh. Reused on the task page, the
 * task lists and My day.
 *
 *   <TimerButton task={{ id, label: "T-000123 · GSTR-3B" }} running={running} />
 *   <TimerButton client={{ id, label: "Sharma Traders" }} running={running} size="sm" />
 */

export type RunningRef = { entryId: string; taskId: string | null; clientId: string | null; startedAt: string } | null

/** Re-renders every second while `active`, for a ticking elapsed time. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function TimerButton({
  task,
  client,
  running,
  size = "default",
  variant = "outline",
  className,
}: {
  task?: { id: string; label: string } | null
  client?: { id: string; label: string } | null
  running: RunningRef
  size?: "default" | "sm"
  variant?: "default" | "outline"
  className?: string
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const here = running !== null && (task ? running.taskId === task.id : client ? running.clientId === client.id && !running.taskId : false)
  const now = useNow(here)

  const toggle = async () => {
    setPending(true)
    try {
      if (here) {
        const r = await stopTimer({})
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        toast.success(`Timer stopped: ${formatMinutes(r.data.minutes)} logged.`)
      } else {
        const r = await startTimer({ task_id: task?.id ?? null, client_id: task ? null : (client?.id ?? null) })
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        toast.success(
          r.data.stopped_minutes !== null
            ? `Timer started on ${task?.label ?? client?.label ?? "this work"}. The previous one stopped after ${formatMinutes(r.data.stopped_minutes)}.`
            : `Timer started on ${task?.label ?? client?.label ?? "this work"}.`,
        )
      }
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Button type="button" variant={here ? "default" : variant} size={size} onClick={toggle} disabled={pending} aria-busy={pending} className={className}>
      {pending ? <Spinner /> : here ? <SquareIcon aria-hidden="true" className="fill-current" /> : <PlayIcon aria-hidden="true" />}
      {here ? (
        <>
          Stop timer
          <span className="num font-normal tabular-nums" suppressHydrationWarning>
            <span className="sr-only">running for </span>
            {formatElapsed(now - new Date(running!.startedAt).getTime())}
          </span>
        </>
      ) : (
        "Start timer"
      )}
    </Button>
  )
}
