import type { Metadata } from "next"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate, pdfFileName } from "@/lib/format"
import { istDateOf, recentFinancialYears, taxYearLabel, todayIST } from "@/lib/domain/fy"
import {
  AUDIT_STAGES,
  AUDIT_STAGE_LABELS,
  AUDIT_TYPE_LABELS,
  STAGE_STANDARDS,
  caroApplicability,
  isAuditStage,
  signableStages,
  stageProgress,
  stepsFor,
  type AuditStage,
} from "@/lib/domain/audit-stages"
import { auditYearLabel } from "@/lib/schemas/audits"
import { readParam } from "@/components/app/data-table/params"
import { getAuditDetail, listAuditTeamOptions, type AuditDetail } from "@/lib/data/audits"
import { documentShare, getShareContextOrNull } from "@/lib/data/document-share"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { Notice } from "@/components/quality/notice"
import { AuditWorkspace, type WorkspaceData } from "@/components/audits/audit-workspace"
import { StageTracker } from "@/components/audits/stage-tracker"
import { GatePanel } from "@/components/audits/gate-panel"
import { StageChecklist, type ChecklistStep } from "@/components/audits/stage-checklist"
import { AssemblyCard, DetailsCard, LinkedCard, MaterialityCard, ReportCard, StageLogCard } from "@/components/audits/side-cards"
import { systemFacts } from "@/components/audits/facts"
import { stageChip } from "@/components/audits/audit-ui"

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Audit engagement" }
    const s = await getSession()
    if (s.status !== "ok" || (s.user.role !== "partner" && s.user.role !== "manager")) return { title: "Audit engagement" }
    const { data } = await s.supabase.from("audit_engagements_list").select("client_name, audit_type, financial_year").eq("id", id).maybeSingle()
    if (!data) return { title: "Audit engagement" }
    const type = data.audit_type && data.audit_type in AUDIT_TYPE_LABELS ? AUDIT_TYPE_LABELS[data.audit_type as keyof typeof AUDIT_TYPE_LABELS] : "Audit"
    return { title: `${type} FY ${data.financial_year} · ${data.client_name}` }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Audit engagement" }
  }
}

function Crumbs({ label }: { label: string }) {
  return <ShellTitle crumbs={[{ label: "Audit engagements", href: "/audits" }, { label }]} />
}

/**
 * One audit engagement (§6.9, §7.15.5): the stage tracker; what stands between it and the next
 * stage, with the engagement partner's approval; the checklist of the stage being looked at, each
 * step with its SA references, live fact, sign-offs and working papers; materiality; the report and
 * UDIN; the SA 230 assembly countdown; the engagement's details, linked tasks and documents; and the
 * stage log. Partners and Managers only (§4.1; RLS 0033). Archived files are read-only, with
 * additions as amendments.
 */
