import type { Metadata } from "next"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy } from "@/lib/fy-context"
import { todayIST } from "@/lib/domain/fy"
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { REPORT_FILTER_LABEL, REPORT_META, defaultReportPeriod, isReportSlug, parseReportFilters, reportQueryString } from "@/lib/schemas/reports"
import { loadReport } from "@/server/reports"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { PeriodPicker } from "@/components/reports/period-picker"
import { ClientFilter } from "@/components/reports/client-filter"
import { ReportExportMenu } from "@/components/reports/report-export-menu"
import { ReportKpis, ReportSections } from "@/components/reports/report-sections"
import { reportPeriodPresets, yearPresets } from "@/components/reports/presets"
import { REPORT_GUIDE } from "@/components/reports/report-guide"

type SearchParams = Record<string, string | string[] | undefined>
type Params = { slug: string }

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params
  return { title: isReportSlug(slug) ? `${REPORT_META[slug].title} report` : "Reports" }
}

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/reports:${source}`, userId }) }
  }
}

/**
 * One report of the reports centre (§7.16). Its title and, under it, the one line on what it counts;
 * the period (the FY in the top bar by default) and the filters it takes; the headline figures; then
 * its sections, each a table with its totals (and a chart where a trend helps). Excel and PDF of the
 * same figures, every row. Partners and Managers only (§4.1): an Employee is refused here, by the
 * export route and by every report function in the database.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const { slug } = await params
  if (!isReportSlug(slug)) notFound()
  const sp = await searchParams
  const meta = REPORT_META[slug]
  const today = todayIST()
  const selectedFy = await getSelectedFy()
  const f = parseReportFilters(sp, slug, { selectedFy, today })
  const takes = (k: (typeof meta.filters)[number]) => meta.filters.includes(k)

  const [report, people] = await Promise.all([
    attempt(slug, user.id, () => loadReport(supabase, f, { today, forExport: false })),
    takes("owner") || takes("employee")
      ? attempt("people", user.id, async () => {
          const { data, error } = await supabase
            .from("employees")
            .select("id, full_name, is_active, staff_role")
            .is("deleted_at", null)
            .in("staff_role", ["partner", "manager", "employee"])
            .order("full_name", { ascending: true })
            .limit(500)
          if (error) throw error
          return (data ?? []).map((p) => ({ value: p.id, label: p.is_active ? p.full_name : `${p.full_name} (disabled)` }))
        })
      : Promise.resolve({ ok: true as const, data: [] as Array<{ value: string; label: string }> }),
  ])

  const filters: FilterDef[] = []
  if (takes("owner") && people.ok) filters.push({ id: "owner", label: REPORT_FILTER_LABEL.owner, multi: false, searchable: people.data.length > 7, options: people.data })
  if (takes("service")) filters.push({ id: "service", label: REPORT_FILTER_LABEL.service, multi: false, options: SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] })) })
  if (takes("employee") && people.ok) filters.push({ id: "employee", label: meta.employeeLabel ?? REPORT_FILTER_LABEL.employee, multi: false, searchable: people.data.length > 7, options: people.data })

  const base = defaultReportPeriod(selectedFy, today)
  const clientLabel = report.ok ? (report.data.scope.find((s) => s.startsWith("Client: "))?.slice(8) ?? null) : null
  const query = reportQueryString(f)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ShellTitle crumbs={[{ label: "Reports", href: "/reports" }, { label: meta.title }]} />
      <PageGuide title={`${meta.title} report`}>{REPORT_GUIDE[slug]}</PageGuide>
      <PageHeader
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: meta.title }]}
        title={`${meta.title} report`}
        description={meta.counts}
        actions={<ReportExportMenu slug={slug} query={query} />}
        className="pb-0 md:pb-0"
      />

      <FilterBar
        hideSearch
        searchLabel={`${meta.title} report filters`}
        filters={filters}
        className="pb-0"
        actions={
          <>
            <PeriodPicker
              from={f.from}
              to={f.to}
              presets={meta.period === "fy" ? yearPresets(today) : reportPeriodPresets(today)}
              isDefault={f.defaultPeriod}
              defaultLabel={meta.period === "fy" ? `FY ${selectedFy}` : base.to === today ? `FY ${selectedFy} to date` : `FY ${selectedFy}`}
              max={meta.period === "fy" ? undefined : today}
              allowCustom={meta.period !== "fy"}
              label={meta.period === "fy" ? "Year" : "Period"}
            />
            {takes("client") ? <ClientFilter value={f.clientId} label={clientLabel} /> : null}
          </>
        }
      />
      {f.periodError ? (
        <p role="status" className="text-sm text-warning-text">
          {f.periodError}
        </p>
      ) : null}

      {report.ok ? (
        <>
          <p className="-mt-1 text-sm text-text-muted">
            <span className="num">{report.data.period.label}</span>
            {report.data.scope.length ? ` · ${report.data.scope.join(" · ")}` : " · The whole firm"}
          </p>
          <ReportKpis report={report.data} />
          <ReportSections report={report.data} />
        </>
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message={`Couldn't prepare the ${meta.title.toLowerCase()} report.`} errorRef={report.ref} />
        </div>
      )}
    </div>
  )
}
