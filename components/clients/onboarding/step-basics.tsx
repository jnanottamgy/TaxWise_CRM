"use client"

import * as React from "react"
import { CheckCircle2Icon, CircleSlashIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ENTITY_TYPE_LABELS, ENTITY_TYPES, GST_REGISTRATION_LABELS, GST_REGISTRATIONS, type EntityType } from "@/lib/domain/enums"
import { deriveFromGstin, stateOptions, validatePan } from "@/lib/domain/india-validators"
import type { GstSchemeDecision, TaxAuditIndication } from "@/lib/domain/scale"
import { CONTACT_ROLES, MONTH_OPTIONS, turnoverFyOptions, type OnboardingValues } from "@/lib/schemas/onboarding"
import { SectionCard } from "@/components/app/section-card"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ComboboxField, DateField, MoneyField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { DuplicateGuard, type DuplicateState } from "@/components/clients/onboarding/duplicate-guard"
import { SchemeExplainer } from "@/components/clients/onboarding/scheme-explainer"
import { TaxAuditCard } from "@/components/clients/onboarding/tax-audit-card"
import type { OnboardingControl } from "@/components/clients/onboarding/types"

const ENTITY_OPTIONS = ENTITY_TYPES.map((e) => ({ value: e, label: ENTITY_TYPE_LABELS[e] }))
const GST_OPTIONS = GST_REGISTRATIONS.map((g) => ({ value: g, label: GST_REGISTRATION_LABELS[g] }))
const STATE_OPTIONS = stateOptions().map((s) => ({ value: s.code, label: s.name, description: s.code }))
const ROLE_OPTIONS = CONTACT_ROLES.map((r) => ({ value: r, label: r }))
const SCHEME_OPTIONS = [
  { value: "auto", label: "Auto from turnover" },
  { value: "monthly", label: "Monthly" },
  { value: "qrmp", label: "QRMP" },
]

const PEOPLE: readonly EntityType[] = ["individual", "huf"]
/** Entities that usually deduct tax at source, so TAN is asked up front (§7.3.2 "shown when TDS is likely"). */
const TDS_LIKELY: readonly EntityType[] = ["partnership", "llp", "pvt_ltd", "public_ltd", "section_8", "trust", "aop"]

export type CodeStatus = "idle" | "checking" | "free" | "taken" | "error"
export type AcceptanceState = { acceptanceId: string; outcome: string; summary: string } | null

/**
 * Step 1, Basic information (§7.3.2): identity, tax registrations, contact, scale, notes, the
 * duplicate guard and the conflict check. Validation is the shared schema (on blur, and on
 * Continue); the wizard owns the duplicate and code checks and passes their state in.
 */
