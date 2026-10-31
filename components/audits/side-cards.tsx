import Link from "next/link"
import { DownloadIcon, FileTextIcon, PencilIcon } from "lucide-react"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { EMPTY, formatDate, formatDateTime } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import {
  AUDIT_STAGE_LABELS,
  MATERIALITY_BASIS_LABELS,
  REPORT_TYPE_LABELS,
  fileAssemblyCountdown,
  isAuditStage,
  materialityComplete,
  type AuditParams,
} from "@/lib/domain/audit-stages"
import type { AuditDetail } from "@/lib/data/audits"
import { assemblyWords } from "@/components/audits/audit-ui"
import { AuditDialogButton } from "@/components/audits/audit-workspace"
import { SendDocumentButton, type DocumentShare } from "@/components/comms/send-document"

/**
 * The engagement page's side column (§7.15.5): materiality, the report and UDIN, the SA 230 file
 * assembly countdown, the engagement's details, linked work and documents, and the stage log.
 * Server-safe; the edit buttons open the workspace's dialogs.
 */

export function MaterialityCard({ d, canEdit }: { d: AuditDetail; canEdit: boolean }) {
  const m = d.materiality
  return (
    <SectionCard
      id="materiality"
      title="Materiality"
      description="SA 320"
      action={canEdit ? <AuditDialogButton dialog={{ kind: "materiality" }} variant="ghost" size="sm">{m ? "Change" : "Record"}</AuditDialogButton> : null}
    >
      {m && materialityComplete(m) ? (
        <div className="flex flex-col gap-3">
          <DefinitionList
            items={[
              { term: "Overall", value: <Money value={m.overall} />, align: "right" },
              { term: "Performance", value: <span className="num">{m.performance_percent}% · <Money value={m.performance} /></span>, align: "right" },
              { term: "Clearly trivial", value: <span className="num">{m.trivial_percent}% · <Money value={m.trivial} /></span>, align: "right" },
              { term: "Basis", value: `${m.percent}% of ${MATERIALITY_BASIS_LABELS[m.basis].toLowerCase()}`, align: "right" },
              { term: "Benchmark", value: <Money value={m.base_amount} />, align: "right" },
            ]}
          />
          {m.rationale ? <p className="text-sm text-text-muted">{m.rationale}</p> : null}
          {m.determined_on ? <p className="text-xs text-text-muted">Set on {formatDate(m.determined_on)}{m.determined_by && d.names[m.determined_by] ? ` by ${d.names[m.determined_by]}` : ""}</p> : null}
        </div>
      ) : (
        <EmptyState size="compact" message="Not recorded. Planning can't finish without it." />
      )}
    </SectionCard>
  )
}

export function ReportCard({ d, canEdit }: { d: AuditDetail; canEdit: boolean }) {
  const e = d.engagement
  const recordable = d.stage === "completion" || d.stage === "reporting"
  return (
    <SectionCard
      title="Report and UDIN"
      description={d.auditType === "tax_audit" ? "SA 700/705 · tax audit report" : "SA 700/705 · CARO 2020 · UDIN"}
      action={
        canEdit && recordable ? (
          <AuditDialogButton dialog={{ kind: "report" }} variant="ghost" size="sm">
            {e.report_date ? "Change" : "Record"}
          </AuditDialogButton>
        ) : null
      }
    >
      <DefinitionList
        items={[
          { term: "Opinion", value: e.report_type ? (REPORT_TYPE_LABELS[e.report_type as keyof typeof REPORT_TYPE_LABELS] ?? e.report_type) : <span className="text-text-muted">{recordable ? "Not recorded" : "At Completion"}</span> },
          { term: "Report date", value: e.report_date ? <DateText date={e.report_date} /> : EMPTY, align: "right" },
          { term: "UDIN", value: d.linkedUdin ? <MonoId value={d.linkedUdin.udin} copy /> : e.report_date ? <span className="text-warning-text">Not linked</span> : EMPTY },
          ...(d.auditType === "statutory_companies_act"
            ? [{ term: "CARO 2020", value: e.caro_applicable === null ? <span className="text-text-muted">Not decided</span> : e.caro_applicable ? "Applies" : "Doesn't apply" }]
            : []),
        ]}
      />
      {canEdit && d.auditType === "statutory_companies_act" ? (
        <div className="mt-3">
          <AuditDialogButton dialog={{ kind: "company_facts" }} variant="link" size="sm" className="h-auto">
            Company facts for CARO and the audit limit
          </AuditDialogButton>
        </div>
      ) : null}
    </SectionCard>
  )
}

export function AssemblyCard({ d, today, params }: { d: AuditDetail; today: string; params: AuditParams }) {
  const e = d.engagement
  const c = fileAssemblyCountdown({ reportDate: e.report_date, archivedOn: e.archived_at ? istDateOf(e.archived_at) : null, today }, params)
  const w = assemblyWords(c)
  return (
    <SectionCard title="File assembly" description="SA 230 · within 60 days of the report">
      <div className="flex items-baseline justify-between gap-3">
        <StatusChip label={w.label} tone={w.tone} meaning={w.meaning} />
        {c.due ? (
          <span className="num text-sm text-text-muted">
            Due <DateText date={c.due} />
          </span>
        ) : null}
      </div>
      <DefinitionList
        className="mt-3"
        items={[
          { term: "Archived", value: e.archived_at ? formatDateTime(e.archived_at) : EMPTY, align: "right" },
          ...(e.archived_by && d.names[e.archived_by] ? [{ term: "By", value: d.names[e.archived_by], align: "right" as const }] : []),
          { term: "Keep until", value: e.retain_until ? <DateText date={e.retain_until} /> : <span className="text-text-muted">Report date + 7 years</span>, align: "right" },
        ]}
      />
    </SectionCard>
  )
}

