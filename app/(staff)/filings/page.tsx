import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { Grid3x3Icon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { currentFy, fyOptions, getSelectedFy, isSelectableFy } from "@/lib/fy-context"
import { previousFinancialYear, todayIST } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { formatCount, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { KpiStrip, type KpiItem } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { GRID_STATUS_FILTERS, GRID_STATUS_LABELS, UNASSIGNED, returnTypeByKey, type GridStatusFilter } from "@/lib/schemas/compliance"
import { getFilingsGrid, listOwnerOptions } from "@/lib/data/compliance"
import { loadComplianceEngine, loadHintContext } from "@/server/compliance/engine"
import { firmCoverageGaps } from "@/server/compliance/coverage-gaps"
import { columnCounts, eventsInColumn, focusColumn, gridColumns } from "@/components/compliance/logic/grid"
import { withParams } from "@/components/compliance/logic/urls"
import { FilingsGrid } from "@/components/compliance/filings-grid"
import { GridControls } from "@/components/compliance/grid-controls"
import { StatusLegend } from "@/components/compliance/status-mark"
import { FirmGapsReport } from "@/components/compliance/coverage-gaps"
import { EventSheetSlot } from "@/components/compliance/event-sheet-slot"
import { BulkReminderLauncher } from "@/components/bulk-queue"

export const metadata: Metadata = { title: "Filings" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/filings:${source}`, userId }) }
  }
}

/**
 * Filings (§7.7): "Is everyone's GSTR-3B filed for September?" in one glance. Rows are clients,
 * columns are periods (months, or quarters for QRMP, TDS returns and advance tax; one per form for
 * annual returns), each cell a status mark. Filter by return type, owner and FY (the top bar's FY
 * unless `?fy=` says otherwise); a cell opens its deadline with its task, filing record and
 * acknowledgement. The Coverage gaps view lists active services with nothing planned ahead, with
 * the one-click fix. Partners and Managers only (§4.1; Employees use the calendar for their own
 * clients), and the grid function refuses anyone else too.
 */
export default async function FilingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const today = todayIST()
  const view = readParam(sp, "view") === "gaps" ? "gaps" : "grid"
  const rawFy = readParam(sp, "fy")
  const fy = isSelectableFy(rawFy, today) ? rawFy : await getSelectedFy()
  const rt = returnTypeByKey(readParam(sp, "type"))
  const t = parseTableParams(sp, {
    filters: { owner: null, status: GRID_STATUS_FILTERS },
  })
  const owner = t.filters.owner?.[0] ?? null
  const status = (t.filters.status?.[0] ?? null) as GridStatusFilter | null
  const tabs = [
    { id: "grid", label: "Grid", href: withParams("/filings", sp, { view: null }, { resetPage: true }) },
    { id: "gaps", label: "Coverage gaps", href: withParams("/filings", sp, { view: "gaps" }, { resetPage: true }) },
  ]

  const guide = (
    <PageGuide title="Filings">
      <p>Each row is a client and each column a period. A mark shows where that return stands: not started, documents awaited, in progress, under review, filed, or overdue. A quarterly return spans its three months.</p>
      <p className="mt-2">The numbers under each period count every client, not just this page: filed of total, then overdue in red. Click a period to see its summary above the grid; click a mark to open the deadline with its task, filing record and acknowledgement.</p>
      <p className="mt-2">A red ring marks an unfiled GST return within six months of the three-year limit after which it can no longer be filed.</p>
    </PageGuide>
  )

  const header = (
    <>
      {guide}
      <PageHeader title="Filings" description={view === "gaps" ? "Active services with nothing planned ahead, and the one-click fix." : `${rt.label} for FY ${fy}. ${rt.description}`} />
      <nav aria-label="Filings views" className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <Link
                href={tab.href}
                scroll={false}
                aria-current={tab.id === view ? "page" : undefined}
                className={`relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11 ${tab.id === view ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text"}`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
  const sheet = <EventSheetSlot eventId={readParam(sp, "event")} user={user} supabase={supabase} closeHref={withParams("/filings", sp, {})} />

  if (view === "gaps") {
    const gaps = await attempt("gaps", user.id, async () => {
      const engine = await loadComplianceEngine(supabase, today)
      return firmCoverageGaps(supabase, engine, today)
    })
    return (
      <div className="flex min-w-0 flex-col">
        {header}
        {gaps.ok ? (
          <FirmGapsReport rows={gaps.data} canFix />
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <ErrorBlock message="Couldn't work out the coverage gaps." errorRef={gaps.ref} />
          </div>
        )}
        {sheet}
      </div>
    )
  }

  const [grid, owners] = await Promise.all([
    attempt("grid", user.id, () => getFilingsGrid(supabase, { fy, returnType: rt, owner, q: t.q, status, from: t.from, pageSize: t.pageSize })),
    attempt("owners", user.id, () => listOwnerOptions(supabase)),
  ])
  const ctxRules = await attempt("rules", user.id, async () => {
    const h = await loadHintContext(supabase, today)
    return { rules: [...h.filingBarRules], ...h.filingBar }
  })

  const filters: FilterDef[] = [
    {
      id: "owner",
      label: "Owner",
      multi: false,
      searchable: true,
      options: [{ value: UNASSIGNED, label: "No owner" }, ...(owners.ok ? owners.data.map((o) => ({ value: o.id, label: o.name })) : [])],
    },
    { id: "status", label: "Status", multi: false, options: GRID_STATUS_FILTERS.map((s) => ({ value: s, label: GRID_STATUS_LABELS[s] })) },
  ]

  const filtered = Boolean(t.q || owner || status)
  let body: React.ReactNode
  if (!grid.ok) {
    body = (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load the filings grid." errorRef={grid.ref} />
      </div>
    )
  } else {
    const g = grid.data
    const columns = gridColumns(rt.layout, fy, g.summary)
    const counts = columnCounts(rt.layout, fy, columns, g.summary, today)
    const requested = readParam(sp, "period")
    const idx = requested ? columns.findIndex((c) => c.key === requested) : -1
    const focus = idx >= 0 ? idx : focusColumn(counts, today)
    const c = counts[focus]
    const col = columns[focus]
    // §7.13.2 bulk reminders for the focused period: this page's returns not started or waiting on documents.
    const remindIds = col
      ? eventsInColumn(rt.layout, fy, columns, g.events, focus)
          .filter((e) => e.status === "pending" && (e.workflow_status === "not_started" || e.workflow_status === "documents_awaited"))
          .map((e) => e.id)
          .slice(0, 200)
      : []
    const kpis: KpiItem[] = col && c
      ? [
          { label: `Filed · ${col.name}`, value: <span>{formatCount(c.done)}<span className="text-text-muted"> /{formatCount(c.total)}</span></span>, sub: c.total ? `${Math.round((c.done / c.total) * 100)}% of ${c.total === 1 ? "the return" : "the returns"} due` : "Nothing due" },
          { label: "Overdue", value: <span className={c.overdue ? "text-danger-text" : undefined}>{formatCount(c.overdue)}</span>, sub: c.overdue ? "Past the due date, not filed" : "None past the due date", href: c.overdue ? withParams("/filings", sp, { status: "overdue" }, { resetPage: true }) : undefined },
          { label: "Under review", value: formatCount(c.review), sub: "Prepared, waiting for a reviewer" },
          { label: "Not started or in progress", value: formatCount(c.open), sub: c.firstDue ? `First due ${formatDate(c.firstDue)}` : "—" },
        ]
      : []

    const annualHint =
      rt.layout === "form" && fy === currentFy() ? (
        <p className="mb-3 text-sm text-text-muted">
          Annual returns for FY {previousFinancialYear(fy)} are the ones filed this year.{" "}
          <Link href={withParams("/filings", sp, { fy: previousFinancialYear(fy), period: null }, { resetPage: true })} className="text-primary hover:underline">
            Show FY {previousFinancialYear(fy)}
          </Link>
        </p>
      ) : null

    if (g.total === 0) {
      body = filtered ? (
        <div className="rounded-lg border border-border bg-surface">
          <FilteredEmpty message={`No clients with ${rt.label} in FY ${fy} match these filters.`} preserve={["type", "fy", "view"]} />
        </div>
      ) : (
        <>
          {annualHint}
          <div className="rounded-lg border border-border bg-surface">
            <EmptyState
              icon={<Grid3x3Icon />}
              message={`No ${rt.label} deadlines are planned for FY ${fy}. Plan them from each client's Compliance tab, or check the coverage gaps.`}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href={withParams("/filings", sp, { view: "gaps" }, { resetPage: true })}>Check coverage gaps</Link>
                </Button>
              }
            />
          </div>
        </>
      )
    } else {
      body = (
        <>
          {kpis.length ? <KpiStrip items={kpis} lead className="mb-4" aria-label={`Summary for ${col?.name ?? "the period"}`} /> : null}
          {annualHint}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <StatusLegend />
            {col ? (
              <BulkReminderLauncher
                source={remindIds.length ? { kind: "compliance_events", ids: remindIds } : { kind: "compliance_due" }}
                label={remindIds.length ? `Remind ${formatCount(remindIds.length)} on WhatsApp` : "Remind on WhatsApp"}
                title={`${rt.label} · ${col.name}: ask for the data`}
                disabled={remindIds.length === 0}
                disabledReason={`Nothing for ${col.name} on this page is waiting on the client.`}
              />
            ) : null}
          </div>
          <FilingsGrid
            layout={rt.layout}
            fy={fy}
            columns={columns}
            counts={counts}
            focus={focus}
            clients={g.clients}
            events={g.events}
            today={g.today || today}
            filingBar={ctxRules.ok ? ctxRules.data : { rules: [], years: 3, warnMonths: 6, fromPeriod: "2025-07-01" }}
            total={g.total}
            page={t.page}
            pageSize={t.pageSize}
            returnLabel={rt.label}
          />
          <p className="mt-2 text-sm text-text-muted">
            {formatCount(g.total)} {g.total === 1 ? "client" : "clients"} with {rt.label} in FY {fy}
            {filtered ? " for these filters" : ""}.
          </p>
        </>
      )
    }
  }

  return (
    <div className="flex min-w-0 flex-col">
      {header}
      <GridControls type={rt.key} fy={fy} fyOptions={fyOptions(today)} currentFy={currentFy()} />
      <FilterBar searchLabel="Search clients" searchPlaceholder="Client name, code or GSTIN" filters={filters} />
      {body}
      {sheet}
    </div>
  )
}
