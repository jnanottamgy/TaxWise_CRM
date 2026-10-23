import type { ClientStatus, EntityType, ServiceFrequency, ServiceType } from "@/lib/domain/enums";
import { compareDates, type DateString } from "@/lib/domain/fy";
import { invoiceTotals, placeOfSupply, sacFor, type SacMap } from "@/lib/domain/gst";
import { retainerPeriodLabel } from "@/lib/domain/invoice";
import { toPaiseOrNull, type Paise } from "@/lib/domain/money";
import { serviceName } from "@/lib/schemas/client-services";

/**
 * The "preview of the next invoice" on Services & fees (§7.3.3 tab 3): one line for the agreed fee
 * (excl. GST) at the firm's default GST rate, the SAC from the service's override or the firm's map
 * (§6.4), and CGST + SGST or IGST from the place of supply (§6.4), computed with invoiceTotals in
 * integer paise (§0.1 rule 7). When auto-invoicing is on, it is the draft the 09:30 job will raise on
 * the next billing date (§7.9.6). Pure and client-safe.
 */

export interface NextInvoiceInput {
  service: {
    service_type: ServiceType;
    custom_name: string | null;
    frequency: ServiceFrequency;
    billing_frequency: ServiceFrequency | null;
    agreed_fee: number | string | null;
    sac_code: string | null;
    auto_invoice: boolean;
    next_billing_date: DateString | null;
    is_active: boolean;
  };
  client: { gstin: string | null; state_code: string | null; entity_type: EntityType | null; status: ClientStatus };
  firm: { state_code: string; default_tax_rate: number | string; default_sac: string; sac_by_service: SacMap | null };
  today: DateString;
}

export type NextInvoicePreview =
  | { kind: "none"; reason: string }
  | {
      kind: "preview";
      /** The billing date the draft is for (auto-invoice), or null when raised by hand. */
      billingDate: DateString | null;
      periodLabel: string;
      description: string;
      sac: string;
      taxRate: number;
      placeOfSupply: { code: string; name: string };
      intraState: boolean;
      taxablePaise: Paise;
      cgstPaise: Paise;
      sgstPaise: Paise;
      igstPaise: Paise;
      totalPaise: Paise;
      /** How it will be raised, in one sentence. */
      basis: string;
      /** Why the automatic draft won't be raised yet, when it won't. */
      paused?: string;
    };

export function nextInvoicePreview(input: NextInvoiceInput): NextInvoicePreview {
  const { service: s, client, firm, today } = input;
  if (!s.is_active) return { kind: "none", reason: "This service has ended, so nothing more is billed for it." };
  const fee = toPaiseOrNull(s.agreed_fee);
  if (fee === null) return { kind: "none", reason: "No fee agreed yet. Re-price the service to set one." };
  if (fee === 0) return { kind: "none", reason: "The agreed fee is ₹0.00, so there is nothing to invoice." };

  const cycle = s.billing_frequency ?? s.frequency;
  const pos = placeOfSupply({ gstin: client.gstin, stateCode: client.state_code }, firm.state_code);
  const override = s.sac_code?.trim() ? s.sac_code.trim() : null;
  const sac = override ?? sacFor(s.service_type, firm.sac_by_service ?? undefined, null, { individual: client.entity_type === "individual", defaultSac: firm.default_sac }).sac;
  const taxRate = Number(firm.default_tax_rate);
  const totals = invoiceTotals([{ quantity: 1, ratePaise: fee, taxRate }], pos.code, firm.state_code);

  const billingDate = s.auto_invoice ? s.next_billing_date : null;
  const labelDate = billingDate ?? s.next_billing_date ?? today;
  const periodLabel = cycle === "one_time" ? "One-time" : retainerPeriodLabel(labelDate, cycle);
  const name = serviceName(s.service_type, s.custom_name);

  let basis: string;
  let paused: string | undefined;
  if (s.auto_invoice && billingDate) {
    basis =
      compareDates(billingDate, today) <= 0
        ? "Raised as a draft at the next 09:30 retainer run (it's due now)."
        : "Raised as a draft by the 09:30 retainer run on the billing date; a Partner or Manager issues it.";
    if (client.status === "on_hold" || client.status === "inactive") {
      paused = `Automatic invoicing is paused while the client is ${client.status === "on_hold" ? "on hold" : "inactive"}.`;
    }
  } else {
    basis = "Automatic invoicing is off: raise this invoice by hand from Billing.";
  }

  return {
    kind: "preview",
    billingDate,
    periodLabel,
    description: cycle === "one_time" ? name : `${name} · ${periodLabel}`,
    sac,
    taxRate,
    placeOfSupply: { code: pos.code, name: pos.name },
    intraState: totals.intraState,
    taxablePaise: totals.taxablePaise,
    cgstPaise: totals.cgstPaise,
    sgstPaise: totals.sgstPaise,
    igstPaise: totals.igstPaise,
    totalPaise: totals.totalPaise,
    basis,
    paused,
  };
}
