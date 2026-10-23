"use client"

import * as React from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { formatMinutes } from "@/lib/format"
import type { ActionResult } from "@/lib/result"
import { checklistProgress } from "@/lib/schemas/tasks"
import { budgetState } from "@/lib/schemas/timesheet"

/**
 * Small pieces the work tracker's screens share: a thin progress bar (grey track, one hue), the
 * checklist and time cells, toasts for action results (with the Ref and warnings), and downloading
 * an export the server returned as base64. Client-only.
 */

/** Shows a failed result as a toast with its Ref; returns true when it went through. Warnings toast too. */
export function toastResult<T>(r: ActionResult<T>, success?: string): r is { ok: true; data: T; warnings?: string[] } {
  if (!r.ok) {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }
  for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
  if (success) toast.success(success)
  return true
}

export function downloadBase64(file: { fileName: string; mimeType: string; base64: string }) {
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }))
  const a = document.createElement("a")
  a.href = url
  a.download = file.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A thin bar at the true ratio (§3.4, taste: inline bars thin and grey unless they're the answer). */
export function ThinBar({ percent, tone = "primary", className, label }: { percent: number; tone?: "primary" | "success" | "warning" | "danger" | "muted"; className?: string; label: string }) {
  const fill = { primary: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger", muted: "bg-text-muted" }[tone]
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-200 ease-out", fill)} style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** "3/7" with a 2px bar under it; grey dash for an empty checklist. */
export function ChecklistCell({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="text-text-muted">—</span>
  const p = checklistProgress(done, total)
  return (
    <span className="inline-flex w-16 flex-col items-end gap-1">
      <span className="num text-sm tabular-nums">
        {p.done}
        <span className="text-text-muted">/{p.total}</span>
      </span>
      <ThinBar percent={p.percent} tone={p.percent === 100 ? "success" : "muted"} className="h-0.5" label={`Checklist ${p.done} of ${p.total} done`} />
    </span>
  )
}

/** Time logged against the estimate: "2h 15m / 3h", over budget in the danger text. */
export function TimeCell({ logged, estimate }: { logged: number; estimate: number | null }) {
  const b = budgetState(estimate, logged)
  if (!logged && !estimate) return <span className="text-text-muted">—</span>
  return (
    <span className={cn("num text-sm whitespace-nowrap tabular-nums", b.state === "over" && "text-danger-text")}>
      {formatMinutes(logged)}
      {estimate ? <span className={cn(b.state === "over" ? "text-danger-text" : "text-text-muted")}> / {formatMinutes(estimate)}</span> : null}
    </span>
  )
}

/** The person's name, or a grey "Unassigned". */
export function PersonCell({ name, empty = "Unassigned" }: { name: string | null; empty?: string }) {
  return name ? <span className="truncate">{name}</span> : <span className="text-text-muted">{empty}</span>
}

/** Debounces a value (for the assignment check while the form changes). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
