import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatDate } from "@/lib/format"
import { getSelectedFy } from "@/lib/fy-context"
import { addMonths, compareDates, endOfMonth, financialYearOf, monthPeriodLabel, previousFinancialYear, quarterLabel, quarterRange, todayIST, type DateString, type FyQuarter } from "@/lib/domain/fy"
import { fromPaise, type Paise } from "@/lib/domain/money"
import { DateRangeSchema, REVENUE_KINDS, REVENUE_KIND_LABEL, REVENUE_SORTABLE, fyRange, type RevenueKind } from "@/lib/schemas/collections"
import { getRevenueLedger, type LedgerCreditNoteRow, type LedgerInvoiceRow, type LedgerPage, type LedgerReceiptRow } from "@/lib/data/revenue"
import { formatCount, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip, type KpiItem } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { PageGuide } from "@/components/shell/page-slots"
import { ViewTabs } from "@/components/collections/ui"
import { PeriodPicker, type PeriodPreset } from "@/components/collections/period-picker"
import { RevenueCreditNotesTable, RevenueInvoicesTable, RevenueReceiptsTable } from "@/components/collections/revenue-table"
import { DownloadButton } from "@/components/collections/download-button"
import { Gstr1Export } from "@/components/collections/gstr1-export"

export const metadata: Metadata = { title: "Revenue" }

type SearchParams = Record<string, string | string[] | undefined>

const minDate = (a: DateString, b: DateString) => (compareDates(a, b) <= 0 ? a : b)

/** The period presets: the FY so far, this and last month, and each quarter of the FY that has started. */
function periodPresets(fy: string, today: DateString): PeriodPreset[] {
  const fyR = fyRange(fy, today)
  const out: PeriodPreset[] = [{ id: "fy", label: `FY ${fy}`, from: fyR.from, to: fyR.to }]
  const monthStart = `${today.slice(0, 7)}-01` as DateString
  out.push({ id: "this_month", label: "This month", from: monthStart, to: today })
  const lastStart = addMonths(monthStart, -1)
  out.push({ id: "last_month", label: "Last month", from: lastStart, to: endOfMonth(lastStart) })
  for (const q of [1, 2, 3, 4] as FyQuarter[]) {
    const r = quarterRange(fy, q)
    if (compareDates(r.start, today) > 0) break
    out.push({ id: `q${q}`, label: `Q${q}`, from: r.start, to: minDate(r.end, today) })
  }
  return out
}

/** GSTR-1 periods: the last 12 months (newest first) and the quarters of this FY and the last that have started. */
function gstr1Periods(today: DateString): { months: Array<{ value: string; label: string }>; quarters: string[]; initial: string } {
  const monthStart = `${today.slice(0, 7)}-01` as DateString
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = addMonths(monthStart, -i)
    return { value: d.slice(0, 7), label: monthPeriodLabel(d) }
  })
  const quarters: string[] = []
  const current = financialYearOf(today)
  for (const fy of [current, previousFinancialYear(current)]) {
    for (const q of [4, 3, 2, 1] as FyQuarter[]) {
      const r = quarterRange(fy, q)
      if (compareDates(r.start, today) <= 0) quarters.push(quarterLabel(r.start))
    }
  }
  return { months, quarters, initial: months[1]?.value ?? months[0].value }
}

