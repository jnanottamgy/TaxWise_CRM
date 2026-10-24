import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { formatDate, formatMinutes } from "@/lib/format"
import type { DateString } from "@/lib/domain/fy"
import { budgetState, dayHeading, formatDurationInput, utilisation } from "@/lib/schemas/timesheet"
import type { BudgetRow, TeamPerson, TeamWeek } from "@/lib/data/timesheet"
import { ThinBar } from "@/components/tasks/task-ui"
import { ApproveWeekButton, ReopenWeekButton } from "@/components/timesheet/week-approval"

/**
 * The team timesheet (§7.10, Partners and Managers): each person's time per day of the week against
 * their target, utilisation (billable ÷ total), whether the week is approved (and so locked), and
 * budget against actual for the tasks worked on this week. Server-safe; approving and reopening
 * are client islands.
 */

export type TeamViewer = { role: "partner" | "manager"; employeeId: string | null }

/** Partners approve anyone's week; Managers approve Employees' weeks, never their own (the database enforces it too). */
export function canApproveWeek(viewer: TeamViewer, person: Pick<TeamPerson, "employee_id" | "role">): boolean {
  if (viewer.role === "partner") return true
  return person.role === "employee" && person.employee_id !== viewer.employeeId
}

function Hours({ minutes }: { minutes: number }) {
  return <span className={cn("num tabular-nums", minutes ? "text-text" : "text-text-muted")}>{formatDurationInput(minutes) || "0:00"}</span>
}

