"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { FilingSchema, NONE } from "@/lib/schemas/compliance"
import { recordComplianceFiling } from "@/server/actions/compliance"
import { DocumentUploader } from "@/components/documents/uploader"
import { formatDate } from "@/lib/format"
import { financialYearOf } from "@/lib/domain/fy"
import type { EventDetail } from "@/lib/data/compliance"

/**
 * Filing capture for a deadline (§7.6.5, §7.7 "Filing an event without a linked filing record
 * prompts for the §7.6.5 details"): return / form*, period*, FY*, filed on*, the acknowledgement /
 * ARN / SRN number, the acknowledgement PDF (uploaded into the client's vault here, or one already
 * there), a UDIN when a certificate or report was signed, and notes. Or link a filing record that
 * already exists (imported from a previous CA, or recorded from the task). Saving creates the
 * filing record and marks the deadline Filed (or Completed). Partners and Managers only (0126).
 */
export function FilingDialog({
  open,
  onOpenChange,
  detail,
  today,
  complete = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: EventDetail
  today: string
  /** Mark Completed rather than Filed. */
  complete?: boolean
}) {
  const router = useRouter()
  const e = detail.event
  const [uploaded, setUploaded] = React.useState<Array<{ id: string; title: string }>>([])

  const f = useActionForm(FilingSchema, recordComplianceFiling, {
    defaultValues: {
      eventId: e.id,
      expectedUpdatedAt: e.updated_at,
      filingRecordId: NONE,
      filingType: e.form_code ?? e.title,
      period: e.filing_period ?? "",
      financialYear: e.financial_year ?? financialYearOf(e.due_date),
      filedOn: today,
      acknowledgementNo: "",
      documentId: NONE,
      udinRecordId: NONE,
      notes: "",
      shareableWithClient: true,
      complete,
      today,
    },
    successMessage: (d) => (d.onTime ? "Filing recorded. Filed on time." : "Filing recorded."),
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })

  const linked = useWatch({ control: f.control, name: "filingRecordId" })
  const linking = Boolean(linked) && linked !== NONE
  const docOptions = [
    { value: NONE, label: "No acknowledgement attached" },
    ...uploaded.map((d) => ({ value: d.id, label: `${d.title} (just uploaded)` })),
    ...detail.documents.map((d) => ({ value: d.id, label: `${d.title} · ${formatDate(d.created_at)}` })),
  ]
  const udinOptions = [{ value: NONE, label: "No UDIN" }, ...detail.udins.map((u) => ({ value: u.id, label: `${u.udin} · ${u.document_type}, ${formatDate(u.document_date)}` }))]
  const linkOptions = [
    { value: NONE, label: "Enter the filing details" },
    ...detail.unlinkedFilings.map((r) => ({
      value: r.id,
      label: `${r.filing_type}${r.period ? ` · ${r.period}` : ""} · FY ${r.financial_year}${r.filed_on ? ` · filed ${formatDate(r.filed_on)}` : ""}${r.acknowledgement_no ? ` · ${r.acknowledgement_no}` : ""}`,
    })),
  ]

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={complete ? "Record the filing and close" : "Record the filing"}
      description={`${e.title}${detail.client ? ` · ${detail.client.client_code} · ${detail.client.display_name}` : ""} · due ${formatDate(e.due_date)}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={complete ? "Save and mark completed" : "Save and mark filed"}
    >
      <FormAlert state={f} />
      {detail.unlinkedFilings.length > 0 ? (
        <SelectField
          control={f.control}
          name="filingRecordId"
          label="Filing record"
          helper="Pick one already recorded for this client (for example imported from the previous CA), or enter the details."
          options={linkOptions}
          className="mb-4"
        />
      ) : null}
      {linking ? null : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={f.control} name="filingType" label="Return or form" required helper="As filed, for example GSTR-3B, ITR-6, 26Q, AOC-4." />
          <TextField control={f.control} name="period" label="Period" required helper="Sep 2026, Q2 2026-27 or FY 2025-26." />
          <TextField control={f.control} name="financialYear" label="Financial year" required helper="YYYY-YY, for example 2026-27." inputMode="numeric" />
          <DateField control={f.control} name="filedOn" label="Filed on" required max={today} />
          <TextField
            control={f.control}
            name="acknowledgementNo"
            label="Acknowledgement / ARN / SRN no."
            helper="From the portal's acknowledgement."
            autoCapitalize="characters"
            className="md:col-span-2"
          />
          <div className="md:col-span-2">
            <SelectField control={f.control} name="documentId" label="Acknowledgement PDF" options={docOptions} helper="Upload it below, or pick one already in the client's documents." />
            {detail.client ? (
              <DocumentUploader
                className="mt-3"
                clientId={detail.client.id}
                purpose="new_document"
                single
                buttonLabel="Upload acknowledgement"
                dropzoneLabel="Drop the acknowledgement PDF here"
                defaults={{
                  title: `${e.form_code ?? e.title} acknowledgement${e.filing_period ? ` ${e.filing_period}` : ""}`,
                  category: "acknowledgements",
                  financialYear: e.financial_year ?? "",
                  period: e.filing_period ?? "",
                }}
                onUploaded={(done) => {
                  const doc = done[0]
                  if (!doc) return
                  setUploaded((list) => [{ id: doc.documentId, title: doc.title }, ...list.filter((x) => x.id !== doc.documentId)])
                  f.form.setValue("documentId", doc.documentId, { shouldDirty: true })
                }}
              />
            ) : null}
          </div>
          {detail.udins.length > 0 ? (
            <SelectField control={f.control} name="udinRecordId" label="UDIN" helper="If a certificate or report was signed for this filing." options={udinOptions} className="md:col-span-2" />
          ) : null}
          <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
          <SwitchField
            control={f.control}
            name="shareableWithClient"
            label="Show the acknowledgement in the client portal"
            description="The client can download it from Compliance in their portal."
            className="md:col-span-2"
          />
        </div>
      )}
      <SwitchField
        control={f.control}
        name="complete"
        label="Mark completed"
        description="Filed and closed, with nothing left to do. Leave off to mark it Filed."
        className="mt-4"
      />
    </FormDialog>
  )
}
