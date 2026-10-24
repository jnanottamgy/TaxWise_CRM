"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useWatch, type Control } from "react-hook-form"
import { CircleAlertIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, SwitchField, TextareaField, TextField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { useActionForm } from "@/hooks/use-action-form"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { cn } from "@/lib/utils"
import { recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { FORM_26_CATEGORIES } from "@/lib/domain/ceiling"
import {
  CreateUdinSchema,
  FORM_26_CATEGORY_LABEL,
  REPORT_FORM_LABEL,
  UDIN_DOCUMENT_TYPES,
  reportFormsFor,
  type CreateUdinInput,
} from "@/lib/schemas/registers"
import type { UdinRow } from "@/lib/data/registers"
import { checkUdin, createUdin, loadUdinLinks, updateUdin, type UdinCheck } from "@/server/actions/udin"
import { ClientPickerField } from "@/components/registers/shared"

export type SigningMember = { id: string; name: string; membershipNo: string | null }

const DOC_OPTIONS = UDIN_DOCUMENT_TYPES.map((d) => ({ value: d, label: d }))
const CATEGORY_OPTIONS = FORM_26_CATEGORIES.map((c) => ({ value: c, label: FORM_26_CATEGORY_LABEL[c] }))

/** Prefill for "Log UDIN" from a signed report that has none (the UDIN tab's list). */
export type UdinPrefill = { clientId: string; clientName: string; auditEngagementId: string; signedOn: string; documentType: CreateUdinInput["documentType"]; financialYear: string | null; signingPartnerId: string | null }

function ConfirmField({ control, message }: { control: Control<CreateUdinInput>; message: string }) {
  const { field, fieldState } = useController({ control, name: "confirmOverCeiling" })
  const { ref: fieldRef, value: fieldValue, onChange } = field
  const id = React.useId()
  return (
    <div className={cn("mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2.5", fieldState.error ? "border-danger/40 bg-danger-soft" : "border-warning/40 bg-warning-soft")}>
      <Checkbox id={id} ref={fieldRef} checked={fieldValue === true} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" aria-describedby={`${id}-msg`} />
      <label htmlFor={id} className="min-w-0 cursor-pointer text-sm text-text">
        <span className="font-medium">I confirm logging this tax audit over the ICAI ceiling.</span>
        <span id={`${id}-msg`} className="block text-text-muted">
          {fieldState.error?.message ?? message}
        </span>
      </label>
    </div>
  )
}

/**
 * Log or edit a UDIN (§7.15.1, §6.2, §6.8): the UDIN (checked as typed: 18 characters, the year
 * digits, the signing partner's membership number in characters 3–8 [verify]), client, document
 * type, report form (it decides whether the report counts towards the tax-audit ceiling), the FY it
 * covers, signed and generated dates (warned past 60 days), signing partner, the linked filing or
 * audit engagement, revised, remarks. While it is typed, the panel shows where the report puts the
 * partner against the ceiling: warned at 50 and 58; a 61st needs a Partner to confirm it, and the
 * database refuses it otherwise.
 */
export function UdinDialog({
  open,
  onOpenChange,
  row,
  fixedClient,
  prefill,
  members,
  isPartner,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  row?: UdinRow | null
  fixedClient?: { id: string; name: string } | null
  prefill?: UdinPrefill | null
  members: SigningMember[]
  isPartner: boolean
}) {
  const router = useRouter()
  const editing = Boolean(row)
  const submit = React.useCallback(
    async (input: CreateUdinInput) => {
      if (row) {
        const r = await updateUdin({ ...input, id: row.id, updatedAt: row.updated_at })
        return r
      }
      return createUdin(input)
    },
    [row],
  )
  const today = todayIST()
  const defaultMember = row?.signing_partner_id ?? prefill?.signingPartnerId ?? (members.length === 1 ? members[0].id : "")
  const f = useActionForm(CreateUdinSchema, submit, {
    defaultValues: {
      udin: row?.udin ?? "",
      clientId: row?.client_id ?? prefill?.clientId ?? fixedClient?.id ?? "",
      documentType: (row?.document_type as CreateUdinInput["documentType"]) ?? prefill?.documentType ?? "Tax Audit Report",
      reportForm: (row?.report_form as CreateUdinInput["reportForm"]) ?? "",
      form26Category: (row?.form26_category as CreateUdinInput["form26Category"]) ?? "",
      financialYear: row?.financial_year ?? prefill?.financialYear ?? "",
      signedOn: row?.signed_on ?? prefill?.signedOn ?? "",
      generatedOn: row?.generated_on ?? today,
      signingPartnerId: defaultMember,
      filingRecordId: row?.filing_record_id ?? "",
      auditEngagementId: row?.audit_engagement_id ?? prefill?.auditEngagementId ?? "",
      isRevised: row?.is_revised ?? false,
      remarks: row?.remarks ?? "",
      confirmOverCeiling: false,
    },
    successMessage: editing ? "UDIN updated" : "UDIN logged",
    onSuccess: () => {
      onOpenChange(false)
      if (!editing) f.form.reset()
      router.refresh()
    },
  })

  const values = useWatch({ control: f.control })
  const clientId = (values.clientId as string | null | undefined) || null
  const docType = values.documentType as string
  const reportForm = (values.reportForm as string) || ""
  const formOptions = reportFormsFor(docType).map((r) => ({ value: r, label: REPORT_FORM_LABEL[r] }))
  if (reportForm && !formOptions.some((o) => o.value === reportForm)) formOptions.push({ value: reportForm as (typeof formOptions)[number]["value"], label: REPORT_FORM_LABEL[reportForm as keyof typeof REPORT_FORM_LABEL] ?? reportForm })
  const fyOptions = recentFinancialYears(today, 6).map((fy) => ({ value: fy, label: `FY ${fy}` }))
  const memberOptions = members.map((m) => ({ value: m.id, label: m.name, description: m.membershipNo ? `M. No. ${m.membershipNo}` : "Membership no. not set" }))

  // The client's filings and audit engagements, for the links.
  const [loadedLinks, setLinks] = React.useState<{ clientId: string; filings: ComboOption[]; engagements: ComboOption[] } | null>(null)
  const links = loadedLinks && loadedLinks.clientId === clientId ? loadedLinks : null
  React.useEffect(() => {
    if (!clientId) return
    let live = true
    loadUdinLinks({ clientId })
      .then((r) => {
        if (live) setLinks({ clientId, ...(r.ok ? r.data : { filings: [], engagements: [] }) })
      })
      .catch(() => {
        if (live) setLinks({ clientId, filings: [], engagements: [] })
      })
    return () => {
      live = false
    }
  }, [clientId])

  // The live check: shape, membership number, 60 days, ceiling position.
  const [check, setCheck] = React.useState<UdinCheck | null>(null)
  const runCheck = useDebouncedCallback(async (v: typeof values) => {
    try {
      const r = await checkUdin({
        udin: String(v.udin ?? "").trim(),
        signingPartnerId: (v.signingPartnerId as string) || null,
        signedOn: String(v.signedOn ?? ""),
        generatedOn: String(v.generatedOn ?? ""),
        reportForm: String(v.reportForm ?? ""),
        form26Category: String(v.form26Category ?? ""),
        isRevised: Boolean(v.isRevised),
        clientId: (v.clientId as string) || null,
        financialYear: String(v.financialYear ?? ""),
        recordId: row?.id ?? null,
      })
      setCheck(r.ok ? r.data : null)
    } catch {
      setCheck(null)
    }
  }, 350)
  const checkKey = [values.udin, values.signingPartnerId, values.signedOn, values.generatedOn, values.reportForm, values.form26Category, values.isRevised, values.clientId, values.financialYear].join("|")
  React.useEffect(() => {
    if (!open) return
    runCheck(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, open])

  const ceiling = check?.ceiling ?? null
  const needsConfirm = ceiling?.level === "confirm"
  const clientName = row?.client_name ?? prefill?.clientName ?? fixedClient?.name ?? null

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? `Edit UDIN ${row?.udin}` : "Log a UDIN"}
      description={clientName ? `For ${clientName}` : "Every report and certificate a member signs gets a UDIN within 60 days of signing."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={editing ? "Save changes" : "Log UDIN"}
      submitDisabled={needsConfirm && !isPartner}
      footerStart={needsConfirm && !isPartner ? "A Partner must log this one." : undefined}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField
          control={f.control}
          name="udin"
          label="UDIN"
          required
          autoCapitalize="characters"
          spellCheck={false}
          autoComplete="off"
          className="md:col-span-2"
          helper={check?.udinError ? <span className="text-danger-text">{check.udinError}</span> : "18 characters: the year, the 6-digit membership number, then 10 letters or digits."}
        />
        {clientName && (fixedClient || prefill || row) ? (
          <p className="text-sm text-text-muted md:col-span-2">
            Client: <span className="font-medium text-text">{clientName}</span>
          </p>
        ) : (
          <div className="md:col-span-2">
            <ClientPickerField control={f.control} name="clientId" required={false} helper="Leave empty for a firm-level certificate." />
          </div>
        )}
        <SelectField control={f.control} name="documentType" label="Document type" required options={DOC_OPTIONS} />
        <SelectField
          control={f.control}
          name="reportForm"
          label="Report form"
          required={docType === "Tax Audit Report"}
          options={formOptions}
          placeholder="Choose the form"
          helper={check?.counts === true ? "Counts towards the tax-audit ceiling." : check?.counts === false ? "Doesn't count towards the tax-audit ceiling." : undefined}
        />
        {reportForm === "FORM_26" ? <SelectField control={f.control} name="form26Category" label="Form 26 category" required options={CATEGORY_OPTIONS} helper="Which s.44AB clause it corresponds to [verify]." className="md:col-span-2" /> : null}
        <SelectField control={f.control} name="financialYear" label="FY the report covers" options={fyOptions} placeholder="Choose the FY" helper="Head office and branch reports of the same assessee and year count once." />
        <ComboboxField control={f.control} name="signingPartnerId" label="Signing partner" required options={memberOptions} placeholder="Choose the partner" clearable={false} />
        <DateField control={f.control} name="signedOn" label="Signed on" required max={today} />
        <DateField control={f.control} name="generatedOn" label="UDIN generated on" required max={today} />
        {clientId ? (
          <>
            <ComboboxField control={f.control} name="filingRecordId" label="Linked filing" options={links?.filings ?? []} placeholder={links ? (links.filings.length ? "Choose a filing" : "No filings on record") : "Loading…"} emptyText="No filing matches." />
            <ComboboxField control={f.control} name="auditEngagementId" label="Linked audit engagement" options={links?.engagements ?? []} placeholder={links ? (links.engagements.length ? "Choose an engagement" : "No audit engagements") : "Loading…"} emptyText="No engagement matches." />
          </>
        ) : null}
      </div>
      <SwitchField control={f.control} name="isRevised" label="Revised report" description="A revised report never counts separately towards the ceiling." className="mt-4" />
      <TextareaField control={f.control} name="remarks" label="Remarks" className="mt-4" rows={2} />

      {check && (check.warnings.length || ceiling) ? (
        <div className="mt-4 flex flex-col gap-2" aria-live="polite">
          {check.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
              {w}
            </p>
          ))}
          {ceiling ? (
            <div className={cn("rounded-md border px-3 py-2.5 text-sm", ceiling.level === "ok" ? "border-border bg-surface-2" : ceiling.level === "warn" ? "border-warning/40 bg-warning-soft" : "border-danger/40 bg-danger-soft")}>
              <p className="flex items-start gap-2 text-text">
                {ceiling.level === "ok" ? null : <CircleAlertIcon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", ceiling.level === "warn" ? "text-warning-text" : "text-danger-text")} />}
                <span>
                  {ceiling.adds ? (
                    <>
                      Tax audit <span className="num font-semibold">{ceiling.position}</span> of <span className="num">{ceiling.ceiling}</span> for this partner in FY {ceiling.fy}, counting audits signed elsewhere.
                    </>
                  ) : (
                    <>Already counted: {ceiling.total} of {ceiling.ceiling} in FY {ceiling.fy}.</>
                  )}
                  {ceiling.message ? <span className="block text-text-muted">{ceiling.message}</span> : null}
                </span>
              </p>
              {needsConfirm && isPartner ? <ConfirmField control={f.control} message="Only a Partner can confirm it, and the confirmation is recorded with your name." /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </FormDialog>
  )
}

export function LogUdinButton({ members, isPartner, fixedClient, variant = "default", label = "Log UDIN" }: { members: SigningMember[]; isPartner: boolean; fixedClient?: { id: string; name: string } | null; variant?: "default" | "outline"; label?: string }) {
  const [open, setOpen] = React.useState(false)
  const usable = members.length > 0
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)} disabled={!usable} title={usable ? undefined : "There is no active Partner to name as the signing member yet."}>
        <PlusIcon aria-hidden="true" />
        {label}
      </Button>
      {open ? <UdinDialog open={open} onOpenChange={setOpen} members={members} isPartner={isPartner} fixedClient={fixedClient} /> : null}
    </>
  )
}
