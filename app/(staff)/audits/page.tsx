import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { BookOpenCheckIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { AUDIT_STAGES, AUDIT_STAGE_LABELS, AUDIT_TYPES, AUDIT_TYPE_LABELS } from "@/lib/domain/audit-stages"
import { AUDIT_ATTENTION, AUDIT_ATTENTION_LABELS, AUDIT_LIST_FILTERS, AUDIT_LIST_SORTABLE, defaultAuditFy } from "@/lib/schemas/audits"
import { getAuditSummary, listAuditTeamOptions, listAudits } from "@/lib/data/audits"
import { formatCount, parseTableParams, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { AuditsTable } from "@/components/audits/audits-table"
import { NewAuditButton } from "@/components/audits/new-audit-button"
import { STAGE_CHIP } from "@/lib/schemas/audits"

export const metadata: Metadata = { title: "Audit engagements" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/audits:${source}`, userId }) }
  }
}

/**
 * Audit engagements (§6.9, §7.15.5): "Which audits need a decision, and is every final file
 * assembled within 60 days of its report?" The figures lead (each the count behind a filter), then
 * the list, searched, filtered and sorted in SQL. Partners and Managers only (§4.1); RLS gives
 * anyone else nothing.
 */
export default async function AuditsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: AUDIT_LIST_SORTABLE, defaultSort: { sort: "updated_at", dir: "desc" }, filters: AUDIT_LIST_FILTERS })
  const today = todayIST()
  const selectedFy = await getSelectedFy()

  const [list, summary, team] = await Promise.all([
    attempt("list", user.id, () => listAudits(supabase, t, { today })),
    attempt("summary", user.id, () => getAuditSummary(supabase, today)),
    attempt("team", user.id, () => listAuditTeamOptions(supabase)),
  ])

  const years = recentFinancialYears(today, 6)
  const partners = team.ok ? team.data.partners : []
  const reviewers = team.ok ? team.data.reviewers : []
  const filters: FilterDef[] = [
    { id: "stage", label: "Stage", options: AUDIT_STAGES.map((s) => ({ value: s, label: AUDIT_STAGE_LABELS[s], tone: STAGE_CHIP[s].tone })) },
    { id: "type", label: "Audit", options: AUDIT_TYPES.map((a) => ({ value: a, label: AUDIT_TYPE_LABELS[a] })) },
    { id: "year", label: "FY", multi: false, options: years.map((y) => ({ value: y, label: `FY ${y}` })) },
    ...(partners.length ? [{ id: "partner", label: "Engagement partner", multi: false, options: partners.map((p) => ({ value: p.value, label: p.label })) }] : []),
    { id: "attention", label: "Needs", multi: false, options: AUDIT_ATTENTION.map((a) => ({ value: a, label: AUDIT_ATTENTION_LABELS[a] })) },
  ]

  const s = summary.ok ? summary.data : null
  const count = (n: number | undefined) => (n === undefined ? "—" : formatCount(n))
  const description = list.ok
    ? `${formatCount(list.data.total)} ${list.data.total === 1 ? "engagement" : "engagements"} in this view, run to the Standards on Auditing.`
    : "Statutory, tax and other audits, each through seven stages with the engagement partner's approval."
  const newButton = (
    <NewAuditButton
      partners={partners}
      reviewers={reviewers}
      fyOptions={years}
      defaultFy={defaultAuditFy(years, selectedFy)}
      defaultPartnerId={user.role === "partner" ? user.employeeId : null}
    />
  )

  return (
    <div className="flex min-w-0 flex-col">
      {/* The sidebar keeps audits under Quality (lib/nav.ts); the top bar names the page itself. */}
      <ShellTitle crumbs={[{ label: "Practice" }, { label: "Quality", href: "/quality" }, { label: "Audit engagements" }]} />
      <PageGuide title="Audit engagements">
        <p>Each audit runs Acceptance, Planning, Risk assessment, Execution, Completion, Reporting and Archive. Every step of a stage is prepared, then reviewed by someone else, and the engagement partner approves the move to the next stage.</p>
        <p className="mt-2">Acceptance holds the engagement until the client&apos;s KYC is complete, the conflict check is accepted, the SA 210 letter is issued and, where another CA audited before, the letter to them is recorded with proof of delivery.</p>
        <p className="mt-2">The final file is assembled within 60 days of the report date (SA 230). Archiving locks it; anything added later is logged as an amendment, and the file is kept 7 years from the report date.</p>
      </PageGuide>
      <PageHeader title="Audit engagements" description={description} actions={newButton} />

      <KpiStrip
        className="mb-4"
        items={[
          { label: "Not archived", value: count(s?.open), sub: s ? "Work in progress" : "Couldn't load", href: tableHref("/audits", { filters: { attention: ["open"] } }) },
          { label: "At acceptance", value: count(s?.atAcceptance), sub: s ? (s.atAcceptance ? "Waiting on KYC, letters or checks" : "None waiting") : "Couldn't load", href: tableHref("/audits", { filters: { stage: ["acceptance"] } }) },
          { label: "File assembly due", value: count(s?.assemblyDue), sub: "In the next 14 days", href: tableHref("/audits", { filters: { attention: ["assembly_due"] } }) },
          { label: "Assembly overdue", value: count(s?.assemblyOverdue), sub: s ? (s.assemblyOverdue ? "Past 60 days from the report" : "None late") : "Couldn't load", href: tableHref("/audits", { filters: { attention: ["assembly_overdue"] } }) },
          { label: "Report signed, no UDIN", value: count(s?.noUdin), sub: "Link the UDIN (60 days)", href: tableHref("/audits", { filters: { attention: ["no_udin"] } }) },
        ]}
      />

      <FilterBar searchLabel="Search audit engagements" searchPlaceholder="Client, code, UDIN or partner" filters={filters} />

      {list.ok ? (
        <AuditsTable
          rows={list.data.rows}
          total={list.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          empty={<EmptyState icon={<BookOpenCheckIcon />} message="No audit engagements yet. Open one for a client's statutory, tax or other audit; it starts at Acceptance." action={newButton} />}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the audit engagements." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
