import { cn } from "@/lib/utils"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy } from "@/lib/fy-context"
import { addDays, compareDates, endOfMonth, todayIST, type DateString } from "@/lib/domain/fy"
import { ceilingLevel, countLevel, fyToDate, healthTally, linkedPcLevel, peerReviewLevel, setupSteps, udinLevel } from "@/lib/domain/dashboard"
import { formatINR, formatINRCompact, fromPaise } from "@/lib/domain/money"
import { formatDate, formatDateRange, formatMinutes } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DateText } from "@/components/app/date-text"
import { BarChartCard, LineChartCard, StackedBarCard } from "@/components/app/charts/chart-cards"
import { PageGuide } from "@/components/shell/page-slots"
import { TaskList } from "@/components/tasks/task-list"
import AbsentWithoutCover from "@/components/covers/absent-without-cover"
import { listActiveStaff } from "@/lib/data/people"
import {
  getAssemblyHealth,
  getCeilingHealth,
  getExpiryHealth,
  getFirmToday,
  getLetterHealth,
  getNoticeHealth,
  getPeerReviewHealth,
  getPendingLeave,
  getRecentActivity,
  getUdinHealth,
  getWhatsAppHealth,
  type FirmToday,
} from "@/lib/data/dashboard"
import type { WorkViewer } from "@/lib/data/tasks"
import { BlockError, DeadlineList } from "@/components/home/home-ui"
import { KpiGrid, figure, money, type KpiFigure } from "@/components/home/kpi-grid"
import { ActivityList, ApprovalsBlock, AtRiskList, HealthRow, PipelineBlock, PracticeHealthBlock, SetupChecklist, type HealthItemView } from "@/components/home/firm-today"
import { agendaHref, count, filingStatusFromGroups, firmFinding, moneyHref, practiceHref, weekHref, workHref } from "@/components/home/logic"

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/dashboard:firm:${source}`, userId }) }
  }
}

const ROWS = 6

/**
 * Firm today (§7.2 Partner): "What needs my decision today, and is the firm on time and getting
 * paid?" The setup checklist (compact) until it's done, then Approvals (leave decided in place)
 * beside the nine figures, overdue receivables leading; the review queue and this week's deadlines;
 * invoiced against collected by month and filing status this month, beside receivables ageing,
 * at-risk clients and the pipeline; practice health; who is away without cover, and recent activity.
 *
 * The figures come from one database call (0216, Partner only; the payments figures are the
 * Partner's, §4.1); practice health reads each register through its own module. Every block loads
 * and fails on its own (§0.1 rule 3).
 */
export async function FirmTodayView({ user, supabase }: { user: CurrentUser; supabase: ServerSupabase }) {
  const today = todayIST()
  const fy = await getSelectedFy()
  const viewer: WorkViewer = { employeeId: user.employeeId, role: user.role, today }

  const [main, leave, staff, activity, udin, ceiling, letters, expiry, peer, assembly, whatsapp, notices] = await Promise.all([
    attempt("main", user.id, () => getFirmToday(supabase, fy, today, { rows: ROWS })),
    attempt("leave", user.id, () => getPendingLeave(supabase, user, 3)),
    attempt("staff", user.id, () => listActiveStaff(supabase)),
    attempt("activity", user.id, () => getRecentActivity(supabase, ROWS)),
    attempt("health:udin", user.id, () => getUdinHealth(supabase, today, 4)),
    attempt("health:ceiling", user.id, () => getCeilingHealth(supabase, fy)),
    attempt("health:letters", user.id, () => getLetterHealth(supabase, fy, today)),
    attempt("health:expiry", user.id, () => getExpiryHealth(supabase, today)),
    attempt("health:peer", user.id, () => getPeerReviewHealth(supabase, today)),
    attempt("health:assembly", user.id, () => getAssemblyHealth(supabase, today, 4)),
    attempt("health:whatsapp", user.id, () => getWhatsAppHealth(supabase)),
    attempt("health:notices", user.id, () => getNoticeHealth(supabase, today)),
  ])

  const m = main.ok ? main.data : null
  const setup = m ? setupSteps(m.setup, { profileId: user.id }) : null
  const approvalsWaiting = m ? m.approvals.invoices + m.approvals.quotations + m.approvals.leave + m.approvals.dataRequests.open : 0
  const finding = m
    ? firmFinding({ approvals: approvalsWaiting, overdueCount: m.kpis.overdueCount, overduePaise: m.kpis.overduePaise, filingsDueIn7: m.kpis.filingsDueIn7, overdueTasks: m.kpis.overdueTasks })
    : "The firm's figures couldn't be loaded; the block below says why."

  const health: HealthItemView[] = [
    udinItem(udin),
    ceilingItem(ceiling, fy),
    lettersItem(letters, fy),
    expiryItem(expiry),
    peerItem(peer),
    assemblyItem(assembly, today),
    noGroupItem(whatsapp),
    linkedPcsItem(whatsapp),
    noticesItem(notices, today),
  ]
  const tally = healthTally(health.map((h) => h.level))
  const unloaded = health.filter((h) => !h.ok).length
  const healthSummary =
    [tally.act ? `${tally.act} need${tally.act === 1 ? "s" : ""} action` : null, tally.watch ? `${tally.watch} coming up` : null, unloaded ? `${unloaded} couldn't be checked` : null].filter(Boolean).join(" · ") ||
    "Every register is in order."

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Firm today">
        <p>The line under the title says what most needs you: approvals, overdue money, filings due this week and overdue work. Every figure opens the list behind it.</p>
        <p className="mt-2">
          Amounts are shown in lakhs and crores; hover or focus a figure for the full amount. Invoiced amounts include GST; collected includes TDS deducted by the client. The FY switcher in the top bar picks the year
          for invoiced, the monthly chart, conversion, the tax-audit ceiling and engagement letters.
        </p>
        <p className="mt-2">Practice health marks in red what is overdue or failing and in amber what is coming up. Each title opens the register behind it.</p>
      </PageGuide>
      <PageHeader title="Firm today" description={finding} />

      <div className="flex flex-col gap-4 lg:gap-6">
        {setup && !setup.complete ? (
          <SectionCard id="setup" title="Finish setting up">
            <SetupChecklist items={setup.items} done={setup.done} percent={setup.percent} />
          </SectionCard>
        ) : null}

        {/* Approvals first (left), the firm's figures beside them; phones: Approvals, figures, review, deadlines. */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-3 lg:gap-6">
          {/* The review queue stretches to the figures' bottom only when it has rows: an empty one keeps its own height. */}
          <div className={cn("max-lg:contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6", (!m || m.review.rows.length > 0) && "lg:[&>*:last-child]:flex-1")}>
            {m ? (
              <SectionCard
                className="max-lg:order-1"
                title="Approvals"
                description={approvalsWaiting ? `${count(approvalsWaiting, "decision")} waiting for you.` : "Nothing waiting for your decision."}
                flush
              >
                <ApprovalsBlock a={m.approvals} leave={leave} today={today} actorRole={user.role} staff={staff.ok ? staff.data : []} />
              </SectionCard>
            ) : (
              <BlockError className="max-lg:order-1" title="Approvals" message="Couldn't load what is waiting for approval." errorRef={!main.ok ? main.ref : ""} />
            )}
            {m ? (
              <SectionCard
                className="max-lg:order-3"
                title="Review queue"
                description="Submitted Under review to you, or to any Manager."
                viewAll={m.review.total ? { href: workHref.review(), label: m.review.total > m.review.rows.length ? `View all ${figure(m.review.total)}` : "Review queue" } : undefined}
              >
                <TaskList rows={m.review.rows} today={today} running={null} viewerEmployeeId={viewer.employeeId} actions={false} emptyMessage="Nothing is waiting for review." />
              </SectionCard>
            ) : null}
          </div>

          <div className="max-lg:contents lg:col-span-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-6 lg:[&>*:last-child]:flex-1">
            <section aria-labelledby="firm-figures" className="max-lg:order-2">
              <h2 id="firm-figures" className="sr-only">
                The firm&apos;s figures
              </h2>
              {m ? (
                <KpiGrid aria-label="The firm's figures" cols={3} lead items={kpiItems(m, today)} />
              ) : (
                <BlockError title="The firm's figures" message="Couldn't load the firm's figures." errorRef={!main.ok ? main.ref : ""} />
              )}
            </section>
            {m ? (
              <SectionCard
                className="max-lg:order-4"
                title="This week's deadlines"
                description={`${formatDateRange(m.week.from, m.week.to)} · not yet filed${m.week.total ? ` · ${figure(m.week.total)}` : ""}`}
                viewAll={{ href: weekHref(today), label: m.week.total > m.week.rows.length ? `All ${figure(m.week.total)} in the calendar` : "Calendar" }}
              >
                <DeadlineList rows={m.week.rows} today={today} emptyMessage="Nothing left to file this week." />
              </SectionCard>
            ) : null}
          </div>
        </div>

        {m ? (
          <MoneyAndFilings m={m} today={today} />
        ) : (
          <BlockError title="Invoiced, collected and filed" message="Couldn't load the charts, at-risk clients and the pipeline." errorRef={!main.ok ? main.ref : ""} />
        )}

        <SectionCard title="Practice health" description={healthSummary}>
          <PracticeHealthBlock items={health} />
        </SectionCard>

        {/* Two lists of about the same length: who is away without cover, and what changed lately. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          <AbsentWithoutCover user={user} supabase={supabase} />
          {activity.ok ? (
            <SectionCard title="Recent activity" viewAll={{ href: "/audit-log", label: "Audit log" }}>
              <ActivityList rows={activity.data} />
            </SectionCard>
          ) : (
            <BlockError title="Recent activity" message="Couldn't load recent activity." errorRef={activity.ref} />
          )}
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// The nine figures (§7.2 KPI tiles): overdue receivables lead (is the firm getting paid?)
// -------------------------------------------------------------------------------------------------

function kpiItems(m: FirmToday, today: DateString): KpiFigure[] {
  const k = m.kpis
  const fyStartDate = m.months[0] ? `${m.months[0].month}-01` : m.monthStart
  const fyTo = m.months.length ? lastDayOf(m.months[m.months.length - 1].month) : today
  const invoicedTo = compareDates(fyTo, today) > 0 ? today : fyTo
  return [
    {
      label: "Overdue receivables",
      value: money(k.overduePaise),
      sub: k.overdueCount ? `${count(k.overdueCount, "invoice")} past the due date` : "No invoice past its due date",
      href: moneyHref.overdue(),
      tone: k.overdueCount ? "danger" : undefined,
    },
    { label: "Outstanding", value: money(k.outstandingPaise), sub: count(k.outstandingCount, "invoice"), href: moneyHref.outstanding() },
    {
      label: "Collected this month",
      value: money(k.collectedMonthPaise),
      sub: k.tdsMonthPaise > 0 ? `Incl. ${formatINRCompact(k.tdsMonthPaise)} TDS` : "Received, by payment date",
      href: moneyHref.received(m.monthStart, today),
    },
    { label: `Invoiced, FY ${m.fy}`, value: money(k.invoicedFyPaise), sub: `${count(k.invoicedFyCount, "invoice")}, incl. GST`, href: moneyHref.invoiced(fyStartDate, invoicedTo) },
    { label: "Unbilled time", value: money(k.unbilledPaise), sub: k.unbilledMinutes ? `${formatMinutes(k.unbilledMinutes)} on ${count(k.unbilledClients, "client")}` : "Nothing logged to bill", href: moneyHref.unbilled() },
    { label: "Active clients", value: figure(k.activeClients), sub: "In billing runs and reminders", href: "/clients?status=active" },
    { label: "Filings due in 7 days", value: figure(k.filingsDueIn7), sub: `Not yet filed, to ${formatDate(addDays(today, 7))}`, href: agendaHref(today, addDays(today, 7), { pendingOnly: true }) },
    { label: "Overdue tasks", value: figure(k.overdueTasks), sub: "Past due, not Filed/Done", href: workHref.overdue(), tone: k.overdueTasks ? "danger" : undefined },
    { label: "Team online now", value: figure(k.onlineNow), sub: `of ${figure(k.withLogin)} with a login`, href: "/people?presence=online" },
  ]
}

function lastDayOf(month: string): DateString {
  return endOfMonth(`${month}-01`)
}

// -------------------------------------------------------------------------------------------------
// Charts and at-risk clients
// -------------------------------------------------------------------------------------------------

function MoneyAndFilings({ m, today }: { m: FirmToday; today: DateString }) {
  const toDate = fyToDate(m.months)
  const filing = filingStatusFromGroups(m.filing)
  const filingTotals = filing.reduce((t, f) => ({ total: t.total + f.total, filed: t.filed + f.filed, overdue: t.overdue + f.overdue }), { total: 0, filed: 0, overdue: 0 })
  const old = m.ageing.find((a) => a.id === "d90_plus")
  const linkClass = "rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 lg:gap-6">
        <LineChartCard
          title="Invoiced and collected"
          description={`FY ${m.fy}, by month. Invoiced by invoice date (incl. GST); collected by payment date (incl. TDS).`}
          action={
            <Link href={moneyHref.invoiced(`${m.months[0]?.month ?? today.slice(0, 7)}-01`, today)} className={linkClass}>
              Revenue
            </Link>
          }
          xKey="label"
          xLabel="Month"
          valueFormat="money"
          data={m.months.map((r) => ({ label: r.label, collected: r.collectedPaise === null ? null : fromPaise(r.collectedPaise), invoiced: r.invoicedPaise === null ? null : fromPaise(r.invoicedPaise) }))}
          series={[
            { key: "collected", label: "Collected" },
            { key: "invoiced", label: "Invoiced" },
          ]}
          summary={`FY ${m.fy} so far: ${formatINR(toDate.invoicedPaise)} invoiced and ${formatINR(toDate.collectedPaise)} collected.`}
        />
        <StackedBarCard
          title="Filing status this month"
          description={
            filingTotals.total
              ? `${count(filingTotals.total, "deadline")} due by ${formatDate(m.monthEnd)} · ${figure(filingTotals.filed)} filed · ${figure(filingTotals.overdue)} overdue`
              : "Deadlines due this month, by return type."
          }
          action={
            <Link href="/filings" className={linkClass}>
              Filings grid
            </Link>
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
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6 lg:[&>*:last-child]:flex-1">
        <BarChartCard
          title="Receivables ageing"
          description="Outstanding, by days since the invoice date."
          action={
            <Link href="/payments" className={linkClass}>
              Payments
            </Link>
          }
          xKey="bucket"
          xLabel="Days since invoice"
          valueFormat="money"
          data={m.ageing.map((a) => ({ bucket: a.label.replace(/ days$/, ""), amount: fromPaise(a.paise) }))}
          series={{ key: "amount", label: "Outstanding" }}
          highlight={old && old.paise > 0 ? m.ageing.indexOf(old) : undefined}
          summary={m.ageing.map((a) => `${a.label}: ${formatINR(a.paise)} on ${count(a.count, "invoice")}`).join("; ")}
        />
        <SectionCard
          title="At-risk clients"
          description={m.atRisk.total ? `${count(m.atRisk.total, "client")} with 3 or more overdue tasks, or receivables over 90 days.` : "3 or more overdue tasks, or receivables over 90 days."}
          viewAll={m.atRisk.total > m.atRisk.rows.length ? { href: "/clients?flag=at_risk", label: `All ${figure(m.atRisk.total)} at-risk clients` } : undefined}
        >
          <AtRiskList rows={m.atRisk.rows} />
        </SectionCard>
        {/* Fees still to come in: the pipeline closes the money column, level with the filing chart. */}
        <SectionCard title="Pipeline" viewAll={{ href: "/leads", label: "Leads & quotations" }}>
          <PipelineBlock p={m.pipeline} fy={m.fy} />
        </SectionCard>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Practice health, one cell per register (each from its own module's reader)
// -------------------------------------------------------------------------------------------------

type L<T> = Loaded<T>

function failed(key: string, title: string, href: string, r: { ok: false; ref: string }, message: string): HealthItemView {
  return { key, title, href, level: null, body: null, ok: false, ref: r.ref, message }
}

function udinItem(r: L<Awaited<ReturnType<typeof getUdinHealth>>>): HealthItemView {
  const key = "udin"
  const title = "Signed reports without a UDIN"
  if (!r.ok) return failed(key, title, practiceHref.udin(), r, "Couldn't load the UDIN register.")
  const u = r.data
  return {
    key,
    title,
    href: practiceHref.udin(),
    level: udinLevel(u.rows, u.total),
    ok: true,
    body:
      u.total === 0 ? (
        "Every signed report has its UDIN."
      ) : (
        <ul className="flex flex-col gap-0.5">
          {u.rows.map((x) => (
            <HealthRow
              key={x.id}
              href={`/audits/${x.id}`}
              name={x.clientName || "Client"}
              value={x.daysLate !== null && x.daysLate > 0 ? `${count(x.daysLate, "day")} late` : x.daysLeft !== null ? `${x.daysLeft} of ${u.windowDays} days left` : formatDate(x.reportDate)}
              tone={x.daysLate !== null && x.daysLate > 0 ? "danger" : (x.daysLeft ?? 99) <= 7 ? "warning" : undefined}
            />
          ))}
          {u.total > u.rows.length ? <li>And {figure(u.total - u.rows.length)} more.</li> : null}
        </ul>
      ),
  }
}

function ceilingItem(r: L<Awaited<ReturnType<typeof getCeilingHealth>>>, fy: string): HealthItemView {
  const key = "ceiling"
  const title = `Tax audits against the ceiling, FY ${fy}`
  if (!r.ok) return failed(key, title, practiceHref.ceiling(), r, "Couldn't count the tax audits.")
  const c = r.data
  return {
    key,
    title,
    href: practiceHref.ceiling(),
    level: ceilingLevel(c.rows.map((x) => x.warning)),
    ok: true,
    body:
      c.rows.length === 0 ? (
        "No active Partners."
      ) : (
        <ul className="flex flex-col gap-0.5">
          {c.rows.map((x) => (
            <HealthRow key={x.memberId} name={x.name} value={`${x.total} of ${x.ceiling}`} tone={x.warning === "over" || x.warning === "at_ceiling" ? "danger" : x.warning === "near" ? "warning" : undefined} />
          ))}
          {c.unverified ? <li className="pt-0.5">The ceiling is still marked [verify] in Law & rules.</li> : null}
        </ul>
      ),
  }
}

function lettersItem(r: L<Awaited<ReturnType<typeof getLetterHealth>>>, fy: string): HealthItemView {
  const key = "letters"
  const title = "Engagement letters"
  if (!r.ok) return failed(key, title, practiceHref.lettersMissing(), r, "Couldn't load the engagement letters.")
  const l = r.data
  return {
    key,
    title,
    href: l.missing ? practiceHref.lettersMissing() : practiceHref.lettersExpiring(),
    level: countLevel(l.missing, l.expiring),
    ok: true,
    body: (
      <ul className="flex flex-col gap-0.5">
        <HealthRow href={practiceHref.lettersMissing()} name={`No letter for FY ${fy}`} value={count(l.missing, "client")} tone={l.missing ? "danger" : undefined} />
        <HealthRow href={practiceHref.lettersExpiring()} name="Expiring in 30 days" value={count(l.expiring, "letter")} tone={l.expiring ? "warning" : undefined} />
      </ul>
    ),
  }
}

function expiryItem(r: L<Awaited<ReturnType<typeof getExpiryHealth>>>): HealthItemView {
  const key = "expiry"
  const title = "DSCs and registrations expiring"
  if (!r.ok) return failed(key, title, practiceHref.dscExpiring(), r, "Couldn't load the DSC and registration registers.")
  const e = r.data
  return {
    key,
    title,
    href: e.dscNext30 || !e.registrationsNext30 ? practiceHref.dscExpiring() : practiceHref.registrationsExpiring(),
    level: countLevel(e.registrationsPast, e.dscNext30 + e.registrationsNext30),
    ok: true,
    body: (
      <ul className="flex flex-col gap-0.5">
        <HealthRow href={practiceHref.dscExpiring()} name="DSCs, next 30 days" value={figure(e.dscNext30)} tone={e.dscNext30 ? "warning" : undefined} />
        <HealthRow href={practiceHref.registrationsExpiring()} name="Registrations, next 30 days" value={figure(e.registrationsNext30)} tone={e.registrationsNext30 ? "warning" : undefined} />
        {e.registrationsPast ? <HealthRow href="/registers?tab=registrations" name="Registrations past expiry" value={figure(e.registrationsPast)} tone="danger" /> : null}
      </ul>
    ),
  }
}

function peerItem(r: L<Awaited<ReturnType<typeof getPeerReviewHealth>>>): HealthItemView {
  const key = "peer"
  const title = "Peer review"
  if (!r.ok) return failed(key, title, practiceHref.peerReview(), r, "Couldn't load the peer review record.")
  const p = r.data
  const text =
    p.state === "missing"
      ? "No peer review certificate recorded."
      : p.state === "expired"
        ? `Expired on ${formatDate(p.validUntil)}.`
        : p.state === "expiring"
          ? `Valid until ${formatDate(p.validUntil)}: ${count(p.daysLeft ?? 0, "day")} left.`
          : `Valid until ${formatDate(p.validUntil)}.`
  return {
    key,
    title,
    href: practiceHref.peerReview(),
    level: peerReviewLevel(p.state),
    ok: true,
    body: <span className={p.state === "expiring" ? "text-warning-text" : p.state === "valid" ? undefined : "text-danger-text"}>{text}</span>,
  }
}

function assemblyItem(r: L<Awaited<ReturnType<typeof getAssemblyHealth>>>, today: DateString): HealthItemView {
  const key = "assembly"
  const title = "Audit files to assemble (SA 230)"
  if (!r.ok) return failed(key, title, practiceHref.assemblyDue(), r, "Couldn't load the audit engagements.")
  const a = r.data
  return {
    key,
    title,
    href: a.overdue ? practiceHref.assemblyOverdue() : practiceHref.assemblyDue(),
    level: countLevel(a.overdue, a.due),
    ok: true,
    body:
      a.rows.length === 0 ? (
        "No audit file's 60-day assembly date is within two weeks."
      ) : (
        <ul className="flex flex-col gap-0.5">
          {a.rows.map((x) => (
            <HealthRow key={x.id} href={`/audits/${x.id}`} name={x.clientName || "Client"} value={<DateText date={x.due} withRelative today={today} />} />
          ))}
          {a.due + a.overdue > a.rows.length ? <li>And {figure(a.due + a.overdue - a.rows.length)} more.</li> : null}
        </ul>
      ),
  }
}

function noGroupItem(r: L<Awaited<ReturnType<typeof getWhatsAppHealth>>>): HealthItemView {
  const key = "wa-groups"
  const title = "Clients with no WhatsApp group"
  if (!r.ok) return failed(key, title, practiceHref.noWhatsAppGroup(), r, "Couldn't load the WhatsApp group register.")
  const n = r.data.withoutGroup
  return {
    key,
    title,
    href: practiceHref.noWhatsAppGroup(),
    level: n > 0 ? "watch" : "fine",
    ok: true,
    body: n ? `${count(n, "active client")} ${n === 1 ? "has" : "have"} no WhatsApp group yet.` : "Every active client has a WhatsApp group.",
  }
}

function linkedPcsItem(r: L<Awaited<ReturnType<typeof getWhatsAppHealth>>>): HealthItemView {
  const key = "wa-pcs"
  const title = "PCs linked per firm number"
  if (!r.ok) return failed(key, title, practiceHref.linkedPcs(), r, "Couldn't load the linked PCs.")
  const nums = r.data.numbers
  return {
    key,
    title,
    href: practiceHref.linkedPcs(),
    level: linkedPcLevel(nums),
    ok: true,
    body:
      nums.length === 0 ? (
        "No firm WhatsApp numbers switched on yet."
      ) : (
        <ul className="flex flex-col gap-0.5">
          {nums.map((n) => (
            <HealthRow key={n.id} name={n.label} value={n.limit !== null ? `${n.links} of ${n.limit} PCs` : count(n.links, "PC")} tone={n.overLimit ? "danger" : n.atLimit ? "warning" : undefined} />
          ))}
        </ul>
      ),
  }
}

function noticesItem(r: L<Awaited<ReturnType<typeof getNoticeHealth>>>, today: DateString): HealthItemView {
  const key = "notices"
  const title = "Notice replies"
  if (!r.ok) return failed(key, title, practiceHref.noticesOverdue(), r, "Couldn't load the notices register.")
  const n = r.data
  const rows = [...n.overdueReplies, ...n.repliesDue].slice(0, 3)
  return {
    key,
    title,
    href: n.counts.overdueReplies ? practiceHref.noticesOverdue() : practiceHref.noticesDue(),
    level: countLevel(n.counts.overdueReplies, n.counts.repliesDue),
    ok: true,
    body:
      rows.length === 0 ? (
        n.counts.open ? `${count(n.counts.open, "open notice")}, no reply due in the next 7 days.` : "No open notices."
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((x) => (
            <HealthRow key={`${x.kind}-${x.id}`} href={x.href} name={`${x.clientName} · ${x.noticeType}`} value={<DateText date={x.date} withRelative today={today} />} />
          ))}
          <li>
            <span className={n.counts.overdueReplies ? "text-danger-text" : undefined}>{figure(n.counts.overdueReplies)} overdue</span> · {figure(n.counts.repliesDue)} due in 7 days
          </li>
        </ul>
      ),
  }
}
