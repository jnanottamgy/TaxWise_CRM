import type { ServiceType } from "@/lib/domain/enums"
import {
  SERVICE_LINE_DEFAULTS,
  derivedPlaceOfSupply,
  emptyQuotationValues,
  newLine,
  type QuotationDraftValues,
  type QuotationTaxRate,
} from "@/lib/schemas/quotations"
import type { BuilderPrefill, BuilderSettings, QuotationDetail } from "@/lib/data/quotations"

/**
 * The builder's starting values (§7.5.2): a new quotation (today, valid for the Settings days, the
 * Settings terms, one empty line or one line per service the lead asked for) optionally pre-filled
 * from a lead or a client, or a Draft as saved. Server-safe.
 */
export function newBuilderValues(settings: BuilderSettings, prefill: BuilderPrefill | null): QuotationDraftValues {
  const base = emptyQuotationValues({ today: settings.today, validityDays: settings.validityDays, terms: settings.terms, firmStateCode: settings.firmStateCode })
  if (!prefill) return base
  const services = prefill.services.filter((s): s is ServiceType => Boolean(s))
  return {
    ...base,
    party: prefill.party,
    lead_id: prefill.lead_id,
    client_id: prefill.client_id,
    client_name: prefill.client_name,
    client_email: prefill.client_email,
    client_phone: prefill.client_phone,
    client_company: prefill.client_company,
    client_gstin: prefill.client_gstin,
    place_of_supply_code: derivedPlaceOfSupply(prefill.client_gstin, prefill.state_code, settings.firmStateCode).code,
    lines: services.length ? services.map((s) => newLine({ service_type: s, description: SERVICE_LINE_DEFAULTS[s] })) : base.lines,
  }
}

/** The line's GST rate as the builder's choice; a rate the builder doesn't offer is kept, so saving asks for a choice rather than changing the tax silently. */
function rateOf(v: number): QuotationTaxRate {
  return String(Number(v)) as QuotationTaxRate
}

/** A saved Draft as the builder's values. */
export function draftBuilderValues(detail: QuotationDetail, firmStateCode: string): QuotationDraftValues {
  const q = detail.q
  const party = q.lead_id ? "lead" : q.client_id ? "client" : "other"
  return {
    id: q.id,
    updatedAt: q.updated_at,
    party,
    lead_id: q.lead_id,
    client_id: q.client_id,
    client_name: q.client_name,
    client_email: String(q.client_email ?? ""),
    client_phone: q.client_phone ?? "",
    client_company: q.client_company ?? "",
    client_gstin: q.client_gstin ? String(q.client_gstin) : "",
    place_of_supply_code: q.place_of_supply_code ?? firmStateCode,
    issue_date: q.issue_date,
    valid_until: q.valid_until,
    notes: q.notes ?? "",
    terms: q.terms ?? "",
    lines: detail.items.length
      ? detail.items.map((i) =>
          newLine({
            description: i.description,
            service_type: i.service_type ?? "",
            frequency: i.frequency ?? "",
            quantity: String(i.quantity),
            unit_price: Number(i.unit_price).toFixed(2),
            tax_rate: rateOf(i.tax_rate),
          }),
        )
      : [newLine()],
  }
}

/** "LD-0012 · Sharma Traders · Ravi Sharma" or "TW-C-0042 · Sharma Traders", the picker's label for a saved Draft. */
export function draftPartyLabel(detail: QuotationDetail): string | null {
  if (detail.lead) return [detail.lead.lead_number, detail.lead.company, detail.lead.name].filter(Boolean).join(" · ")
  if (detail.client) return `${detail.client.client_code} · ${detail.client.display_name}`
  return null
}