export function DetailsCard({ d, canEdit, isPartner }: { d: AuditDetail; canEdit: boolean; isPartner: boolean }) {
  const e = d.engagement
  return (
    <SectionCard
      title="Engagement"
      action={
        canEdit ? (
          <AuditDialogButton dialog={{ kind: "edit" }} variant="ghost" size="sm">
            <PencilIcon aria-hidden="true" />
            Edit
          </AuditDialogButton>
        ) : null
      }
    >
      <DefinitionList
        items={[
          { term: "Client", value: <Link href={`/clients/${d.client.id}?tab=engagement`} className="text-primary hover:underline">{d.client.display_name}</Link> },
          { term: "Engagement partner", value: d.partner?.name ?? EMPTY },
          { term: "Review manager", value: d.reviewManager?.name ?? <span className="text-text-muted">Not named</span> },
          { term: "Accepted on", value: e.accepted_on ? <DateText date={e.accepted_on} /> : <span className="text-text-muted">At Acceptance</span> },
          { term: "Previous auditor", value: e.had_previous_auditor === null ? <span className="text-warning-text">Not answered</span> : e.had_previous_auditor ? "Yes" : "No, first audit" },
          { term: "Peer-reviewed auditor", value: e.requires_peer_reviewed_auditor ? "Required" : "Not required" },
          ...(e.limit_override_at ? [{ term: "Over the ceiling", value: `Confirmed by ${d.limitOverrideByName ?? "a Partner"}, ${formatDate(istDateOf(e.limit_override_at))}` }] : []),
        ]}
      />
      {e.notes ? <p className="mt-3 text-sm whitespace-pre-line text-text-muted">{e.notes}</p> : null}
      {isPartner && canEdit && d.stage === "acceptance" && d.evidence.length === 0 ? (
        <div className="mt-3">
          <AuditDialogButton dialog={{ kind: "delete" }} variant="destructive-outline" size="sm">
            Delete engagement
          </AuditDialogButton>
        </div>
      ) : null}
    </SectionCard>
  )
}

/** The letters and exports, the vault and the linked tasks; the representation letter can go to the client on WhatsApp. */
export function LinkedCard({ d, repLetterShare = null }: { d: AuditDetail; repLetterShare?: DocumentShare | null }) {
  const repLetter = `/api/pdf/management-representation/${d.engagement.id}`
  return (
    <SectionCard title="Documents and work" flush>
      <div className="flex flex-col gap-2 px-4 pb-3 md:px-5">
        <Button asChild variant="outline" size="sm" className="justify-start">
          <a href={repLetter} target="_blank" rel="noopener">
            <FileTextIcon aria-hidden="true" />
            Management representation letter (SA 580)
          </a>
        </Button>
        {repLetterShare ? <SendDocumentButton share={repLetterShare} label="Send the letter on WhatsApp" className="justify-start" /> : null}
        <Button asChild variant="outline" size="sm" className="justify-start">
          <a href={`/api/exports/audit-checklist/${d.engagement.id}`}>
            <DownloadIcon aria-hidden="true" />
            Checklist export (Excel)
          </a>
        </Button>
        <Link href={`/clients/${d.client.id}?tab=documents`} className="text-sm font-medium text-primary hover:underline">
          {d.evidence.length} working {d.evidence.length === 1 ? "paper" : "papers"} tagged · client&apos;s vault
        </Link>
      </div>
      <div className="border-t border-border">
        <p className="px-4 pt-3 text-sm font-medium text-text md:px-5">Linked tasks</p>
        {d.tasks.length ? (
          <ul className="divide-y divide-border">
            {d.tasks.map((t) => (
              <li key={t.id}>
                <Link href={`/work/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-surface-2 md:px-5">
                  <span className="min-w-0">
                    <span className="block truncate text-text">{t.title}</span>
                    <span className="block text-xs text-text-muted">{t.task_number}</span>
                  </span>
                  <StatusChip kind="task_status" value={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pt-1 pb-3 text-sm text-text-muted md:px-5">No audit task for FY {d.engagement.financial_year} yet. Apply the audit job template from the client&apos;s Tasks tab.</p>
        )}
      </div>
    </SectionCard>
  )
}

export function StageLogCard({ d }: { d: AuditDetail }) {
  return (
    <SectionCard title="Stage log" description="Each move, approved by the engagement partner" flush>
      {d.log.length ? (
        <ol className="divide-y divide-border">
          {d.log.map((l) => (
            <li key={l.id} className="px-4 py-2.5 md:px-5">
              <p className="text-sm text-text">
                {isAuditStage(l.from_stage) ? AUDIT_STAGE_LABELS[l.from_stage] : l.from_stage} → {isAuditStage(l.to_stage) ? AUDIT_STAGE_LABELS[l.to_stage] : l.to_stage}
              </p>
              <p className="text-xs text-text-muted">
                {l.approved_by_name ?? "Someone"}, {formatDateTime(l.at)}
              </p>
              {l.note ? <p className="mt-0.5 text-sm text-text-muted">{l.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 pb-4 text-sm text-text-muted md:px-5">No moves yet. The engagement opened at Acceptance.</p>
      )}
    </SectionCard>
  )
}
