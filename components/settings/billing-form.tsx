"use client"

import { useWatch } from "react-hook-form"
import { addDays, MONTH_ABBR } from "@/lib/domain/fy"
import { formatINR, parseAmount, percentOf, roundOffToRupee } from "@/lib/domain/money"
import { formatDate } from "@/lib/format"
import {
  approvalModesFromRow,
  BillingSchema,
  sacMapFromJson,
  SAC_MAP_LABELS,
  type BillingInput,
} from "@/lib/schemas/settings"
import { saveBilling } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange } from "@/lib/data/settings"
import { MoneyField, SelectField, SwitchField, TextareaField, TextField } from "@/components/app/form/fields"
import { ChoiceField } from "@/components/settings/choice-field"
import { SettingsCard, SettingPreview, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"

/** The rates the invoice picker offers since 22 Sep 2025 (§6.4); a stored rate outside them stays selectable. */
const RATE_OPTIONS = [
  { value: "18", label: "18% (professional services, SAC 9982)" },
  { value: "5", label: "5%" },
  { value: "0", label: "0% / exempt" },
]

/** The last 18 months, newest first, as YYYY-MM with a "Sep 2026" label. */
function monthOptions(today: string): Array<{ value: string; label: string }> {
  const [y, m] = today.split("-").map(Number)
  const out: Array<{ value: string; label: string }> = [{ value: "none", label: "Not filed yet" }]
  for (let i = 0; i < 18; i++) {
    const idx = (y * 12 + (m - 1)) - i
    const year = Math.floor(idx / 12)
    const month = (idx % 12) + 1
    out.push({ value: `${year}-${String(month).padStart(2, "0")}`, label: `${MONTH_ABBR[month - 1]} ${year}` })
  }
  return out
}

function rupees(text: string | number | null | undefined): number | null {
  const r = parseAmount(String(text ?? ""))
  return r.ok ? r.paise : null
}

/**
 * Settings → Billing (§7.21, §6.4): the defaults every new invoice and quotation starts from, the
 * approval limits (with their null / 0 meaning spelled out), and the two GST facts the invoice module
 * needs (e-invoicing, last month in TaxWise's own filed GSTR-1).
 */
export function BillingForm({ row, lastChange, today }: { row: FirmSettingsRow; lastChange: LastChange; today: string }) {
  const modes = approvalModesFromRow(row)
  const rate = String(Number(row.default_tax_rate))
  const rateOptions = RATE_OPTIONS.some((o) => o.value === rate) ? RATE_OPTIONS : [...RATE_OPTIONS, { value: rate, label: `${rate}% (current)` }]
  const months = monthOptions(today)
  if (row.last_gstr1_reported_month && !months.some((m) => m.value === row.last_gstr1_reported_month)) {
    const [yy, mm] = row.last_gstr1_reported_month.split("-").map(Number)
    months.push({ value: row.last_gstr1_reported_month, label: mm >= 1 && mm <= 12 ? `${MONTH_ABBR[mm - 1]} ${yy}` : row.last_gstr1_reported_month })
  }
  const defaults: BillingInput = {
    updated_at: row.updated_at,
    default_tax_rate: rate,
    default_sac: row.default_sac,
    sac_map: sacMapFromJson(row.sac_by_service),
    payment_terms_days: String(row.payment_terms_days),
    invoice_terms: row.invoice_terms ?? "",
    invoice_footer_note: row.invoice_footer_note ?? "",
    round_off_enabled: row.round_off_enabled,
    ...modes,
    quotation_validity_days: String(row.quotation_validity_days),
    quotation_terms: row.quotation_terms ?? "",
    e_invoicing_applies: row.e_invoicing_applies,
    last_gstr1_reported_month: row.last_gstr1_reported_month ?? "none",
  }
  const f = useSettingsForm(BillingSchema, saveBilling, defaults, { savedMessage: "Billing defaults saved" })
  const v = useWatch({ control: f.control }) as Partial<BillingInput>

  const terms = Number(v.payment_terms_days)
  const validity = Number(v.quotation_validity_days)
  const rateNum = Number(v.default_tax_rate)
  // A sample line to show rounding and the rate at work: ₹10,000.50 of fees.
  const sampleTaxable = 1_000_050
  const sampleTax = Number.isFinite(rateNum) ? percentOf(sampleTaxable, rateNum) : 0
  const sampleTotal = sampleTaxable + sampleTax
  const rounded = roundOffToRupee(sampleTotal)
  const invLimit = rupees(v.invoice_approval_limit)
  const quoLimit = rupees(v.quotation_approval_limit)

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save billing defaults">
      <SettingsCard title="GST on invoices" description="New invoice lines start with this rate and SAC; each line can still be changed.">
        <SelectField control={f.control} name="default_tax_rate" label="Default GST rate" required options={rateOptions} helper="The 12% and 28% slabs went on 22 Sep 2025. Old invoices keep their rate." />
        <TextField control={f.control} name="default_sac" label="Default SAC" required inputMode="numeric" maxLength={8} helper="9982 covers legal and accounting services." />
        <Wide>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-text">SAC by service</legend>
            <p className="mb-3 text-sm text-text-muted">
              Up to ₹5 crore of aggregate turnover a 4-digit SAC is enough on the invoice; above that, 6 digits. Leave a service empty to use the default.
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {(defaults.sac_map ?? []).map((r, i) => (
                <TextField
                  key={r.service}
                  control={f.control}
                  name={`sac_map.${i}.sac`}
                  label={SAC_MAP_LABELS[r.service]}
                  inputMode="numeric"
                  maxLength={8}
                  placeholder={v.default_sac || "9982"}
                />
              ))}
            </div>
          </fieldset>
        </Wide>
        <Wide>
          <SwitchField
            control={f.control}
            name="e_invoicing_applies"
            label="E-invoicing applies to TaxWise"
            description="Turn on only above ₹5 crore of aggregate turnover. Invoices then show the IRN, acknowledgement and signed QR fields."
          />
        </Wide>
        <SelectField
          control={f.control}
          name="last_gstr1_reported_month"
          label="Last month in our filed GSTR-1"
          options={months}
          helper="Invoices up to this month are already reported: correcting one needs a credit note, not cancel and reissue."
        />
      </SettingsCard>

      <SettingsCard title="Invoices" description="Due dates, rounding and the words printed on every invoice.">
        <TextField control={f.control} name="payment_terms_days" label="Payment terms (days)" required inputMode="numeric" helper="Days from the invoice date to the due date." />
        <SettingPreview wide={false} label="Due date">
          {Number.isInteger(terms) && terms >= 0 && terms <= 365 ? (
            <>
              An invoice dated <span className="num">{formatDate(today)}</span> is due on <span className="num font-medium">{formatDate(addDays(today, terms))}</span>.
            </>
          ) : (
            <span className="text-text-muted">Enter the days to see the due date.</span>
          )}
        </SettingPreview>
        <Wide>
          <SwitchField
            control={f.control}
            name="round_off_enabled"
            label="Round invoice totals to whole rupees"
            description="Adds a round-off line of at most ±₹0.99."
          />
        </Wide>
        <SettingPreview label="Amounts as they print">
          <span className="num">
            Fees {formatINR(sampleTaxable)} + GST {Number.isFinite(rateNum) ? `${rateNum}%` : ""} {formatINR(sampleTax)} = {formatINR(sampleTotal)}
          </span>
          {v.round_off_enabled ? (
            <span className="num">
              {" "}
              → round-off {rounded.roundOff >= 0 ? "+" : ""}
              {formatINR(rounded.roundOff)}, total <span className="font-medium">{formatINR(rounded.total)}</span>
            </span>
          ) : (
            <span className="text-text-muted"> (no round-off line)</span>
          )}
        </SettingPreview>
        <Wide>
          <TextareaField control={f.control} name="invoice_terms" label="Invoice terms" rows={4} helper="Printed under the totals, e.g. how to pay and late-payment terms." />
        </Wide>
        <Wide>
          <TextareaField control={f.control} name="invoice_footer_note" label="Footer note" rows={2} helper="One or two lines at the foot of every invoice." />
        </Wide>
      </SettingsCard>

      <SettingsCard title="Approvals" description="Only Partners approve. A Partner's own invoices and quotations never wait." columns={1}>
        <ChoiceField
          control={f.control}
          name="invoice_approval_mode"
          legend="Invoices raised by Managers"
          choices={[
            { value: "none", label: "No approval needed", description: "Managers' invoices can be sent straight away." },
            { value: "above", label: "Wait for a Partner above an amount", description: "The total including GST is compared when the invoice is created; changing the limit later doesn't re-check old invoices." },
          ]}
          renderUnder={(mode) =>
            mode === "above" ? (
              <div className="grid max-w-md grid-cols-1 gap-2">
                <MoneyField control={f.control} name="invoice_approval_limit" label="Approval needed above" required />
                <p className="text-sm text-text-muted" aria-live="polite">
                  {invLimit !== null ? `A Manager's invoice above ${formatINR(invLimit)} saves as Awaiting approval.` : "Enter the amount."}
                </p>
              </div>
            ) : null
          }
        />
        <ChoiceField
          control={f.control}
          name="quotation_approval_mode"
          legend="Quotations prepared by Managers"
          choices={[
            { value: "always", label: "Always wait for a Partner", description: "Every Manager quotation is approved before it is sent." },
            { value: "never", label: "Never wait", description: "Managers send their quotations themselves." },
            { value: "above", label: "Wait for a Partner above an amount" },
          ]}
          renderUnder={(mode) =>
            mode === "above" ? (
              <div className="grid max-w-md grid-cols-1 gap-2">
                <MoneyField control={f.control} name="quotation_approval_limit" label="Approval needed above" required />
                <p className="text-sm text-text-muted" aria-live="polite">
                  {quoLimit !== null && quoLimit > 0 ? `A Manager's quotation above ${formatINR(quoLimit)} waits for a Partner before it is sent.` : "Enter an amount above ₹0."}
                </p>
              </div>
            ) : null
          }
        />
      </SettingsCard>

      <SettingsCard title="Quotations" description="What a new quotation starts with.">
        <TextField control={f.control} name="quotation_validity_days" label="Valid for (days)" required inputMode="numeric" />
        <SettingPreview wide={false} label="Validity">
          {Number.isInteger(validity) && validity >= 1 && validity <= 365 ? (
            <>
              A quotation issued <span className="num">{formatDate(today)}</span> is valid until <span className="num font-medium">{formatDate(addDays(today, validity))}</span>.
            </>
          ) : (
            <span className="text-text-muted">Enter the days to see the date.</span>
          )}
        </SettingPreview>
        <Wide>
          <TextareaField control={f.control} name="quotation_terms" label="Quotation terms" rows={5} helper="Printed on every quotation and on the client's acceptance page." />
        </Wide>
      </SettingsCard>
    </SettingsForm>
  )
}
