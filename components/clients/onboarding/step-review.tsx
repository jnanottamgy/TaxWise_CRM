"use client"

import { PencilIcon } from "lucide-react"
import {
  ENTITY_TYPE_LABELS,
  GST_REGISTRATION_LABELS,
  GST_SCHEME_LABELS,
  SERVICE_FREQUENCY_LABELS,
  type EntityType,
  type GstRegistration,
  type ServiceFrequency,
} from "@/lib/domain/enums"
import { formatStateWithCode } from "@/lib/domain/india-validators"
import type { GstSchemeDecision, TaxAuditIndication } from "@/lib/domain/scale"
import { ACCEPTANCE_DECISION_LABELS, type AcceptanceDecision } from "@/lib/domain/conflict"
import { formatDate, formatMoney } from "@/lib/format"
import { paiseToDecimalString } from "@/lib/domain/money"
import {
  AUDIT_KIND_LABELS,
  effectiveStateCode,
  gstFrequencyLock,
  moneyToPaise,
  MONTH_OPTIONS,
  NOTIFY_CHANNEL_LABELS,
  NOTIFY_CHANNELS,
  PRIORITY_OPTIONS,
  serviceName,
  TAX_AUDIT_DECISION_LABELS,
  type AuditKind,
  type OnboardingValues,
} from "@/lib/schemas/onboarding"
import type { StaffOption } from "@/lib/data/clients"
import { Button } from "@/components/ui/button"
import { DefinitionList, type DefinitionItem } from "@/components/app/definition-list"
import { CheckboxGroupField, SwitchField, TextField } from "@/components/app/form/fields"
import { CompliancePreview } from "@/components/clients/onboarding/compliance-preview"
import type { OnboardingControl } from "@/components/clients/onboarding/types"
import type { PreviewState } from "@/components/clients/onboarding/use-deadline-preview"

const CHANNEL_OPTIONS = NOTIFY_CHANNELS.map((c) => ({
  value: c,
  label: NOTIFY_CHANNEL_LABELS[c],
  description: c === "whatsapp" ? "Drafted for the team to send from WhatsApp." : "Needs the portal invite.",
}))

/**
 * Step 5, Compliance setup and review (§7.3.2): reminder lead time, how the client is notified,
 * the 12-month deadline preview with the source of each date, the portal invite and the welcome
 * message on WhatsApp, and a summary of every step with Edit links back to it.
 */
export function StepReview({
  control,
  values,
  today,
  decision,
  indication,
  preview,
  staff,
  suggestedCode,
  files,
  seesFees,
  onEdit,
}: {
  control: OnboardingControl
  values: OnboardingValues
  today: string
  decision: GstSchemeDecision
  indication: TaxAuditIndication | null
  preview: PreviewState
  staff: StaffOption[]
  suggestedCode: string
  files: number
  seesFees: boolean
  onEdit: (step: number) => void
}) {
  const hasEmail = !!values.email?.trim()
  const gstPending = (values.services ?? []).some((s) => s.service_type === "gst") && !(values.gst_registration === "registered" && values.gstin)
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="review-reminders" className="rounded-lg border border-border bg-surface px-4 py-4">
        <h3 id="review-reminders" className="text-md font-semibold text-text">
          Reminders and notifications
        </h3>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            control={control}
            name="reminder_days"
            label="Reminder lead time (days)"
            inputMode="numeric"
            maxLength={2}
            helper="How many days before each due date the team and the client are reminded. 1 to 60."
            className="[&_input]:tabular-nums md:max-w-xs"
          />
          <CheckboxGroupField control={control} name="notify_channels" label="Notify the client by" options={CHANNEL_OPTIONS} helper="Defaults come from Settings → Reminders." />
          <SwitchField
            control={control}
            name="invite_portal"
            label="Invite to the client portal now"
            description={hasEmail ? `A login is created for ${values.email} and the details are shown once on the next screen.` : "Needs the client's email address (step 1)."}
            disabled={!hasEmail && !values.invite_portal}
            className="md:col-span-2"
          />
          <SwitchField
            control={control}
            name="send_welcome"
            label="Send a welcome message on WhatsApp"
            description="Introduces the owner and the services. Ready to send on the next screen, once the client is created."
            className="md:col-span-2"
          />
        </div>
      </section>

      <section aria-labelledby="review-deadlines" className="rounded-lg border border-border bg-surface px-4 py-4">
        <h3 id="review-deadlines" className="text-md font-semibold text-text">
          Deadlines for the next 12 months
        </h3>
        <p className="mt-0.5 mb-3 text-sm text-text-muted">Created with the client, from the statutory calendar. Each shows where its date comes from.</p>
        <CompliancePreview preview={preview} today={today} gstPending={gstPending} />
      </section>

      <Summary values={values} decision={decision} indication={indication} staff={staff} suggestedCode={suggestedCode} files={files} seesFees={seesFees} onEdit={onEdit} />
    </div>
  )
}

