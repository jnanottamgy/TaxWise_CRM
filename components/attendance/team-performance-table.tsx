import Link from "next/link"
import { cn } from "@/lib/utils"
import { RoleBadge } from "@/components/app/role-badge"
import { EmptyState } from "@/components/app/empty-state"
import { formatMinutes, formatPercent, EMPTY } from "@/lib/format"
import type { TeamAttendanceRow } from "@/lib/data/attendance"
import type { TeamPerformanceRow } from "@/lib/data/people"

/**
 * The team's month and year side by side (/performance, §7.11.2 Performance, §7.12 monthly
 * summary): attendance counts for the month, then performance for the financial year. A report of
 * the whole team (bounded by its size), so it isn't paged; on phones it scrolls inside its own
 * frame with the name column fixed. Server-safe.
 */
export function TeamPerformanceTable({ rows, performance, month, fy }: { rows: TeamAttendanceRow[]; performance: Map<string, TeamPerformanceRow>; month: string; fy: string }) {
  if (rows.length === 0) return <EmptyState message="No one on the team yet." />
  const head = "sticky top-0 z-10 h-9 bg-surface-2 px-3 text-xs font-medium whitespace-nowrap text-text-muted shadow-[inset_0_-1px_0_var(--border)]"
  const num = "num border-b border-border/70 px-3 text-right whitespace-nowrap tabular-nums"
  return (
    <div className="max-h-[max(22rem,calc(100dvh-16rem))] overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-base">
        <caption className="sr-only">
          Attendance for {month} and performance for FY {fy}, per person
        </caption>
        <thead>
          <tr>
            <th scope="col" className={cn(head, "left-0 z-20 pl-4 text-left")} style={{ width: "20%" }}>
              Person
            </th>
            <th scope="col" className={cn(head, "text-right")}>Present</th>
            <th scope="col" className={cn(head, "text-right")}>Late</th>
            <th scope="col" className={cn(head, "text-right")}>Half days</th>
            <th scope="col" className={cn(head, "text-right")}>Absent</th>
            <th scope="col" className={cn(head, "text-right")}>On leave</th>
            <th scope="col" className={cn(head, "text-right")}>Active time</th>
            <th scope="col" className={cn(head, "border-l border-border text-right")}>Filed on time</th>
            <th scope="col" className={cn(head, "text-right")}>Avg days late</th>
            <th scope="col" className={cn(head, "text-right")}>Sent back</th>
            <th scope="col" className={cn(head, "pr-4 text-right")}>Hours vs target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = performance.get(r.employee_id)
            const s = r.summary
            return (
              <tr key={r.employee_id} className="h-(--row-height) bg-surface">
                <td className="sticky left-0 z-[1] border-b border-border/70 bg-surface pr-3 pl-4">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/people/${r.employee_id}?tab=performance`} className="truncate font-medium text-text hover:underline">
                      {r.full_name}
                    </Link>
                    <RoleBadge role={r.role} className="max-2xl:hidden" />
                  </span>
                </td>
                <td className={num}>{s.present}</td>
                <td className={num}>{s.lateLogin}</td>
                <td className={num}>{s.halfDay}</td>
                <td className={cn(num, s.absent > 0 && "text-danger-text")}>{s.absent}</td>
                <td className={num}>{s.onLeave}</td>
                <td className={num}>{formatMinutes(s.workMinutes)}</td>
                <td className={cn(num, "border-l border-border/70")}>
                  {p && p.onTimePercent !== null ? (
                    <span title={`${p.filedOnTime} of ${p.filed} filed on time`}>{formatPercent(p.onTimePercent, { decimals: 1 })}</span>
                  ) : (
                    <span className="text-text-muted">{EMPTY}</span>
                  )}
                </td>
                {/* Nothing filed yet is "no figure", not "0 days late" (the on-time % beside it is a dash too). */}
                <td className={num}>{p && p.filed > 0 ? (p.averageDaysLate ?? 0) : <span className="text-text-muted">{EMPTY}</span>}</td>
                <td className={num}>
                  {p && p.sendBackPercent !== null ? (
                    <span title={`${p.sentBack} of ${p.submittedForReview} submissions sent back`}>{formatPercent(p.sendBackPercent, { decimals: 1 })}</span>
                  ) : (
                    <span className="text-text-muted">{EMPTY}</span>
                  )}
                </td>
                <td className={cn(num, "pr-4")}>
                  {p ? (
                    // Stacked, so the year's target doesn't widen the table past a 1366px screen.
                    <span title={`${formatMinutes(p.hoursMinutes)} of ${formatMinutes(p.targetMinutes)}`} className="flex flex-col items-end leading-4">
                      <span>{formatMinutes(p.hoursMinutes)}</span>
                      <span className="text-xs text-text-muted">of {formatMinutes(p.targetMinutes)}</span>
                    </span>
                  ) : (
                    EMPTY
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