function UtilisationText({ value }: { value: number | null }) {
  return value === null ? <span className="text-text-muted">—</span> : <span className="num tabular-nums">{value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%</span>
}

function WeekState({ person, viewer, monday }: { person: TeamPerson; viewer: TeamViewer; monday: DateString }) {
  const allowed = canApproveWeek(viewer, person)
  if (person.approval) {
    return (
      <span className="inline-flex items-center gap-2">
        <StatusChip
          label="Approved"
          tone="success"
          meaning={`Approved${person.approval.approved_by_name ? ` by ${person.approval.approved_by_name}` : ""} on ${formatDate(person.approval.approved_at)}. The week's entries are locked.`}
        />
        {allowed ? <ReopenWeekButton person={{ employee_id: person.employee_id, name: person.name }} weekStart={monday} /> : null}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <StatusChip label="Open" tone="muted" meaning="Not approved yet: the person can still change this week's entries." />
      {allowed && person.total > 0 ? <ApproveWeekButton person={{ employee_id: person.employee_id, name: person.name }} weekStart={monday} minutes={person.total} running={person.running} /> : null}
    </span>
  )
}

export function TeamWeekTable({ team, viewer, today, personHref }: { team: TeamWeek; viewer: TeamViewer; today: DateString; personHref: (employeeId: string) => string }) {
  if (team.people.length === 0) {
    return (
      <section aria-label="Team timesheet" className="rounded-lg border border-border bg-surface">
        <EmptyState size="compact" className="m-4 md:m-5" message="Nobody on the team yet. People added in People show here with their week." />
      </section>
    )
  }
  const teamTarget = team.people.reduce((n, p) => n + p.target, 0)
  return (
    <section aria-labelledby="team-week-title" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 md:px-5">
        <h2 id="team-week-title" className="text-base font-semibold text-text">
          Team
        </h2>
        <p className="text-sm text-text-muted">Time per person per day against their target. Open a person to see their week before approving it.</p>
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <caption className="sr-only">Time per person per day for the week</caption>
          <thead className="bg-surface-2">
            <tr className="border-b border-border">
              <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-4 py-2 text-left text-xs font-medium text-text-muted md:px-5">
                Person
              </th>
              {team.dates.map((d) => {
                const h = dayHeading(d)
                return (
                  <th key={d} scope="col" aria-current={d === today ? "date" : undefined} className={cn("w-14 px-1.5 py-2 text-right text-xs font-medium", d === today ? "text-text" : "text-text-muted")}>
                    <span className="block">{h.weekday}</span>
                    <span className={cn("num tabular-nums", d === today && "font-semibold")}>{h.day}</span>
                  </th>
                )
              })}
              <th scope="col" className="w-24 px-2 py-2 text-right text-xs font-medium text-text-muted">
                Total
              </th>
              <th scope="col" className="w-24 px-2 py-2 text-right text-xs font-medium text-text-muted">
                Utilisation
              </th>
              <th scope="col" className="w-48 px-4 py-2 text-left text-xs font-medium text-text-muted md:px-5">
                Week
              </th>
            </tr>
          </thead>
          <tbody>
            {team.people.map((p) => (
              <tr key={p.employee_id} className="border-b border-border/70 last:border-b-0">
                <th scope="row" className="sticky left-0 z-10 max-w-[16rem] bg-surface px-4 py-2 text-left font-normal md:px-5">
                  <Link href={personHref(p.employee_id)} className="block truncate text-sm font-medium text-text hover:underline">
                    {p.name}
                  </Link>
                  <span className="block truncate text-xs text-text-muted">
                    {p.designation ?? (p.role === "partner" ? "Partner" : p.role === "manager" ? "Manager" : "Employee")}
                    {p.running ? " · timer running" : ""}
                  </span>
                </th>
                {p.days.map((m, i) => (
                  <td key={team.dates[i]} className="px-1.5 py-2 text-right">
                    <Hours minutes={m} />
                  </td>
                ))}
                <td className="px-2 py-2 text-right">
                  <span className="num inline-flex flex-col items-end leading-tight tabular-nums">
                    <span className="font-medium text-text">{formatDurationInput(p.total) || "0:00"}</span>
                    <span className="text-xs text-text-muted">{p.target ? `of ${formatDurationInput(p.target)}` : "no target"}</span>
                  </span>
                </td>
                <td className="px-2 py-2 text-right">
                  <span className="inline-flex flex-col items-end leading-tight">
                    <UtilisationText value={p.utilisation} />
                    <span className="num text-xs text-text-muted tabular-nums">{formatMinutes(p.billable)} billable</span>
                  </span>
                </td>
                <td className="px-4 py-2 md:px-5">
                  <WeekState person={p} viewer={viewer} monday={team.monday} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-surface-2/60">
              <th scope="row" className="sticky left-0 z-10 bg-surface-2 px-4 py-2 text-left text-sm font-medium text-text md:px-5">
                Team
              </th>
              {team.dayTotals.map((m, i) => (
                <td key={team.dates[i]} className="px-1.5 py-2 text-right font-medium">
                  <Hours minutes={m} />
                </td>
              ))}
              <td className="px-2 py-2 text-right">
                <span className="num inline-flex flex-col items-end leading-tight tabular-nums">
                  <span className="font-semibold text-text">{formatDurationInput(team.total) || "0:00"}</span>
                  <span className="text-xs text-text-muted">{teamTarget ? `of ${formatDurationInput(teamTarget)}` : "no target"}</span>
                </span>
              </td>
              <td className="px-2 py-2 text-right font-medium">
                <UtilisationText value={utilisation(team.billable, team.total)} />
              </td>
              <td className="px-4 py-2 md:px-5" />
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="divide-y divide-border/70 md:hidden">
        {team.people.map((p) => (
          <li key={p.employee_id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={personHref(p.employee_id)} className="block truncate text-base font-medium text-text hover:underline">
                  {p.name}
                </Link>
                <p className="text-sm text-text-muted">
                  <span className="num tabular-nums">{formatMinutes(p.total)}</span>
                  {p.target ? ` of ${formatMinutes(p.target)}` : ""}
                  {" · "}
                  {p.utilisation === null ? "no time yet" : `${p.utilisation.toLocaleString("en-IN", { maximumFractionDigits: 1 })}% billable`}
                  {p.running ? " · timer running" : ""}
                </p>
              </div>
            </div>
            <WeekState person={p} viewer={viewer} monday={team.monday} />
          </li>
        ))}
      </ul>
    </section>
  )
}

const BUDGET_WORDS = { over: "Over budget", near: "Near budget", under: "Within budget", none: "No estimate" } as const
const BUDGET_TONE = { over: "danger", near: "warning", under: "success", none: "muted" } as const

/** Budget (estimate) against actual (all time logged) for the tasks worked on this week, most used first. */
/** Rows shown before "Show the other N tasks": over budget comes first, so these are the ones to read. */
const BUDGET_SHOWN = 10

export function BudgetTable({ rows }: { rows: BudgetRow[] }) {
  const shown = rows.slice(0, BUDGET_SHOWN)
  const rest = rows.slice(BUDGET_SHOWN)
  return (
    <section aria-labelledby="budget-title" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 md:px-5">
        <h2 id="budget-title" className="text-base font-semibold text-text">
          Budget against actual
        </h2>
        <p className="text-sm text-text-muted">Tasks with an estimate that had time this week: everything logged on each so far against its estimate, furthest over first.</p>
      </div>
      {rows.length === 0 ? (
        <EmptyState size="compact" className="m-4 md:m-5" message="No task with an estimate had time logged this week." />
      ) : (
        <>
          <ul className="divide-y divide-border/70">
            {shown.map((r) => (
              <BudgetItem key={r.task_id} r={r} />
            ))}
          </ul>
          {rest.length ? (
            // A week can touch dozens of tasks; the rest stay one click away instead of a page-long list.
            <details className="group border-t border-border">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium text-text transition-colors duration-150 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">Show the other {rest.length} {rest.length === 1 ? "task" : "tasks"}</span>
                <span className="hidden group-open:inline">Hide the other {rest.length} {rest.length === 1 ? "task" : "tasks"}</span>
                <ChevronDownIcon aria-hidden="true" className="size-4 text-text-muted transition-transform duration-150 group-open:rotate-180" />
              </summary>
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {rest.map((r) => (
                  <BudgetItem key={r.task_id} r={r} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

function BudgetItem({ r }: { r: BudgetRow }) {
  const b = budgetState(r.estimated_minutes, r.logged_minutes)
  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center sm:gap-6 md:px-5">
      <div className="min-w-0">
        <Link href={`/work/${r.task_id}`} className="block truncate text-sm font-medium text-text hover:underline">
          {r.title}
        </Link>
        <p className="truncate text-xs text-text-muted">
          <span className="font-mono">{r.task_number}</span>
          {r.client_name ? ` · ${r.client_name}` : ""}
          {` · ${formatMinutes(r.week_minutes)} this week`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="num whitespace-nowrap text-text tabular-nums">
            {formatMinutes(r.logged_minutes)} <span className="text-text-muted">of {formatMinutes(r.estimated_minutes)}</span>
          </span>
          <span className={cn("text-xs whitespace-nowrap", b.state === "over" ? "text-danger-text" : b.state === "near" ? "text-warning-text" : "text-text-muted")}>
            {b.percent !== null ? `${b.percent}% · ` : ""}
            {BUDGET_WORDS[b.state]}
          </span>
        </div>
        <ThinBar percent={b.percent ?? 0} tone={BUDGET_TONE[b.state]} label={`${r.task_number}: ${b.percent ?? 0}% of the estimate used`} />
      </div>
    </li>
  )
}
