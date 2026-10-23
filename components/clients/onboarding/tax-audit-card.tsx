"use client"

import { ScaleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { TAX_AUDIT_DISCLAIMER, type TaxAuditIndication } from "@/lib/domain/scale"
import { INCOME_NATURE_LABELS, INCOME_NATURES, TAX_AUDIT_DECISION_LABELS, TAX_AUDIT_DECISIONS } from "@/lib/schemas/onboarding"
import { PercentField, SelectField, TextareaField } from "@/components/app/form/fields"
import type { OnboardingControl } from "@/components/clients/onboarding/types"

const INDICATION_TEXT: Record<TaxAuditIndication["indication"], { label: string; tone: string }> = {
  yes: { label: "Tax audit indicated", tone: "border-warning/40 bg-warning-soft text-warning-text" },
  no: { label: "No tax audit indicated", tone: "border-success/40 bg-success-soft text-success-text" },
  review: { label: "Needs more facts", tone: "border-info/40 bg-info-soft text-info-text" },
}

const NATURE_OPTIONS = INCOME_NATURES.map((n) => ({ value: n, label: INCOME_NATURE_LABELS[n] }))
const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
]

/**
 * The tax audit indication card (§7.3.2 step 1, §6.6), shown once turnover is entered: the
 * indication with its reasoning, the questions that complete it (cash shares, declared profit, the
 * basic exemption), and the disclaimer. Only a Partner records the decision (yes / no / review,
 * with a note); a Manager's onboarding leaves it for a Partner to confirm.
 */
export function TaxAuditCard({
  control,
  indication,
  nature,
  isPartner,
}: {
  control: OnboardingControl
  indication: TaxAuditIndication
  nature: string
  isPartner: boolean
}) {
  const presumptive = nature === "presumptive_44ad" || nature === "presumptive_44ada"
  const profession = nature === "profession" || nature === "presumptive_44ada"
  const needsBasic = presumptive && indication.reasons.some((r) => /basic exemption/i.test(r))
  const text = INDICATION_TEXT[indication.indication]
  return (
    <section aria-labelledby="tax-audit-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 id="tax-audit-title" className="flex items-center gap-2 text-md font-semibold text-text">
          <ScaleIcon aria-hidden="true" className="size-4 text-text-muted" />
          Tax audit indication
        </h3>
        <span className={cn("rounded-full border px-2 text-sm leading-6", text.tone)}>{text.label}</span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-3">
        <ul aria-live="polite" className="flex list-disc flex-col gap-1 pl-4 text-base text-text">
          {indication.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={control} name="income_nature" label="Income is earned from" options={NATURE_OPTIONS} placeholder="Business" helper="Companies and firms are a business." />
          {indication.askCashRatio || presumptive ? (
            <PercentField control={control} name="cash_receipts_pct" label="Cash receipts" helper="Share of total receipts received in cash." max={100} />
          ) : null}
          {indication.askCashRatio && !profession ? (
            <PercentField control={control} name="cash_payments_pct" label="Cash payments" helper="Share of total payments made in cash." max={100} />
          ) : null}
          {presumptive || (profession && indication.askCashRatio) ? (
            <PercentField
              control={control}
              name="declared_profit_pct"
              label={profession ? "Income declared" : "Profit declared"}
              helper={profession ? "As a share of gross receipts." : "As a share of turnover."}
              max={100}
            />
          ) : null}
          {needsBasic ? (
            <SelectField control={control} name="income_above_basic_exemption" label="Total income above the basic exemption limit?" options={YES_NO} />
          ) : null}
        </div>
        {isPartner ? (
          <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 md:grid-cols-2">
            <SelectField
              control={control}
              name="tax_audit_decision"
              label="Your decision"
              options={TAX_AUDIT_DECISIONS.map((d) => ({ value: d, label: TAX_AUDIT_DECISION_LABELS[d] }))}
              helper="Stored on the client. A confirmed tax audit adds its deadlines."
            />
            <TextareaField control={control} name="tax_audit_note" label="Note" rows={2} placeholder="What the decision rests on" />
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-sm text-text-muted">A Partner confirms whether a tax audit applies, from the client&apos;s Overview. Until then it shows as Partner to review.</p>
        )}
        <p className="text-sm text-text-muted">{TAX_AUDIT_DISCLAIMER}</p>
      </div>
    </section>
  )
}
