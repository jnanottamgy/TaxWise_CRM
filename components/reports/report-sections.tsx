import { cn } from "@/lib/utils"
import { fromPaise } from "@/lib/domain/money"
import { formatNumber } from "@/lib/format"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { KpiStrip } from "@/components/app/kpi-strip"
import { FullValueHint } from "@/components/app/full-value-hint"
import { ReportTable } from "@/components/reports/report-table"
import { ReportChart } from "@/components/reports/report-chart"
import { ReportPager } from "@/components/reports/report-pager"
import { reportCellText, type ReportKpi, type ReportResult, type ReportSection } from "@/components/reports/report-types"

function KpiValue({ k, lead }: { k: ReportKpi; lead: boolean }) {
  if (k.value === null || k.value === undefined) return <span className="text-text-muted">—</span>
  if (k.kind === "money" && typeof k.value === "number") {
    const full = reportCellText("money", k.value)
    const short = reportCellText("money", k.value, { compact: true })
    return short === full ? <span>{full}</span> : <FullValueHint short={short} full={full} className={cn("num tabular-nums", lead && "")} />
  }
  return <span>{reportCellText(k.kind, k.value)}</span>
}

/** The headline figures as type (DESIGN.md §3): the first is the report's answer. */
export function ReportKpis({ report }: { report: ReportResult }) {
  return (
    <KpiStrip
      lead
      aria-label={`${report.title}: headline figures`}
      items={report.kpis.map((k, i) => ({ label: k.label, value: <KpiValue k={k} lead={i === 0} />, sub: k.sub ?? undefined, href: k.href ?? undefined }))}
    />
  )
}

function chartData(s: ReportSection): Array<{ x: string; y: number }> {
  if (!s.chart) return []
  const c = s.chart
  return s.rows.map((r) => {
    const x = r[c.x]
    const y = r[c.y]
    return { x: typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? x.text : String(x ?? ""), y: typeof y === "number" ? (c.format === "money" ? fromPaise(y) : y) : 0 }
  })
}

function ReportSectionCard({ s }: { s: ReportSection }) {
  const data = chartData(s)
  const showChart = s.chart && s.rows.length > 1 && data.some((d) => d.y !== 0)
  const countNote = s.total !== undefined && s.total > s.rows.length && !s.pager ? `${formatNumber(s.rows.length)} of ${formatNumber(s.total)}` : null
  return (
    <SectionCard
      id={`report-${s.id}`}
      title={s.title}
      description={s.description}
      action={countNote ? <span className="num text-sm text-text-muted tabular-nums">{countNote}</span> : undefined}
      viewAll={s.more ? { href: s.more.href, label: s.more.label } : undefined}
      flush
      className="h-full"
    >
      {s.rows.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" message={s.empty} />
        </div>
      ) : (
        <>
          {showChart && s.chart ? (
            <ReportChart
              data={data}
              label={s.chart.label}
              format={s.chart.format}
              summary={s.chart.summary ?? `${s.chart.label} by ${s.chart.xLabel.toLowerCase()}: ${data.map((d) => `${d.x} ${s.chart?.format === "money" ? `₹${formatNumber(d.y)}` : formatNumber(d.y)}`).join(", ")}.`}
            />
          ) : null}
          <div className={cn(showChart && "border-t border-border")}>
            <ReportTable columns={s.columns} rows={s.rows} totals={s.totals} caption={s.title} />
          </div>
          {s.pager && s.pager.total > 0 ? <ReportPager page={s.pager.page} pageSize={s.pager.pageSize} total={s.pager.total} /> : null}
        </>
      )}
    </SectionCard>
  )
}

/**
 * The report's sections in a 12-column grid: full-width sections span it, half-width ones pair up
 * on a wide screen (each pair shares its bottom edge) and stack on a phone.
 */
export function ReportSections({ report }: { report: ReportResult }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {report.sections.map((s, i) => {
        const prevHalf = i > 0 && report.sections[i - 1].half
        const nextHalf = i < report.sections.length - 1 && report.sections[i + 1].half
        // A half section without a partner takes the full width rather than leave a hole beside it.
        const pairedIndex = report.sections.slice(0, i).filter((x) => x.half).length
        const paired = s.half && ((pairedIndex % 2 === 0 && nextHalf) || (pairedIndex % 2 === 1 && prevHalf))
        return (
          <div key={s.id} className={cn("min-w-0", paired ? "lg:col-span-6" : "lg:col-span-12")}>
            <ReportSectionCard s={s} />
          </div>
        )
      })}
    </div>
  )
}
