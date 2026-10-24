"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { useActionForm } from "@/hooks/use-action-form"
import { DocumentUploader } from "@/components/documents/uploader"
import { AUDIT_TYPES, AUDIT_TYPE_LABELS, type AuditType } from "@/lib/domain/audit-stages"
import {
  PREVIOUS_AUDITOR_OUTCOMES,
  PREVIOUS_AUDITOR_OUTCOME_LABELS,
  PreviousAuditorSchema,
  SENT_VIA,
  SENT_VIA_LABELS,
  type PreviousAuditorOutcome,
  type SentVia,
} from "@/lib/schemas/audits"
import { searchAuditClients, searchEvidenceDocs } from "@/server/actions/audits"
import { savePreviousAuditorComm } from "@/server/actions/previous-auditor"

export type PreviousAuditorRecord = {
  id: string
  updated_at: string
  client_id: string
  audit_engagement_id: string | null
  engagement_type: string
  previous_auditor_name: string
  previous_auditor_frn: string | null
  letter_sent_on: string
  sent_via: string | null
  delivery_proof_document_id: string | null
  delivery_proof_title?: string | null
  reply_received_on: string | null
  objections: string | null
  outcome: string | null
  notes: string | null
}

/**
 * The letter to the previous auditor (CA Act 1949, First Schedule, Part I, Clause 8; §6.8): who,
 * when and how it was sent, the proof of delivery (one of the client's documents: pick it, or
 * upload the postal or email acknowledgement here), and the reply or its absence. With proof of
 * delivery it opens the Acceptance gate of the client's audit of that type.
 */
export function PreviousAuditorDialog({
  onClose,
  client,
  engagement,
  record,
  today,
}: {
  onClose: () => void
  /** The client, when fixed (an engagement page, Client 360); otherwise chosen in the form. */
  client: { id: string; label: string } | null
  engagement?: { id: string; auditType: AuditType; financialYear: string } | null
  record?: PreviousAuditorRecord | null
  today: string
}) {
  const router = useRouter()
  const [proofLabel, setProofLabel] = React.useState<string | undefined>(record?.delivery_proof_title ?? (record?.delivery_proof_document_id ? "The proof of delivery on file" : undefined))
  const f = useActionForm(PreviousAuditorSchema, savePreviousAuditorComm, {
    defaultValues: {
      id: record?.id ?? "",
      updatedAt: record?.updated_at ?? "",
      clientId: record?.client_id ?? client?.id ?? "",
      auditEngagementId: record?.audit_engagement_id ?? engagement?.id ?? "",
      engagementType: ((record?.engagement_type ?? engagement?.auditType ?? "statutory_companies_act") as AuditType),
      previousAuditorName: record?.previous_auditor_name ?? "",
      previousAuditorFrn: record?.previous_auditor_frn ?? "",
      letterSentOn: record?.letter_sent_on ?? today,
      sentVia: (record?.sent_via as SentVia | null) ?? "",
      deliveryProofDocumentId: record?.delivery_proof_document_id ?? "",
      replyReceivedOn: record?.reply_received_on ?? "",
      objections: record?.objections ?? "",
      outcome: (record?.outcome as PreviousAuditorOutcome | null) ?? "",
      notes: record?.notes ?? "",
    },
    successMessage: record ? "Letter updated" : "Letter recorded",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const clientId = f.form.watch("clientId")

  const loadClients = React.useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await searchAuditClients({ q })
    return r.ok ? r.data : []
  }, [])
  const loadDocs = React.useCallback(
    async (q: string): Promise<ComboOption[]> => {
      if (!clientId) return []
      const r = await searchEvidenceDocs({ clientId, q })
      return r.ok ? r.data : []
    },
    [clientId],
  )

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="lg"
      title={record ? "Letter to the previous auditor" : "Record the letter to the previous auditor"}
      description="Clause 8: write to the outgoing auditor before accepting the audit, keep proof of delivery, and record the reply or that none came."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={record ? "Save" : "Record letter"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {client ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Client</span>
            <span className="text-base text-text">{client.label}</span>
          </div>
        ) : (
          <ComboboxField control={f.control} name="clientId" label="Client" required loadOptions={loadClients} placeholder="Search by name or code" searchPlaceholder="Name or client code" />
        )}
        <SelectField control={f.control} name="engagementType" label="For the audit" required options={AUDIT_TYPES.map((t) => ({ value: t, label: AUDIT_TYPE_LABELS[t] }))} disabled={Boolean(engagement)} />
        <TextField control={f.control} name="previousAuditorName" label="Previous auditor" required placeholder="Firm or member's name" autoComplete="off" />
        <TextField control={f.control} name="previousAuditorFrn" label="FRN or membership no." autoCapitalize="characters" autoComplete="off" />
        <DateField control={f.control} name="letterSentOn" label="Letter sent on" required max={today} />
        <SelectField control={f.control} name="sentVia" label="Sent by" options={SENT_VIA.map((s) => ({ value: s, label: SENT_VIA_LABELS[s] }))} placeholder="Choose how" helper="Registered post (AD) or an email with a delivery receipt gives the clearest proof." />
        <ComboboxField
          control={f.control}
          name="deliveryProofDocumentId"
          label="Proof of delivery"
          className="md:col-span-2"
          loadOptions={loadDocs}
          selectedLabel={proofLabel}
          placeholder={clientId ? "Choose from the client's documents" : "Choose the client first"}
          disabled={!clientId}
          helper="The AD card, the postal tracking page or the email's delivery acknowledgement."
        />
        {clientId ? (
          <div className="md:col-span-2">
            <DocumentUploader
              clientId={clientId}
              purpose="new_document"
              single
              defaults={{ category: "audit", financialYear: engagement?.financialYear ?? "", title: "Previous auditor letter: proof of delivery" }}
              fields="none"
              buttonLabel="Upload the proof"
              dropzoneLabel="Or drop the acknowledgement here"
              onUploaded={(done) => {
                const doc = done[0]
                if (!doc) return
                setProofLabel(doc.title)
                f.form.setValue("deliveryProofDocumentId", doc.documentId, { shouldDirty: true, shouldValidate: true })
              }}
            />
          </div>
        ) : null}
        <DateField control={f.control} name="replyReceivedOn" label="Reply received on" max={today} helper="Leave blank while no reply has come." />
        <SelectField control={f.control} name="outcome" label="Outcome" options={PREVIOUS_AUDITOR_OUTCOMES.map((o) => ({ value: o, label: PREVIOUS_AUDITOR_OUTCOME_LABELS[o] }))} placeholder="Not known yet" />
        <TextareaField control={f.control} name="objections" label="Objections raised" rows={2} className="md:col-span-2" helper="Professional reasons the outgoing auditor gave, such as unpaid audit fees or a disagreement with management." />
        <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
      </div>
    </FormDialog>
  )
}
