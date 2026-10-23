import { Suspense } from "react"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { Skeleton } from "@/components/ui/skeleton"
import { getRunningTimer, getTimerShortcuts, type RunningTimer, type TimerShortcut } from "@/lib/data/timesheet"
import { TimerPanelControls } from "@/components/timesheet/timer-panel-controls"

/**
 * The running-timer panel in the shell's timer sheet (§7.10: "start from a task, client or top bar;
 * stop; switching tasks stops the previous one"). The staff layout renders it on every page, so it
 * never throws: it streams behind its own Suspense boundary (the layout never waits for it) and any
 * failure to load shows a sentence with the Ref instead.
 */
export function TimerPanel({ user }: { user: CurrentUser }) {
  return (
    <Suspense fallback={<TimerPanelSkeleton />}>
      <TimerPanelBody user={user} />
    </Suspense>
  )
}

function TimerPanelSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  )
}

async function TimerPanelBody({ user }: { user: CurrentUser }) {
  if (!user.employeeId) {
    return <p className="text-base text-text-muted">Your team record is missing, so the timer isn&apos;t available. Ask a Partner to link your account.</p>
  }
  const loaded = await load(user.id, user.employeeId)
  if (loaded.status === "no_session") return <Hint />
  if (loaded.status === "failed") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-base text-text">Couldn&apos;t load your timer.</p>
        <p className="text-sm text-text-muted">
          Your time is safe: a running timer keeps running. Reload the page to try again. <span className="font-mono text-xs">Ref {loaded.ref}</span>
        </p>
      </div>
    )
  }
  const { running, shortcuts } = loaded
  return (
    <TimerPanelControls
      running={running ? { id: running.id, startedAt: running.started_at, description: running.description, task: running.task, client: running.client } : null}
      shortcuts={shortcuts}
    />
  )
}

type Loaded = { status: "ok"; running: RunningTimer | null; shortcuts: TimerShortcut[] } | { status: "no_session" } | { status: "failed"; ref: string }

/** The running timer and the person's open tasks; never throws. */
async function load(userId: string, employeeId: string): Promise<Loaded> {
  try {
    const session = await getSession()
    if (session.status !== "ok") return { status: "no_session" }
    const [running, shortcuts] = await Promise.all([getRunningTimer(session.supabase, employeeId), getTimerShortcuts(session.supabase, employeeId)])
    return { status: "ok", running, shortcuts }
  } catch (err) {
    unstable_rethrow(err)
    return { status: "failed", ref: logUnexpected(err, { source: "timesheet:timer-panel", userId }) }
  }
}

function Hint() {
  return <p className="text-base text-text-muted">Start a timer from a task or a client, or log time you have already spent.</p>
}