function kpisFor(page: LedgerPage<RevenueKind>): KpiItem[] {
  const t = page.totals
  const c = page.counts
  const p = (k: string): Paise => t[k] ?? 0
  const n = (k: string): number => c[k] ?? 0
  if (page.kind === "invoices") {
    return [
      { label: "Billed", value: <Money value={fromPaise(p("total"))} compact />, sub: `${formatCount(n("count"))} ${n("count") === 1 ? "invoice" : "invoices"}${n("cancelled") ? ` · ${formatCount(n("cancelled"))} cancelled` : ""}` },
      { label: "Fees (taxable)", value: <Money value={fromPaise(p("taxable"))} compact />, sub: p("reimbursement") ? <>plus <Money value={fromPaise(p("reimbursement"))} /> reimbursements</> : "before GST" },
      { label: "GST", value: <Money value={fromPaise(p("cgst") + p("sgst") + p("igst"))} compact />, sub: p("igst") ? <>IGST <Money value={fromPaise(p("igst"))} /></> : "CGST + SGST" },
      { label: "Received", value: <Money value={fromPaise(p("received") + p("tds"))} compact />, sub: p("tds") ? <>incl. TDS <Money value={fromPaise(p("tds"))} /></> : "on these invoices" },
      { label: "Outstanding", value: <Money value={fromPaise(p("outstanding"))} compact />, sub: p("credited") || p("written_off") ? <>after <Money value={fromPaise(p("credited") + p("written_off"))} /> credited or written off</> : "on these invoices" },
    ]
  }
  if (page.kind === "receipts") {
    return [
      { label: "Received", value: <Money value={fromPaise(p("received"))} compact />, sub: `${formatCount(n("count"))} ${n("count") === 1 ? "receipt" : "receipts"}${n("reversed") ? ` · ${formatCount(n("reversed"))} reversed` : ""}` },
      { label: "TDS deducted", value: <Money value={fromPaise(p("tds"))} compact />, sub: "credit to claim" },
      { label: "Settled on invoices", value: <Money value={fromPaise(p("settled"))} compact />, sub: "received plus TDS" },
    ]
  }
  return [
    { label: "Credited", value: <Money value={fromPaise(p("total"))} compact />, sub: `${formatCount(n("count"))} ${n("count") === 1 ? "credit note" : "credit notes"}` },
    { label: "Fees (taxable)", value: <Money value={fromPaise(p("taxable"))} compact />, sub: "reduced" },
    { label: "GST", value: <Money value={fromPaise(p("cgst") + p("sgst") + p("igst"))} compact />, sub: "reduced" },
  ]
}

/**
 * Revenue (§7.9.10): "What did we bill, collect and credit in this period?" The revenue ledger in
 * three views (invoices, receipts, credit notes) for a period (the selected FY so far by default),
 * with its totals; searched, sorted, paged and totalled in SQL (revenue_ledger, 0163). Below it the
 * exports: the revenue ledger and the sales register (Excel, CSV) for the period, and GSTR-1 for a
 * month or a quarter (Excel sheets for the offline tool, or JSON). Partners and Managers only (§4.1).
 */
