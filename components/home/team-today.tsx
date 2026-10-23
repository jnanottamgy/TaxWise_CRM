import Link from "next/link"
import { PhoneIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { AskClientForData, type AskClientMessaging } from "@/components/tasks/ask-client"
import { CapacityChip, PersonInitials } from "@/components/people/people-bits"
import { DECLINE_REASON_LABELS, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { daysSince } from "@/lib/domain/dashboard"
import { istDateOf } from "@/lib/domain/fy"
import { fromPaise } from "@/lib/domain/money"
import { formatDate, formatTimeAgo } from "@/lib/format"
import type { AttendanceSnapshot, CallListRow, SalesSnapshot } from "@/lib/data/dashboard"
import type { TaskListRow } from "@/lib/data/tasks"
import { Figure, RowLink } from "@/components/home/home-ui"
import { count, workHref, type TeamLoadRow } from "@/components/home/logic"

/**
 * Team today's own blocks (§7.2 Manager): declined tasks to reassign, the Data awaited call list,
 * the team's capacity with each person's overdue tasks, attendance today, and the sales and billing
 * strip.
 * Server-safe; the hand-off buttons are client islands.
 */

/** Declined tasks, unassigned again, with who declined and why (§7.6.3), ready to reassign. */
export function DeclinedList({ rows, today }: { rows: TaskListRow[]; today: string }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No declined tasks waiting to be reassigned." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-11 flex-col justify-center gap-0.5 py-2.5">
          <RowLink href={`/work/${r.id}`}>{r.title}</RowLink>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
            <span className="font-mono text-xs">{r.task_number}</span>
            {r.client_name ? <span className="truncate">· {r.client_name}</span> : null}
            {r.due_date ? (
              <span className="whitespace-nowrap">
                · <DateText date={r.due_date} withRelative today={today} />
              </span>
            ) : null}
          </p>
          <p className="text-sm text-text">
            {r.declined_by_name ?? "The assignee"} declined: {r.decline_reason ? DECLINE_REASON_LABELS[r.decline_reason] : "no reason recorded"}
          </p>
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
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
                <Link href={`/work/${task.id}`} className="truncate text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  {task.title}
                </Link>
                <span className="font-mono text-xs">· {task.task_number}</span>
                {task.assignee_name ? <span>· {task.assignee_name}</span> : null}
                {task.due_date ? (
                  <span className="whitespace-nowrap">
                    · <DateText date={task.due_date} withRelative today={today} />
                  </span>
                ) : null}
              </p>
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
            <div className="flex flex-wrap items-center gap-2">
              {phone ? (
                <Button asChild size="sm" variant="outline" className="pointer-coarse:h-11">
                  <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
                    <PhoneIcon aria-hidden="true" />
                    Call
                  </a>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled title="No phone number for this client. Add one in Contacts.">
                  <PhoneIcon aria-hidden="true" />
                  Call
                </Button>
              )}
              {messaging ? (
                <AskClientForData
                  taskId={task.id}
                  clientId={task.client_id}
                  size="sm"
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

export function TeamLoadList({ rows }: { rows: TeamLoadRow[] }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No active team members yet." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <PersonInitials name={r.name} size="sm" />
          <div className="min-w-0 flex-1">
            <Link href={`/people/${r.id}`} className="block truncate text-base text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              {r.name}
            </Link>
            <p className="num truncate text-sm text-text-muted">{r.capacity ? r.capacity.arithmetic : "No longer active"}</p>
          </div>
          {r.overdue > 0 ? (
            <Link href={workHref.overdueFor(r.id)} className="num w-24 text-right text-sm font-medium text-danger-text tabular-nums hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              {r.overdue} overdue
            </Link>
          ) : (
            <span className="num w-24 text-right text-sm text-text-muted">0 overdue</span>
          )}
          <span className="flex w-24 justify-end">{r.capacity ? <CapacityChip capacity={r.capacity} /> : null}</span>
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
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3 md:grid-cols-6">
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
    <div>
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className={`num text-lg leading-7 font-semibold tabular-nums ${tone === "danger" ? "text-danger-text" : tone === "warning" ? "text-warning-text" : "text-text"}`}>{value}</dd>
    </div>
  )
}

/** Invoices raised this month, quotations awaiting a response, and leads untouched for 14 days (§7.2, §7.4). */
export function SalesBlock({ sales }: { sales: SalesSnapshot }) {
  const { invoicesThisMonth, quotationsAwaiting, staleLeads } = sales
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      <div className="flex flex-col gap-2">
        <Figure label="Invoices raised this month" value={<Money value={fromPaise(invoicesThisMonth.totalPaise)} compact />} sub={`${count(invoicesThisMonth.count, "invoice")}, incl. GST`} href="/invoices" />
      </div>
      <div className="flex flex-col gap-2">
        <Figure
          label="Quotations awaiting response"
          value={<Money value={fromPaise(quotationsAwaiting.valuePaise)} compact />}
          sub={count(quotationsAwaiting.total, "quotation")}
          href="/quotations?status=sent,viewed"
        />
        {quotationsAwaiting.rows.length ? (
          <ul className="divide-y divide-border/70 text-sm">
            {quotationsAwaiting.rows.map((q) => (
              <li key={q.id} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                <Link href={`/quotations/${q.id}`} className="min-w-0 truncate text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  {q.client_name}
                </Link>
                <span className="num flex-none text-text-muted">{q.sent_at ? `sent ${formatTimeAgo(q.sent_at)}` : <StatusChip kind="quotation_status" value={q.status} />}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Figure label="Leads untouched for 14 days" value={staleLeads.total} sub={staleLeads.total ? "No call, note or quotation since" : "Every open lead has recent activity"} href="/leads" />
        {staleLeads.rows.length ? (
          <ul className="divide-y divide-border/70 text-sm">
            {staleLeads.rows.map((l) => (
              <li key={l.id} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
                <Link href={`/leads/${l.id}`} className="min-w-0 truncate text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
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
