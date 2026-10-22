import { cn } from "@/lib/utils"
import { EMPTY, formatDate, formatDateTime, relativeDue } from "@/lib/format"
import { isDateString, istDateOf, todayIST } from "@/lib/domain/fy"
import { urgencyTextClass } from "@/components/app/tones"

/**
 * A date as `22 Oct 2026` (§3.4), optionally with the relative due text coloured by urgency:
 * overdue = danger, ≤ 3 days = warning, ≤ 7 days = info, later = grey. Server-safe.
 *
 *   <DateText date={task.due_date} withRelative />          → 25 Oct 2026 · in 3 days
 *   <DateText date={task.due_date} withRelative stacked />  → date over the relative text (table cells)
 *   <DateText date={msg.created_at} withTime />             → 22 Oct 2026, 14:05 (IST)
 *   <DateText date={null} />                                → grey —
 *
 * Pass `withRelative={false}` once the work is done (a filed return isn't "2 days overdue").
 * `today` defaults to today in IST; pass it from the server when you render many rows.
 */
export function DateText({
  date,
  withRelative = false,
  withTime = false,
  stacked = false,
  today,
  className,
}: {
  date: string | Date | null | undefined
  withRelative?: boolean
  withTime?: boolean
  stacked?: boolean
  today?: string
  className?: string
}) {
  if (date === null || date === undefined || date === "") {
    return (
      <span className={cn("text-text-muted", className)} aria-label="No date">
        {EMPTY}
      </span>
    )
  }

  let day: string
  try {
    day = typeof date === "string" && isDateString(date) ? date : istDateOf(date)
  } catch {
    return (
      <span className={cn("text-text-muted", className)} aria-label="No date">
        {EMPTY}
      </span>
    )
  }

  const label = withTime && !(typeof date === "string" && isDateString(date)) ? formatDateTime(date) : formatDate(day)
  const iso = typeof date === "string" ? date : date.toISOString()
  const rel = withRelative ? relativeDue(day, today ?? todayIST()) : null

  return (
    <span
      className={cn("num tabular-nums", stacked ? "inline-flex flex-col leading-5" : "inline", className)}
    >
      <time dateTime={iso} className="whitespace-nowrap">
        {label}
      </time>
      {rel ? (
        <span className={cn("whitespace-nowrap", stacked ? "text-xs leading-4" : "", urgencyTextClass(rel.urgency))}>
          {stacked ? null : <span className="text-text-muted"> · </span>}
          {rel.text}
        </span>
      ) : null}
    </span>
  )
}
