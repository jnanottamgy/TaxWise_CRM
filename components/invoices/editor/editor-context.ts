import { rateOptions, type GstParams } from "@/lib/domain/gst"
import type { BillingSettings, ClientBillingFacts, InvoiceItemRow, InvoiceRow } from "@/lib/data/invoices"
import { placeOfSupply } from "@/lib/domain/gst"
import { paiseToDecimalString, toPaise } from "@/lib/domain/money"
import { defaultDueDate, type InvoiceFormInput, type InvoiceLineValues } from "@/lib/schemas/invoices"
import type { EditorGst, EditorSettings } from "@/components/invoices/editor/types"

/**
 * Shapes what the server read into the editor's props (§7.9.2). Pure; used by /invoices/new and
 * /invoices/[id]/edit.
 */

export function editorSettings(s: BillingSettings): EditorSettings {
  return {
    firmStateCode: s.firmStateCode,
    defaultSac: s.defaultSac,
    sacByService: s.sacByService,
    paymentTermsDays: s.paymentTermsDays,
    invoiceTerms: s.invoiceTerms,
    approvalLimitPaise: s.invoiceApprovalLimitPaise,
    roundOffDefault: s.roundOffEnabled,
  }
}

export function editorGst(p: GstParams): EditorGst {
  return {
    rateOptions: rateOptions(p),
    defaultRate: p.defaultRateServices,
    b2cThresholdPaise: p.b2cAddressThreshold.amountPaise,
    b2cInclusive: p.b2cAddressThreshold.inclusive,
    invoiceIssueDays: p.invoiceIssueDays,
    unbilledFlagDays: p.unbilledFlagDays,
  }
}

export function blankFormLine(defaultRate: number): InvoiceLineValues {
  return {
    key: "l0",
    description: "",
    service_type: "",
    sac_code: "",
    quantity: "1",
    rate: "",
    tax_rate: String(defaultRate),
    tax_rate_reason: "",
    is_reimbursement: false,
    client_service_id: "",
    source_task_id: "",
    time_entry_ids: [],
    source_label: "",
  }
}

/** The form for a new invoice: today, the payment terms, the derived place of supply, the firm's terms. */
export function newInvoiceForm(input: { today: string; settings: BillingSettings; client: ClientBillingFacts | null; defaultRate: number }): InvoiceFormInput {
  const pos = input.client ? placeOfSupply({ gstin: input.client.gstin, stateCode: input.client.state_code }, input.settings.firmStateCode).code : input.settings.firmStateCode
  return {
    id: null,
    updated_at: null,
    client_id: input.client?.id ?? "",
    issue_date: input.today,
    due_date: defaultDueDate(input.today, input.settings.paymentTermsDays),
    place_of_supply_code: pos,
    place_of_supply_reason: "",
    billing_period_label: "",
    notes: "",
    terms: input.settings.invoiceTerms ?? "",
    round_off: input.settings.roundOffEnabled,
    lines: [blankFormLine(input.defaultRate)],
  }
}

/** The form for a saved draft. */
export function draftInvoiceForm(inv: InvoiceRow, items: readonly InvoiceItemRow[], defaultRate: number, roundOffDefault: boolean): InvoiceFormInput {
  const lines: InvoiceLineValues[] = items.map((i, idx) => ({
    key: `l${idx}-${i.id.slice(0, 8)}`,
    description: i.description,
    service_type: i.service_type ?? "",
    sac_code: i.sac_code,
    quantity: String(Number(i.quantity)),
    rate: paiseToDecimalString(toPaise(i.rate)),
    tax_rate: String(Number(i.tax_rate)),
    tax_rate_reason: i.tax_rate_reason ?? "",
    is_reimbursement: i.is_reimbursement,
    client_service_id: i.client_service_id ?? "",
    source_task_id: i.source_task_id ?? "",
    time_entry_ids: i.time_entry_ids ?? [],
    source_label: i.client_service_id ? "From an engagement" : i.time_entry_ids?.length ? `From unbilled time: ${i.time_entry_ids.length} ${i.time_entry_ids.length === 1 ? "entry" : "entries"}` : i.source_task_id ? "From a completed task" : "",
  }))
  return {
    id: inv.id,
    updated_at: inv.updated_at,
    client_id: inv.client_id,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    place_of_supply_code: inv.place_of_supply_code,
    place_of_supply_reason: inv.place_of_supply_reason ?? "",
    billing_period_label: inv.billing_period_label ?? "",
    notes: inv.notes ?? "",
    terms: inv.terms ?? "",
    round_off: Number(inv.round_off) !== 0 || roundOffDefault,
    lines: lines.length ? lines : [blankFormLine(defaultRate)],
  }
}
