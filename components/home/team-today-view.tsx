import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { countByPerson } from "@/lib/domain/dashboard"
import { formatDateRange } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { TaskList } from "@/components/tasks/task-list"
import AbsentWithoutCover from "@/components/covers/absent-without-cover"
import { getMessagingContext } from "@/lib/data/clients"
import {
  getAttendanceSnapshot,
  getDataAwaitedCallList,
  getSalesSnapshot,
  getTeamCapacity,
  getTeamQueues,
  loadDeadlines,
  loadOverdueTasks,
  weekWindow,
} from "@/lib/data/dashboard"
import type { WorkViewer } from "@/lib/data/tasks"
import { BlockError, DeadlineList, moreLink } from "@/components/home/home-ui"
import { AttendanceBlock, CallList, DeclinedList, SalesBlock, TeamLoadList } from "@/components/home/team-today"
import { count, teamFinding, teamLoadRows, weekHref, workHref } from "@/components/home/logic"

const SHOWN = 5

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/dashboard:team:${source}`, userId }) }
  }
}

/**
 * Team today (§7.2 Manager): "Who is stuck, who is over capacity, and what is due this week?"
 * Unassigned, waiting and declined work; the review queue; the Data awaited call list; deadlines this
 * week; the team's capacity (§7.11.4) beside each person's overdue tasks; attendance today; absent
 * without cover (§4.7);
 * invoices raised this month and quotations awaiting a response, plus leads untouched for 14 days
 * (§7.4). Every block loads on its own and fails on its own (§0.1 rule 3).
 */
export async function TeamTodayView({ user, supabase }: { user: CurrentUser; supabase: ServerSupabase }) {
  const today = todayIST()
  const viewer: WorkViewer = { employeeId: user.employeeId, role: user.role, today }
  const week = weekWindow(today)

  const [queues, callList, messaging, deadlines, overdue, capacity, attendance, sales] = await Promise.all([
    attempt("queues", user.id, () => getTeamQueues(supabase, viewer, SHOWN)),
    attempt("call-list", user.id, () => getDataAwaitedCallList(supabase, 6)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    attempt("deadlines", user.id, async () => (await loadDeadlines(supabase, week.from, week.to)).filter((d) => d.status === "pending")),
    attempt("overdue", user.id, async () => countByPerson((await loadOverdueTasks(supabase)).map((t) => ({ assigneeId: t.assigned_employee_id, assigneeName: t.assignee_name })))),
    attempt("capacity", user.id, () => getTeamCapacity(supabase, today)),
    attempt("attendance", user.id, () => getAttendanceSnapshot(supabase, today)),
    attempt("sales", user.id, () => getSalesSnapshot(supabase, today)),
  ])

  const q = queues.ok ? queues.data : null
  const overCapacity = capacity.ok ? capacity.data.filter((c) => c.capacity.band === "over").length : 0
  const finding = q
    ? teamFinding({ unassigned: q.unassigned.total, declined: q.declined.total, waiting: q.waiting.total, overdue: q.overdue, overCapacity })
    : "Couldn't load the work queues."
  const m = messaging.ok ? messaging.data : null
  const team = overdue.ok && capacity.ok ? teamLoadRows(capacity.data, overdue.data) : []
  const unassignedOverdue = overdue.ok ? (overdue.data.find((o) => o.employeeId === null)?.count ?? 0) : 0

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Team today">
        <p>Start at the top: work nobody has, work declined back to you, and people who are away with clients that need cover. Each figure opens the list behind it.</p>
        <p className="mt-2">The call list is every task waiting on a client&apos;s data, soonest due first, with who to call and what is still needed. WhatsApp and Gmail open a preview and are logged against the task as handed off.</p>
      </PageGuide>
      {/* No header action: the shell's "+ New" leads with New task for Managers. */}
      <PageHeader title="Team today" description={finding} />

      {q ? (
        <KpiStrip
          aria-label="Work queues"
          className="mb-4 lg:mb-6"
          items={[
            { label: "Unassigned", value: q.unassigned.total, sub: q.declined.total ? `incl. ${q.declined.total} declined` : "Nobody on them", href: workHref.unassigned() },
            { label: "Not yet accepted", value: q.waiting.total, sub: "Assigned", href: workHref.waiting() },
            { label: "Declined", value: q.declined.total, sub: "To reassign", href: workHref.declined() },
            { label: "Review queue", value: q.review.total, sub: "Under review", href: workHref.review() },
            { label: "Data awaited", value: q.dataAwaited, sub: "On clients", href: workHref.dataAwaited() },
            { label: "Overdue", value: q.overdue, sub: "Not Filed/Done", href: workHref.overdue() },
          ]}
        />
      ) : (
        <div className="mb-4 rounded-lg border border-border bg-surface lg:mb-6">
          <ErrorBlock message="Couldn't load the work queues." errorRef={!queues.ok ? queues.ref : null} size="compact" />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:gap-6">
        {attendance.ok ? (
          <SectionCard
            title="Attendance today"
            action={
              <Link href="/performance" className="rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                Performance & attendance
              </Link>
            }
          >
            <AttendanceBlock a={attendance.data} />
          </SectionCard>
        ) : (
          <BlockError title="Attendance today" message="Couldn't load today's attendance." errorRef={attendance.ref} />
        )}
        <AbsentWithoutCover user={user} supabase={supabase} />

        {q ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
            <SectionCard title="Unassigned tasks" description="Open, with nobody on them. Soonest due first." viewAll={moreLink(workHref.unassigned(), q.unassigned.total, q.unassigned.rows.length)}>
              <TaskList rows={q.unassigned.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Every open task has someone on it." />
            </SectionCard>
            <SectionCard title="Declined to reassign" description="Unassigned by the person who declined." viewAll={moreLink(workHref.declined(), q.declined.total, q.declined.rows.length)}>
              <DeclinedList rows={q.declined.rows} today={today} />
            </SectionCard>
            <SectionCard title="Waiting for acceptance" description="Assigned, not yet accepted or declined." viewAll={moreLink(workHref.waiting(), q.waiting.total, q.waiting.rows.length)}>
              <TaskList rows={q.waiting.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Every assigned task has been answered." />
            </SectionCard>
          </div>
        ) : null}

        {callList.ok ? (
          <SectionCard
            title="Data awaited"
            description="The call list: tasks waiting on the client, soonest due first."
            flush
            viewAll={moreLink(workHref.dataAwaited(), callList.data.total, callList.data.rows.length)}
          >
            {callList.data.rows.length ? (
              <CallList
                rows={callList.data.rows}
                today={today}
                portalLink={`${env.appUrl().replace(/\/+$/, "")}/portal/documents`}
                messaging={
                  m
                    ? {
                        firmName: m.firmName,
                        firmPhone: m.firmPhone,
                        countryCode: m.countryCode,
                        signatureFormat: m.signatureFormat,
                        addSignature: m.addSignature,
                        senderName: user.fullName,
                        templates: m.templates.filter((t) => t.type === "document_reminder"),
                      }
                    : null
                }
              />
            ) : (
              <p className="px-4 pb-4 text-sm text-text-muted md:px-5">No task is waiting on a client&apos;s data.</p>
            )}
          </SectionCard>
        ) : (
          <BlockError title="Data awaited" message="Couldn't load the call list." errorRef={callList.ref} />
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          {deadlines.ok ? (
            <SectionCard
              className="lg:col-span-2"
              title="Deadlines this week"
              description={`${formatDateRange(week.from, week.to)} · not yet filed${deadlines.data.length ? ` · ${deadlines.data.length}` : ""}`}
              viewAll={{ href: weekHref(today), label: deadlines.data.length > 6 ? `All ${deadlines.data.length} in the calendar` : "Calendar" }}
            >
              <DeadlineList rows={deadlines.data.slice(0, 6)} today={today} emptyMessage="Nothing left to file this week." />
            </SectionCard>
          ) : (
            <BlockError className="lg:col-span-2" title="Deadlines this week" message="Couldn't load this week's deadlines." errorRef={deadlines.ref} />
          )}
          {q ? (
            <SectionCard title="Review queue" description="Submitted Under review to you, or to any Manager." viewAll={q.review.total ? { href: workHref.review(), label: q.review.total > q.review.rows.length ? `View all ${q.review.total}` : "Review queue" } : undefined}>
              <TaskList rows={q.review.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Nothing is waiting for review." />
            </SectionCard>
          ) : (
            <BlockError title="Review queue" message="Couldn't load the review queue." errorRef={!queues.ok ? queues.ref : ""} />
          )}
        </div>

        {overdue.ok && capacity.ok ? (
          <SectionCard
            title="The team"
            description="Capacity: open tasks due in the next 14 days (overdue included) per working day left. Overdue: past due, not Filed/Done."
            viewAll={{ href: "/people", label: "People" }}
          >
            <TeamLoadList rows={team.slice(0, 10)} />
            {unassignedOverdue > 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                And{" "}
                <Link href={workHref.overdueFor(null)} className="font-medium text-danger-text hover:underline">
                  {count(unassignedOverdue, "overdue task")}
                </Link>{" "}
                with nobody assigned.
              </p>
            ) : null}
            {team.length > 10 ? <p className="mt-2 text-sm text-text-muted">And {team.length - 10} more on People.</p> : null}
          </SectionCard>
        ) : (
          <BlockError title="The team" message="Couldn't work out the team's capacity and overdue work." errorRef={!overdue.ok ? overdue.ref : !capacity.ok ? capacity.ref : ""} />
        )}

        {sales.ok ? (
          <SectionCard title="Billing and sales">
            <SalesBlock sales={sales.data} />
          </SectionCard>
        ) : (
          <BlockError title="Billing and sales" message="Couldn't load invoices, quotations and leads." errorRef={sales.ref} />
        )}
      </div>
    </div>
  )
}
