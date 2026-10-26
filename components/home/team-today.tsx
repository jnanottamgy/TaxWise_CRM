import Link from "next/link"
import { PhoneIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { AskClientForData, type AskClientMessaging } from "@/components/tasks/ask-client"
import { CapacityChip, PersonInitials } from "@/components/people/people-bits"
import { DECLINE_REASON_LABELS, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { daysSince } from "@/lib/domain/dashboard"
import { istDateOf } from "@/lib/domain/fy"
import { formatDate, formatTimeAgo } from "@/lib/format"
import { STALE_LEAD_DAYS, type AttendanceSnapshot, type CallListRow, type SalesSnapshot } from "@/lib/data/dashboard"
import type { TaskListRow } from "@/lib/data/tasks"
import { Figure, RowLink } from "@/components/home/home-ui"
import { MetaLine } from "@/components/tasks/meta-line"
import { MoneyText, figure } from "@/components/home/kpi-grid"
import { count, moneyHref, workHref, type TeamLoadRow } from "@/components/home/logic"

/**
 * Team today's own blocks (§7.2 Manager): declined tasks to reassign, the Data awaited call list,
 * the team's capacity with each person's overdue tasks, attendance today, and the sales and billing
 * strip.
 * Server-safe; the hand-off buttons are client islands.
 */

/**
 * Work with nobody on it (§7.2, §7.6.3): tasks declined back to the Manager first, each with who
 * declined and why, then the rest of the unassigned work, soonest due first. One list, so a declined
 * task is never shown twice.
 */
export function NeedsOwnerList({ declined, unassigned, today, limit }: { declined: TaskListRow[]; unassigned: TaskListRow[]; today: string; limit: number }) {
  const declinedIds = new Set(declined.map((r) => r.id))
  const rows = [...declined, ...unassigned.filter((r) => !declinedIds.has(r.id))].slice(0, limit)
  if (rows.length === 0) return <EmptyState size="compact" message="Every open task has someone on it." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-11 flex-col justify-center gap-0.5 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <RowLink href={`/work/${r.id}`} className="min-w-0 flex-1 truncate">
              {r.title}
            </RowLink>
            <StatusChip kind="task_status" value={r.status} />
          </div>
          <MetaLine>
            <span className="font-mono text-xs">{r.task_number}</span>
            {r.client_name ? <span>{r.client_name}</span> : null}
            {r.due_date ? (
              <span className="whitespace-nowrap">
                <DateText date={r.due_date} withRelative today={today} />
              </span>
            ) : null}
          </MetaLine>
          {declinedIds.has(r.id) ? (
            <p className="text-sm text-text">
              {r.declined_by_name ?? "The assignee"} declined: {r.decline_reason ? DECLINE_REASON_LABELS[r.decline_reason] : "no reason recorded"}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Data awaited (§7.2 Manager, "the call list"): client, task, days waiting, contact person, and the
 * Call / WhatsApp / Gmail buttons. The hand-offs open a preview first and are logged as "handed off"
 * against the task (§7.13.1).
 */
export function CallList({ rows, today, messaging, portalLink }: { rows: CallListRow[]; today: string; messaging: AskClientMessaging | null; portalLink: string }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No task is waiting on a client's data." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map(({ task, since, contact, client, missing }) => {
        const phone = contact?.phone ?? client?.phone ?? null
        const waited = since ? daysSince(istDateOf(since), today) : null
        return (
          <li key={task.id} className="flex flex-col gap-3 px-4 py-3 md:px-5 lg:flex-row lg:items-center lg:gap-6">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <RowLink href={`/clients/${task.client_id}`}>{task.client_name ?? "Client"}</RowLink>
                <span className="num text-sm whitespace-nowrap text-warning-text">{waited === null ? "Waiting" : waited === 0 ? "Waiting since today" : `Waiting ${count(waited, "day")}`}</span>
              </div>
              <MetaLine className="mt-0.5">
                <Link href={`/work/${task.id}`} className="text-text hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  {task.title}
                </Link>
                <span className="font-mono text-xs">{task.task_number}</span>
                {task.assignee_name ? <span>{task.assignee_name}</span> : null}
                {task.due_date ? (
                  <span className="whitespace-nowrap">
                    <DateText date={task.due_date} withRelative today={today} />
                  </span>
                ) : null}
              </MetaLine>
              <p className="mt-0.5 text-sm text-text-muted">
                {contact ? (
                  <>
                    <span className="text-text">{contact.name}</span>
                    {phone ? <span className="num"> · {phone}</span> : null}
                  </>
                ) : (
                  "No contact person on file"
                )}
                {missing.length ? <span> · Needs {missing.slice(0, 3).join(", ")}{missing.length > 3 ? ` and ${missing.length - 3} more` : ""}</span> : null}
              </p>
            </div>
            <div className="-mx-2 flex flex-wrap items-center gap-1 lg:mx-0">
              {phone ? (
                <Button asChild size="sm" variant="ghost" className="pointer-coarse:h-11">
                  <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
                    <PhoneIcon aria-hidden="true" />
                    Call
                  </a>
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled title="No phone number for this client. Add one in Contacts.">
                  <PhoneIcon aria-hidden="true" />
                  Call
                </Button>
              )}
              {messaging ? (
                <AskClientForData
                  taskId={task.id}
                  clientId={task.client_id}
                  size="sm"
                  variant="ghost"
                  recipient={{ contact, client }}
                  facts={{
                    clientName: task.client_name ?? "",
                    clientCode: task.client_code ?? "",
                    taskTitle: task.title,
                    period: task.period_label,
                    serviceLabel: task.service_type ? SERVICE_TYPE_LABELS[task.service_type] : null,
                    missing,
                    dueDateText: task.due_date ? formatDate(task.due_date) : null,
                    portalLink,
                  }}
                  messaging={messaging}
                />
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function TeamLoadList({ rows, columns = 1 }: { rows: TeamLoadRow[]; /** Two columns of people on wide screens, for a full-width card. */ columns?: 1 | 2 }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No active team members yet." />
  return (
    <ul className={cn(columns === 2 ? "lg:columns-2 lg:gap-x-10 [&>li]:break-inside-avoid [&>li]:border-b [&>li]:border-border/70 max-lg:[&>li:last-child]:border-b-0" : "divide-y divide-border/70")}>
      {rows.map((r) => (
        // Phones: name and arithmetic at full width, then overdue and band on their own line (two
        // fixed 96px columns beside the text squeezed it to one word a line). Wider: one row.
        <li key={r.id} className="flex min-h-11 items-start gap-3 py-2 sm:items-center">
          <PersonInitials name={r.name} size="sm" className="max-sm:mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1">
              <Link href={`/people/${r.id}`} className="block truncate text-base text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                {r.name}
              </Link>
              <p className="num text-sm text-pretty text-text-muted">{r.capacity ? r.capacity.arithmetic : "No longer active"}</p>
            </div>
            <div className="flex items-center gap-3 sm:contents">
              {r.overdue > 0 ? (
                <Link href={workHref.overdueFor(r.id)} className="num text-sm font-medium whitespace-nowrap text-danger-text tabular-nums hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:w-24 sm:text-right">
                  {r.overdue} overdue
                </Link>
              ) : (
                <span className="num text-sm whitespace-nowrap text-text-muted sm:w-24 sm:text-right">0 overdue</span>
              )}
              <span className="flex sm:w-24 sm:justify-end">{r.capacity ? <CapacityChip capacity={r.capacity} /> : null}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Attendance today (§7.2 Manager): present, late, absent and on leave so far, and online now. */
export function AttendanceBlock({ a }: { a: AttendanceSnapshot }) {
  if (!a.workingDay) {
    return (
      <p className="text-sm text-text-muted">
        Today isn&apos;t a working day. <span className="num">{a.onlineNow}</span> online now.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
        <AttendanceFigure label="Present" value={a.present} />
        <AttendanceFigure label="Late login" value={a.late} tone={a.late > 0 ? "warning" : undefined} />
        <AttendanceFigure label="Absent" value={a.absent} tone={a.absent > 0 ? "danger" : undefined} />
        <AttendanceFigure label="On leave" value={a.onLeave} />
        <AttendanceFigure label="Not in yet" value={a.notInYet} />
        <AttendanceFigure label="Online now" value={a.onlineNow} />
      </dl>
      <p className="text-sm text-text-muted">
        Not signed in by {a.cutoff} counts as absent. The day&apos;s attendance is final at 11:30 tomorrow.
      </p>
    </div>
  )
}

function AttendanceFigure({ label, value, tone }: { label: string; value: number; tone?: "warning" | "danger" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-sm text-text-muted">{label}</dt>
      <dd className={`num text-lg leading-7 font-semibold tabular-nums ${tone === "danger" ? "text-danger-text" : tone === "warning" ? "text-warning-text" : "text-text"}`}>{value}</dd>
    </div>
  )
}

/**
 * Invoices raised this month, quotations awaiting a response, and leads untouched for 14 days
 * (§7.2, §7.4), stacked for the narrow column: each figure opens its list, with the oldest
 * quotations and leads under it.
 */
export function SalesBlock({ sales }: { sales: SalesSnapshot }) {
  const { invoicesThisMonth, quotationsAwaiting, staleLeads } = sales
  return (
    <div className="flex flex-col divide-y divide-border/70">
      <div className="pb-3">
        <Figure
          label="Invoices raised this month"
          value={<MoneyText paise={invoicesThisMonth.totalPaise} />}
          sub={`${count(invoicesThisMonth.count, "invoice")} issued, incl. GST${invoicesThisMonth.awaitingApproval ? ` · ${figure(invoicesThisMonth.awaitingApproval)} awaiting a Partner's approval` : ""}`}
          href={moneyHref.issuedThisMonth()}
        />
      </div>
      <div className="flex flex-col gap-2 py-3">
        <Figure
          label="Quotations awaiting response"
          value={<MoneyText paise={quotationsAwaiting.valuePaise} />}
          sub={quotationsAwaiting.total ? `${count(quotationsAwaiting.total, "quotation")}, longest waiting first` : "Nothing out with a client"}
          href={moneyHref.quotationsAwaiting()}
        />
        {quotationsAwaiting.rows.length ? (
          <ul className="divide-y divide-border/70 text-sm">
            {quotationsAwaiting.rows.map((q) => (
              <li key={q.id} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                <Link href={`/quotations/${q.id}`} className="min-w-0 truncate rounded-sm text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  {q.client_name}
                </Link>
                <span className="num flex-none text-text-muted">{q.sent_at ? `sent ${formatTimeAgo(q.sent_at)}` : <StatusChip kind="quotation_status" value={q.status} />}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 pt-3">
        <Figure
          label={`Leads untouched for ${STALE_LEAD_DAYS} days`}
          value={figure(staleLeads.total)}
          sub={staleLeads.total ? "No call, note or quotation since" : "Every open lead has recent activity"}
          href={moneyHref.staleLeads()}
        />
        {staleLeads.rows.length ? (
          <ul className="divide-y divide-border/70 text-sm">
            {staleLeads.rows.map((l) => (
              <li key={l.id} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                <Link href={`/leads/${l.id}`} className="min-w-0 truncate rounded-sm text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  {l.company ? `${l.name} · ${l.company}` : l.name}
                </Link>
                <span className="num flex-none text-text-muted">{formatTimeAgo(l.last_activity_at ?? l.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
