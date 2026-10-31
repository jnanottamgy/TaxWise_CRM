import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requirePartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatMinutes } from "@/lib/format"
import { fromPaise, formatINR } from "@/lib/domain/money"
import { MONTH_ABBR, todayIST } from "@/lib/domain/fy"
import { formatPercent } from "@/lib/domain/collections"
import { AGEING_BUCKET_LABELS } from "@/lib/domain/invoice"
import { getPaymentsDashboard, type PaymentsDashboard } from "@/lib/data/payments"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { ErrorBlock } from "@/components/app/error-block"
import { BarChartCard } from "@/components/app/charts/chart-cards"
import { PageGuide } from "@/components/shell/page-slots"
import { HandoffQueue, PromisesThisMonth, TopDebtors } from "@/components/collections/payments-blocks"

export const metadata: Metadata = { title: "Payments" }

/**
 * Payments (§7.9.5, Partner only, §4.1): "Who owes us, how old is it, and are we collecting?" The
 * answer leads (outstanding), with overdue, this month's collections, the collection rate, days
 * sales outstanding and unbilled time beside it; then reminders waiting to be sent by hand,
 * collections by month, receivables ageing, the ten clients owing most, and payment promises
 * falling due this month against what came in. One SQL call (payments_dashboard, 0163), in paise.
 * A Manager is refused here (403/404) and by the database function.
 */
export default async function PaymentsPage() {
  const { user, supabase } = await requirePartner()
  const today = todayIST()
  let data: PaymentsDashboard | null = null
  let ref: string | null = null
  try {
    data = await getPaymentsDashboard(supabase, today)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/payments", userId: user.id })
  }

  const guide = (
    <PageGuide title="Payments">
      <p>Outstanding counts every issued invoice with a balance: Sent, Partially paid and Disputed. Overdue is worked out from the due date; a draft is never overdue.</p>
      <p className="mt-2">
        The collection rate is what came in this financial year (received plus TDS) out of what there was to collect: receivables open on 1 April, plus billing since, less credit notes and
        write-offs. Days sales outstanding compares what is owed with the last 90 days&apos; billing.
      </p>
      <p className="mt-2">Promises come from the follow-up log on each invoice. Payment reminders that are due wait below until someone sends them on WhatsApp from the invoice.</p>
    </PageGuide>
  )

  if (!data) {
    return (
      <div className="flex min-w-0 flex-col">
        {guide}
        <PageHeader title="Payments" description="Receivables, collections and promises." />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the payments dashboard." errorRef={ref} />
        </div>
      </div>
    )
  }

  const d = data
  const monthLabel = `${MONTH_ABBR[Number(today.slice(5, 7)) - 1]} ${today.slice(0, 4)}`
  const monthStart = `${today.slice(0, 7)}-01`
  const months = d.monthly.map((m) => ({ month: MONTH_ABBR[Number(m.month.slice(5, 7)) - 1], collected: fromPaise(m.collectedPaise) }))
  const current = d.monthly.findIndex((m) => m.month === today.slice(0, 7))
  const fyCollected = d.monthly.reduce((s, m) => s + m.collectedPaise, 0)
  const ageing = d.ageing.map((a) => ({ bucket: AGEING_BUCKET_LABELS[a.bucket].replace(/ days$/, ""), amount: fromPaise(a.amountPaise) }))
  const over90 = d.ageing.find((a) => a.bucket === "90_plus")

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      {guide}
      <PageHeader
        title="Payments"
        description={`As of ${formatDate(today)} · ${d.receivables.count} ${d.receivables.count === 1 ? "invoice" : "invoices"} with a balance across ${d.receivables.clients} ${d.receivables.clients === 1 ? "client" : "clients"}`}
        className="pb-0 md:pb-0"
      />

      <KpiStrip
        lead
        aria-label="Receivables and collections"
        items={[
          {
            label: "Outstanding",
            value: <Money value={fromPaise(d.receivables.outstandingPaise)} compact />,
            sub: d.receivables.disputedCount ? `incl. ${formatINR(d.receivables.disputedPaise)} disputed` : `${d.receivables.count} ${d.receivables.count === 1 ? "invoice" : "invoices"}`,
            href: "/invoices?status=sent,partially_paid,disputed",
          },
          {
            label: "Overdue",
            value: <Money value={fromPaise(d.receivables.overduePaise)} compact />,
            sub: d.receivables.overdueCount ? `${d.receivables.overdueCount} past the due date` : "Nothing past its due date",
            href: "/invoices?status=overdue",
          },
          {
            label: `Collected in ${monthLabel}`,
            value: <Money value={fromPaise(d.collection.collectedMonthPaise)} compact />,
            sub: d.collection.tdsMonthPaise ? `incl. ${formatINR(d.collection.tdsMonthPaise)} TDS` : "Received and TDS",
            href: `/revenue?tab=receipts&from=${monthStart}&to=${today}`,
          },
          {
            label: "Collection rate",
            value: formatPercent(d.collection.ratePercent),
            sub: d.collection.duePaise > 0 ? `FY ${d.financialYear}: ${formatINR(d.collection.collectedPaise)} of ${formatINR(d.collection.duePaise)}` : `FY ${d.financialYear}: nothing to collect yet`,
            href: "/revenue?tab=receipts",
          },
          {
            label: "Days sales outstanding",
            value: d.dso.days === null ? "—" : `${d.dso.days} days`,
            sub: d.dso.billedPaise > 0 ? `On the last ${d.dso.windowDays} days' billing` : `Nothing billed in the last ${d.dso.windowDays} days`,
          },
          {
            label: "Unbilled time",
            value: <Money value={fromPaise(d.unbilled.amountPaise)} compact />,
            sub: d.unbilled.minutes ? `${formatMinutes(d.unbilled.minutes)} across ${d.unbilled.clients} ${d.unbilled.clients === 1 ? "client" : "clients"}` : "Nothing waiting to bill",
            href: "/timesheet?view=unbilled",
          },
        ]}
      />

      <HandoffQueue h={d.handoffs} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <BarChartCard
          className="lg:col-span-2"
          title="Collections by month"
          description={`FY ${d.financialYear}: received and TDS, by payment date. ${formatINR(fyCollected)} so far.`}
          xKey="month"
          xLabel="Month"
          valueFormat="money"
          data={months}
          series={{ key: "collected", label: "Collected" }}
          highlight={current >= 0 ? current : undefined}
          summary={`FY ${d.financialYear}: ${formatINR(fyCollected)} collected so far, ${formatINR(d.collection.collectedMonthPaise)} of it in ${monthLabel}.`}
          emptyMessage="Nothing collected this year yet."
        />
        <BarChartCard
          title="Receivables ageing"
          description={over90 && over90.amountPaise > 0 ? `By days since the invoice date. ${formatINR(over90.amountPaise)} is over 90 days old.` : "Outstanding, by days since the invoice date."}
          xKey="bucket"
          xLabel="Days since invoice"
          valueFormat="money"
          data={d.receivables.count ? ageing : []}
          series={{ key: "amount", label: "Outstanding" }}
          summary={d.ageing.map((a) => `${AGEING_BUCKET_LABELS[a.bucket]}: ${formatINR(a.amountPaise)} on ${a.count}`).join("; ")}
          emptyMessage="Nothing outstanding."
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        <TopDebtors rows={d.topDebtors} today={today} />
        <PromisesThisMonth p={d.promises} />
      </div>
    </div>
  )
}
