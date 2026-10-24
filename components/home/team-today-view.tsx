import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { formatDateRange } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { TaskList } from "@/components/tasks/task-list"
import { BulkReminderLauncher } from "@/components/bulk-queue"
import AbsentWithoutCover from "@/components/covers/absent-without-cover"
import { getMessagingContext } from "@/lib/data/clients"
import { getAttendanceSnapshot, getDataAwaitedCallList, getTeamCapacity, getTeamToday } from "@/lib/data/dashboard"
import { BlockError, DeadlineList, moreLink } from "@/components/home/home-ui"
import { figure } from "@/components/home/kpi-grid"
import { AttendanceBlock, CallList, DeclinedList, SalesBlock, TeamLoadList } from "@/components/home/team-today"
import { count, teamFinding, teamLoadRows, weekHref, workHref } from "@/components/home/logic"

/** Rows per queue list: the three queues sit side by side and fit the first screen at 1366×768. */
const QUEUE_ROWS = 4
const CALL_ROWS = 6

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
 * The queues as one strip of figures (unassigned leading), then unassigned, declined and waiting
 * work side by side; the Data awaited call list (call, WhatsApp, Gmail, or queue every client on
 * WhatsApp) beside who is away without cover and today's attendance; this week's deadlines and the
 * review queue; the team's capacity (§7.11.4) beside each person's overdue tasks; and invoices raised
 * this month, quotations awaiting a response and leads untouched for 14 days (§7.4).
 *
 * The queues and sales come from one database call (0217). Every block loads and fails on its own
 * (§0.1 rule 3).
 */
