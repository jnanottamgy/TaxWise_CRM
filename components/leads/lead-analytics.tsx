import Link from "next/link"
import { KpiStrip } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { EmptyState } from "@/components/app/empty-state"
import { formatDate, formatNumber } from "@/lib/format"
import { fromPaise } from "@/lib/domain/money"
import { LEAD_SOURCE_LABELS, LEAD_STATUSES } from "@/lib/domain/enums"
import { conversionRate, lostCategoryLabel } from "@/lib/schemas/leads"
import type { LeadAnalytics } from "@/lib/data/leads"

/**
 * Leads analytics (§7.5.1): conversion rate (won ÷ closed), average days to win, pipeline value
 * (the open quotations' totals), then leads by source and by stage, why leads were lost, and why
 * quotations were declined, for the chosen period. Figures as type, tables with numbers right-aligned;
 * every proportion is also a number (no chart without its table). Server-safe.
 */
export function LeadAnalyticsView({ a }: { a: LeadAnalytics }) {
  const conv = conversionRate(a.won, a.lost)
  const maxSource = Math.max(1, ...a.bySource.map((s) => s.total))
  const stages = LEAD_STATUSES.map((s) => a.byStage.find((x) => x.status === s) ?? { status: s, total: 0, estimatedValuePaise: 0 })
  const maxStage = Math.max(1, ...stages.map((s) => s.total))
  const period = `${formatDate(a.from)} to ${formatDate(a.to)}`

  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        lead
        aria-label="Pipeline results"
        items={[
          {
            label: "Conversion (won ÷ closed)",
            value: conv.rate === null ? "—" : `${conv.rate}%`,
            sub: conv.rate === null ? "No lead closed in this period" : `${formatNumber(a.won)} won of ${formatNumber(a.won + a.lost)} closed`,
            href: "/leads?view=table&status=won,lost",
          },
          {
            label: "Average days to win",
            value: a.avgDaysToWin === null ? "—" : formatNumber(a.avgDaysToWin, { maxDecimals: 1 }),
            sub: a.avgDaysToWin === null ? "No lead won in this period" : "From the lead being added to Won",
          },
          {
            label: "Pipeline value",
            value: <Money value={fromPaise(a.pipeline.openValuePaise)} compact />,
            sub: `${formatNumber(a.pipeline.openCount)} open ${a.pipeline.openCount === 1 ? "quotation" : "quotations"}, incl. GST`,
            href: "/quotations?status=pending_approval,approved,sent,viewed",
          },
          {
            label: "Leads added",
            value: formatNumber(a.leadsCreated),
            sub: `${formatNumber(a.quotations.sent)} quotations sent · ${formatNumber(a.quotations.accepted)} accepted`,
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Leads by source" description={`Added ${period}`} flush>
          {a.bySource.length === 0 ? (
            <EmptyState size="compact" message="No leads were added in this period." className="mx-4 mb-4 md:mx-5" />
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[34rem] text-base">
                <caption className="sr-only">Leads by source</caption>
                <thead>
                  <tr className="border-y border-border text-left text-sm text-text-muted">
                    <th scope="col" className="px-4 py-2 font-normal md:px-5">Source</th>
                    <th scope="col" className="px-2 py-2 text-right font-normal">Leads</th>
                    <th scope="col" className="px-2 py-2 text-right font-normal">Won</th>
                    <th scope="col" className="px-2 py-2 text-right font-normal">Lost</th>
                    <th scope="col" className="px-2 py-2 text-right font-normal">Open</th>
                    <th scope="col" className="px-4 py-2 text-right font-normal md:px-5">Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {a.bySource.map((s) => {
                    const c = conversionRate(s.won, s.lost)
                    return (
                      <tr key={s.source} className="border-b border-border/70 last:border-b-0">
                        <th scope="row" className="px-4 py-2 text-left font-normal md:px-5">
                          <Link href={`/leads?view=table&source=${s.source}`} className="text-text hover:underline">
                            {LEAD_SOURCE_LABELS[s.source] ?? s.source}
                          </Link>
                          <span aria-hidden="true" className="mt-1 block h-0.5 rounded-full bg-text-muted/40" style={{ width: `${Math.max(4, (s.total / maxSource) * 100)}%` }} />
                        </th>
                        <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(s.total)}</td>
                        <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(s.won)}</td>
                        <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(s.lost)}</td>
                        <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(s.open)}</td>
                        <td className="num px-4 py-2 text-right tabular-nums md:px-5">{c.rate === null ? <span className="text-text-muted">—</span> : `${c.rate}%`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Leads by stage" description={`Where the leads added ${period} are now`} flush>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[26rem] text-base">
              <caption className="sr-only">Leads by stage</caption>
              <thead>
                <tr className="border-y border-border text-left text-sm text-text-muted">
                  <th scope="col" className="px-4 py-2 font-normal md:px-5">Stage</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Leads</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal md:px-5">Est. value / yr</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((s) => (
                  <tr key={s.status} className="border-b border-border/70 last:border-b-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal md:px-5">
                      <StatusChip kind="lead_status" value={s.status} />
                      <span aria-hidden="true" className="mt-1 block h-0.5 rounded-full bg-text-muted/40" style={{ width: `${s.total ? Math.max(4, (s.total / maxStage) * 100) : 0}%` }} />
                    </th>
                    <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(s.total)}</td>
                    <td className="num px-4 py-2 text-right tabular-nums md:px-5">
                      <Money value={fromPaise(s.estimatedValuePaise)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard title="Why leads were lost" description={`Closed as Lost ${period}`} flush>
          {a.lossReasons.length === 0 ? (
            <EmptyState size="compact" message="No lead was lost in this period." className="mx-4 mb-4 md:mx-5" />
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border">
              {a.lossReasons.map((l) => (
                <li key={l.category} className="flex items-start gap-4 px-4 py-2.5 md:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-text">{lostCategoryLabel(l.category)}</p>
                    {l.examples.length ? <p className="mt-0.5 line-clamp-2 text-sm text-text-muted">{l.examples.map((e) => `“${e}”`).join(" · ")}</p> : null}
                  </div>
                  <span className="num flex-none text-base tabular-nums">{formatNumber(l.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Why quotations were declined" description={`The client's reason, ${period}`} flush>
          {a.declineReasons.length === 0 ? (
            <EmptyState size="compact" message="No quotation was declined in this period." className="mx-4 mb-4 md:mx-5" />
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border">
              {a.declineReasons.map((d) => (
                <li key={d.id} className="flex items-start gap-4 px-4 py-2.5 md:px-5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/quotations/${d.id}`} className="text-base text-text hover:underline">
                      {d.client}
                    </Link>
                    <p className="mt-0.5 line-clamp-2 text-sm text-text-muted">{d.reason ? `“${d.reason}”` : "No reason given"}</p>
                  </div>
                  <span className="flex flex-none flex-col items-end text-sm text-text-muted">
                    <span className="font-mono text-xs">{d.quotationNumber}</span>
                    <span className="num tabular-nums">{formatDate(d.respondedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
