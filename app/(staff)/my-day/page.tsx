import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { PageGuide } from "@/components/shell/page-slots"
import { TaskList } from "@/components/tasks/task-list"
import { TimerCard } from "@/components/home/timer-card"
import MyCovers from "@/components/covers/my-covers"
import { BlockError, DeadlineList, MessageList, moreLink } from "@/components/home/home-ui"
import { LeaveCard, NoticeRepliesCard, SentBackList, WeekCard } from "@/components/home/my-day"
import { agendaHref, myDayFinding, workHref } from "@/components/home/logic"
import { getMyDay, getMyLeave, getMyNoticeReplies, getMyWeekHours, getUnreadClientMessages } from "@/lib/data/dashboard"
import { getRunningTimer, getTimerShortcuts } from "@/lib/data/timesheet"

export const metadata: Metadata = { title: "My day" }

const SHOWN = 6
/** "My clients' upcoming deadlines": the next two weeks. */
const DEADLINE_DAYS = 14

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/my-day:${source}`, userId }) }
  }
}

/**
 * My day (§7.2 Employee): "What do I do next?" The timer; tasks waiting for my acceptance (Accept /
 * Decline inline); tasks sent back to me with the reviewer's reason; what is due today or overdue;
 * my review items; notice replies due (§7.8.4); my clients' upcoming deadlines; unread messages from
 * clients I handle; this week's hours against the target; the clients I'm covering, and covers for
 * me with "I'm back, end cover" (§4.7); my leave.
 *
 * It is the Employee's landing page (§4.4) and works for Partners and Managers too: everything on it
 * is the viewer's own work, read under their RLS, and none of it is money (§4.1). The queues and
 * deadlines come from one database call (0218); every block loads and fails on its own.
 */
export default async function MyDayPage() {
  const { user, supabase } = await requireStaff()
  const today = todayIST()
  const fy = financialYearOf(today)
  const employeeId = user.employeeId

  if (!employeeId) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="My day" description={formatDate(today)} />
        <SectionCard title="Your team record is missing">
          <EmptyState size="compact" message="Your login isn't linked to a team member, so there is no work to show. Ask a Partner to link your account in People." />
        </SectionCard>
      </div>
    )
  }

  const [day, week, leave, messages, notices, running, shortcuts] = await Promise.all([
    attempt("day", user.id, () => getMyDay(supabase, today, { rows: SHOWN, deadlineDays: DEADLINE_DAYS })),
    attempt("week", user.id, () => getMyWeekHours(supabase, employeeId, today)),
    attempt("leave", user.id, () => getMyLeave(supabase, employeeId, today, fy)),
    attempt("messages", user.id, () => getUnreadClientMessages(supabase, user)),
    attempt("notices", user.id, () => getMyNoticeReplies(supabase, employeeId, today)),
    attempt("timer", user.id, () => getRunningTimer(supabase, employeeId)),
    attempt("shortcuts", user.id, () => getTimerShortcuts(supabase, employeeId)),
  ])

  const runningTimer = running.ok ? running.data : null
  const runningRef = runningTimer ? { entryId: runningTimer.id, taskId: runningTimer.task?.id ?? null, clientId: runningTimer.client?.id ?? null, startedAt: runningTimer.started_at } : null
  const q = day.ok && day.data.linked ? day.data : null
  const isReviewer = user.role !== "employee" || (q?.review.total ?? 0) > 0
  const finding = q
    ? myDayFinding({ waiting: q.waiting.total, sentBack: q.sentBack.total, overdue: q.dueNow.overdue, dueToday: q.dueNow.today, review: q.review.total })
    : formatDate(today)
  const noticeTotal = notices.ok ? notices.data.counts.overdueReplies + notices.data.counts.repliesDue : 0

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="My day">
        <p>Everything here is yours: tasks assigned to you, work waiting for your review, your clients&apos; deadlines and your time.</p>
        <p className="mt-2">
          Accept or decline new work as it arrives. A task sent back shows the reviewer&apos;s reason; fix it and submit it Under review again. Start the timer on whatever you&apos;re doing, and switching to another task
          stops the last one.
        </p>
        <p className="mt-2">When you are covering a colleague&apos;s clients, they show here with the handover note. When someone covered for you, end the cover from here once you are back.</p>
      </PageGuide>
      {/* No header action: the shell's "+ New" already leads with Log time (and New task for Managers). */}
      <PageHeader title="My day" description={finding} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:grid-rows-[auto_1fr] lg:gap-6">
        {/* Phones: the timer first, then the work, then the rest (§7.2; the bottom tab bar has Timer too). */}
        <div className="min-w-0 lg:col-start-3 lg:row-start-1">
          <SectionCard title="Timer">
            {running.ok && shortcuts.ok ? (
              <TimerCard
                running={runningTimer ? { id: runningTimer.id, startedAt: runningTimer.started_at, description: runningTimer.description, task: runningTimer.task, client: runningTimer.client } : null}
                shortcuts={shortcuts.data}
              />
            ) : (
              <p className="text-sm text-text-muted">
                Couldn&apos;t load your timer. A running timer keeps running. <span className="font-mono text-xs">Ref {!running.ok ? running.ref : !shortcuts.ok ? shortcuts.ref : ""}</span>
              </p>
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:gap-6">
          {!day.ok ? (
            <BlockError title="Your tasks" message="Couldn't load your tasks." errorRef={day.ref} />
          ) : !q ? (
            <SectionCard title="Your team record is missing">
              <EmptyState size="compact" message="Your login isn't linked to a team member, so there is no work to show. Ask a Partner to link your account in People." />
            </SectionCard>
          ) : (
            <>
              {q.waiting.total > 0 ? (
                <SectionCard
                  title="Waiting for you to accept"
                  description="Accept to take it on, or decline with a reason and it goes back to the Managers."
                  viewAll={moreLink(workHref.myWaiting(), q.waiting.total, q.waiting.rows.length)}
                >
                  <TaskList rows={q.waiting.rows} today={today} running={runningRef} viewerEmployeeId={employeeId} waitingNote={false} />
                </SectionCard>
              ) : null}

              {q.sentBack.total > 0 ? (
                <SectionCard title="Sent back to you" description="The reviewer's reason is under each task." viewAll={moreLink(workHref.mySentBack(), q.sentBack.total, q.sentBack.rows.length, "Your tasks in progress")}>
                  <SentBackList rows={q.sentBack.rows} today={today} running={runningRef} viewerEmployeeId={employeeId} />
                </SectionCard>
              ) : null}

              <SectionCard
                title="Due today and overdue"
                description={q.dueNow.total > 0 ? `${q.dueNow.overdue.toLocaleString("en-IN")} overdue · ${q.dueNow.today.toLocaleString("en-IN")} due today` : undefined}
                viewAll={{ href: workHref.myOpen(), label: q.dueNow.total > q.dueNow.rows.length ? `All ${q.dueNow.total.toLocaleString("en-IN")} in your open tasks, soonest first` : "All your open tasks" }}
              >
                <TaskList rows={q.dueNow.rows} today={today} running={runningRef} viewerEmployeeId={employeeId} emptyMessage="Nothing of yours is due today or overdue." />
              </SectionCard>

              {isReviewer ? (
                <SectionCard
                  title="Waiting for your review"
                  description="Submitted Under review to you, or to any Manager."
                  viewAll={q.review.total > 0 ? { href: workHref.review(), label: q.review.total > q.review.rows.length ? `View all ${q.review.total.toLocaleString("en-IN")}` : "Review queue" } : undefined}
                >
                  <TaskList rows={q.review.rows} today={today} running={runningRef} viewerEmployeeId={employeeId} actions={false} emptyMessage="Nothing is waiting for your review." />
                </SectionCard>
              ) : null}
            </>
          )}

          {!notices.ok ? (
            <BlockError title="Notice replies" message="Couldn't check your notice replies." errorRef={notices.ref} />
          ) : noticeTotal > 0 ? (
            <NoticeRepliesCard alerts={notices.data} today={today} />
          ) : null}

          {!day.ok ? null : q ? (
            <SectionCard
              title="Your clients' deadlines"
              description={`Not yet filed, due in the next ${DEADLINE_DAYS} days${q.deadlines.total ? ` · ${q.deadlines.total.toLocaleString("en-IN")}` : ""}.`}
              viewAll={{ href: agendaHref(today), label: q.deadlines.total > q.deadlines.rows.length ? `All ${q.deadlines.total.toLocaleString("en-IN")} in the calendar` : "Calendar" }}
            >
              <DeadlineList rows={q.deadlines.rows} today={today} emptyMessage={`Nothing is due for your clients in the next ${DEADLINE_DAYS} days.`} />
            </SectionCard>
          ) : null}

          {!messages.ok ? (
            <BlockError title="Messages from your clients" message="Couldn't load your clients' messages." errorRef={messages.ref} />
          ) : (
            <SectionCard
              title="Messages from your clients"
              description={messages.data.total > 0 ? `${messages.data.total.toLocaleString("en-IN")} unread, newest first.` : "Portal and email messages you haven't read yet."}
              viewAll={messages.data.total > 0 ? { href: "/messages", label: "Messages" } : undefined}
            >
              <MessageList rows={messages.data.rows} emptyMessage="No unread messages from your clients." />
            </SectionCard>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-start-3 lg:row-start-2 lg:gap-6">
          {week.ok ? <WeekCard week={week.data} /> : <BlockError title="This week" message="Couldn't load this week's hours." errorRef={week.ref} />}
          <MyCovers user={user} supabase={supabase} />
          {leave.ok ? <LeaveCard leave={leave.data} /> : <BlockError title="Leave" message="Couldn't load your leave." errorRef={leave.ref} />}
        </div>
      </div>
    </div>
  )
}