export async function TeamTodayView({ user, supabase }: { user: CurrentUser; supabase: ServerSupabase }) {
  const today = todayIST()

  const [main, callList, messaging, capacity, attendance] = await Promise.all([
    attempt("main", user.id, () => getTeamToday(supabase, today, { rows: QUEUE_ROWS })),
    attempt("call-list", user.id, () => getDataAwaitedCallList(supabase, CALL_ROWS)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    attempt("capacity", user.id, () => getTeamCapacity(supabase, today)),
    attempt("attendance", user.id, () => getAttendanceSnapshot(supabase, today)),
  ])

  const t = main.ok ? main.data : null
  const overCapacity = capacity.ok ? capacity.data.filter((c) => c.capacity.band === "over").length : 0
  const finding = t
    ? teamFinding({ unassigned: t.unassigned.total, declined: t.declined.total, waiting: t.waiting.total, overdue: t.overdue, overCapacity })
    : "Couldn't load the work queues."
  const m = messaging.ok ? messaging.data : null
  const team = t && capacity.ok ? teamLoadRows(capacity.data, t.overdueByPerson) : []
  const unassignedOverdue = t ? (t.overdueByPerson.find((o) => o.employeeId === null)?.count ?? 0) : 0
  const whatsappTemplates = m ? m.templates.filter((tpl) => tpl.type === "document_reminder" && tpl.channel === "whatsapp").map((tpl) => ({ id: tpl.id, name: tpl.name })) : undefined
  const linkClass = "rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Team today">
        <p>Start at the top: work nobody has, work declined back to you, and work nobody has accepted yet. Each figure opens the list behind it.</p>
        <p className="mt-2">
          The call list is every task waiting on a client&apos;s data, soonest due first, with who to call and what is still needed. WhatsApp and Gmail open a preview and are logged against the task as handed off. Queue
          all on WhatsApp drafts a message for every client in Data awaited; you open each chat and press Send.
        </p>
        <p className="mt-2">People away today whose clients have work due in the next two days, with no cover, are listed with Set up cover.</p>
      </PageGuide>
      {/* No header action: the shell's "+ New" leads with New task for Managers. */}
      <PageHeader title="Team today" description={finding} />

      {t ? (
        <KpiStrip
          aria-label="Work queues"
          lead
          className="mb-4 lg:mb-6"
          items={[
            { label: "Unassigned", value: figure(t.unassigned.total), sub: t.declined.total ? `incl. ${figure(t.declined.total)} declined` : "Nobody on them", href: workHref.unassigned() },
            { label: "Not yet accepted", value: figure(t.waiting.total), sub: "Assigned, no answer", href: workHref.waiting() },
            { label: "Declined", value: figure(t.declined.total), sub: "To reassign", href: workHref.declined() },
            { label: "Review queue", value: figure(t.review.total), sub: "Under review", href: workHref.review() },
            { label: "Data awaited", value: figure(t.dataAwaited), sub: "On clients", href: workHref.dataAwaited() },
            { label: "Overdue", value: <span className={t.overdue ? "text-danger-text" : undefined}>{figure(t.overdue)}</span>, sub: "Not Filed/Done", href: workHref.overdue() },
          ]}
        />
      ) : (
        <div className="mb-4 rounded-lg border border-border bg-surface lg:mb-6">
          <ErrorBlock message="Couldn't load the work queues." errorRef={!main.ok ? main.ref : null} size="compact" />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:gap-6">
        {t ? (
          // Short queues keep their own height: a card stretched over empty space reads as missing rows.
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start lg:gap-6">
            <SectionCard title="Unassigned tasks" description="Open, with nobody on them. Soonest due first." viewAll={moreLink(workHref.unassigned(), t.unassigned.total, t.unassigned.rows.length)}>
              <TaskList rows={t.unassigned.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Every open task has someone on it." />
            </SectionCard>
            <SectionCard title="Declined to reassign" description="Unassigned by the person who declined." viewAll={moreLink(workHref.declined(), t.declined.total, t.declined.rows.length)}>
              <DeclinedList rows={t.declined.rows} today={today} />
            </SectionCard>
            <SectionCard title="Waiting for acceptance" description="Assigned, not yet accepted or declined." viewAll={moreLink(workHref.waiting(), t.waiting.total, t.waiting.rows.length)}>
              <TaskList rows={t.waiting.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Every assigned task has been answered." />
            </SectionCard>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          {callList.ok ? (
            <SectionCard
              className="lg:col-span-2"
              title="Data awaited"
              description={callList.data.total ? `The call list: ${count(callList.data.total, "task")} waiting on the client, soonest due first.` : "The call list: tasks waiting on the client."}
              action={
                <BulkReminderLauncher
                  source={{ kind: "data_awaited", mine: false }}
                  label="Queue all on WhatsApp"
                  title="Data awaited: ask each client for what's missing"
                  templates={whatsappTemplates}
                  disabled={callList.data.total === 0}
                  disabledReason="No task is waiting on a client's data."
                />
              }
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
                          templates: m.templates.filter((tpl) => tpl.type === "document_reminder"),
                        }
                      : null
                  }
                />
              ) : (
                <p className="px-4 pb-4 text-sm text-text-muted md:px-5">No task is waiting on a client&apos;s data.</p>
              )}
            </SectionCard>
          ) : (
            <BlockError className="lg:col-span-2" title="Data awaited" message="Couldn't load the call list." errorRef={callList.ref} />
          )}
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6 lg:[&>*:last-child]:flex-1">
            <AbsentWithoutCover user={user} supabase={supabase} />
            {attendance.ok ? (
              <SectionCard
                title="Attendance today"
                action={
                  <Link href="/performance" className={linkClass}>
                    Attendance
                  </Link>
                }
              >
                <AttendanceBlock a={attendance.data} />
              </SectionCard>
            ) : (
              <BlockError title="Attendance today" message="Couldn't load today's attendance." errorRef={attendance.ref} />
            )}
            {t ? (
              <SectionCard
                title="Review queue"
                description="Submitted Under review to you, or to any Manager."
                viewAll={t.review.total ? { href: workHref.review(), label: t.review.total > t.review.rows.length ? `View all ${figure(t.review.total)}` : "Review queue" } : undefined}
              >
                <TaskList rows={t.review.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Nothing is waiting for review." />
              </SectionCard>
            ) : null}
          </div>
        </div>

        {t ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
            <SectionCard
              className="lg:col-span-2"
              title="Deadlines this week"
              description={`${formatDateRange(t.week.from, t.week.to)} · not yet filed${t.week.total ? ` · ${figure(t.week.total)}` : ""}`}
              viewAll={{ href: weekHref(today), label: t.week.total > t.week.rows.length ? `All ${figure(t.week.total)} in the calendar` : "Calendar" }}
            >
              <DeadlineList rows={t.week.rows} today={today} emptyMessage="Nothing left to file this week." />
            </SectionCard>
            <SectionCard title="Billing and sales">
              <SalesBlock sales={t.sales} />
            </SectionCard>
          </div>
        ) : (
          <BlockError title="Billing and sales" message="Couldn't load invoices, quotations and leads." errorRef={!main.ok ? main.ref : ""} />
        )}

        {t && capacity.ok ? (
          <SectionCard
            title="The team"
            description="Capacity: open tasks due in the next 14 days (overdue included) per working day left. Overdue: past due, not Filed/Done."
            viewAll={{ href: "/people", label: "People" }}
          >
            <TeamLoadList rows={team.slice(0, 10)} columns={2} />
            {unassignedOverdue > 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                And{" "}
                <Link href={workHref.overdueFor(null)} className="font-medium text-danger-text hover:underline">
                  {count(unassignedOverdue, "overdue task")}
                </Link>{" "}
                with nobody assigned.
              </p>
            ) : null}
            {team.length > 10 ? <p className="mt-2 text-sm text-text-muted">And {figure(team.length - 10)} more on People.</p> : null}
          </SectionCard>
        ) : (
          <BlockError title="The team" message="Couldn't work out the team's capacity and overdue work." errorRef={!main.ok ? main.ref : !capacity.ok ? capacity.ref : ""} />
        )}
      </div>
    </div>
  )
}
