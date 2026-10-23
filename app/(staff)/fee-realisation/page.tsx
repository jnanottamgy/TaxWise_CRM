import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatDate } from "@/lib/format"
import { getSelectedFy } from "@/lib/fy-context"
import { compareDates, fyEnd, todayIST } from "@/lib/domain/fy"
import { fromPaise, formatINR } from "@/lib/domain/money"
import { formatPercent } from "@/lib/domain/collections"
import { REALISATION_SORTS, sortRealisationRows, type RealisationReport, type RealisationSort } from "@/lib/domain/realisation"
import { loadRealisation } from "@/lib/data/realisation"
import { formatCount, parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { PageGuide } from "@/components/shell/page-slots"
import { RealisationTable, LeakageList } from "@/components/collections/realisation-table"
import { DownloadButton } from "@/components/collections/download-button"

export const metadata: Metadata = { title: "Fee realisation" }

type SearchParams = Record<string, string | string[] | undefined>

const SHOW = ["leakage", "under_billed", "untied"] as const
const SHOW_LABEL: Record<(typeof SHOW)[number], string> = { leakage: "Periods not invoiced", under_billed: "Billed under the agreed fee", untied: "Not tied to an engagement" }

/**
 * Fee realisation (§7.9.10): "Are we billing what we agreed, and collecting what we bill?" For the
 * selected FY so far: agreed (the fee in force each billing period), invoiced (fees net of credit
 * notes), collected (received + TDS), billing % and realisation %, per engagement; then the leakage
 * list, the ended periods of recurring engagements with no invoice, each a click from a new
 * invoice. Worked out in paise (lib/domain/realisation.ts) from what RLS lets the caller read.
 * Partners and Managers only (§4.1).
 */
export default async function FeeRealisationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const fy = await getSelectedFy()
  const today = todayIST()
  const asOf = compareDates(fyEnd(fy), today) < 0 ? fyEnd(fy) : today
  const t = parseTableParams(sp, { sortable: REALISATION_SORTS, defaultSort: { sort: "leakage", dir: "desc" }, filters: { show: SHOW } })

  let report: RealisationReport | null = null
  let ref: string | null = null
  try {
    report = await loadRealisation(supabase, fy, today)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/fee-realisation", userId: user.id })
  }

  const guide = (
    <PageGuide title="Fee realisation">
      <p>
        Agreed is the fee agreed on each engagement for every billing period of the year that has started (the fee in force then, if it changed). Invoiced is the fee on issued invoices, without
        GST or reimbursements, less credit notes. Collected is what came in against those fees, received plus TDS.
      </p>
      <p className="mt-2">Billing % is invoiced out of agreed; realisation % is collected out of invoiced. A period not invoiced is one that has ended with no invoice for the engagement; a draft counts.</p>
    </PageGuide>
  )

  if (!report) {
    return (
      <div className="flex min-w-0 flex-col">
        {guide}
        <PageHeader title="Fee realisation" description={`FY ${fy}`} />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't work out the fee realisation." errorRef={ref} />
        </div>
      </div>
    )
  }

  const r = report
  const show = t.filters.show ?? []
  const q = t.q.toLowerCase()
  const filtered = r.rows.filter((row) => {
    if (q && !`${row.clientName} ${row.clientCode} ${row.serviceLabel}`.toLowerCase().includes(q)) return false
    if (show.includes("leakage") && row.leakagePeriods === 0) return false
    if (show.includes("under_billed") && !(row.billingPercent !== null && row.billingPercent < 100)) return false
    if (show.includes("untied") && row.engagementId !== null) return false
    return true
  })
  const sorted = sortRealisationRows(filtered, (t.sort ?? "leakage") as RealisationSort, t.dir)
  const pageRows = sorted.slice(t.from, t.to + 1)
  const leakagePaise = r.leakage.reduce((s, l) => s + l.agreedPaise, 0)

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      {guide}
      <PageHeader
        title="Fee realisation"
        description={`FY ${fy} · as of ${formatDate(asOf)}`}
        className="pb-0 md:pb-0"
        actions={<DownloadButton href={`/fee-realisation/export?fy=${encodeURIComponent(fy)}`} label="Download Excel" fallbackName={`Fee-realisation-FY-${fy}.xlsx`} />}
      />
      <KpiStrip
        aria-label={`Fee realisation, FY ${fy}`}
        lead
        items={[
          { label: "Realisation", value: formatPercent(r.totals.realisationPercent), sub: <>collected <Money value={fromPaise(r.totals.collectedPaise)} /> of invoiced</> },
          { label: "Billing", value: formatPercent(r.totals.billingPercent), sub: <>invoiced <Money value={fromPaise(r.totals.invoicedPaise)} /> of agreed</> },
          { label: "Agreed so far", value: <Money value={fromPaise(r.totals.agreedPaise)} compact />, sub: `${formatCount(r.rows.filter((x) => x.engagementId).length)} engagements` },
          {
            label: "Not invoiced",
            value: <Money value={fromPaise(leakagePaise)} compact />,
            sub: `${formatCount(r.leakage.length)} ${r.leakage.length === 1 ? "period" : "periods"} ended without an invoice`,
            href: r.leakage.length ? "#leakage" : undefined,
          },
        ]}
      />
      <div className="flex min-w-0 flex-col">
        <FilterBar
          searchLabel="Search fee realisation"
          searchPlaceholder="Client, code or service"
          filters={[{ id: "show", label: "Show", options: SHOW.map((s) => ({ value: s, label: SHOW_LABEL[s] })) }]}
        />
        <RealisationTable rows={pageRows} total={filtered.length} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} fy={fy} filtered={Boolean(q) || show.length > 0} />
      </div>
      <SectionCard
        id="leakage"
        title="Periods not invoiced"
        description={r.leakage.length ? `${formatCount(r.leakage.length)} ${r.leakage.length === 1 ? "period" : "periods"} · ${formatINR(leakagePaise)} agreed and not billed` : "Ended periods of recurring engagements with no invoice."}
        flush
      >
        <LeakageList items={r.leakage} today={today} />
      </SectionCard>
    </div>
  )
}
