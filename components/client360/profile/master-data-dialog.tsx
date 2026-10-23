"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Checkbox } from "@/components/ui/checkbox"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, MoneyField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { CLIENT_PRIORITIES, ENTITY_TYPES, ENTITY_TYPE_LABELS, GST_REGISTRATIONS, GST_REGISTRATION_LABELS, type EntityType } from "@/lib/domain/enums"
import { deriveFromGstin, stateOptions, validatePan } from "@/lib/domain/india-validators"
import { gstSchemeDecision } from "@/lib/domain/scale"
import { parseAmount, type Paise } from "@/lib/domain/money"
import { recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { getStatus } from "@/lib/status"
import { MONTH_NAMES, MasterDataSchema, type MasterDataInput } from "@/components/client360/logic/master-data"
import { updateMasterData } from "@/server/actions/client-profile"

const STATES = stateOptions().map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))

/**
 * Edit the master data (§7.3.3 Profile & contacts: "edit form = step 1 fields"): identity, tax
 * registrations, contact, scale, priority and notes, validated like the wizard (§6.2). A valid
 * GSTIN shows its state and PAN at once and fills them when empty; the PAN's holder type is checked
 * against the entity type (a warning, never a block); the GST scheme line explains the decision
 * live (§6.6). Saves with optimistic concurrency (§13).
 */