function SummaryBlock({ title, step, onEdit, items }: { title: string; step: number; onEdit: (s: number) => void; items: DefinitionItem[] }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h4 className="text-base font-semibold text-text">{title}</h4>
        <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(step)} aria-label={`Edit ${title}`}>
          <PencilIcon aria-hidden="true" />
          Edit
        </Button>
      </div>
      <div className="px-4 py-1">
        <DefinitionList items={items} columns={2} />
      </div>
    </section>
  )
}

function Summary({
  values,
  decision,
  indication,
  staff,
  suggestedCode,
  files,
  seesFees,
  onEdit,
}: {
  values: OnboardingValues
  decision: GstSchemeDecision
  indication: TaxAuditIndication | null
  staff: StaffOption[]
  suggestedCode: string
  files: number
  seesFees: boolean
  onEdit: (step: number) => void
}) {
  const name = (id: string | null | undefined) => (id ? (staff.find((s) => s.id === id)?.name ?? "—") : null)
  const services = values.services ?? []
  const lock = gstFrequencyLock(decision)
  const state = effectiveStateCode({ gstin: values.gstin ?? "", state_code: values.state_code ?? "" })
  const turnover = moneyToPaise(values.annual_turnover)
  const whatsapp = values.whatsapp_same_as_phone !== false ? values.phone : values.whatsapp
  const checklist = (values.checklist ?? []).filter((i) => i.included)
  const collected = checklist.filter((i) => i.collected).length
  const audit = services.some((s) => s.service_type === "audit")

  const basics: DefinitionItem[] = [
    { term: "Display name", value: values.display_name },
    { term: "Legal name", value: values.legal_name },
    { term: "Client code", value: values.client_code_auto !== false ? `${suggestedCode} (next free number)` : values.client_code?.toUpperCase() },
    {
      term: "Entity type",
      value: values.entity_type ? (values.entity_type === "other" ? values.entity_type_other : ENTITY_TYPE_LABELS[values.entity_type as EntityType]) : null,
    },
    { term: "PAN", value: values.pan ? <span className="font-mono text-[13px]">{values.pan.toUpperCase()}</span> : null },
    { term: "GST", value: values.gst_registration ? GST_REGISTRATION_LABELS[values.gst_registration as GstRegistration] : null },
    { term: "GSTIN", value: values.gstin ? <span className="font-mono text-[13px]">{values.gstin.toUpperCase()}</span> : null },
    { term: "State", value: state ? formatStateWithCode(state) : null },
    { term: "TAN", value: values.tan ? <span className="font-mono text-[13px]">{values.tan.toUpperCase()}</span> : null },
    { term: "Contact", value: [values.contact_name, values.contact_role].filter(Boolean).join(", ") || null },
    { term: "Email", value: values.email },
    { term: "Phone", value: values.phone },
    { term: "WhatsApp", value: whatsapp },
    { term: "Address", value: [values.address, values.city, values.pincode].filter(Boolean).join(", ") || null, wide: true },
    { term: "Financial year ends", value: MONTH_OPTIONS.find((m) => m.value === values.fy_end_month)?.label ?? null },
    { term: "Turnover", value: turnover !== null ? `${formatMoney(paiseToDecimalString(turnover))}${values.turnover_fy ? ` (FY ${values.turnover_fy})` : ""}` : null },
    { term: "GST scheme", value: `${GST_SCHEME_LABELS[decision.scheme]}${decision.basis === "choice" ? " (chosen)" : " (from turnover)"}` },
    {
      term: "Tax audit",
      value: indication ? `${TAX_AUDIT_DECISION_LABELS[(values.tax_audit_decision ?? "review") as keyof typeof TAX_AUDIT_DECISION_LABELS]}` : null,
    },
    {
      term: "Conflict check",
      value: values.acceptance_outcome ? `${ACCEPTANCE_DECISION_LABELS[values.acceptance_outcome as AcceptanceDecision]}. ${values.acceptance_summary ?? ""}` : audit ? "Not run" : "Not run (optional)",
      wide: true,
    },
    ...(values.duplicate_reason ? [{ term: "Not a duplicate because", value: values.duplicate_reason, wide: true }] : []),
  ]

  const servicesItems: DefinitionItem[] = [
    { term: "Services", value: services.map((s) => serviceName({ service_type: s.service_type, custom_name: s.custom_name ?? "" })).join(", ") || null, wide: true },
    ...(audit ? [{ term: "Audit", value: (values.audit_kinds ?? []).map((k) => AUDIT_KIND_LABELS[k as AuditKind]).join(", ") || null, wide: true }] : []),
  ]

  const configure: DefinitionItem[] = services.map((s) => {
    const freq = (s.service_type === "gst" ? lock.frequency : (s.frequency ?? "annual")) as ServiceFrequency
    const fee = moneyToPaise(s.agreed_fee)
    const bits = [
      SERVICE_FREQUENCY_LABELS[freq],
      s.next_due_date ? `next due ${formatDate(s.next_due_date)}` : "next due from the calendar",
      seesFees && fee !== null ? `${formatMoney(paiseToDecimalString(fee))} per bill` : null,
      seesFees && s.billing_frequency ? `billed ${SERVICE_FREQUENCY_LABELS[s.billing_frequency as ServiceFrequency].toLowerCase()}` : null,
      s.auto_invoice ? `auto-invoiced from ${s.first_billing_date ? formatDate(s.first_billing_date) : "—"}` : null,
      s.sac_code ? `SAC ${s.sac_code}` : null,
    ].filter(Boolean)
    return { term: serviceName({ service_type: s.service_type, custom_name: s.custom_name ?? "" }), value: bits.join(" · "), wide: true }
  })
  configure.push(
    { term: "Owner", value: name(values.owner_employee_id) },
    { term: "Priority", value: PRIORITY_OPTIONS.find((p) => p.value === values.priority)?.label ?? "Medium" },
    { term: "Engagement partner", value: name(values.engagement_partner_id) },
    { term: "Review manager", value: name(values.review_manager_id) },
    { term: "Preparers", value: (values.preparer_ids ?? []).map((id) => name(id)).join(", ") || null, wide: true },
  )

  const checklistItems: DefinitionItem[] = [
    { term: "Items", value: `${checklist.length} on the checklist, ${collected} collected` },
    { term: "Files attached", value: files ? `${files}, filed after Complete` : "None" },
  ]

  const reviewItems: DefinitionItem[] = [
    { term: "Reminders", value: `${values.reminder_days || "7"} days before each due date` },
    { term: "Notify by", value: (values.notify_channels ?? []).map((c) => NOTIFY_CHANNEL_LABELS[c]).join(", ") || "Nobody (reminders to the team only)" },
    { term: "Portal invite", value: values.invite_portal ? "Yes, now" : "Not now" },
    { term: "Welcome message", value: values.send_welcome ? "Yes, on WhatsApp" : "No" },
  ]

  return (
    <section aria-labelledby="review-summary" className="flex flex-col gap-3">
      <h3 id="review-summary" className="text-md font-semibold text-text">
        Summary
      </h3>
      <SummaryBlock title="Basic information" step={0} onEdit={onEdit} items={basics} />
      <SummaryBlock title="Services" step={1} onEdit={onEdit} items={servicesItems} />
      <SummaryBlock title="Configuration and team" step={2} onEdit={onEdit} items={configure} />
      <SummaryBlock title="Document checklist" step={3} onEdit={onEdit} items={checklistItems} />
      <SummaryBlock title="Compliance setup" step={4} onEdit={onEdit} items={reviewItems} />
    </section>
  )
}
