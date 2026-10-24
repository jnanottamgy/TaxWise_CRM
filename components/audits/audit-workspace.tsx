"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import type { AuditParams, AuditStage, AuditType, CompanyFacts, StoredMateriality } from "@/lib/domain/audit-stages"
import { SignoffSchema } from "@/lib/schemas/audits"
import { deleteAudit, signoffStep } from "@/server/actions/audits"
import { AuditFormDialog, type StaffChoice } from "@/components/audits/audit-form-dialog"
import { CompanyFactsDialog, LimitOverrideDialog, MaterialityDialog, NoteDialog, ReportDialog, StageMoveDialog, type UdinChoice } from "@/components/audits/audit-dialogs"
import { EvidenceDialog } from "@/components/audits/evidence-dialog"
import { PreviousAuditorDialog, type PreviousAuditorRecord } from "@/components/audits/previous-auditor-dialog"
import type { AuditDialogKind } from "@/components/audits/facts"
import { toastResult } from "@/components/quality/feedback"

export type AuditDialog =
  | { kind: Exclude<AuditDialogKind, "record_letter"> }
  | { kind: "record_letter"; record?: PreviousAuditorRecord | null }
  | { kind: "move"; to: AuditStage }
  | { kind: "evidence"; step: { key: string; title: string } }
  | { kind: "na"; step: { key: string; title: string } }
  | { kind: "delete" }

/** Everything the engagement's dialogs need, serialisable from the page. */
export type WorkspaceData = {
  id: string
  updatedAt: string
  stage: AuditStage
  auditType: AuditType
  financialYear: string
  client: { id: string; label: string }
  archived: boolean
  today: string
  team: { engagementPartnerId: string; reviewManagerId: string | null; partners: StaffChoice[]; reviewers: StaffChoice[]; fyOptions: string[]; canChangePartner: boolean }
  answers: { hadPreviousAuditor: boolean | null; requiresPeerReviewedAuditor: boolean; notes: string | null }
  materiality: StoredMateriality | null
  company: CompanyFacts
  params: Pick<AuditParams, "smallCompany" | "caroPrivateExemption">
  privateExclusionPaise: number
  report: { reportType: string | null; reportDate: string | null; udinRecordId: string | null; caroApplicable: boolean | null; caroHint: string | null; udins: UdinChoice[] }
  limitMessage: string | null
  moveWarnings: string[]
}

const Ctx = React.createContext<{ open: (d: AuditDialog) => void; data: WorkspaceData } | null>(null)

export function useAuditWorkspace() {
  const v = React.useContext(Ctx)
  if (!v) throw new Error("useAuditWorkspace outside AuditWorkspace")
  return v
}

/**
 * The engagement page's client side (§7.15.5): holds the one open dialog (edit, materiality,
 * report and UDIN, company facts, the previous auditor's letter, the ceiling confirmation, a stage
 * move, working papers, not applicable, delete) so any button on the page can open it.
 */
export function AuditWorkspace({ data, children }: { data: WorkspaceData; children: React.ReactNode }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<AuditDialog | null>(null)
  const close = React.useCallback(() => setDialog(null), [])
  const value = React.useMemo(() => ({ open: setDialog, data }), [data])

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog?.kind === "edit" ? (
        <AuditFormDialog
          mode="edit"
          open
          onOpenChange={(o) => (!o ? close() : undefined)}
          partners={data.team.partners}
          reviewers={data.team.reviewers}
          fyOptions={data.team.fyOptions.includes(data.financialYear) ? data.team.fyOptions : [data.financialYear, ...data.team.fyOptions]}
          canChangePartner={data.team.canChangePartner}
          engagement={{
            id: data.id,
            updatedAt: data.updatedAt,
            stage: data.stage,
            auditType: data.auditType,
            financialYear: data.financialYear,
            engagementPartnerId: data.team.engagementPartnerId,
            reviewManagerId: data.team.reviewManagerId,
            hadPreviousAuditor: data.answers.hadPreviousAuditor,
            requiresPeerReviewedAuditor: data.answers.requiresPeerReviewedAuditor,
            notes: data.answers.notes,
          }}
        />
      ) : null}
      {dialog?.kind === "materiality" ? <MaterialityDialog onClose={close} engagementId={data.id} updatedAt={data.updatedAt} current={data.materiality} /> : null}
      {dialog?.kind === "report" ? (
        <ReportDialog
          onClose={close}
          engagementId={data.id}
          updatedAt={data.updatedAt}
          reportType={data.report.reportType}
          reportDate={data.report.reportDate}
          udinRecordId={data.report.udinRecordId}
          caroApplicable={data.report.caroApplicable}
          isCompanyAudit={data.auditType === "statutory_companies_act"}
          caroHint={data.report.caroHint}
          udins={data.report.udins}
          today={data.today}
        />
      ) : null}
      {dialog?.kind === "company_facts" ? (
        <CompanyFactsDialog onClose={close} engagementId={data.id} updatedAt={data.updatedAt} facts={data.company} params={data.params} privateExclusionPaise={data.privateExclusionPaise} />
      ) : null}
      {dialog?.kind === "record_letter" ? (
        <PreviousAuditorDialog onClose={close} client={data.client} engagement={{ id: data.id, auditType: data.auditType, financialYear: data.financialYear }} record={dialog.record ?? null} today={data.today} />
      ) : null}
      {dialog?.kind === "confirm_limit" ? <LimitOverrideDialog onClose={close} engagementId={data.id} message={data.limitMessage} /> : null}
      {dialog?.kind === "move" ? (
        <StageMoveDialog onClose={close} engagementId={data.id} updatedAt={data.updatedAt} from={data.stage} to={dialog.to} warnings={dialog.to === "archived" || data.stage === "acceptance" ? data.moveWarnings : []} />
      ) : null}
      {dialog?.kind === "evidence" ? (
        <EvidenceDialog onClose={close} engagementId={data.id} clientId={data.client.id} financialYear={data.financialYear} step={dialog.step} amendment={data.archived} />
      ) : null}
      {dialog?.kind === "na" ? (
        <NoteDialog
          onClose={close}
          title="Mark the step not applicable?"
          description={`"${dialog.step.title}" doesn't apply to this engagement. Someone else still reviews the reason.`}
          label="Why it doesn't apply"
          required
          submitLabel="Mark not applicable"
          schema={SignoffSchema}
          action={signoffStep}
          values={{ id: data.id, step: dialog.step.key, action: "not_applicable" }}
          successMessage="Marked not applicable"
          onDone={() => router.refresh()}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? close() : undefined)}
          title="Delete this engagement?"
          description="It is still at Acceptance with no working papers, so nothing is lost but the engagement itself. The deletion is kept in the audit log."
          confirmLabel="Delete engagement"
          destructive
          onConfirm={async () => {
            const r = await deleteAudit({ id: data.id })
            if (!toastResult(r, "Engagement deleted")) return false
            router.push("/audits")
          }}
        />
      ) : null}
    </Ctx.Provider>
  )
}

/** A button that opens one of the engagement's dialogs. */
export function AuditDialogButton({
  dialog,
  children,
  variant = "outline",
  size = "sm",
  disabled,
  title,
  className,
}: {
  dialog: AuditDialog
  children: React.ReactNode
  variant?: "default" | "outline" | "ghost" | "link" | "destructive-outline"
  size?: "default" | "sm" | "xs"
  disabled?: boolean
  title?: string
  className?: string
}) {
  const { open } = useAuditWorkspace()
  return (
    <Button type="button" variant={variant} size={size} disabled={disabled} title={title} className={className} onClick={() => open(dialog)}>
      {children}
    </Button>
  )
}