export function MasterDataDialog({
  open,
  onOpenChange,
  defaults,
  clientName,
  qrmpMaxTurnoverPaise,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaults: MasterDataInput
  clientName: string
  qrmpMaxTurnoverPaise: Paise
}) {
  const router = useRouter()
  const f = useActionForm(MasterDataSchema, updateMasterData, {
    defaultValues: defaults,
    successMessage: (d) => (d.changed.length === 0 ? "Nothing changed." : "Details saved."),
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the row as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults.updatedAt])

  const v = f.form.watch()
  const [sameAsPhone, setSameAsPhone] = React.useState(false)
  React.useEffect(() => {
    if (sameAsPhone) f.form.setValue("whatsapp", v.phone ?? "", { shouldDirty: true })
  }, [sameAsPhone, v.phone, f.form])

  const gst = v.gstin ? deriveFromGstin(String(v.gstin)) : null
  const pan = v.pan ? validatePan(String(v.pan), { entityType: (v.entityType as EntityType) ?? null }) : null
  const turnover = typeof v.annualTurnover === "string" && v.annualTurnover.trim() !== "" ? parseAmount(v.annualTurnover) : null
  const scheme =
    v.gstRegistration === "registered"
      ? gstSchemeDecision(turnover && turnover.ok ? turnover.paise : null, v.gstScheme === "auto" || !v.gstScheme ? null : (v.gstScheme as "monthly" | "qrmp"), { qrmpMaxTurnoverPaise })
      : null
  const fyOptions = recentFinancialYears(todayIST(), 3)
  if (typeof v.turnoverFy === "string" && v.turnoverFy && !fyOptions.includes(v.turnoverFy)) fyOptions.push(v.turnoverFy)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit master data"
      description={`${clientName}: the details from the client wizard's first step.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save details"
      size="lg"
    >
      <div className="flex flex-col gap-6">
        <FormAlert state={f} />

        <Fieldset legend="Identity">
          <TextField control={f.control} name="displayName" label="Display name" required maxLength={120} />
          <TextField control={f.control} name="legalName" label="Legal / registered name" maxLength={200} />
          <TextField control={f.control} name="clientCode" label="Client code" required autoCapitalize="characters" helper="Unique, like TW-C-0042." maxLength={20} />
          <SelectField control={f.control} name="entityType" label="Entity type" required options={ENTITY_TYPES.map((e) => ({ value: e, label: ENTITY_TYPE_LABELS[e] }))} />
          {v.entityType === "other" ? <TextField control={f.control} name="entityTypeOther" label="Specify" required maxLength={80} /> : null}
          <DateField
            control={f.control}
            name="dateOfBirthOrIncorporation"
            label={v.entityType === "individual" || v.entityType === "proprietorship" ? "Date of birth" : "Date of incorporation"}
            max={todayIST()}
            helper={v.entityType === "individual" ? "Sets the age band in ITR computations." : undefined}
          />
          <SwitchField control={f.control} name="isIncorporated" label="Already incorporated / registered" description="Off for an entity still being formed (the Incorporation service)." className="md:col-span-2" />
        </Fieldset>

        <Fieldset legend="Tax registrations">
          <TextField
            control={f.control}
            name="pan"
            label="PAN"
            autoCapitalize="characters"
            maxLength={10}
            helper={pan && pan.ok ? (pan.warning ? <span className="text-warning-text">{pan.warning}</span> : pan.holderLabel ? `Holder: ${pan.holderLabel}` : undefined) : "10 characters, like AAXFT1811B."}
          />
          <SelectField control={f.control} name="gstRegistration" label="GST registration" required options={GST_REGISTRATIONS.map((g) => ({ value: g, label: GST_REGISTRATION_LABELS[g] }))} />
          {v.gstRegistration !== "unregistered" ? (
            <TextField
              control={f.control}
              name="gstin"
              label="GSTIN"
              required={v.gstRegistration === "registered"}
              autoCapitalize="characters"
              maxLength={15}
              helper={gst ? `${gst.stateName} (${gst.stateCode}) · PAN ${gst.pan}` : "15 characters; the state and PAN are read from it."}
            />
          ) : null}
          <SelectField control={f.control} name="stateCode" label="State (place of supply)" options={STATES} helper={gst ? "Set from the GSTIN when saved." : undefined} />
          <TextField control={f.control} name="tan" label="TAN" autoCapitalize="characters" maxLength={10} helper="For clients who deduct TDS." />
        </Fieldset>

        <Fieldset legend="Contact">
          <TextField control={f.control} name="email" label="Primary email" type="email" autoComplete="off" />
          <TextField control={f.control} name="phone" label="Phone" type="tel" inputMode="tel" />
          <div className="flex flex-col gap-1.5">
            <TextField control={f.control} name="whatsapp" label="WhatsApp" type="tel" inputMode="tel" disabled={sameAsPhone} />
            <label className="flex items-center gap-2 text-sm text-text">
              <Checkbox checked={sameAsPhone} onCheckedChange={(c) => setSameAsPhone(c === true)} />
              Same as phone
            </label>
          </div>
          <TextField control={f.control} name="pincode" label="Pincode" inputMode="numeric" maxLength={6} />
          <TextareaField control={f.control} name="address" label="Address" rows={2} maxLength={500} className="md:col-span-2" />
          <TextField control={f.control} name="city" label="City" maxLength={80} />
        </Fieldset>

        <Fieldset legend="Scale">
          <SelectField control={f.control} name="fyEndMonth" label="Financial year ends in" options={MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m }))} />
          <MoneyField control={f.control} name="annualTurnover" label="Annual turnover (₹)" />
          <SelectField control={f.control} name="turnoverFy" label="Turnover for FY" options={fyOptions.map((fy) => ({ value: fy, label: `FY ${fy}` }))} required={!!turnover} />
          {v.gstRegistration === "registered" ? (
            <SelectField
              control={f.control}
              name="gstScheme"
              label="GST filing scheme"
              options={[
                { value: "auto", label: "Auto from turnover" },
                { value: "monthly", label: "Monthly" },
                { value: "qrmp", label: "QRMP" },
              ]}
              helper={scheme ? <span className={scheme.warning ? "text-warning-text" : undefined}>{scheme.warning ?? scheme.explanation}</span> : undefined}
            />
          ) : null}
        </Fieldset>

        <Fieldset legend="Work">
          <SelectField control={f.control} name="priority" label="Priority" required options={CLIENT_PRIORITIES.map((p) => ({ value: p, label: getStatus("client_priority", p).label }))} />
        </Fieldset>

        <TextareaField control={f.control} name="notes" label="Notes" rows={4} maxLength={4000} helper="Internal: never shown to the client." />
      </div>
    </FormDialog>
  )
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-3 text-base font-semibold text-text">{legend}</legend>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </fieldset>
  )
}
