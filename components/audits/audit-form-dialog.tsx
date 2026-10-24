"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, SelectField, SwitchField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { AUDIT_TYPES, AUDIT_TYPE_LABELS, taxAuditReportForm, type AuditStage } from "@/lib/domain/audit-stages"
import { taxYearLabel } from "@/lib/domain/fy"
import { CreateAuditSchema, UpdateAuditSchema } from "@/lib/schemas/audits"
import { createAudit, searchAuditClients, updateAudit } from "@/server/actions/audits"
import type { ComboOption } from "@/components/app/form/combobox"

export type StaffChoice = { value: string; label: string; description?: string }

const TYPE_OPTIONS = AUDIT_TYPES.map((t) => ({ value: t, label: AUDIT_TYPE_LABELS[t] }))
const YES_NO = [
  { value: "yes", label: "Yes, another CA was the auditor" },
  { value: "no", label: "No, this is the first audit by a CA" },
]

const triOut = (v: boolean | null | undefined): "" | "yes" | "no" => (v === true ? "yes" : v === false ? "no" : "")

function YearHint({ control }: { control: unknown }) {
  const [type, fy] = useWatch({ control: control as never, name: ["auditType", "financialYear"] as never }) as unknown as [string, string]
  if (type !== "tax_audit" || !fy) return null
  return (
    <p className="text-sm text-text-muted">
      {taxYearLabel(fy)}: the report goes in {taxAuditReportForm(fy)}.
    </p>
  )
}

/**
 * Open an audit engagement (§6.9, §7.15.5), or change its details. It starts at Acceptance: KYC,
 * the conflict check, the previous auditor (Clause 8), the SA 210 letter, the peer review
 * certificate and the ceilings are checked before it can move on. The type, year and acceptance
 * answers are fixed once it is past Acceptance; only a Partner changes the engagement partner.
 */
export function AuditFormDialog(
  props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    partners: StaffChoice[]
    reviewers: StaffChoice[]
    fyOptions: string[]
    canChangePartner: boolean
  } & (
    | { mode: "create"; client?: { id: string; label: string } | null; defaultFy: string; defaultPartnerId?: string | null }
    | {
        mode: "edit"
        engagement: {
          id: string
          updatedAt: string
          stage: AuditStage
          auditType: string
          financialYear: string
          engagementPartnerId: string
          reviewManagerId: string | null
          hadPreviousAuditor: boolean | null
          requiresPeerReviewedAuditor: boolean
          notes: string | null
        }
      }
  ),
) {
  const router = useRouter()
  const { open, onOpenChange, partners, reviewers, fyOptions, canChangePartner } = props
  const create = props.mode === "create"
  const locked = props.mode === "edit" && props.engagement.stage !== "acceptance"

  const createForm = useActionForm(CreateAuditSchema, createAudit, {
    defaultValues:
      props.mode === "create"
        ? {
            clientId: props.client?.id ?? "",
            auditType: "statutory_companies_act",
            financialYear: props.defaultFy,
            engagementPartnerId: props.defaultPartnerId ?? partners[0]?.value ?? "",
            reviewManagerId: "",
            hadPreviousAuditor: "",
            requiresPeerReviewedAuditor: false,
            notes: "",
          }
        : undefined,
    successMessage: "Engagement opened at Acceptance",
    onSuccess: ({ id }) => {
      onOpenChange(false)
      router.push(`/audits/${id}`)
    },
  })
  const editForm = useActionForm(UpdateAuditSchema, updateAudit, {
    defaultValues:
      props.mode === "edit"
        ? {
            id: props.engagement.id,
            updatedAt: props.engagement.updatedAt,
            auditType: props.engagement.auditType as (typeof AUDIT_TYPES)[number],
            financialYear: props.engagement.financialYear,
            engagementPartnerId: props.engagement.engagementPartnerId,
            reviewManagerId: props.engagement.reviewManagerId ?? "",
            hadPreviousAuditor: triOut(props.engagement.hadPreviousAuditor),
            requiresPeerReviewedAuditor: props.engagement.requiresPeerReviewedAuditor,
            notes: props.engagement.notes ?? "",
          }
        : undefined,
    successMessage: "Engagement updated",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const f = (create ? createForm : editForm) as unknown as typeof editForm
  const control = f.control

  const loadClients = React.useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await searchAuditClients({ q })
    return r.ok ? r.data : []
  }, [])

  const yearOptions = fyOptions.map((y) => ({ value: y, label: `FY ${y}` }))
  const partnerHelp = canChangePartner ? "An active Partner. They approve every stage move." : "Only a Partner can change the engagement partner."

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={create ? "New audit engagement" : "Engagement details"}
      description={
        create
          ? "It starts at Acceptance. KYC, the conflict check, the previous auditor and the SA 210 letter come before Planning."
          : locked
            ? "The audit type, year and acceptance answers are fixed now the engagement is past Acceptance."
            : "Change the team or the acceptance answers."
      }
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={create ? "Open engagement" : "Save"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {create ? (
          props.client ? (
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-sm font-medium text-text">Client</span>
              <span className="text-base text-text">{props.client.label}</span>
            </div>
          ) : (
            <ComboboxField
              control={createForm.control}
              name="clientId"
              label="Client"
              required
              className="md:col-span-2"
              loadOptions={loadClients}
              placeholder="Search by name or code"
              searchPlaceholder="Name or client code"
              emptyText="No current client matches."
            />
          )
        ) : null}
        <SelectField control={control} name="auditType" label="Type of audit" required options={TYPE_OPTIONS} disabled={locked} />
        <SelectField control={control} name="financialYear" label="Financial year" required options={yearOptions} disabled={locked} />
        <div className="md:col-span-2">
          <YearHint control={control} />
        </div>
        <SelectField
          control={control}
          name="engagementPartnerId"
          label="Engagement partner"
          required
          options={partners}
          disabled={!create && !canChangePartner}
          helper={partnerHelp}
        />
        <SelectField
          control={control}
          name="reviewManagerId"
          label="Review manager"
          options={reviewers}
          placeholder="Nobody named yet"
          helper="A Partner or Manager other than the engagement partner."
        />
        <SelectField
          control={control}
          name="hadPreviousAuditor"
          label="Previous auditor"
          options={YES_NO}
          placeholder="Not answered yet"
          className="md:col-span-2"
          disabled={locked}
          helper="If another CA held the position, the letter to them with proof of delivery is needed before Planning (Clause 8)."
        />
        <SwitchField
          control={control}
          name="requiresPeerReviewedAuditor"
          label="The entity needs a peer-reviewed auditor"
          description="Listed entities, large unlisted public companies and other public-interest entities. The firm's certificate must be valid on the acceptance date."
          className="md:col-span-2"
          disabled={locked}
        />
        <TextareaField control={control} name="notes" label="Notes" rows={3} className="md:col-span-2" />
      </div>
    </FormDialog>
  )
}
