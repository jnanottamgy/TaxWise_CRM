import Link from "next/link"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { ThinBar } from "@/components/tasks/task-ui"
import { TimerButton, type RunningRef } from "@/components/timesheet/timer-button"
import { RequestLeaveDialog } from "@/components/leave/request-leave-dialog"
import { formatMinutes, formatTimeAgo } from "@/lib/format"
import { LEAVE_TYPE_LABELS } from "@/lib/domain/enums"
import { formatLeaveRange } from "@/lib/domain/leave"
import type { MyLeave, MyWeek, SentBackRow } from "@/lib/data/dashboard"
import { RowLink } from "@/components/home/home-ui"

/**
 * My day's own blocks (§7.2 Employee): Sent back to me (with the reviewer's reason), this week's
 * hours against the target, and my leave. The task lists themselves are components/tasks/task-list.
 */

/** Tasks a reviewer sent back, each with the reason as they wrote it, and the timer to restart. */
export function SentBackList({ rows, today, running, viewerEmployeeId }: { rows: SentBackRow[]; today: string; running: RunningRef; viewerEmployeeId: string | null }) {
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <RowLink href={`/work/${r.id}`}>{r.title}</RowLink>
              <StatusChip label="Sent back" tone="warning" meaning="Sent back: the reviewer returned it to you with a reason. Fix what they asked, then submit it Under review again." className="flex-none" />
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
              <span className="font-mono text-xs">{r.task_number}</span>
              {r.client_name ? <span className="truncate">· {r.client_name}</span> : null}
              {r.due_date ? (
                <span className="whitespace-nowrap">
                  · <DateText date={r.due_date} withRelative today={today} />
                </span>
              ) : null}
            </p>
            <blockquote className="mt-2 border-l-2 border-warning pl-3 text-base text-text">
              {r.reason?.trim() ? r.reason : <span className="text-text-muted">No reason was given.</span>}
              <footer className="mt-0.5 text-sm text-text-muted">
                {r.sentBackBy ?? "The reviewer"}, {formatTimeAgo(r.sentBackAt)}
              </footer>
            </blockquote>
          </div>
          {viewerEmployeeId ? (
            <div className="flex-none">
              <TimerButton task={{ id: r.id, label: `${r.task_number} · ${r.title}` }} running={running} size="sm" />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** This week's hours against the target (§7.2), the same figures as the timesheet. */
export function WeekCard({ week }: { week: MyWeek }) {
  const { loggedMinutes, targetMinutes, behindMinutes, percent } = week
  const tone = targetMinutes === 0 ? "muted" : behindMinutes > 0 ? "warning" : "success"
  return (
    <SectionCard
      title="This week"
      action={
        <Link href="/timesheet" className="rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          Timesheet
        </Link>
      }
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="num text-xl leading-8 font-semibold text-text tabular-nums">{formatMinutes(loggedMinutes)}</span>
        <span className="text-sm text-text-muted">{targetMinutes > 0 ? `of ${formatMinutes(targetMinutes)} target` : "No target this week"}</span>
      </p>
      {percent !== null ? <ThinBar percent={percent} tone={tone === "muted" ? "muted" : tone === "warning" ? "warning" : "success"} label="Logged against this week's target" className="mt-2" /> : null}
      <p className={tone === "warning" ? "mt-2 text-sm text-warning-text" : "mt-2 text-sm text-text-muted"}>
        {targetMinutes === 0
          ? "Nothing is expected this week (holidays or leave)."
          : behindMinutes > 0
            ? `${formatMinutes(behindMinutes)} behind the target for the days so far.`
            : "On track for the days so far."}
      </p>
    </SectionCard>
  )
}

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** "2 days", "1.5 days" (working days). */
function short(n: number): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(1)
  return `${v} ${n === 1 ? "day" : "days"}`
}

function days(n: number): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(1)
  return `${v} working ${n === 1 ? "day" : "days"}`
}

/** My leave (§7.2): taken this FY, approved ahead, waiting for a decision, and what's coming up. */
export function LeaveCard({ leave }: { leave: MyLeave }) {
  const { summary, upcoming } = leave
  return (
    <SectionCard
      title="Leave"
      description={[`${short(summary.taken)} taken in FY ${summary.fy}`, summary.upcoming ? `${short(summary.upcoming)} ahead` : null, summary.pending ? `${short(summary.pending)} waiting for a decision` : null].filter(Boolean).join(" · ")}
      viewAll={{ href: "/leave", label: "All your leave" }}
    >
      {upcoming.rows.length === 0 ? (
        <EmptyState size="compact" message="No leave coming up." action={<RequestLeaveDialog variant="outline" />} />
      ) : (
        <ul className="divide-y divide-border/70">
          {upcoming.rows.map((l) => (
            <li key={l.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-base text-text">{sentenceCase(formatLeaveRange(l.start_date, l.end_date, l.half_day))}</p>
                <p className="text-sm text-text-muted">
                  {LEAVE_TYPE_LABELS[l.type]} · {days(l.working_days)}
                </p>
              </div>
              <StatusChip kind="leave_status" value={l.status} className="flex-none" />
            </li>
          ))}
        </ul>
      )}
      {upcoming.rows.length ? (
        <div className="mt-3">
          <RequestLeaveDialog variant="outline" />
        </div>
      ) : null}
    </SectionCard>
  )
}