export function StepBasics({
  control,
  values,
  today,
  isPartner,
  suggestedCode,
  decision,
  indication,
  tdsSelected,
  attest,
  duplicates,
  continuingDuplicate,
  onContinueAnyway,
  onRetryDuplicates,
  onIdentityBlur,
  codeStatus,
  onCodeBlur,
  onUseSuggestedCode,
  onShowTan,
  acceptance,
  onOpenConflictCheck,
}: {
  control: OnboardingControl
  values: OnboardingValues
  today: string
  isPartner: boolean
  suggestedCode: string
  decision: GstSchemeDecision
  indication: TaxAuditIndication | null
  tdsSelected: boolean
  attest: boolean
  duplicates: DuplicateState
  continuingDuplicate: boolean
  onContinueAnyway: () => void
  onRetryDuplicates: () => void
  onIdentityBlur: () => void
  codeStatus: CodeStatus
  onCodeBlur: () => void
  onUseSuggestedCode: () => void
  onShowTan: () => void
  acceptance: AcceptanceState
  onOpenConflictCheck: () => void
}) {
  const entity = (values.entity_type || "") as EntityType | ""
  const person = entity !== "" && PEOPLE.includes(entity)
  const gstParts = values.gstin ? deriveFromGstin(values.gstin) : null
  const panCheck = values.pan ? validatePan(values.pan, { entityType: entity || null }) : null
  const showTan = values.show_tan || tdsSelected || !!values.tan || (entity !== "" && TDS_LIKELY.includes(entity))
  const fyOptions = React.useMemo(() => turnoverFyOptions(today).map((fy) => ({ value: fy, label: `FY ${fy}` })), [today])
  const dateLabel = person ? "Date of birth" : entity === "" ? "Date of birth / incorporation" : "Date of incorporation"

  const identityBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const name = (e.target as HTMLInputElement).name
    if (name === "display_name" || name === "legal_name" || name === "pan" || name === "gstin") onIdentityBlur()
    if (name === "client_code") onCodeBlur()
  }

  const codeHelper =
    values.client_code_auto !== false ? (
      "The next free number is taken when you complete onboarding."
    ) : codeStatus === "checking" ? (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" /> Checking the code…
      </span>
    ) : codeStatus === "free" ? (
      <span className="inline-flex items-center gap-1.5 text-success-text">
        <CheckCircle2Icon aria-hidden="true" className="size-3.5" /> This code is free.
      </span>
    ) : (
      <span>
        Typed by hand: it must be unique.{" "}
        <button type="button" onClick={onUseSuggestedCode} className="cursor-pointer text-primary underline-offset-2 hover:underline">
          Use {suggestedCode}
        </button>
      </span>
    )

  return (
    <div className="flex flex-col gap-5" onBlur={identityBlur}>
      <SectionCard id="basics-identity" headingLevel={3} title="Identity">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={control} name="display_name" label="Display name" required autoComplete="organization" placeholder="Sharma Traders" className="md:col-span-2" />
          <TextField control={control} name="legal_name" label="Legal / registered name" placeholder="As on the PAN or certificate of incorporation" className="md:col-span-2" />
          <TextField control={control} name="client_code" label="Client code" required helper={codeHelper} autoCapitalize="characters" spellCheck={false} className="[&_input]:font-mono" />
          <SelectField control={control} name="entity_type" label="Entity type" required options={ENTITY_OPTIONS} />
          {values.entity_type === "other" ? <TextField control={control} name="entity_type_other" label="Specify the entity type" required placeholder="For example: Co-operative society" /> : null}
          <DateField control={control} name="date_of_birth_or_incorporation" label={dateLabel} max={today} helper={person ? "Sets the age band for the income-tax return." : undefined} />
          {!person ? (
            <SwitchField
              control={control}
              name="is_incorporated"
              label="Already incorporated or registered?"
              description={values.is_incorporated === false ? "Incorporation is suggested in the next step." : "Turn off if the firm will register the entity."}
              className="md:col-span-2"
            />
          ) : null}
        </div>
      </SectionCard>

      <SectionCard id="basics-tax" headingLevel={3} title="Tax registrations">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            control={control}
            name="pan"
            label="PAN"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={10}
            placeholder="AAKFS1234C"
            className="[&_input]:font-mono [&_input]:uppercase"
            helper={
              panCheck && panCheck.ok ? (
                panCheck.warning ? (
                  <span className="text-warning-text">{panCheck.warning}</span>
                ) : panCheck.holderLabel ? (
                  `Held by: ${panCheck.holderLabel}.`
                ) : undefined
              ) : (
                "10 characters: 5 letters, 4 digits, 1 letter."
              )
            }
          />
          <SelectField control={control} name="gst_registration" label="GST registration" required options={GST_OPTIONS} />
          <TextField
            control={control}
            name="gstin"
            label="GSTIN"
            required={values.gst_registration === "registered"}
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={15}
            placeholder="29AAKFS1234C1Z5"
            className="[&_input]:font-mono [&_input]:uppercase"
            helper={gstParts ? `${gstParts.stateName} (${gstParts.stateCode}) · PAN ${gstParts.pan}` : "Checked against its checksum; it must contain the PAN."}
          />
          <ComboboxField
            control={control}
            name="state_code"
            label="State (place of supply)"
            options={STATE_OPTIONS}
            placeholder="Choose the state"
            searchPlaceholder="Search states"
            disabled={!!gstParts}
            helper={gstParts ? "From the GSTIN." : "Where the client's principal place of business is."}
          />
          {showTan ? (
            <TextField control={control} name="tan" label="TAN" autoCapitalize="characters" spellCheck={false} maxLength={10} placeholder="BLRS12345A" className="[&_input]:font-mono [&_input]:uppercase" helper="For TDS returns and certificates." />
          ) : (
            <div className="flex items-end">
              <Button type="button" variant="ghost" size="sm" onClick={onShowTan}>
                Add a TAN
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      <DuplicateGuard state={duplicates} control={control} continuing={continuingDuplicate} onContinueAnyway={onContinueAnyway} onRetry={onRetryDuplicates} />

      <SectionCard id="basics-contact" headingLevel={3} title="Contact" description="The primary contact. More contacts can be added on the client's page.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={control} name="contact_name" label="Contact name" autoComplete="name" placeholder="Defaults to the display name" />
          <SelectField control={control} name="contact_role" label="Role" options={ROLE_OPTIONS} placeholder="Choose a role" />
          <TextField control={control} name="email" label="Primary email" type="email" inputMode="email" autoComplete="email" placeholder="accounts@example.in" className="md:col-span-2" />
          <TextField control={control} name="phone" label="Phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="98450 12345 or 080 2345 6789" />
          <div className="flex flex-col gap-2">
            <SwitchField control={control} name="whatsapp_same_as_phone" label="WhatsApp is the same number" />
            {values.whatsapp_same_as_phone === false ? <TextField control={control} name="whatsapp" label="WhatsApp" type="tel" inputMode="tel" placeholder="98450 12345" /> : null}
          </div>
          <TextareaField control={control} name="address" label="Address" rows={2} className="md:col-span-2" />
          <TextField control={control} name="city" label="City" autoComplete="address-level2" />
          <TextField control={control} name="pincode" label="Pincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" className="[&_input]:tabular-nums" />
        </div>
      </SectionCard>

      <SectionCard id="basics-scale" headingLevel={3} title="Scale" description="Decides the GST scheme and whether a tax audit is indicated.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={control} name="fy_end_month" label="Financial year ends in" options={MONTH_OPTIONS} />
          <div className="hidden md:block" />
          <MoneyField control={control} name="annual_turnover" label="Annual turnover (₹)" placeholder="0.00" />
          <SelectField control={control} name="turnover_fy" label="Turnover for FY" options={fyOptions} placeholder="Choose the year" required={!!values.annual_turnover} />
          <div className="flex flex-col gap-2 md:col-span-2">
            <SelectField control={control} name="gst_scheme_choice" label="GST filing scheme" options={SCHEME_OPTIONS} className="md:max-w-sm" />
            <SchemeExplainer decision={decision} registered={values.gst_registration === "registered"} />
          </div>
        </div>
        {indication ? (
          <div className="mt-4">
            <TaxAuditCard control={control} indication={indication} nature={values.income_nature || "business"} isPartner={isPartner} />
          </div>
        ) : null}
      </SectionCard>

      <ConflictCheckCard acceptance={acceptance} attest={attest} onOpen={onOpenConflictCheck} />

      <TextareaField control={control} name="notes" label="Notes" rows={3} placeholder="Anything the team should know about this client" />
    </div>
  )
}

function ConflictCheckCard({ acceptance, attest, onOpen }: { acceptance: AcceptanceState; attest: boolean; onOpen: () => void }) {
  const outcome = acceptance?.outcome ?? ""
  const view =
    outcome === "accepted"
      ? { icon: ShieldCheckIcon, tone: "text-success-text", title: "Accepted", text: acceptance?.summary }
      : outcome === "declined"
        ? { icon: CircleSlashIcon, tone: "text-danger-text", title: "Declined", text: `${acceptance?.summary ?? ""} A declined prospect can't be onboarded.` }
        : outcome === "pending"
          ? { icon: ShieldQuestionIcon, tone: "text-warning-text", title: "Decision pending", text: acceptance?.summary }
          : {
              icon: ShieldAlertIcon,
              tone: "text-text-muted",
              title: attest ? "Required for audit work" : "Optional",
              text: attest
                ? "Audit work needs a conflict check with the decision Accept before the client can be onboarded."
                : "Checks existing clients, leads and related parties for a conflict of interest.",
            }
  const Icon = view.icon
  return (
    <SectionCard
      id="basics-conflict"
      headingLevel={3}
      title="Conflict check"
      action={
        <Button type="button" variant={outcome === "" && attest ? "default" : "outline"} size="sm" onClick={onOpen}>
          {outcome === "" ? "Run conflict check" : outcome === "pending" ? "Decide" : "View"}
        </Button>
      }
    >
      <p className="flex gap-2 text-base">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", view.tone)} />
        <span>
          <span className={cn("font-medium", view.tone)}>{view.title}.</span> <span className="text-text-muted">{view.text}</span>
        </span>
      </p>
    </SectionCard>
  )
}
