"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useFieldArray } from "react-hook-form"
import { BadgeCheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Explain } from "@/components/app/explain"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, ComboboxField, DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import type { EntityType } from "@/lib/domain/enums"
import { todayIST } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import {
  KYC_CATEGORIES,
  KYC_CATEGORY_LABELS,
  KYC_ENGAGEMENT_TYPES,
  KYC_ENGAGEMENT_TYPE_LABELS,
  PRINCIPAL_ROLES,
  SaveKycSchema,
  VerifyKycSchema,
  defaultNextReview,
  principalPersonsLabel,
  type SaveKycInput,
} from "@/lib/schemas/client-kyc"
import type { KycCategory } from "@/lib/domain/ceiling"
import { saveClientKyc, verifyClientKyc } from "@/server/actions/client-kyc"

/**
 * Edit KYC and Mark verified (§6.8 KYC Norms; Partner/Manager only). The form asks for what the
 * category needs: everyone's name, PAN, business description, last audited financial statements and
 * engagement type; a corporate adds its CIN/LLPIN and each director's name, address and DIN; a
 * non-corporate entity each partner's or trustee's name, address and PAN or DIN. Aadhaar is never
 * stored in full: only its last 4 digits (§6.10). Verifying needs a complete record and sets the
 * annual review.
 */
export function KycActions({
  clientId,
  clientName,
  entityType,
  defaults,
  documents,
  complete,
  updatedAt,
  verified,
}: {
  clientId: string
  clientName: string
  entityType: EntityType | null
  defaults: SaveKycInput
  documents: Array<{ id: string; label: string; description?: string }>
  complete: boolean
  /** client_kyc.updated_at, or null when there is no record yet. */
  updatedAt: string | null
  verified: boolean
}) {
  const [editing, setEditing] = React.useState(false)
  const [verifying, setVerifying] = React.useState(false)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
        <PencilIcon aria-hidden="true" />
        {updatedAt ? "Edit KYC" : "Start KYC"}
      </Button>
      {updatedAt && complete ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setVerifying(true)}>
          <BadgeCheckIcon aria-hidden="true" />
          {verified ? "Re-confirm" : "Mark verified"}
        </Button>
      ) : updatedAt ? (
        <Explain content={<p>Complete the missing KYC details first: they are listed in this section.</p>}>
          <Button type="button" variant="ghost" size="sm" aria-disabled="true" className="cursor-not-allowed text-text-muted hover:bg-transparent hover:text-text-muted">
            <BadgeCheckIcon aria-hidden="true" />
            Mark verified
          </Button>
        </Explain>
      ) : null}
      <KycDialog open={editing} onOpenChange={setEditing} clientName={clientName} entityType={entityType} defaults={defaults} documents={documents} />
      {updatedAt ? <VerifyDialog open={verifying} onOpenChange={setVerifying} clientId={clientId} clientName={clientName} updatedAt={updatedAt} /> : null}
    </div>
  )
}

