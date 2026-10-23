import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy } from "@/lib/fy-context"
import { endOfMonth, todayIST } from "@/lib/domain/fy"
import { ageReceivables, atRiskClients, receivableTotals, setupChecklist } from "@/lib/domain/dashboard"
import { formatINR, fromPaise, sumPaise } from "@/lib/domain/money"
import { formatDateRange, formatMinutes } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { BarChartCard, LineChartCard, StackedBarCard } from "@/components/app/charts/chart-cards"
import { PageGuide } from "@/components/shell/page-slots"
import { TaskList } from "@/components/tasks/task-list"
import AbsentWithoutCover from "@/components/covers/absent-without-cover"
import { listActiveStaff } from "@/lib/data/people"
import {
  getApprovals,
  getMoneyPicture,
  getPipeline,
  getPracticeCounts,
  getPracticeHealth,
  getRecentActivity,
  getSetupFacts,
  getTeamQueues,
  loadDeadlines,
  loadOverdueTasks,
  weekWindow,
} from "@/lib/data/dashboard"
import type { WorkViewer } from "@/lib/data/tasks"
import { BlockError, DeadlineList } from "@/components/home/home-ui"
import { ActivityList, ApprovalsBlock, AtRiskList, PipelineBlock, PracticeHealthBlock, SetupChecklist } from "@/components/home/firm-today"
import { agendaHref, count, filingStatusByReturnType, firmFinding, weekHref, workHref } from "@/components/home/logic"

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/dashboard:firm:${source}`, userId }) }
  }
}

/**
 * Firm today (§7.2 Partner): "What needs my decision today, and is the firm on time and getting
 * paid?" The setup checklist until it's done; KPIs (each linking to its list); approvals with leave
 * decided in place; this week's deadlines; invoiced against collected by month; receivables ageing;
 * filing status by return type this month; the review queue; practice health; at-risk clients; the
 * pipeline; recent activity; and who is away without cover. The payments figures are the Partner's
 * alone (§4.1); every block loads and fails on its own (§0.1 rule 3).
 */
export async function FirmTodayView({ user, supabase }: { user: CurrentUser; supabase: ServerSupabase }) {
  const today = todayIST()
  const fy = await getSelectedFy()
  const week = weekWindow(today)
  const monthStart = `${today.slice(0, 7)}-01`
  const viewer: WorkViewer = { employeeId: user.employeeId, role: user.role, today }

  const [setup, counts, money, approvals, staff, weekDeadlines, monthDeadlines, queues, health, overdue, pipeline, activity] = await Promise.all([
    attempt("setup", user.id, () => getSetupFacts(supabase)),
    attempt("counts", user.id, () => getPracticeCounts(supabase, today)),
    attempt("money", user.id, () => getMoneyPicture(supabase, today, fy)),
    attempt("approvals", user.id, () => getApprovals(supabase, user)),
    attempt("staff", user.id, () => listActiveStaff(supabase)),
    attempt("week", user.id, async () => (await loadDeadlines(supabase, week.from, week.to)).filter((d) => d.status === "pending")),
    attempt("month", user.id, () => loadDeadlines(supabase, monthStart, endOfMonth(monthStart))),
    attempt("queues", user.id, () => getTeamQueues(supabase, viewer, 5)),
    attempt("health", user.id, () => getPracticeHealth(supabase, today, fy)),
    attempt("overdue", user.id, () => loadOverdueTasks(supabase)),
    attempt("pipeline", user.id, () => getPipeline(supabase, fy)),
    attempt("activity", user.id, () => getRecentActivity(supabase, 6)),
  ])

  const checklist = setup.ok ? setupChecklist(setup.data) : null
  const totals = money.ok ? receivableTotals(money.data.receivables.map((r) => ({ outstandingPaise: r.outstandingPaise, isOverdue: r.isOverdue }))) : null
  const approvalsWaiting = approvals.ok ? approvals.data.invoices + approvals.data.quotations + approvals.data.leave.total + approvals.data.dataRequests.total : 0
  const finding =
    counts.ok && totals
      ? firmFinding({ approvals: approvalsWaiting, overdueCount: totals.overdueCount, overduePaise: totals.overduePaise, filingsDueIn7: counts.data.filingsDueIn7, overdueTasks: counts.data.overdueTasks })
      : "Some figures couldn't be loaded; each block below says which."
  const ageing = money.ok ? ageReceivables(money.data.receivables.map((r) => ({ issueDate: r.issue_date, outstandingPaise: r.outstandingPaise })), today) : null
  const filing = monthDeadlines.ok ? filingStatusByReturnType(monthDeadlines.data, today) : null
  const filingTotals = { total: (filing ?? []).reduce((n, f) => n + f.total, 0), filed: (filing ?? []).reduce((n, f) => n + f.filed, 0), overdue: (filing ?? []).reduce((n, f) => n + f.overdue, 0) }
  const atRisk = money.ok && overdue.ok ? atRiskClients(overdue.data.map((t) => ({ clientId: t.client_id, clientName: t.client_name })), money.data.receivables.map((r) => ({ clientId: r.client_id, clientName: r.client_name, issueDate: r.issue_date, outstandingPaise: r.outstandingPaise })), today) : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Firm today">
        <p>The top line says what most needs you: approvals, overdue money, filings due this week and overdue work. Every figure opens the list behind it.</p>
        <p className="mt-2">Money is shown in lakhs and crores on the tiles; hover or focus a figure for the full amount. Invoiced amounts include GST; collected includes TDS deducted by the client. The FY switcher in the top bar picks the year for invoiced, the monthly chart and conversion.</p>
      </PageGuide>
      <PageHeader title="Firm today" description={finding} />

      <div className="flex flex-col gap-4 lg:gap-6">
        {checklist && !checklist.complete ? (
          <SectionCard title="Finish setting up" description={`${checklist.done} of ${checklist.items.length} done. This goes once everything is set.`}>
            <SetupChecklist items={checklist.items} />
          </SectionCard>
        ) : !setup.ok ? (
          <BlockError title="Finish setting up" message="Couldn't check the firm's setup." errorRef={setup.ref} />
        ) : null}

        <div className="flex flex-col gap-3">
          {counts.ok ? (
            <KpiStrip
              aria-label="Practice"
              items={[
                { label: "Active clients", value: counts.data.activeClients.toLocaleString("en-IN"), href: "/clients?status=active" },
                { label: "Filings due in 7 days", value: counts.data.filingsDueIn7, sub: "Not yet filed", href: agendaHref(today) },
                { label: "Overdue tasks", value: counts.data.overdueTasks, sub: "Past due, not Filed/Done", href: workHref.overdue() },
                { label: "Team online now", value: counts.data.onlineNow, sub: "In use in the last 20 minutes", href: "/people" },
              ]}
            />
          ) : (
            <BlockError title="Practice" message="Couldn't load the practice figures." errorRef={counts.ref} />
          )}
          {money.ok && totals ? (
            <KpiStrip
              aria-label="Money"
              items={[
                { label: `Invoiced, FY ${fy}`, value: <Money value={fromPaise(money.data.invoicedFyPaise)} compact />, sub: "Incl. GST", href: "/revenue" },
                {
                  label: "Collected this month",
                  value: <Money value={fromPaise(money.data.collectedMonthPaise)} compact />,
                  sub: money.data.tdsMonthPaise > 0 ? (
                    <>
                      Incl. <Money value={fromPaise(money.data.tdsMonthPaise)} compact /> TDS
                    </>
                  ) : (
                    "Received, by payment date"
                  ),
                  href: "/payments",
                },
                { label: "Outstanding", value: <Money value={fromPaise(totals.outstandingPaise)} compact />, sub: count(totals.count, "invoice"), href: "/invoices?status=sent,partially_paid,disputed" },
                { label: "Overdue receivables", value: <Money value={fromPaise(totals.overduePaise)} compact />, sub: count(totals.overdueCount, "invoice"), href: "/invoices?status=overdue" },
                { label: "Unbilled time", value: <Money value={fromPaise(money.data.unbilledPaise)} compact />, sub: `${formatMinutes(money.data.unbilledMinutes)} logged`, href: "/timesheet?view=unbilled" },
              ]}
            />
          ) : !money.ok ? (
            <BlockError title="Money" message="Couldn't load invoices, receipts and unbilled time." errorRef={money.ref} />
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
          {approvals.ok ? (
            <SectionCard title="Approvals" description={approvalsWaiting ? `${count(approvalsWaiting, "decision")} waiting for you.` : "Nothing waiting for your decision."} flush>
              <ApprovalsBlock a={approvals.data} today={today} actorRole={user.role} staff={staff.ok ? staff.data : []} />
            </SectionCard>
          ) : (
            <BlockError title="Approvals" message="Couldn't load what is waiting for approval." errorRef={approvals.ref} />
          )}
          {weekDeadlines.ok ? (
            <SectionCard
              className="lg:col-span-2"
              title="This week's deadlines"
              description={`${formatDateRange(week.from, week.to)} · not yet filed${weekDeadlines.data.length ? ` · ${weekDeadlines.data.length}` : ""}`}
              viewAll={{ href: weekHref(today), label: weekDeadlines.data.length > 6 ? `All ${weekDeadlines.data.length} in the calendar` : "Calendar" }}
            >
              <DeadlineList rows={weekDeadlines.data.slice(0, 6)} today={today} emptyMessage="Nothing left to file this week." />
            </SectionCard>
          ) : (
            <BlockError className="lg:col-span-2" title="This week's deadlines" message="Couldn't load this week's deadlines." errorRef={weekDeadlines.ref} />
          )}
        </div>

        {money.ok && ageing ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
            <LineChartCard
              className="lg:col-span-2"
              title="Invoiced and collected"
              description={`FY ${fy}, by month. Invoiced by invoice date (incl. GST); collected by payment date (incl. TDS).`}
              xKey="label"
              xLabel="Month"
              valueFormat="money"
              data={money.data.byMonth.map((m) => ({ label: m.label, collected: m.collected, invoiced: m.invoiced }))}
              series={[
                { key: "collected", label: "Collected" },
                { key: "invoiced", label: "Invoiced" },
              ]}
              summary={`FY ${fy}: ${formatINR(money.data.invoicedFyPaise)} invoiced and ${formatINR(sumPaise(money.data.byMonth.map((m) => m.collectedPaise)))} collected so far.`}
            />
            <BarChartCard
              title="Receivables ageing"
              description="Outstanding, by days since the invoice date."
              xKey="bucket"
              xLabel="Days since invoice"
              valueFormat="money"
              data={ageing.map((a) => ({ bucket: a.label.replace(/ days$/, ""), amount: fromPaise(a.paise) }))}
              series={{ key: "amount", label: "Outstanding" }}
              emptyMessage="Nothing outstanding."
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          {filing ? (
            <StackedBarCard
              title="Filing status this month"
              description={
                filingTotals.total
                  ? `${count(filingTotals.total, "deadline")} due this month · ${filingTotals.filed} filed · ${filingTotals.overdue} overdue`
                  : "Deadlines due this month, by return type."
              }
              xKey="label"
              xLabel="Return"
              integer
              data={filing.map((f) => ({ label: f.label, overdue: f.overdue, pending: f.pending, filed: f.filed }))}
              series={[
                { key: "overdue", label: "Overdue" },
                { key: "pending", label: "Not yet due" },
                { key: "filed", label: "Filed" },
              ]}
              emptyMessage="No deadlines fall due this month."
              action={
                <Link href="/filings" className="rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  Filings grid
                </Link>
              }
            />
          ) : (
            <BlockError title="Filing status this month" message="Couldn't load this month's deadlines." errorRef={!monthDeadlines.ok ? monthDeadlines.ref : ""} />
          )}
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6 [&>*:last-child]:flex-1">
            {queues.ok ? (
              <SectionCard
                title="Review queue"
                description="Submitted Under review to you, or to any Manager."
                viewAll={queues.data.review.total ? { href: workHref.review(), label: queues.data.review.total > queues.data.review.rows.length ? `View all ${queues.data.review.total}` : "Review queue" } : undefined}
              >
                <TaskList rows={queues.data.review.rows} today={today} running={null} viewerEmployeeId={user.employeeId} actions={false} emptyMessage="Nothing is waiting for review." />
              </SectionCard>
            ) : (
              <BlockError title="Review queue" message="Couldn't load the review queue." errorRef={queues.ref} />
            )}
            {atRisk ? (
              <SectionCard title="At-risk clients" description="3 or more overdue tasks, or receivables over 90 days.">
                <AtRiskList rows={atRisk.slice(0, 6)} />
              </SectionCard>
            ) : (
              <BlockError title="At-risk clients" message="Couldn't work out which clients are at risk." errorRef={!overdue.ok ? overdue.ref : !money.ok ? money.ref : ""} />
            )}
          </div>
        </div>

        {health.ok ? (
          <SectionCard title="Practice health" description="UDINs, the tax-audit ceiling, letters, DSCs, peer review, file assembly and WhatsApp.">
            <PracticeHealthBlock h={health.data} today={today} />
          </SectionCard>
        ) : (
          <BlockError title="Practice health" message="Couldn't load the practice registers." errorRef={health.ref} />
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          {activity.ok ? (
            <SectionCard title="Recent activity" viewAll={{ href: "/audit-log", label: "Audit log" }}>
              <ActivityList rows={activity.data} />
            </SectionCard>
          ) : (
            <BlockError title="Recent activity" message="Couldn't load recent activity." errorRef={activity.ref} />
          )}
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6 [&>*:last-child]:flex-1">
            {pipeline.ok ? (
              <SectionCard title="Pipeline" viewAll={{ href: "/leads", label: "Leads & quotations" }}>
                <PipelineBlock p={pipeline.data} />
              </SectionCard>
            ) : (
              <BlockError title="Pipeline" message="Couldn't load leads and quotations." errorRef={pipeline.ref} />
            )}
            <AbsentWithoutCover user={user} supabase={supabase} />
          </div>
        </div>
      </div>
    </div>
  )
}
