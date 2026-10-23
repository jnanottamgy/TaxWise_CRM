import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { ACCEPTANCE_FILTERS, ACCEPTANCE_SORTABLE, getAcceptanceSummary, listAcceptances } from "@/lib/data/acceptance"
import { getLeadSummary } from "@/lib/data/leads"
import { getQuotationSummary } from "@/lib/data/quotations"
import { GrowthSubnav } from "@/components/leads/growth-subnav"
import { AcceptancesTable } from "@/components/acceptance/acceptances-table"
import { AcceptanceExportButton } from "@/components/acceptance/acceptance-export"
import { DateRangeFilter } from "@/components/acceptance/date-range-filter"
import { NewConflictCheckButton } from "@/components/acceptance/new-check-button"

export const metadata: Metadata = { title: "Client acceptance" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/acceptance:${source}`, userId }) }
  }
}

const OUTCOME_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
]
const CONFLICT_OPTIONS = [
  { value: "with", label: "Matches found" },
  { value: "none", label: "No matches" },
]

/**
 * The client acceptance register (§7.5.4): every conflict check, its matches (frozen at the
 * decision), the decision (Accept, Decline or Pending) with its rationale and decider, and the lead
 * or client it belongs to. Filters: outcome, matches, and the date checked. A new check can be run
 * here for a prospect who isn't a lead yet. Partners and Managers only (§4.1).
 */
export default async function AcceptancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: ACCEPTANCE_SORTABLE, defaultSort: { sort: "created_at", dir: "desc" }, filters: ACCEPTANCE_FILTERS })
  const isFiltered = Boolean(t.q) || Object.values(t.filters).some((v) => Array.isArray(v) && v.length > 0) || Boolean(readParam(sp, "from") || readParam(sp, "to"))

  const [list, summary, leadSummary, quotationSummary] = await Promise.all([
    attempt("list", user.id, () => listAcceptances(supabase, t)),
    attempt("summary", user.id, () => getAcceptanceSummary(supabase)),
    attempt("lead-summary", user.id, () => getLeadSummary(supabase)),
    attempt("quotation-summary", user.id, () => getQuotationSummary(supabase)),
  ])

  const filters: FilterDef[] = [
    { id: "outcome", label: "Decision", options: OUTCOME_OPTIONS },
    { id: "conflicts", label: "Matches", options: CONFLICT_OPTIONS, multi: false },
  ]
  const s = summary.ok ? summary.data : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Client acceptance">
        <p>Before taking on a client, and always for audit work, run the conflict check. It looks for the same PAN or GSTIN, the same or a close name, and overlapping directors, partners and related parties across clients, leads and contacts.</p>
        <p className="mt-2">Record Accept, Decline or Pending. Declining, or accepting despite a match, needs a rationale. The matches are frozen with the decision, so the register shows what was known at the time.</p>
      </PageGuide>
      <GrowthSubnav
        active="acceptance"
        counts={{
          leads: leadSummary.ok && leadSummary.data.followUpsDue ? { n: leadSummary.data.followUpsDue, label: "follow-ups due" } : null,
          quotations: quotationSummary.ok && quotationSummary.data.pendingApproval ? { n: quotationSummary.data.pendingApproval, label: "waiting for approval" } : null,
          acceptance: s?.pending ? { n: s.pending, label: "pending a decision" } : null,
        }}
      />
      <PageHeader
        title="Client acceptance"
        description={s ? `${formatNumber(s.total)} ${s.total === 1 ? "check" : "checks"} · ${formatNumber(s.pending)} pending a decision` : "Conflict checks and acceptance decisions."}
        actions={<NewConflictCheckButton />}
      />
      {s ? (
        <KpiStrip
          className="mb-4"
          aria-label="The register at a glance"
          items={[
            { label: "Pending a decision", value: formatNumber(s.pending), sub: "Checked, not yet decided", href: "/acceptance?outcome=pending" },
            { label: "Accepted", value: formatNumber(s.accepted), href: "/acceptance?outcome=accepted" },
            { label: "Declined", value: formatNumber(s.declined), href: "/acceptance?outcome=declined" },
            { label: "With matches", value: formatNumber(s.withConflicts), sub: "At least one match found", href: "/acceptance?conflicts=with" },
          ]}
        />
      ) : null}
      <FilterBar
        searchLabel="Search the register"
        searchPlaceholder="Prospect, PAN, GSTIN, lead, client or rationale"
        filters={filters}
        actions={<DateRangeFilter />}
        exportSlot={<AcceptanceExportButton />}
      />
      {list.ok ? (
        <AcceptancesTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} isFiltered={isFiltered} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the acceptance register." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