function KycDialog({
  open,
  onOpenChange,
  clientName,
  entityType,
  defaults,
  documents,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  clientName: string
  entityType: EntityType | null
  defaults: SaveKycInput
  documents: Array<{ id: string; label: string; description?: string }>
}) {
  const router = useRouter()
  const f = useActionForm(SaveKycSchema, saveClientKyc, {
    defaultValues: defaults,
    successMessage: (d) => (d.complete ? "KYC saved: complete." : `KYC saved. Still missing: ${d.missing.join(", ")}.`),
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the record as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults.updatedAt])
  const people = useFieldArray({ control: f.control, name: "principalPersons" })
  const category = (f.form.watch("entityCategory") ?? "individual_proprietor") as KycCategory
  const peopleLabel = principalPersonsLabel(category, entityType)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="KYC"
      description={`${clientName}, under the ICAI KYC Norms for attest engagements. Re-confirmed every year.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save KYC"
      size="lg"
    >
      <div className="flex flex-col gap-6">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={f.control} name="entityCategory" label="Category" required options={KYC_CATEGORIES.map((c) => ({ value: c, label: KYC_CATEGORY_LABELS[c] }))} />
          <TextField control={f.control} name="pan" label="PAN" autoCapitalize="characters" maxLength={10} />
          {category === "corporate" ? (
            <TextField control={f.control} name="cinLlpin" label={entityType === "llp" ? "LLPIN" : "CIN"} autoCapitalize="characters" maxLength={21} helper="U74999KA2020PTC123456 or AAB-1234." />
          ) : null}
          <ComboboxField
            control={f.control}
            name="lastAuditedFsDocumentId"
            label="Last audited financial statements"
            options={documents.map((d) => ({ value: d.id, label: d.label, description: d.description }))}
            placeholder={documents.length ? "Choose the document" : "Upload it in Documents first"}
            emptyText="No matching document."
            helper="From this client's documents."
            className={category === "corporate" ? undefined : "md:col-span-1"}
          />
          <TextareaField control={f.control} name="businessDescription" label="Business description" rows={3} maxLength={2000} className="md:col-span-2" />
          <TextareaField control={f.control} name="registeredAddress" label="Registered address" rows={2} maxLength={500} className="md:col-span-2" />
        </div>

        <CheckboxGroupField
          control={f.control}
          name="engagementTypes"
          label="Engagement types"
          helper="The attest work this KYC is for."
          options={KYC_ENGAGEMENT_TYPES.map((t) => ({ value: t, label: KYC_ENGAGEMENT_TYPE_LABELS[t] }))}
          columns={2}
        />

        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="text-base font-semibold text-text">{peopleLabel}</legend>
          <p className="-mt-2 text-sm text-text-muted">
            {category === "corporate"
              ? "Each director's (or designated partner's) name, address and DIN."
              : category === "non_corporate"
                ? "Each partner's or trustee's name, address and PAN or DIN."
                : "Optional for an individual or proprietor."}{" "}
            Never the full Aadhaar number: only its last 4 digits.
          </p>
          {people.fields.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">No one added yet.</p> : null}
          <ol className="flex flex-col gap-3">
            {people.fields.map((p, i) => (
              <li key={p.id} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">Person {i + 1}</span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove person ${i + 1}`} onClick={() => people.remove(i)}>
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <TextField control={f.control} name={`principalPersons.${i}.name`} label="Name" required maxLength={120} />
                  <SelectField control={f.control} name={`principalPersons.${i}.role`} label="Role" options={PRINCIPAL_ROLES.map((r) => ({ value: r, label: r }))} />
                  <TextField control={f.control} name={`principalPersons.${i}.aadhaarLast4`} label="Aadhaar, last 4 digits" inputMode="numeric" maxLength={4} />
                  <TextField control={f.control} name={`principalPersons.${i}.pan`} label="PAN" autoCapitalize="characters" maxLength={10} />
                  <TextField control={f.control} name={`principalPersons.${i}.din`} label="DIN" inputMode="numeric" maxLength={8} />
                  <TextField control={f.control} name={`principalPersons.${i}.address`} label="Address" maxLength={500} className="md:col-span-3" />
                </div>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => people.append({ name: "", role: "", address: "", pan: "", din: "", aadhaarLast4: "" })}
            disabled={people.fields.length >= 50}
          >
            <PlusIcon aria-hidden="true" />
            Add person
          </Button>
        </fieldset>

        <DateField control={f.control} name="nextReviewOn" label="Next review" helper="Set a year after verification when you mark it verified." />
      </div>
    </FormDialog>
  )
}

function VerifyDialog({ open, onOpenChange, clientId, clientName, updatedAt }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; clientName: string; updatedAt: string }) {
  const router = useRouter()
  const today = todayIST()
  const defaults = { clientId, updatedAt, verifiedOn: today, nextReviewOn: defaultNextReview(today) }
  const f = useActionForm(VerifyKycSchema, verifyClientKyc, {
    defaultValues: defaults,
    successMessage: "KYC marked verified.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])
  const verifiedOn = f.form.watch("verifiedOn")
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark KYC verified"
      description={`You confirm ${clientName}'s KYC details against the documents. Your name and the date are recorded.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Mark verified"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <DateField control={f.control} name="verifiedOn" label="Verified on" required max={today} />
        <DateField
          control={f.control}
          name="nextReviewOn"
          label="Next review"
          helper={typeof verifiedOn === "string" && verifiedOn ? `KYC is re-confirmed every year: ${formatDate(defaultNextReview(verifiedOn))} by default.` : undefined}
        />
      </div>
    </FormDialog>
  )
}
