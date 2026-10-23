import type { Metadata } from "next"
import { requireClient } from "@/lib/auth/guards"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { periodShort } from "@/lib/domain/portal-copy"
import {
  COMPLIANCE_GROUP_LABEL,
  COMPLIANCE_GROUPS,
  COMPLIANCE_PROGRESS_FILTER,
  COMPLIANCE_SORTS,
  resolveFy,
  type ComplianceGroup,
} from "@/lib/schemas/portal"
import { getFilingSummary, listComplianceYears, listFilings, listOtherFilings } from "@/lib/data/portal"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { CopyButton } from "@/components/app/copy-button"
import { attempt } from "@/components/portal/load"
import { PortalBlockError } from "@/components/portal/portal-ui"
import { ViewTabs } from "@/components/portal/view-tabs"
import { UrlSelect } from "@/components/portal/url-select"
import { FilingsTable } from "@/components/portal/tables"

export const metadata: Metadata = { title: "Compliance" }

const OTHER_LIMIT = 50

const STATUS_OPTIONS = [
  { value: "filed", label: "Filed" },
  { value: "overdue", label: "Overdue" },
  { value: "waiting_on_you", label: "Documents awaited" },
  { value: "in_progress", label: "In progress" },
  { value: "not_started", label: "Not started" },
  { value: "cancelled", label: "Cancelled" },
]

/**
 * Compliance (§7.22): "Is everything filed for this year?" Filing status by period for the chosen
 * FY: every return and deadline, where it stands, when it was filed and its acknowledgement number;
 * the acknowledgement downloads when the firm marked it shareable. Below, filings on record that no
 * deadline covers (for example inherited from a previous accountant). Read through
 * portal_compliance_events and portal_filing_records only (0175); paged, sorted and filtered in SQL.
 */
export default async function PortalCompliancePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const sp = await props.searchParams
  const today = todayIST()
  const currentFy = financialYearOf(today)
  const fy = resolveFy(readParam(sp, "fy"), currentFy)
  const t = parseTableParams(sp, {
    sortable: COMPLIANCE_SORTS,
    defaultSort: { sort: "due_date", dir: "asc" },
    filters: { group: COMPLIANCE_GROUPS, status: COMPLIANCE_PROGRESS_FILTER },
  })
  const group = (t.filters.group?.[0] ?? null) as ComplianceGroup | null
  const status = t.filters.status?.[0] ?? null

  const [filings, summary, years, other] = await Promise.all([
    attempt("compliance:filings", user.id, () =>
      listFilings(supabase, { fy, group, progress: status, sort: (t.sort ?? "due_date") as "due_date" | "form_code" | "filed_on", dir: t.dir, from: t.from, to: t.to }),
    ),
    attempt("compliance:summary", user.id, () => getFilingSummary(supabase, fy)),
    attempt("compliance:years", user.id, () => listComplianceYears(supabase)),
    attempt("compliance:other", user.id, () => listOtherFilings(supabase, { fy, from: 0, to: OTHER_LIMIT - 1 })),
  ])

  const yearOptions = [...new Set([currentFy, ...(years.ok ? years.data : []), fy])].sort().reverse().map((y) => ({ value: y, label: `FY ${y}` }))
  const base = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams()
    if (fy !== currentFy) next.set("fy", fy)
    if (status) next.set("status", status)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    const qs = next.toString()
    return qs ? `/portal/compliance?${qs}` : "/portal/compliance"
  }
  const tabs = [
    { href: base({ group: null }), label: "All", active: group === null },
    ...COMPLIANCE_GROUPS.map((g) => ({ href: base({ group: g }), label: COMPLIANCE_GROUP_LABEL[g], active: group === g })),
  ]

  const s = summary.ok ? summary.data : null
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Compliance"
        description={
          s
            ? s.total === 0
              ? `Nothing is planned for FY ${fy} yet.`
              : `FY ${fy}: ${s.filed} of ${s.total} filed${s.overdue ? ` · ${s.overdue} overdue` : ""}.`
            : `Filing status for FY ${fy}, with acknowledgement numbers.`
        }
        actions={<UrlSelect param="fy" value={fy} options={yearOptions} label="Financial year" />}
      />

      {s ? (
        <KpiStrip
          aria-label={`FY ${fy} at a glance`}
          className="mb-4 md:mb-6"
          items={[
            { label: "Returns and deadlines", value: s.total, sub: `FY ${fy}` },
            { label: "Filed", value: s.filed, href: base({ status: "filed" }) },
            { label: "Still to file", value: s.pending, href: "/portal/deadlines" },
            { label: "Overdue", value: s.overdue, sub: s.overdue ? "Late fees may apply" : "None", href: s.overdue ? base({ status: "overdue" }) : undefined },
          ]}
        />
      ) : null}

      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <ViewTabs label="Type of return" items={tabs} />
        <UrlSelect param="status" value={status ?? ""} options={STATUS_OPTIONS} label="Status" emptyLabel="Any status" />
      </div>

      {!filings.ok ? (
        <PortalBlockError title="Filing status" message="Couldn't load your filing status." errorRef={filings.ref} />
      ) : (
        <FilingsTable
          rows={filings.data.rows}
          total={filings.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          isFiltered={Boolean(group || status)}
        />
      )}

      {other.ok ? (
        other.data.total > 0 ? (
          <SectionCard
            title="Other filings on record"
            description={`Filed for FY ${fy} without a deadline in the portal, including any by your previous accountant.`}
            className="mt-4 md:mt-6"
            flush
          >
            <ul className="divide-y divide-border/70 px-4 pb-2 md:px-5">
              {other.data.rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-text">
                      {r.filingType}
                      {r.period ? <span className="font-normal text-text-muted"> · {periodShort(r.period)}</span> : null}
                    </p>
                    <p className="text-sm text-text-muted">
                      {r.filedOn ? `Filed ${formatDate(r.filedOn)}` : "Filing date not recorded"}
                      {r.isExternal ? ` by ${r.filedByExternal ?? "your previous accountant"}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-3 text-sm">
                    {r.acknowledgementNo ? (
                      <span className="inline-flex items-center gap-1 text-text">
                        <span className="num tabular-nums">{r.acknowledgementNo}</span>
                        <CopyButton value={r.acknowledgementNo} label="acknowledgement number" />
                      </span>
                    ) : null}
                    {r.acknowledgementDocumentId ? (
                      <a href={`/api/files/documents/${r.acknowledgementDocumentId}`} className="font-medium text-primary hover:underline">
                        Acknowledgement
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {other.data.total > other.data.rows.length ? (
              <p className="border-t border-border px-4 py-2.5 text-sm text-text-muted md:px-5">
                Showing the latest {other.data.rows.length} of {other.data.total}. Ask your accountant for the full history.
              </p>
            ) : null}
          </SectionCard>
        ) : null
      ) : (
        <PortalBlockError title="Other filings on record" message="Couldn't load the other filings on record." errorRef={other.ref} className="mt-4 md:mt-6" />
      )}
    </div>
  )
}
