"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { deriveFromGstin, stateOptions } from "@/lib/domain/india-validators"
import { FirmDetailsSchema, type FirmDetailsInput } from "@/lib/schemas/settings"
import { saveFirmDetails } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange, PartnerRow } from "@/lib/data/settings"
import { SelectField, TextareaField, TextField } from "@/components/app/form/fields"
import { EmptyState } from "@/components/app/empty-state"
import { SettingsCard, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"
import { InvoiceHeaderPreview } from "@/components/settings/invoice-header-preview"
import { LogoUploader } from "@/components/settings/logo-uploader"

const STATE_OPTIONS = stateOptions().map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))

export function FirmDetailsForm({
  row,
  partners,
  lastChange,
  logoUrl: savedLogoUrl,
  sampleInvoiceNumber,
  today,
}: {
  row: FirmSettingsRow
  partners: PartnerRow[]
  lastChange: LastChange
  logoUrl: string | null
  sampleInvoiceNumber: string
  today: string
}) {
  const router = useRouter()
  const defaults: FirmDetailsInput = {
    updated_at: row.updated_at,
    firm_name: row.firm_name ?? "",
    legal_name: row.legal_name ?? "",
    tagline: row.tagline ?? "",
    address: row.address ?? "",
    city: row.city ?? "",
    state_code: row.state_code ?? "29",
    pincode: row.pincode ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    website: row.website ?? "",
    gstin: row.gstin ?? "",
    pan: row.pan ?? "",
    tan: row.tan ?? "",
    icai_frn: row.icai_frn ?? "",
    partners: partners.map((p) => ({ id: p.id, full_name: p.full_name, icai_membership_no: p.icai_membership_no ?? "" })),
  }
  const f = useSettingsForm(FirmDetailsSchema, saveFirmDetails, defaults, { savedMessage: "Firm details saved" })
  const values = useWatch({ control: f.control }) as Partial<FirmDetailsInput>

  const [logoUrl, setLogoUrl] = React.useState(savedLogoUrl)
  const [localPreview, setLocalPreview] = React.useState<string | null>(null)

  const gstinParts = values.gstin ? deriveFromGstin(values.gstin) : null

  const fillFromGstin = () => {
    const parts = values.gstin ? deriveFromGstin(values.gstin) : null
    if (!parts) return
    if (!f.form.getValues("pan")) f.form.setValue("pan", parts.pan, { shouldDirty: true, shouldValidate: true })
    if (f.form.getValues("state_code") !== parts.stateCode) f.form.setValue("state_code", parts.stateCode, { shouldDirty: true, shouldValidate: true })
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SettingsCard
        title="Logo and letterhead"
        description="The logo saves as soon as it uploads. The letterhead below follows the details you type, before you save them."
        columns={1}
      >
        <LogoUploader
          logoUrl={logoUrl}
          updatedAt={values.updated_at ?? row.updated_at}
          onPreview={setLocalPreview}
          onSaved={({ updated_at, logoUrl: next }) => {
            setLogoUrl(next)
            // The logo moved the row's updated_at: keep the details form's token current without
            // marking it changed, and refresh the server view only when nothing is unsaved.
            f.form.resetField("updated_at", { defaultValue: updated_at })
            if (!f.form.formState.isDirty) router.refresh()
          }}
        />
        <InvoiceHeaderPreview
          logoUrl={localPreview ?? logoUrl}
          firmName={values.firm_name ?? ""}
          legalName={values.legal_name}
          tagline={values.tagline}
          address={values.address}
          city={values.city}
          stateCode={values.state_code}
          pincode={values.pincode}
          phone={values.phone}
          email={values.email}
          website={values.website}
          gstin={values.gstin?.toUpperCase()}
          pan={values.pan?.toUpperCase()}
          sampleNumber={sampleInvoiceNumber}
          today={today}
        />
      </SettingsCard>

      <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save firm details">
        <SettingsCard title="Identity" description="The name on every invoice, quotation, email and portal page.">
          <TextField control={f.control} name="firm_name" label="Display name" required autoComplete="organization" />
          <TextField control={f.control} name="legal_name" label="Legal name" helper="As registered, if it differs from the display name." />
          <Wide>
            <TextField control={f.control} name="tagline" label="Tagline" helper="Shown under the name, e.g. Chartered Accountants · Bengaluru." />
          </Wide>
        </SettingsCard>

        <SettingsCard title="Address and contact" description="The registered address prints on invoices; phone and email are shown to clients in the portal.">
          <Wide>
            <TextareaField control={f.control} name="address" label="Registered address" required rows={3} autoComplete="street-address" />
          </Wide>
          <TextField control={f.control} name="city" label="City" required autoComplete="address-level2" />
          <SelectField control={f.control} name="state_code" label="State" required options={STATE_OPTIONS} helper="Decides CGST + SGST or IGST on every invoice." />
          <TextField control={f.control} name="pincode" label="Pincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" />
          <TextField control={f.control} name="phone" label="Phone" type="tel" autoComplete="tel" />
          <TextField control={f.control} name="email" label="Public email" type="email" autoComplete="email" />
          <TextField control={f.control} name="website" label="Website" type="url" inputMode="url" />
        </SettingsCard>

        <SettingsCard title="Registrations" description="GSTIN and PAN print on every tax invoice (Rule 46). The FRN prints on audit reports and certificates.">
          <div onBlur={fillFromGstin} className="min-w-0">
            <TextField
              control={f.control}
              name="gstin"
              label="GSTIN"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={15}
              helper={gstinParts ? `${gstinParts.stateName} (${gstinParts.stateCode}) · PAN ${gstinParts.pan}` : "15 characters, e.g. 29AAXFT1811B1Z3"}
            />
          </div>
          <TextField control={f.control} name="pan" label="PAN" autoCapitalize="characters" spellCheck={false} maxLength={10} helper="Filled from the GSTIN when left empty." />
          <TextField control={f.control} name="tan" label="TAN" autoCapitalize="characters" spellCheck={false} maxLength={10} />
          <TextField control={f.control} name="icai_frn" label="ICAI firm registration number" autoCapitalize="characters" spellCheck={false} helper="As on the ICAI certificate, e.g. 012345S." />
        </SettingsCard>

        <SettingsCard
          title="Partners' membership numbers"
          description="Each Partner's ICAI membership number: checked against UDINs and printed under their signature."
          columns={1}
        >
          {partners.length === 0 ? (
            <EmptyState size="compact" message="No active Partners found. Partners are added in People." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {partners.map((p, i) => (
                <li key={p.id} className="grid grid-cols-1 items-start gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-6">
                  <div className="min-w-0 pt-1.5">
                    <p className="truncate text-base font-medium text-text">{p.full_name}</p>
                    <p className="truncate text-sm text-text-muted">{p.email}</p>
                  </div>
                  <TextField
                    control={f.control}
                    name={`partners.${i}.icai_membership_no`}
                    label={`Membership number for ${p.full_name}`}
                    hideLabel
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6 digits"
                  />
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </SettingsForm>

    </div>
  )
}
