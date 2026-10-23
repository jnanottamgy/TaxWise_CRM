import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FileTextIcon, TargetIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { statusOptions } from "@/lib/status"
import { formatCount, parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { LEAD_FILTERS, LEAD_FLAGS, LEAD_FLAG_LABELS, LEAD_SORTABLE, analyticsPeriod, parseLeadView } from "@/lib/schemas/leads"
import { getLeadAnalytics, getLeadBoard, getLeadSummary, listLeads } from "@/lib/data/leads"
import { getQuotationSummary } from "@/lib/data/quotations"
import { listStaffOptions } from "@/lib/data/clients"
import { GrowthSubnav } from "@/components/leads/growth-subnav"
import { LeadViewTabs } from "@/components/leads/lead-view-tabs"
import { LeadBoard } from "@/components/leads/lead-board"
import { LeadsTable } from "@/components/leads/leads-table"
import { LeadAnalyticsView } from "@/components/leads/lead-analytics"
import { PeriodPicker } from "@/components/leads/period-picker"
import { NewLeadButton } from "@/components/leads/lead-form-dialog"
import { LeadExportButton } from "@/components/leads/lead-export"

export const metadata: Metadata = { title: "Leads" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/leads:${source}`, userId }) }
  }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null

/**
 * Leads (§7.5.1): the pipeline board (columns = stages; drag to move, a reason for Lost), the table,
 * and the analytics (by source and stage, conversion, days to win, pipeline value, win/loss
 * reasons). Partners and Managers only: an Employee is refused here and by RLS (§4.1). `?new=1`
 * opens the new-lead form (the "+ New" menu links there).
 */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const view = parseLeadView(sp.view)
  const t = parseTableParams(sp, { sortable: LEAD_SORTABLE, defaultSort: { sort: "last_activity_at", dir: "desc" }, filters: LEAD_FILTERS })
  const now = new Date()
  const fy = await getSelectedFy()
  const period = analyticsPeriod({ period: one(sp.period), from: one(sp.from), to: one(sp.to) }, todayIST(now), fy)

  const [summary, quoteSummary, staff, board, table, analytics] = await Promise.all([
    attempt("summary", user.id, () => getLeadSummary(supabase)),
    attempt("quotation-summary", user.id, () => getQuotationSummary(supabase)),
    attempt("staff", user.id, () => listStaffOptions(supabase, user.role)),
    view === "board" ? attempt("board", user.id, () => getLeadBoard(supabase, t)) : Promise.resolve(null),
    view === "table" ? attempt("table", user.id, () => listLeads(supabase, t)) : Promise.resolve(null),
    view === "analytics" ? attempt("analytics", user.id, () => getLeadAnalytics(supabase, period.from, period.to)) : Promise.resolve(null),
  ])

  const assignable = staff.ok ? staff.data.filter((s) => s.role === "partner" || s.role === "manager").map((s) => ({ value: s.id, label: s.name })) : []
  const filters: FilterDef[] = [
    ...(view === "board" ? [] : [{ id: "status", label: "Stage", options: statusOptions("lead_status") }]),
    { id: "source", label: "Source", options: LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] })) },
    { id: "service", label: "Service", options: SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] })) },
    { id: "assigned", label: "Assigned to", options: [{ value: "none", label: "Not assigned" }, ...assignable], searchable: true },
    { id: "flag", label: "Needs attention", options: LEAD_FLAGS.map((f) => ({ value: f, label: LEAD_FLAG_LABELS[f] })) },
  ]

  const s = summary.ok ? summary.data : null
  const description = s
    ? [
        `${formatCount(s.open)} open ${s.open === 1 ? "lead" : "leads"}`,
        s.followUpsDue ? `${formatCount(s.followUpsDue)} follow-ups due` : null,
        s.stale ? `${formatCount(s.stale)} untouched for 14 days` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Prospects, the quotations sent to them and what was accepted."

  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v)
  const boardViewAll = Object.fromEntries(
    (board && board.ok ? board.data : []).map((c) => {
      const p = new URLSearchParams(params.toString())
      p.set("view", "table")
      p.set("status", c.status)
      p.delete("page")
      p.delete("new")
      return [c.status, `/leads?${p.toString()}`]
    }),
  )
  const filtered = Boolean(t.q) || Object.keys(t.filters).length > 0
  const boardEmpty = board && board.ok && board.data.every((c) => c.total === 0)

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Leads">
        <p>Every enquiry is a lead. Move it along the pipeline as you talk to them: drag a card to another stage, or use its menu. Moving a lead to Lost asks why, so the win/loss analysis is useful.</p>
        <p className="mt-2">From a lead you can log calls and notes, send a WhatsApp or Gmail draft, run the conflict check, prepare a quotation and, once they agree, convert it to a client. A reminder comes up at the next follow-up time, and a lead nobody has touched for 14 days is flagged.</p>
      </PageGuide>
      <GrowthSubnav
        active="leads"
        counts={{
          leads: s?.followUpsDue ? { n: s.followUpsDue, label: "follow-ups due" } : null,
          quotations: quoteSummary.ok && quoteSummary.data.pendingApproval ? { n: quoteSummary.data.pendingApproval, label: "waiting for approval" } : null,
        }}
      />
      <PageHeader
        title="Leads"
        description={description}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/quotations/new">
                <FileTextIcon aria-hidden="true" />
                New quotation
              </Link>
            </Button>
            <NewLeadButton staff={assignable} defaultOpen={one(sp.new) === "1"} />
          </>
        }
      />
      <div className="flex flex-col gap-3 pb-1">
        <LeadViewTabs active={view} params={params} />
      </div>

      {view === "analytics" ? (
        <div className="mt-3">
          <PeriodPicker preset={period.preset} from={period.from} to={period.to} />
          {analytics && analytics.ok ? (
            <LeadAnalyticsView a={analytics.data} />
          ) : (
            <div className="rounded-lg border border-border bg-surface">
              <ErrorBlock message="Couldn't load the analytics." errorRef={analytics && !analytics.ok ? analytics.ref : null} />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <FilterBar
            searchLabel="Search leads"
            searchPlaceholder="Name, company, email, phone or number"
            filters={filters}
            exportSlot={view === "table" ? <LeadExportButton /> : null}
          />
          {view === "board" ? (
            board && board.ok ? (
              boardEmpty && !filtered ? (
                <div className="rounded-lg border border-border bg-surface">
                  <EmptyState icon={<TargetIcon />} message="No leads yet. Add the first enquiry to start the pipeline." action={<NewLeadButton staff={assignable} size="sm" />} />
                </div>
              ) : boardEmpty ? (
                <div className="rounded-lg border border-border bg-surface">
                  <FilteredEmpty />
                </div>
              ) : (
                <LeadBoard columns={board.data} now={now.toISOString()} viewAllHref={boardViewAll} />
              )
            ) : (
              <div className="rounded-lg border border-border bg-surface">
                <ErrorBlock message="Couldn't load the pipeline." errorRef={board && !board.ok ? board.ref : null} />
              </div>
            )
          ) : table && table.ok ? (
            <LeadsTable rows={table.data.rows} total={table.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} now={now.toISOString()} emptyAction={<NewLeadButton staff={assignable} size="sm" />} />
          ) : (
            <div className="rounded-lg border border-border bg-surface">
              <ErrorBlock message="Couldn't load the leads." errorRef={table && !table.ok ? table.ref : null} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