export default async function AuditPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams
  const today = todayIST()

  let d: AuditDetail | null
  let team: Awaited<ReturnType<typeof listAuditTeamOptions>> = { partners: [], reviewers: [] }
  try {
    ;[d, team] = await Promise.all([getAuditDetail(supabase, id, today), listAuditTeamOptions(supabase)])
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/audits/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <Crumbs label="Engagement" />
        <PageHeader breadcrumbs={[{ label: "Audit engagements", href: "/audits" }, { label: "Engagement" }]} title="Audit engagement" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this audit engagement." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!d) notFound()

  const e = d.engagement
  const isPartner = user.role === "partner"
  const archived = Boolean(e.archived_at)
  const rawStage = readParam(sp, "stage")
  const viewing: AuditStage = isAuditStage(rawStage) ? rawStage : d.stage
  const signable = !archived && signableStages(d.stage).includes(viewing)
  const yearLabel = auditYearLabel(d.auditType, e.financial_year, taxYearLabel)
  const title = `${AUDIT_TYPE_LABELS[d.auditType]} ${yearLabel}`
  const chip = stageChip(d.stage)
  const facts = systemFacts(d, today, { isPartner })
  const isEngagementPartner = d.gate?.isEngagementPartner ?? (user.employeeId !== null && user.employeeId === e.engagement_partner_id)
  // The draft management representation letter goes to the client on WhatsApp with its PDF (§7.13.2).
  const shareCtx = await getShareContextOrNull(supabase, user, d.client.id, { source: "page:/audits/[id]:share" })
  const repLetterShare = shareCtx
    ? documentShare(shareCtx, {
        serviceType: "audit",
        draft: (first) =>
          `${first ? `Hi ${first}` : "Hello"}, please find the draft management representation letter for our audit of ${shareCtx.client.name} for FY ${e.financial_year}. Please put it on your letterhead, have it signed, and send us the signed copy dated on or before the date of our audit report.`,
        values: { service_type: "Audit", period: `FY ${e.financial_year}` },
        templateTypes: ["custom"],
        attachment: { href: `/api/pdf/management-representation/${e.id}?download=1`, filename: pdfFileName(`${shareCtx.client.code ?? ""} FY ${e.financial_year}`, "Management representation") },
        related: { type: "audit_representation_letter", id: e.id },
      })
    : null
  const steps: ChecklistStep[] = stepsFor(d.auditType, viewing).map((s) => ({
    key: s.key,
    title: s.title,
    sa: s.sa,
    guidance: s.guidance,
    evidenceRequired: s.evidenceRequired,
    allowNa: s.allowNa,
    system: s.system,
  }))
  const progress = Object.fromEntries(
    AUDIT_STAGES.map((s) => {
      const p = stageProgress(d.auditType, s, d.checklist)
      return [s, { done: p.done, total: p.total }]
    }),
  ) as Partial<Record<AuditStage, { done: number; total: number }>>

  const viewIndex = AUDIT_STAGES.indexOf(viewing)
  const currentIndex = AUDIT_STAGES.indexOf(d.stage)
  const viewNote = archived
    ? "The file is archived: nothing here changes. Add anything new as an amendment, with a note."
    : signable
      ? null
      : viewIndex < currentIndex
        ? `${AUDIT_STAGE_LABELS[viewing]} is done. To change a step, the engagement partner moves the engagement back.`
        : `${AUDIT_STAGE_LABELS[viewing]} comes later. Its steps are signed once the engagement gets there${viewing === "archived" ? " (from Reporting)" : ""}.`

  const years = recentFinancialYears(today, 6)
  const data: WorkspaceData = {
    id: e.id,
    updatedAt: e.updated_at,
    stage: d.stage,
    auditType: d.auditType,
    financialYear: e.financial_year,
    client: { id: d.client.id, label: `${d.client.display_name} (${d.client.client_code})` },
    archived,
    today,
    team: { engagementPartnerId: e.engagement_partner_id, reviewManagerId: e.review_manager_id, partners: team.partners, reviewers: team.reviewers, fyOptions: years, canChangePartner: isPartner },
    answers: { hadPreviousAuditor: e.had_previous_auditor, requiresPeerReviewedAuditor: e.requires_peer_reviewed_auditor, notes: e.notes },
    materiality: d.materiality,
    company: d.company,
    params: { smallCompany: d.params.smallCompany, caroPrivateExemption: d.params.caroPrivateExemption },
    privateExclusionPaise: d.ceiling.privateCompanyPaidUpExclusionPaise,
    report: {
      reportType: e.report_type,
      reportDate: e.report_date,
      udinRecordId: e.udin_record_id,
      caroApplicable: e.caro_applicable,
      caroHint: d.auditType === "statutory_companies_act" ? caroApplicability(d.company, d.params).reason : null,
      udins: d.udins.filter((u) => !u.audit_engagement_id || u.audit_engagement_id === e.id),
    },
    limitMessage: d.limit?.message ?? null,
    moveWarnings: (d.gate?.warnings ?? []).map((w) => `${w.message.charAt(0).toUpperCase()}${w.message.slice(1).replace(/\.?$/, ".")}`),
  }

  return (
    <AuditWorkspace data={data}>
      <div className="flex min-w-0 flex-col gap-4">
        <Crumbs label={`${d.client.display_name} · ${title}`} />
        <PageGuide title="Audit engagement">
          <p>Sign each step of the stage the engagement is at: prepare it (or mark it not applicable, with a reason), then someone else reviews it. Steps that need a working paper can&apos;t be prepared until one is attached.</p>
          <p className="mt-2">When every step is reviewed and the checks pass, the engagement partner approves the move to the next stage. Leaving Acceptance needs the KYC, the conflict check, the SA 210 letter, the previous auditor&apos;s letter where there was one, the peer review certificate where required, and the ceilings.</p>
          <p className="mt-2">Archive locks the engagement and its working papers. Anything added after is an amendment, and the file is kept until the report date plus 7 years.</p>
        </PageGuide>
        <PageHeader
          breadcrumbs={[{ label: "Audit engagements", href: "/audits" }, { label: d.client.display_name }]}
          title={title}
          description={`${d.client.display_name} (${d.client.client_code}) · engagement partner ${d.partner?.name ?? "not set"}`}
          meta={<StatusChip label={chip.label} tone={chip.tone} meaning={chip.meaning} variant="pill" />}
          className="mb-0"
        />

        <StageTracker current={d.stage} viewing={viewing} progress={progress} hrefFor={(s) => (s === d.stage ? `/audits/${e.id}` : `/audits/${e.id}?stage=${s}`)} />

        {archived ? (
          <Notice tone="success" title={`Archived ${formatDate(istDateOf(e.archived_at!))}: the file is read-only`}>
            The engagement and its working papers can&apos;t be changed (SA 230). Anything added now is logged as an amendment.{e.retain_until ? ` Kept until ${formatDate(e.retain_until)}.` : ""}
          </Notice>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            {!archived ? <GatePanel stage={d.stage} gate={d.gate} isEngagementPartner={isEngagementPartner} partnerName={d.partner?.name ?? null} canWork /> : null}
            <SectionCard title={`${AUDIT_STAGE_LABELS[viewing]} checklist`} description={STAGE_STANDARDS[viewing]} flush>
              {viewNote ? <p className="border-b border-border px-4 pb-3 text-sm text-text-muted md:px-5">{viewNote}</p> : null}
              <StageChecklist
                steps={steps}
                signoffs={d.checklist}
                evidence={d.evidence}
                names={d.names}
                facts={facts}
                actorId={user.id}
                signable={signable}
                archived={archived}
                emptyText="This type of audit has no steps at this stage."
              />
            </SectionCard>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <MaterialityCard d={d} canEdit={!archived} />
            <ReportCard d={d} canEdit={!archived} />
            <AssemblyCard d={d} today={today} params={d.params} />
            <DetailsCard d={d} canEdit={!archived} isPartner={isPartner} />
            <LinkedCard d={d} repLetterShare={repLetterShare} />
            <StageLogCard d={d} />
          </div>
        </div>
      </div>
    </AuditWorkspace>
  )
}
