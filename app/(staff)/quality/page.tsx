import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { financialYearOf, isFinancialYear, recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { DATA_REQUEST_STATUSES, DATA_REQUEST_STATUS_INFO, DATA_REQUEST_TYPES, DATA_REQUEST_TYPE_LABELS } from "@/lib/domain/dpdp"
import { DATA_REQUEST_FILTERS, DATA_REQUEST_SORTABLE } from "@/lib/schemas/dpdp"
import { DISPOSAL_SORTABLE, KYC_FILTERS, KYC_SORTABLE, KYC_STATES, KYC_STATE_INFO, QUALITY_TABS, isQualityTab, type QualityTab } from "@/lib/schemas/quality"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import {
  getAcceptanceSummary,
  getIndependenceRegister,
  getOwnDeclaration,
  getQualityOverview,
  getRetentionSummary,
  listDisposal,
  listKycRegister,
  listPeerReviews,
  listPreviousAuditorComms,
  listQualityItems,
  listRestoreDrills,
  listStaffOptions,
} from "@/lib/data/quality"
import { getDataRequest, listConsents, listDataRequests, listIncidents, listNoticeVersions, listNotices, listPartnerProfiles } from "@/lib/data/dpdp"
import { getAuditParams } from "@/lib/data/audits"
import { CEILING_DEFAULTS } from "@/lib/domain/ceiling"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { QualityNav } from "@/components/quality/quality-nav"
import { QualityOverviewView } from "@/components/quality/overview"
import { QualityManual } from "@/components/quality/manual"
import { PeerReviews } from "@/components/quality/peer-reviews"
import { AcceptanceSection } from "@/components/quality/acceptance"
import { KycExportButton, KycRegisterTable } from "@/components/quality/kyc-register"
import { PreviousAuditorsTable } from "@/components/quality/previous-auditors"
import { IndependenceRegister, OwnDeclaration } from "@/components/quality/independence"
import { DisposalTable, RetentionSummary } from "@/components/quality/retention"
import { RestoreDrills } from "@/components/quality/restore-drills"
import { Notice } from "@/components/quality/notice"
import { NoticeVersions } from "@/components/dpdp/notices"
import { ConsentsTable } from "@/components/dpdp/consents"
import { DataRequestsTable } from "@/components/dpdp/data-requests"
import { Incidents } from "@/components/dpdp/incidents"
import { CONSENT_SUBJECT_LABELS } from "@/lib/schemas/dpdp"

export const metadata: Metadata = { title: "Quality and risk" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/quality:${source}`, userId }) }
  }
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

const DESCRIPTIONS: Record<QualityTab, string> = {
  overview: "SQC 1 quality control, the ICAI practice rules and data protection, with what needs a Partner first.",
  manual: "The firm's quality control policies, each with an owner and its last review.",
  "peer-reviews": "The firm's peer reviews and the certificate in force.",
  acceptance: "Conflict and independence checks made before taking on a client.",
  kyc: "ICAI KYC Norms for every attest client, complete for its category and re-confirmed each year.",
  "previous-auditors": "Letters to outgoing auditors under Clause 8, with proof of delivery and the replies.",
  independence: "The annual independence declaration of every member of staff.",
  retention: "Documents by the year their retention ends, and those past it to review for disposal.",
  "restore-drills": "Backups restored every quarter, to prove they can be.",
  notices: "The versions of the privacy notice portal users and leads acknowledge.",
  consents: "Acknowledgements of the privacy notice, and their withdrawal.",
  "data-requests": "Requests from data principals: access, correction, erasure, grievance and nomination.",
  incidents: "Personal data breaches, and the response checklist for each.",
}

/** Partner-only writes in these sections; Managers read (§7.15.4). */
const PARTNER_SECTIONS: readonly QualityTab[] = ["manual", "peer-reviews", "independence", "restore-drills", "notices", "consents", "data-requests", "incidents"]

/**
 * Quality and risk (§7.15.4; §6.8 SQC 1 and the ICAI practice rules; §6.10 DPDP; §12 restore
 * drills), one view per section (`?tab=`). Partners keep it; Managers read it (KYC re-confirmation
 * and previous-auditor letters are part of their audit work). Every member of staff reaches their own
 * independence declaration here; an Employee sees nothing else (RLS gives them nothing else).
 */
export default async function QualityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const currentFy = financialYearOf(today)
  const years = recentFinancialYears(today, 3)
  const rawFy = readParam(sp, "fy")
  const fy = rawFy && isFinancialYear(rawFy) && years.includes(rawFy) ? rawFy : currentFy

  // ---------------------------------------------------------------------------------------------
  // An Employee: their own independence declaration only.
  // ---------------------------------------------------------------------------------------------
  if (user.role === "employee") {
    const own = user.employeeId ? await attempt("own-declaration", user.id, () => getOwnDeclaration(supabase, user.employeeId!, fy)) : null
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <PageHeader title="Independence declaration" description={`Your annual declaration for FY ${fy}. Everyone at the firm declares their independence each year before attest work.`} />
        {!user.employeeId ? (
          <Notice tone="warning" title="Your login isn't linked to a staff record">
            Ask a Partner to link it, then declare here.
          </Notice>
        ) : own && own.ok ? (
          <div className="max-w-3xl">
            <OwnDeclaration key={fy} fy={fy} existing={own.data ? { answers: own.data.answers, details: own.data.details, declared_at: own.data.declared_at, updated_at: own.data.updated_at } : null} />
          </div>
        ) : own && !own.ok ? (
          <Failed what="your declaration" errorRef={own.ref} />
        ) : null}
      </div>
    )
  }

  // ---------------------------------------------------------------------------------------------
  // Partners and Managers.
  // ---------------------------------------------------------------------------------------------
  const rawTab = readParam(sp, "tab")
  const tab: QualityTab = isQualityTab(rawTab) ? rawTab : "overview"
  const isPartner = user.role === "partner"
  const label = QUALITY_TABS.find((t) => t.id === tab)?.label ?? "Quality"
  const params = await attempt("params", user.id, () => getAuditParams(supabase, today))
  const overview = await attempt("overview", user.id, () =>
    getQualityOverview(supabase, today, currentFy, params.ok ? params.data.ceiling : CEILING_DEFAULTS),
  )
  const o = overview.ok ? overview.data : null
  const counts: Partial<Record<QualityTab, number>> = o
    ? {
        manual: o.manual.reviewDue,
        acceptance: o.acceptancePending,
        kyc: o.kyc.missing + o.kyc.incomplete + o.kyc.review_due,
        independence: Math.max(0, o.independence.staff - o.independence.declared),
        retention: o.disposal,
        "data-requests": o.dataRequests.open,
        incidents: o.incidents.open,
      }
    : {}

  let body: React.ReactNode = null
  switch (tab) {
    case "overview": {
      body = overview.ok ? <QualityOverviewView o={overview.data} fy={currentFy} /> : <Failed what="the quality overview" errorRef={overview.ref} />
      break
    }
    case "manual": {
      const [items, staff] = await Promise.all([attempt("manual", user.id, () => listQualityItems(supabase)), attempt("staff", user.id, () => listStaffOptions(supabase))])
      body = items.ok ? (
        <QualityManual items={items.data.items} framework={items.data.framework} settingsUpdatedAt={items.data.settingsUpdatedAt} staff={staff.ok ? staff.data : []} canEdit={isPartner} today={today} />
      ) : (
        <Failed what="the quality manual" errorRef={items.ref} />
      )
      break
    }
    case "peer-reviews": {
      const rows = await attempt("peer-reviews", user.id, () => listPeerReviews(supabase))
      body = rows.ok ? <PeerReviews rows={rows.data} today={today} ceiling={params.ok ? params.data.ceiling : CEILING_DEFAULTS} canEdit={isPartner} /> : <Failed what="the peer reviews" errorRef={rows.ref} />
      break
    }
    case "acceptance": {
      const s = await attempt("acceptance", user.id, () => getAcceptanceSummary(supabase))
      body = s.ok ? <AcceptanceSection s={s.data} /> : <Failed what="the acceptance register" errorRef={s.ref} />
      break
    }
    case "kyc": {
      const t = parseTableParams(sp, { sortable: KYC_SORTABLE, defaultSort: { sort: "client_name", dir: "asc" }, filters: KYC_FILTERS })
      const list = await attempt("kyc", user.id, () => listKycRegister(supabase, t))
      const filters: FilterDef[] = [
        { id: "state", label: "KYC", options: KYC_STATES.map((s) => ({ value: s, label: KYC_STATE_INFO[s].label, tone: KYC_STATE_INFO[s].tone })) },
        { id: "audits", label: "Audits", multi: false, options: [{ value: "open", label: "With an open audit" }] },
      ]
      body = (
        <>
          <FilterBar searchLabel="Search attest clients" searchPlaceholder="Client name or code" filters={filters} exportSlot={<KycExportButton />} />
          {list.ok ? <KycRegisterTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} canReconfirm /> : <Failed what="the KYC register" errorRef={list.ref} />}
        </>
      )
      break
    }
    case "previous-auditors": {
      const t = parseTableParams(sp, { sortable: ["letter_sent_on", "previous_auditor_name"], defaultSort: { sort: "letter_sent_on", dir: "desc" }, filters: { state: ["no_proof", "awaiting_reply", "objection"] } })
      const list = await attempt("previous-auditors", user.id, () => listPreviousAuditorComms(supabase, t))
      body = (
        <>
          <FilterBar
            searchLabel="Search letters"
            searchPlaceholder="Previous auditor or FRN"
            filters={[
              {
                id: "state",
                label: "Showing",
                multi: false,
                options: [
                  { value: "no_proof", label: "No proof of delivery", tone: "danger" },
                  { value: "awaiting_reply", label: "Awaiting a reply" },
                  { value: "objection", label: "Objection not resolved", tone: "danger" },
                ],
              },
            ]}
          />
          {list.ok ? <PreviousAuditorsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} canEdit /> : <Failed what="the letters to previous auditors" errorRef={list.ref} />}
        </>
      )
      break
    }
    case "independence": {
      const [register, own] = await Promise.all([
        attempt("independence", user.id, () => getIndependenceRegister(supabase, fy)),
        user.employeeId ? attempt("own-declaration", user.id, () => getOwnDeclaration(supabase, user.employeeId!, fy)) : Promise.resolve(null),
      ])
      body = (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
          {register.ok ? <IndependenceRegister fy={fy} rows={register.data} years={years} canRemind={isPartner} /> : <Failed what="the declarations" errorRef={register.ref} />}
          {own === null ? null : own.ok ? (
            <OwnDeclaration key={fy} fy={fy} existing={own.data ? { answers: own.data.answers, details: own.data.details, declared_at: own.data.declared_at, updated_at: own.data.updated_at } : null} />
          ) : (
            <Failed what="your declaration" errorRef={own.ref} />
          )}
        </div>
      )
      break
    }
    case "retention": {
      const t = parseTableParams(sp, { sortable: DISPOSAL_SORTABLE, defaultSort: { sort: "retention_until", dir: "asc" }, filters: { audit: ["in_file", "not_in_file"] } })
      const [summary, list] = await Promise.all([attempt("retention-summary", user.id, () => getRetentionSummary(supabase)), attempt("disposal", user.id, () => listDisposal(supabase, t))])
      body = (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[20rem_minmax(0,1fr)] xl:items-start">
          <SectionCard title="By retention year" description="Documents whose retention ends that year" flush>
            {summary.ok ? <RetentionSummary years={summary.data} thisYear={Number(today.slice(0, 4))} /> : <ErrorBlock message="Couldn't load the retention summary." errorRef={summary.ref} size="compact" />}
          </SectionCard>
          <div className="min-w-0">
            <h2 className="mb-2 font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">Review for disposal</h2>
            <FilterBar
              searchLabel="Search documents past retention"
              searchPlaceholder="Title, file or client"
              filters={[{ id: "audit", label: "Audit file", multi: false, options: [{ value: "in_file", label: "In an archived audit file" }, { value: "not_in_file", label: "Not in an audit file" }] }]}
            />
            {list.ok ? <DisposalTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} /> : <Failed what="the documents past retention" errorRef={list.ref} />}
          </div>
        </div>
      )
      break
    }
    case "restore-drills": {
      const rows = await attempt("restore-drills", user.id, () => listRestoreDrills(supabase))
      body = rows.ok ? <RestoreDrills rows={rows.data} today={today} canEdit={isPartner} /> : <Failed what="the restore drills" errorRef={rows.ref} />
      break
    }
    case "notices": {
      const rows = await attempt("notices", user.id, () => listNotices(supabase))
      body = (
        <SectionCard
          title="Versions"
          action={
            isPartner ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/data">Edit in Settings → Data</Link>
              </Button>
            ) : null
          }
          flush
        >
          {rows.ok ? <NoticeVersions notices={rows.data} /> : <ErrorBlock message="Couldn't load the privacy notices." errorRef={rows.ref} size="compact" />}
        </SectionCard>
      )
      break
    }
    case "consents": {
      const t = parseTableParams(sp, { sortable: ["given_at", "withdrawn_at", "notice_version"], defaultSort: { sort: "given_at", dir: "desc" }, filters: { subject: ["client_contact", "portal_user", "employee", "lead"], state: ["live", "withdrawn"], version: null } })
      const [list, versions] = await Promise.all([attempt("consents", user.id, () => listConsents(supabase, t)), attempt("versions", user.id, () => listNoticeVersions(supabase))])
      const filters: FilterDef[] = [
        { id: "subject", label: "Who", options: Object.entries(CONSENT_SUBJECT_LABELS).map(([value, l]) => ({ value, label: l })) },
        { id: "state", label: "State", multi: false, options: [{ value: "live", label: "Given" }, { value: "withdrawn", label: "Withdrawn" }] },
        ...(versions.ok && versions.data.length ? [{ id: "version", label: "Notice", multi: false, options: versions.data.map((v) => ({ value: v, label: v })) }] : []),
      ]
      body = (
        <>
          <FilterBar hideSearch filters={filters} />
          {list.ok ? <ConsentsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canEdit={isPartner} /> : <Failed what="the consent records" errorRef={list.ref} />}
        </>
      )
      break
    }
    case "data-requests": {
      const t = parseTableParams(sp, { sortable: DATA_REQUEST_SORTABLE, defaultSort: { sort: "due_by", dir: "asc" }, filters: DATA_REQUEST_FILTERS })
      const focusId = readParam(sp, "request")
      const [list, partners, focus] = await Promise.all([
        attempt("data-requests", user.id, () => listDataRequests(supabase, t, today)),
        attempt("partners", user.id, () => listPartnerProfiles(supabase)),
        focusId && UUID.test(focusId) ? attempt("data-request", user.id, () => getDataRequest(supabase, focusId)) : Promise.resolve(null),
      ])
      const filters: FilterDef[] = [
        {
          id: "status",
          label: "Status",
          options: [
            { value: "open_all", label: "Open (any)" },
            { value: "overdue", label: "Overdue", tone: "danger" },
            ...DATA_REQUEST_STATUSES.map((s) => ({ value: s, label: DATA_REQUEST_STATUS_INFO[s].label, tone: DATA_REQUEST_STATUS_INFO[s].tone })),
          ],
        },
        { id: "type", label: "Request", options: DATA_REQUEST_TYPES.map((x) => ({ value: x, label: DATA_REQUEST_TYPE_LABELS[x] })) },
      ]
      body = (
        <>
          <FilterBar searchLabel="Search data requests" searchPlaceholder="Name, contact or details" filters={filters} />
          {list.ok ? (
            <DataRequestsTable
              rows={list.data.rows}
              total={list.data.total}
              page={t.page}
              pageSize={t.pageSize}
              sort={t.sort}
              dir={t.dir}
              today={today}
              canEdit={isPartner}
              partners={partners.ok ? partners.data : []}
              focus={focus && focus.ok ? focus.data : null}
            />
          ) : (
            <Failed what="the data requests" errorRef={list.ref} />
          )}
        </>
      )
      break
    }
    case "incidents": {
      const rows = await attempt("incidents", user.id, () => listIncidents(supabase))
      const focusId = readParam(sp, "incident")
      body = rows.ok ? <Incidents rows={rows.data} canEdit={isPartner} focusId={focusId && UUID.test(focusId) ? focusId : null} /> : <Failed what="the incidents" errorRef={rows.ref} />
      break
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:gap-8">
      <PageGuide title="Quality and risk">
        <p>SQC 1 continues to apply: ICAI deferred SQM 1 on 31 March 2026. The quality manual records the firm&apos;s policies under SQC 1&apos;s six elements, and switches to SQM 1&apos;s components when the firm adopts it.</p>
        <p className="mt-2">Audits can&apos;t move past Acceptance without a current KYC, an accepted conflict check, the previous auditor&apos;s letter with proof of delivery where there was one, and a peer review certificate where the entity needs one.</p>
        <p className="mt-2">Data protection follows the DPDP Act 2023: notice versions and acknowledgements, requests from data principals with their due dates, and the breach checklist with the Board&apos;s report deadline.</p>
      </PageGuide>
      <aside className="min-w-0 lg:sticky lg:top-20 lg:w-52 lg:flex-none lg:self-start">
        <QualityNav active={tab} counts={counts} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <PageHeader title={tab === "overview" ? "Quality and risk" : label} description={DESCRIPTIONS[tab]} className="mb-0" />
        {!isPartner && PARTNER_SECTIONS.includes(tab) ? (
          <Notice tone="muted" title="Read-only for Managers">
            A Partner keeps these records{tab === "independence" ? "; your own declaration is yours to make" : ""}.
          </Notice>
        ) : null}
        {body}
      </div>
    </div>
  )
}