export default async function RevenuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const fy = await getSelectedFy()
  const today = todayIST()
  const rawKind = readParam(sp, "tab")
  const kind: RevenueKind = (REVENUE_KINDS as readonly string[]).includes(rawKind ?? "") ? (rawKind as RevenueKind) : "invoices"

  const fallback = fyRange(fy, today)
  const parsed = DateRangeSchema.safeParse({ from: readParam(sp, "from") || fallback.from, to: readParam(sp, "to") || fallback.to })
  const range = parsed.success ? parsed.data : fallback
  const rangeProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "That period isn't valid, so the financial year so far is shown.")
  const presets = periodPresets(fy, today)
  const preset = presets.find((p) => p.from === range.from && p.to === range.to)
  const periodLabel = preset ? (preset.id === "fy" ? `FY ${fy} so far` : preset.label.startsWith("Q") ? `${preset.label} ${fy}` : preset.label.toLowerCase()) : `${formatDate(range.from)} – ${formatDate(range.to)}`

  const t = parseTableParams(sp, { sortable: REVENUE_SORTABLE[kind], defaultSort: { sort: "date", dir: "desc" } })
  let page: LedgerPage<RevenueKind> | null = null
  let ref: string | null = null
  try {
    page = await getRevenueLedger(supabase, { kind, from: range.from, to: range.to, q: t.q, sort: t.sort, dir: t.dir, offset: t.from, limit: t.pageSize })
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: `page:/revenue:${kind}`, userId: user.id })
  }

  const keep = new URLSearchParams()
  if (readParam(sp, "from")) keep.set("from", range.from)
  if (readParam(sp, "to")) keep.set("to", range.to)
  const tabHref = (k: RevenueKind) => {
    const q = new URLSearchParams(keep)
    if (k !== "invoices") q.set("tab", k)
    const s = q.toString()
    return s ? `/revenue?${s}` : "/revenue"
  }
  const period = `from=${range.from}&to=${range.to}`
  const gst = gstr1Periods(today)
  const tableProps = { total: page?.total ?? 0, page: t.page, pageSize: t.pageSize, sort: t.sort, dir: t.dir, today, periodLabel }

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <PageGuide title="Revenue">
        <p>
          The revenue ledger for a period: invoices by their date, receipts by the date paid, and credit notes by their date. Cancelled invoices and reversed receipts stay in the list, marked,
          and are left out of the totals.
        </p>
        <p className="mt-2">
          The exports cover the same period. GSTR-1 is for one month or one quarter and lists B2B invoices, B2C large and small, credit notes, the SAC summary and the documents issued; check it
          against the GST portal before filing.
        </p>
      </PageGuide>
      <PageHeader
        title="Revenue"
        description={`${periodLabel[0].toUpperCase()}${periodLabel.slice(1)} · ${formatDate(range.from)} – ${formatDate(range.to)}`}
        className="pb-0 md:pb-0"
        actions={<PeriodPicker from={range.from} to={range.to} presets={presets} />}
      />
      {rangeProblem ? (
        <p role="alert" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-text">
          {rangeProblem} Showing FY {fy} so far.
        </p>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4">
        <ViewTabs label="Revenue views" active={kind} items={REVENUE_KINDS.map((k) => ({ id: k, label: REVENUE_KIND_LABEL[k], href: tabHref(k) }))} />
        {page ? <KpiStrip aria-label={`${REVENUE_KIND_LABEL[kind]} totals, ${periodLabel}`} items={kpisFor(page)} /> : null}
        <div className="flex min-w-0 flex-col">
          <FilterBar
            searchLabel={`Search ${REVENUE_KIND_LABEL[kind].toLowerCase()}`}
            searchPlaceholder={kind === "receipts" ? "Client, receipt, invoice or reference" : kind === "credit_notes" ? "Client, credit note or invoice" : "Client, invoice or GSTIN"}
            filters={[]}
          />
          {page ? (
            page.kind === "invoices" ? (
              <RevenueInvoicesTable rows={page.rows as LedgerInvoiceRow[]} {...tableProps} />
            ) : page.kind === "receipts" ? (
              <RevenueReceiptsTable rows={page.rows as LedgerReceiptRow[]} {...tableProps} />
            ) : (
              <RevenueCreditNotesTable rows={page.rows as LedgerCreditNoteRow[]} {...tableProps} />
            )
          ) : (
            <div className="rounded-lg border border-border bg-surface">
              <ErrorBlock message={`Couldn't load the ${REVENUE_KIND_LABEL[kind].toLowerCase()}.`} errorRef={ref} />
            </div>
          )}
        </div>
      </div>

      <SectionCard title="Exports" description={`Registers for ${formatDate(range.from)} – ${formatDate(range.to)}; GSTR-1 for the return period you choose.`}>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-3">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text">Revenue ledger</h3>
            <p className="text-sm text-text-muted">Invoices, receipts and credit notes, one sheet each, with the totals.</p>
            <div className="flex flex-wrap gap-2">
              <DownloadButton href={`/api/exports/revenue-ledger?${period}${t.q ? `&q=${encodeURIComponent(t.q)}` : ""}`} label="Excel" fallbackName={`Revenue-ledger-${range.from}-to-${range.to}.xlsx`} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text">Sales register</h3>
            <p className="text-sm text-text-muted">Every invoice and credit note with GSTIN, place of supply, SAC, taxable value and GST.</p>
            <div className="flex flex-wrap gap-2">
              <DownloadButton href={`/api/exports/sales-register?${period}&format=xlsx`} label="Excel" fallbackName={`Sales-register-${range.from}-to-${range.to}.xlsx`} />
              <DownloadButton href={`/api/exports/sales-register?${period}&format=csv`} label="CSV" fallbackName={`Sales-register-${range.from}-to-${range.to}.csv`} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text">GSTR-1</h3>
            <Gstr1Export months={gst.months} quarters={gst.quarters} initial={gst.initial} />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

