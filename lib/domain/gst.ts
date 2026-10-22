/**
 * GST on TaxWise's own invoices (§6.3, §6.4, §7.9.2, §7.9.7).
 *
 * - Place of supply: the recipient's state, from the client's GSTIN, otherwise the client's state
 *   code, otherwise the firm's own state (an unregistered local client).
 * - Amounts are integer paise. Each line is rounded half-up on its own (`qty × rate`, then its tax,
 *   then its CGST/SGST halves) and the invoice totals are sums of those rounded lines (§6.3).
 *   Intra-state: `cgst = round(tax / 2)`, `sgst = tax − cgst`, so the two always add up exactly.
 * - Pure-agent reimbursements (Rule 33) carry no GST and stay out of the taxable value.
 * - Rule 46 contents, the Rule 47 "invoice within 30 days" flag, the s.34 credit-note deadline, the
 *   SAC-digits rule and the e-invoicing threshold are all here, each taking its statutory numbers as
 *   parameters (`GstParams`, resolved from `statutory_parameters`, §5.12). `GST_DEFAULTS` holds the
 *   §6.4 seed values; `supabase/seed/40_params_gst_tds.sql` seeds the same rows (`GST_SEED_PARAMETERS`).
 *
 * Pure and client-safe. Functions whose answer depends on the date take it as a parameter.
 */

import type { GstRegistration, ServiceType } from "@/lib/domain/enums";
import { addDays, compareDates, diffDays, financialYearOf, fyEnd, MONTH_ABBR, parseDateString, toDateString, type DateString } from "@/lib/domain/fy";
import { isValidStateCode, stateName, validateGstin } from "@/lib/domain/india-validators";
import { divideRoundHalfUp, formatINR, multiplyPaise, percentOf, roundOffToRupee, sumPaise, toPaise, type Paise } from "@/lib/domain/money";
import type { FieldErrors } from "@/lib/result";

// -------------------------------------------------------------------------------------------------
// Statutory parameters (§5.12)
// -------------------------------------------------------------------------------------------------

/**
 * A `statutory_parameters` row as read from the database (§5.12), camel-cased. `value` is the raw
 * jsonb. Amounts inside values are in rupees, as the Law & rules page shows them.
 */
export type StatutoryParameterRow = {
  key: string;
  value: unknown;
  effectiveFrom: DateString;
  effectiveTo?: DateString | null;
  statute?: string | null;
  sectionRef?: string | null;
  sourceRef?: string | null;
  notes?: string | null;
  verified?: boolean;
};

/** A seed row: every column the seed SQL fills (§16), each documented with its legal source. */
export type SeedParameterRow = {
  key: string;
  value: unknown;
  effectiveFrom: DateString;
  effectiveTo: DateString | null;
  statute: string;
  sectionRef: string;
  sourceRef: string;
  notes: string;
  verified: boolean;
};

/**
 * The row for `key` in force on `on` (§5.12: "Lookups always pass a date, and the row in force on
 * that date wins"): `effective_from ≤ on ≤ effective_to` (open-ended when null), latest start wins.
 */
export function parameterInForce<R extends StatutoryParameterRow>(rows: readonly R[], key: string, on: DateString): R | null {
  let best: R | null = null;
  for (const row of rows) {
    if (row.key !== key) continue;
    if (compareDates(row.effectiveFrom, on) > 0) continue;
    if (row.effectiveTo && compareDates(row.effectiveTo, on) < 0) continue;
    if (!best || compareDates(row.effectiveFrom, best.effectiveFrom) > 0) best = row;
  }
  return best;
}

/**
 * A number out of a parameter value stored as `60`, `"60"`, or an object such as `{"value": 60}`,
 * `{"rate": 10}`, `{"amount": 50000}` (the same reading as the SQL `jsonb_to_numeric`). Null otherwise.
 */
export function readParameterNumber(value: unknown): number | null {
  let v = value;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    v = o.value ?? o.limit ?? o.rate ?? o.amount ?? o.max;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberArray(value: unknown): number[] | null {
  const list = Array.isArray(value) ? value : asRecord(value)?.options ?? asRecord(value)?.slabs;
  if (!Array.isArray(list)) return null;
  const out = list.map((x) => readParameterNumber(x));
  return out.every((x): x is number => x !== null) ? out : null;
}

/** The `statutory_parameters` keys this module reads (documented in the seed file too). */
export const GST_PARAM_KEYS = {
  /** GST rate (%) for SAC group 9982 services. [verify] at the SAC level from 22 Sep 2025. */
  defaultRateServices: "gst.default_rate_services",
  /** The GST slab structure, e.g. `[0, 5, 18, 40]` from 22 Sep 2025. */
  slabs: "gst.slabs",
  /** The invoice rate picker: `{"options": [18, 5, 0], "allowOther": true}`. */
  invoiceRateOptions: "gst.invoice_rate_options",
  /** The default SAC map: `{"default": "9982", "byService": {...}}` (firm_settings copies it). */
  sacByService: "gst.sac_by_service",
  /** `{"turnoverUpTo": 50000000, "digitsUpTo": 4, "digitsAbove": 6}`: SAC digits by turnover. */
  sacDigits: "gst.sac_digits",
  /** `{"amount": 50000000}`: e-invoicing applies above this aggregate turnover. */
  eInvoicingThreshold: "gst.e_invoicing_threshold",
  /** `{"amount": 100000000, "days": 30}`: IRP reporting window from this turnover. */
  eInvoiceReportingWindow: "gst.e_invoice_reporting_window",
  /** `{"amount": 50000, "inclusive": false}`: unregistered recipient's address and state (Rule 46). */
  b2cAddressThreshold: "gst.b2c_address_threshold",
  /** 30: a service invoice is due within this many days of supply (Rule 47). */
  invoiceIssueDays: "gst.invoice_issue_days",
  /** 25: completed billable work with no invoice is flagged after this many days (§6.4). */
  unbilledFlagDays: "gst.unbilled_flag_days",
  /** `{"month": 11, "day": 30}`: s.34 credit-note deadline after the FY of supply. */
  creditNoteDeadline: "gst.credit_note_deadline",
  /** 30: warn this many days before the s.34 deadline (§6.4). */
  creditNoteWarnDays: "gst.credit_note_warn_days",
} as const;

/** The SAC map (§6.4, firm_settings.sac_by_service): service type → SAC. */
export type SacMap = Partial<Record<ServiceType | "income_tax_individual", string>>;

/** Every GST number the rules need, resolved for one date (§5.12). Amounts in paise. */
export type GstParams = {
  defaultRateServices: number;
  slabs: readonly number[];
  invoiceRateOptions: readonly number[];
  allowOtherRate: boolean;
  defaultSac: string;
  sacByService: SacMap;
  sacDigits: { turnoverUpToPaise: Paise; digitsUpTo: number; digitsAbove: number };
  eInvoicingThresholdPaise: Paise;
  eInvoiceReportingWindow: { turnoverFromPaise: Paise; days: number };
  b2cAddressThreshold: { amountPaise: Paise; inclusive: boolean };
  invoiceIssueDays: number;
  unbilledFlagDays: number;
  creditNoteDeadline: { month: number; day: number };
  creditNoteWarnDays: number;
};

/** The firm's own state by default (firm_settings.state_code = '29', Karnataka; §1, §5.2). */
export const FIRM_STATE_CODE_DEFAULT = "29";

/** The §6.4 seed values (also in `GST_SEED_PARAMETERS` and the seed SQL). */
export const GST_DEFAULTS: GstParams = {
  defaultRateServices: 18,
  slabs: [0, 5, 18, 40],
  invoiceRateOptions: [18, 5, 0],
  allowOtherRate: true,
  defaultSac: "9982",
  sacByService: {
    audit: "998221",
    bookkeeping: "998222",
    income_tax: "998231",
    income_tax_individual: "998232",
    other: "9982",
  },
  sacDigits: { turnoverUpToPaise: 5_00_00_000_00, digitsUpTo: 4, digitsAbove: 6 },
  eInvoicingThresholdPaise: 5_00_00_000_00,
  eInvoiceReportingWindow: { turnoverFromPaise: 10_00_00_000_00, days: 30 },
  b2cAddressThreshold: { amountPaise: 50_000_00, inclusive: false },
  invoiceIssueDays: 30,
  unbilledFlagDays: 25,
  creditNoteDeadline: { month: 11, day: 30 },
  creditNoteWarnDays: 30,
};

const CGST_ACT = "Central Goods and Services Tax Act, 2017";
const CGST_RULES = "Central Goods and Services Tax Rules, 2017";

/**
 * The GST rows of `supabase/seed/40_params_gst_tds.sql` (§16: statutory_parameters from §6.4). A
 * unit test checks the SQL against this list. [verify] items are `verified: false`.
 */
export const GST_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: GST_PARAM_KEYS.defaultRateServices,
    value: 18,
    effectiveFrom: "2017-07-01",
    effectiveTo: "2025-09-21",
    statute: CGST_ACT,
    sectionRef: "s.9(1); services of heading 9982",
    sourceRef: "Notification 11/2017-Central Tax (Rate) dated 28 Jun 2017, as amended",
    notes: "Professional, accounting, auditing and tax services (SAC group 9982) at 18% (9% CGST + 9% SGST, or 18% IGST). Old invoices keep the rate they were issued at.",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.defaultRateServices,
    value: 18,
    effectiveFrom: "2025-09-22",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.9(1); services of heading 9982",
    sourceRef: "GST rate rationalisation from 22 Sep 2025 (56th GST Council meeting, 3 Sep 2025; CBIC services rate notification of 17 Sep 2025)",
    notes: "SAC group 9982 stays at 18% under the 0/5/18/40 structure. [verify] the SAC-level rate against the current CBIC rate notification (§6.4).",
    verified: false,
  },
  {
    key: GST_PARAM_KEYS.slabs,
    value: [0, 5, 12, 18, 28],
    effectiveFrom: "2017-07-01",
    effectiveTo: "2025-09-21",
    statute: CGST_ACT,
    sectionRef: "s.9(1)",
    sourceRef: "Notification 11/2017-Central Tax (Rate) dated 28 Jun 2017 (services); 1/2017-Central Tax (Rate) (goods)",
    notes: "The GST slabs before 22 Sep 2025. Old invoices keep the rate they were issued at.",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.slabs,
    value: [0, 5, 18, 40],
    effectiveFrom: "2025-09-22",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.9(1)",
    sourceRef: "56th GST Council meeting (3 Sep 2025); rate notifications dated 17 Sep 2025, in force 22 Sep 2025",
    notes: "Since 22 Sep 2025 the slab structure is 0% / 5% / 18% / 40%; the 12% and 28% slabs were removed (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.invoiceRateOptions,
    value: { options: [18, 5, 0], allowOther: true },
    effectiveFrom: "2025-09-22",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.9(1)",
    sourceRef: "§6.4 invoice rate picker",
    notes: "The invoice rate picker offers 18% (default), 5%, 0% / exempt, and \"other\" with a reason (§6.4, §7.9.2).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.sacByService,
    value: {
      default: "9982",
      byService: { audit: "998221", bookkeeping: "998222", income_tax: "998231", income_tax_individual: "998232", other: "9982" },
    },
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "Scheme of classification of services (annexure to Notification 11/2017-Central Tax (Rate))",
    sourceRef: "§6.4 SAC by service",
    notes: "audit/assurance 998221 · accounting & bookkeeping 998222 · corporate tax consulting & preparation 998231 · individual tax preparation 998232 · other/general 9982. Editable in Settings → Billing; confirm with the partners (§6.4).",
    verified: false,
  },
  {
    key: GST_PARAM_KEYS.sacDigits,
    value: { turnoverUpTo: 50000000, digitsUpTo: 4, digitsAbove: 6 },
    effectiveFrom: "2021-04-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 46, first proviso",
    sourceRef: "Notification 78/2020-Central Tax dated 15 Oct 2020",
    notes: "Up to ₹5 crore aggregate turnover a 4-digit SAC on the invoice is enough; above that, 6 digits (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.eInvoicingThreshold,
    value: { amount: 50000000 },
    effectiveFrom: "2023-08-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 48(4)",
    sourceRef: "Notification 10/2023-Central Tax dated 10 May 2023",
    notes: "E-invoicing applies only above ₹5 crore aggregate turnover in any FY from 2017-18 (§6.4). Settings → \"E-invoicing applies\" shows the IRN fields.",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.eInvoiceReportingWindow,
    value: { amount: 100000000, days: 30 },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 48(4)",
    sourceRef: "GSTN advisory dated 5 Nov 2024 (IRP reporting time limit)",
    notes: "Where aggregate turnover is ₹10 crore or more, IRPs refuse e-invoices reported more than 30 days after the invoice date (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.b2cAddressThreshold,
    value: { amount: 50000, inclusive: false },
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 46(f)",
    sourceRef: "CGST Rules, 2017, Rule 46(f)",
    notes: "For an unregistered recipient where the invoice value exceeds ₹50,000, the invoice carries the recipient's address and state (§6.4). [verify] Rule 46(f) reads \"fifty thousand rupees or more\" of taxable value; set inclusive = true to apply it at exactly ₹50,000.",
    verified: false,
  },
  {
    key: GST_PARAM_KEYS.invoiceIssueDays,
    value: 30,
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 47",
    sourceRef: "CGST Rules, 2017, Rule 47",
    notes: "A tax invoice for a service must be issued within 30 days of supplying it (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.unbilledFlagDays,
    value: 25,
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_RULES,
    sectionRef: "Rule 47",
    sourceRef: "§6.4 firm practice",
    notes: "The app flags completed, billable work with no invoice after 25 days, ahead of the Rule 47 limit (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.creditNoteDeadline,
    value: { month: 11, day: 30 },
    effectiveFrom: "2022-10-01",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.34(2)",
    sourceRef: "s.34(2) as amended by the Finance Act, 2022 (Notification 18/2022-Central Tax dated 28 Sep 2022)",
    notes: "A tax-reducing credit note is issued no later than 30 November after the end of the FY of supply, or the date the annual return for that FY is filed, whichever is earlier (§6.4).",
    verified: true,
  },
  {
    key: GST_PARAM_KEYS.creditNoteWarnDays,
    value: 30,
    effectiveFrom: "2022-10-01",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.34(2)",
    sourceRef: "§6.4 firm practice",
    notes: "Warn from 30 days before the s.34 deadline (§6.4).",
    verified: true,
  },
];

export type ResolvedGstParams = {
  params: GstParams;
  /** Keys with no row in force on the date: their `GST_DEFAULTS` value was used. */
  missing: string[];
  /** Keys whose row in force is not yet verified by a Partner (§6: "awaiting partner confirmation"). */
  unverified: string[];
};

/**
 * Resolves `GstParams` for a date from `statutory_parameters` rows (§5.12). A key with no row in
 * force, or a value that can't be read, falls back to `GST_DEFAULTS` and is listed in `missing`.
 */
export function resolveGstParams(rows: readonly StatutoryParameterRow[], on: DateString): ResolvedGstParams {
  const missing: string[] = [];
  const unverified: string[] = [];
  const read = <T>(key: string, parse: (v: unknown) => T | null, fallback: T): T => {
    const row = parameterInForce(rows, key, on);
    const parsed = row ? parse(row.value) : null;
    if (parsed === null) {
      missing.push(key);
      return fallback;
    }
    if (row && row.verified === false) unverified.push(key);
    return parsed;
  };
  const rupees = (v: unknown): Paise | null => {
    const n = readParameterNumber(v);
    return n === null ? null : toPaise(n);
  };
  const d = GST_DEFAULTS;

  const rateOptions = read(
    GST_PARAM_KEYS.invoiceRateOptions,
    (v) => {
      const options = numberArray(v);
      if (!options) return null;
      const allowOther = asRecord(v)?.allowOther;
      return { options, allowOther: typeof allowOther === "boolean" ? allowOther : d.allowOtherRate };
    },
    { options: [...d.invoiceRateOptions], allowOther: d.allowOtherRate },
  );
  const sac = read(
    GST_PARAM_KEYS.sacByService,
    (v) => {
      const o = asRecord(v);
      const byService = asRecord(o?.byService);
      if (!o || !byService) return null;
      const map: SacMap = {};
      for (const [k, s] of Object.entries(byService)) if (typeof s === "string") map[k as keyof SacMap] = s;
      return { defaultSac: typeof o.default === "string" ? o.default : d.defaultSac, map };
    },
    { defaultSac: d.defaultSac, map: { ...d.sacByService } },
  );

  const params: GstParams = {
    defaultRateServices: read(GST_PARAM_KEYS.defaultRateServices, readParameterNumber, d.defaultRateServices),
    slabs: read(GST_PARAM_KEYS.slabs, numberArray, [...d.slabs]),
    invoiceRateOptions: rateOptions.options,
    allowOtherRate: rateOptions.allowOther,
    defaultSac: sac.defaultSac,
    sacByService: sac.map,
    sacDigits: read(
      GST_PARAM_KEYS.sacDigits,
      (v) => {
        const o = asRecord(v);
        const upTo = rupees(o?.turnoverUpTo);
        const low = readParameterNumber(o?.digitsUpTo);
        const high = readParameterNumber(o?.digitsAbove);
        return upTo === null || low === null || high === null ? null : { turnoverUpToPaise: upTo, digitsUpTo: low, digitsAbove: high };
      },
      { ...d.sacDigits },
    ),
    eInvoicingThresholdPaise: read(GST_PARAM_KEYS.eInvoicingThreshold, rupees, d.eInvoicingThresholdPaise),
    eInvoiceReportingWindow: read(
      GST_PARAM_KEYS.eInvoiceReportingWindow,
      (v) => {
        const from = rupees(v);
        const days = readParameterNumber(asRecord(v)?.days);
        return from === null || days === null ? null : { turnoverFromPaise: from, days };
      },
      { ...d.eInvoiceReportingWindow },
    ),
    b2cAddressThreshold: read(
      GST_PARAM_KEYS.b2cAddressThreshold,
      (v) => {
        const amount = rupees(v);
        const inclusive = asRecord(v)?.inclusive;
        return amount === null ? null : { amountPaise: amount, inclusive: inclusive === true };
      },
      { ...d.b2cAddressThreshold },
    ),
    invoiceIssueDays: read(GST_PARAM_KEYS.invoiceIssueDays, readParameterNumber, d.invoiceIssueDays),
    unbilledFlagDays: read(GST_PARAM_KEYS.unbilledFlagDays, readParameterNumber, d.unbilledFlagDays),
    creditNoteDeadline: read(
      GST_PARAM_KEYS.creditNoteDeadline,
      (v) => {
        const o = asRecord(v);
        const month = readParameterNumber(o?.month);
        const day = readParameterNumber(o?.day);
        return month === null || day === null ? null : { month, day };
      },
      { ...d.creditNoteDeadline },
    ),
    creditNoteWarnDays: read(GST_PARAM_KEYS.creditNoteWarnDays, readParameterNumber, d.creditNoteWarnDays),
  };
  return { params, missing, unverified };
}

// -------------------------------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------------------------------

/** `22 Oct 2026`, the display form of a date (§0.1 rule 13; matches lib/format `formatDate`). */
function displayDate(date: DateString): string {
  const { year, month, day } = parseDateString(date);
  return `${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]} ${year}`;
}

/** A rate as written on screen: `18`, `2.5` (no trailing zeros). */
function rateText(rate: number): string {
  return String(rate);
}

function blank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

function addError(errors: FieldErrors, field: string, message: string): void {
  (errors[field] ??= []).push(message);
}

// -------------------------------------------------------------------------------------------------
// Place of supply (§6.4)
// -------------------------------------------------------------------------------------------------

export type PlaceOfSupplySource = "gstin" | "client_state" | "firm_state" | "override";

export type PlaceOfSupply = {
  /** Two-digit GST state code, e.g. `'29'`. */
  code: string;
  /** State name, e.g. `'Karnataka'`. */
  name: string;
  source: PlaceOfSupplySource;
  /** Same state as the firm → CGST + SGST; otherwise IGST. */
  intraState: boolean;
};

/** True when the supply is within the firm's state (CGST + SGST), false for IGST (§6.4). */
export function isIntraState(placeOfSupplyCode: string, firmStateCode: string = FIRM_STATE_CODE_DEFAULT): boolean {
  return placeOfSupplyCode === firmStateCode;
}

/**
 * The place of supply (§6.4): the recipient's state from a valid GSTIN, otherwise the client's
 * state code, otherwise the firm's own state (an unregistered local client). An invalid GSTIN is
 * ignored here (Rule 46 validation blocks the invoice for it).
 */
export function placeOfSupply(
  client: { gstin?: string | null; stateCode?: string | null },
  firmStateCode: string = FIRM_STATE_CODE_DEFAULT,
): PlaceOfSupply {
  const make = (code: string, source: PlaceOfSupplySource): PlaceOfSupply => ({
    code,
    name: stateName(code) ?? code,
    source,
    intraState: isIntraState(code, firmStateCode),
  });
  if (!blank(client.gstin)) {
    const g = validateGstin(client.gstin as string);
    if (g.ok) return make(g.stateCode, "gstin");
  }
  const state = client.stateCode?.trim() ?? "";
  if (state !== "" && isValidStateCode(state)) return make(state, "client_state");
  return make(firmStateCode, "firm_state");
}

export type PlaceOfSupplyOverride = { stateCode: string; reason: string };

/**
 * Applies a manual place-of-supply override (§7.9.2: "auto; overridable with a reason"). The state
 * code must be valid and a reason is required. Returns the derived value when no override is given.
 */
export function applyPlaceOfSupplyOverride(
  derived: PlaceOfSupply,
  override: PlaceOfSupplyOverride | null | undefined,
  firmStateCode: string = FIRM_STATE_CODE_DEFAULT,
): { ok: true; value: PlaceOfSupply } | { ok: false; error: string; fieldErrors: FieldErrors } {
  if (!override) return { ok: true, value: derived };
  const code = override.stateCode.trim();
  if (!isValidStateCode(code)) {
    const error = "Pick the state the service is supplied to.";
    return { ok: false, error, fieldErrors: { place_of_supply_code: [error] } };
  }
  if (code === derived.code) return { ok: true, value: derived };
  if (blank(override.reason)) {
    const error = `Say why the place of supply is ${stateName(code)} (${code}) rather than ${derived.name} (${derived.code}).`;
    return { ok: false, error, fieldErrors: { place_of_supply_reason: [error] } };
  }
  return {
    ok: true,
    value: { code, name: stateName(code) ?? code, source: "override", intraState: isIntraState(code, firmStateCode) },
  };
}

// -------------------------------------------------------------------------------------------------
// Lines and totals (§6.3, §6.4)
// -------------------------------------------------------------------------------------------------

export type LineAmounts = {
  /** `qty × rate`, rounded half-up to the paisa: the line's taxable value (or reimbursement). */
  amountPaise: Paise;
  /** `amount × taxRate %`, rounded half-up. */
  taxPaise: Paise;
};

function decimalNumber(value: number | string, what: string): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new TypeError(`The ${what} must be a number; got ${String(value)}.`);
  return n;
}

function assertTaxRate(taxRate: number | string): number {
  const rate = decimalNumber(taxRate, "GST rate");
  if (rate < 0 || rate > 100) throw new RangeError(`A GST rate must be between 0 and 100; got ${rate}.`);
  return rate;
}

/**
 * One invoice line (§6.3): `amount = round(qty × rate)` and `tax = round(amount × taxRate %)`, each
 * half-up to the paisa. `qty` and `taxRate` may be numbers or numeric strings (`"1.50"`, `"18.00"`).
 */
export function computeLine(qty: number | string, ratePaise: Paise, taxRate: number | string): LineAmounts {
  if (decimalNumber(qty, "quantity") <= 0) throw new RangeError("A line's quantity must be more than 0.");
  if (!Number.isSafeInteger(ratePaise) || ratePaise < 0) throw new RangeError("A line's rate must be a whole number of paise, 0 or more.");
  assertTaxRate(taxRate);
  const amountPaise = multiplyPaise(ratePaise, qty);
  return { amountPaise, taxPaise: percentOf(amountPaise, taxRate) };
}

export type TaxSplit = { cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise };

/**
 * Splits a tax amount (§6.4): intra-state → `cgst = round(tax / 2)` half-up, `sgst = tax − cgst`,
 * so the two always add up; inter-state → all IGST.
 */
export function splitTax(taxPaise: Paise, intraState: boolean): TaxSplit {
  if (!intraState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
  const cgstPaise = divideRoundHalfUp(taxPaise, 2);
  return { cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0 };
}

export type InvoiceLineInput = {
  quantity: number | string;
  ratePaise: Paise;
  /** GST %; ignored (treated as 0) for reimbursement lines. */
  taxRate: number | string;
  /** Pure-agent expense (Rule 33): no GST, kept out of the taxable value (§6.4). */
  isReimbursement?: boolean;
};

export type InvoiceLineTotals = LineAmounts & TaxSplit & { isReimbursement: boolean; taxRate: number };

export type InvoiceTotals = {
  intraState: boolean;
  lines: InvoiceLineTotals[];
  /** Sum of non-reimbursement line amounts. */
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  /** cgst + sgst + igst. */
  taxPaise: Paise;
  /** Pure-agent reimbursements (no GST). */
  reimbursementPaise: Paise;
  /** Total before round-off. */
  grossPaise: Paise;
  /** At most ±₹0.99 to reach whole rupees, when enabled (§6.3); 0 otherwise. */
  roundOffPaise: Paise;
  /** taxable + tax + reimbursements + round-off (§5.7). */
  totalPaise: Paise;
};

/**
 * The invoice totals (§5.7, §6.3, §6.4), computed per line and then summed: each line's amount, tax
 * and CGST/SGST (or IGST) split are rounded on the line; the totals are sums of the rounded lines.
 * Reimbursement lines carry no GST and add to `reimbursementPaise`, not the taxable value. With
 * `roundOff` on, the total is rounded half-up to whole rupees and the difference is the round-off.
 */
export function invoiceTotals(
  lines: readonly InvoiceLineInput[],
  placeOfSupplyCode: string,
  firmStateCode: string = FIRM_STATE_CODE_DEFAULT,
  opts: { roundOff: boolean } = { roundOff: false },
): InvoiceTotals {
  const intraState = isIntraState(placeOfSupplyCode, firmStateCode);
  const computed: InvoiceLineTotals[] = lines.map((line) => {
    const isReimbursement = line.isReimbursement === true;
    const taxRate = isReimbursement ? 0 : assertTaxRate(line.taxRate);
    const amounts = computeLine(line.quantity, line.ratePaise, taxRate);
    return { ...amounts, ...splitTax(amounts.taxPaise, intraState), isReimbursement, taxRate };
  });
  const taxable = computed.filter((l) => !l.isReimbursement);
  const taxablePaise = sumPaise(taxable.map((l) => l.amountPaise));
  const cgstPaise = sumPaise(computed.map((l) => l.cgstPaise));
  const sgstPaise = sumPaise(computed.map((l) => l.sgstPaise));
  const igstPaise = sumPaise(computed.map((l) => l.igstPaise));
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  const reimbursementPaise = sumPaise(computed.filter((l) => l.isReimbursement).map((l) => l.amountPaise));
  const grossPaise = taxablePaise + taxPaise + reimbursementPaise;
  const { total, roundOff } = opts.roundOff ? roundOffToRupee(grossPaise) : { total: grossPaise, roundOff: 0 };
  return {
    intraState,
    lines: computed,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    reimbursementPaise,
    grossPaise,
    roundOffPaise: roundOff,
    totalPaise: total,
  };
}

/** The words a reimbursement line must carry (§6.4: "The line must say it's a reimbursement"). */
export const REIMBURSEMENT_SUFFIX = "(reimbursement of expenses incurred as pure agent)";

/**
 * A reimbursement line's description, made to say it's a reimbursement (§6.4, Rule 33): unchanged
 * when it already mentions "reimbursement", otherwise with `REIMBURSEMENT_SUFFIX` appended.
 */
export function reimbursementDescription(description: string): string {
  const text = description.trim();
  if (/reimburse/i.test(text)) return text;
  return text === "" ? "Reimbursement of expenses incurred as pure agent" : `${text} ${REIMBURSEMENT_SUFFIX}`;
}

// -------------------------------------------------------------------------------------------------
// GST rate picker (§6.4)
// -------------------------------------------------------------------------------------------------

export type RateOption = { value: number | "other"; label: string; isDefault: boolean };

/** The invoice rate picker (§6.4): 18% (default), 5%, 0% / exempt, then "Other (give a reason)". */
export function rateOptions(params: Pick<GstParams, "invoiceRateOptions" | "allowOtherRate" | "defaultRateServices"> = GST_DEFAULTS): RateOption[] {
  const options: RateOption[] = params.invoiceRateOptions.map((rate) => ({
    value: rate,
    label: rate === 0 ? "0% / exempt" : rate === params.defaultRateServices ? `${rateText(rate)}% (default)` : `${rateText(rate)}%`,
    isDefault: rate === params.defaultRateServices,
  }));
  if (params.allowOtherRate) options.push({ value: "other", label: "Other (give a reason)", isDefault: false });
  return options;
}

export type TaxRateCheck =
  | { ok: true; rate: number; isOther: boolean; warning?: string }
  | { ok: false; error: string };

/**
 * Validates a line's GST rate (§6.4, §7.9.2): reimbursements must be 0; a rate from the picker is
 * accepted; any other rate (0–100, at most two decimals) needs a reason, and warns when it isn't a
 * current slab. Old invoices keep their rate: this is for new lines only.
 */
export function validateTaxRate(
  rate: number | string,
  opts: { reason?: string | null; isReimbursement?: boolean; params?: Pick<GstParams, "invoiceRateOptions" | "allowOtherRate" | "slabs"> } = {},
): TaxRateCheck {
  const params = opts.params ?? GST_DEFAULTS;
  const text = String(rate).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Enter the GST rate as a percentage, for example 18." };
  const value = Number(text);
  if (value > 100) return { ok: false, error: "A GST rate can't be more than 100%." };
  if (opts.isReimbursement) {
    return value === 0
      ? { ok: true, rate: 0, isOther: false }
      : { ok: false, error: "A reimbursement (pure agent) line carries no GST. Set its rate to 0%." };
  }
  if (params.invoiceRateOptions.includes(value)) return { ok: true, rate: value, isOther: false };
  const listed = params.invoiceRateOptions.map((r) => `${rateText(r)}%`).join(", ");
  if (!params.allowOtherRate) return { ok: false, error: `Use one of the GST rates offered: ${listed}.` };
  if (blank(opts.reason)) return { ok: false, error: `Give a reason for using ${rateText(value)}% instead of ${listed}.` };
  const warning = params.slabs.includes(value)
    ? undefined
    : `${rateText(value)}% isn't one of the current GST slabs (${params.slabs.map((s) => `${rateText(s)}%`).join(" / ")}).`;
  return warning ? { ok: true, rate: value, isOther: true, warning } : { ok: true, rate: value, isOther: true };
}

// -------------------------------------------------------------------------------------------------
// SAC (§6.4)
// -------------------------------------------------------------------------------------------------

export type SacChoice = {
  sac: string;
  /** Where it came from: the map entry, or the firm's default SAC. */
  source: "map" | "default";
  /** Digits the invoice needs at the firm's turnover (4 up to ₹5 crore, else 6). */
  minDigits: number;
  ok: boolean;
  error?: string;
};

const SAC_PATTERN = /^99\d{2}(\d{2})?$/;

/** The SAC digits required at the firm's aggregate turnover (§6.4); unknown turnover → the lower rule. */
export function sacDigitsRequired(turnoverPaise: Paise | null, params: Pick<GstParams, "sacDigits"> = GST_DEFAULTS): number {
  const r = params.sacDigits;
  return turnoverPaise !== null && turnoverPaise > r.turnoverUpToPaise ? r.digitsAbove : r.digitsUpTo;
}

/**
 * Checks a SAC on an invoice line (§6.4): 4 or 6 digits starting `99`, and at least the digits the
 * firm's aggregate turnover requires (4 up to ₹5 crore, 6 above). Returns null when it's fine.
 */
export function checkSacCode(sac: string, turnoverPaise: Paise | null, params: Pick<GstParams, "sacDigits"> = GST_DEFAULTS): string | null {
  const code = sac.replace(/\s+/g, "");
  if (!SAC_PATTERN.test(code)) return "Enter the SAC: 4 or 6 digits starting 99, for example 9982 or 998221.";
  const min = sacDigitsRequired(turnoverPaise, params);
  if (code.length < min) {
    return `Above ${formatINR(params.sacDigits.turnoverUpToPaise, { decimals: 0 })} aggregate turnover the invoice needs the ${min}-digit SAC, not ${code}.`;
  }
  return null;
}

/**
 * The SAC for a service (§6.4): the map's entry for the service (income-tax work for an individual
 * uses `income_tax_individual`, then `income_tax`), otherwise the firm's default SAC, checked
 * against the digits the firm's turnover requires.
 */
export function sacFor(
  serviceType: ServiceType | null | undefined,
  sacMap: SacMap = GST_DEFAULTS.sacByService,
  turnoverPaise: Paise | null = null,
  opts: { individual?: boolean; defaultSac?: string; params?: Pick<GstParams, "sacDigits"> } = {},
): SacChoice {
  const params = opts.params ?? GST_DEFAULTS;
  const defaultSac = opts.defaultSac ?? GST_DEFAULTS.defaultSac;
  let mapped: string | undefined;
  if (serviceType === "income_tax" && opts.individual) mapped = sacMap.income_tax_individual ?? sacMap.income_tax;
  else if (serviceType) mapped = sacMap[serviceType];
  const fromMap = mapped?.trim() ? mapped : undefined;
  const sac = (fromMap ?? defaultSac).replace(/\s+/g, "");
  const error = checkSacCode(sac, turnoverPaise, params);
  const base = { sac, source: fromMap ? ("map" as const) : ("default" as const), minDigits: sacDigitsRequired(turnoverPaise, params) };
  return error ? { ...base, ok: false, error } : { ...base, ok: true };
}

// -------------------------------------------------------------------------------------------------
// Rule 46: invoice contents (§6.4)
// -------------------------------------------------------------------------------------------------

export type Rule46Input = {
  recipient: {
    name?: string | null;
    address?: string | null;
    stateCode?: string | null;
    gstRegistration: GstRegistration;
    gstin?: string | null;
  };
  /** The firm (supplier). Checked only when given (at issue). */
  supplier?: { name?: string | null; address?: string | null; gstin?: string | null };
  /** The invoice value (total incl. GST), compared with the unregistered-recipient threshold. */
  invoiceValuePaise: Paise;
  placeOfSupplyCode?: string | null;
  lines?: ReadonlyArray<{ description?: string | null; sacCode?: string | null }>;
};

export type Rule46Result = {
  /** False when anything blocks the invoice. */
  ok: boolean;
  /** Blocking problems, by field. */
  fieldErrors: FieldErrors;
  /** The first blocking sentence, for a form-level alert. */
  error?: string;
  /** Things to fix that don't block. */
  warnings: string[];
};

/** The sentence shown when a registered client has no GSTIN (§6.4). */
export const MISSING_RECIPIENT_GSTIN_MESSAGE =
  "This client is registered for GST but has no GSTIN on file. Add it before invoicing: an invoice without the recipient's GSTIN costs a registered client their input tax credit.";

/** True when the invoice value is over the unregistered-recipient threshold (Rule 46(f), §6.4). */
export function needsB2cAddress(invoiceValuePaise: Paise, params: Pick<GstParams, "b2cAddressThreshold"> = GST_DEFAULTS): boolean {
  const t = params.b2cAddressThreshold;
  return t.inclusive ? invoiceValuePaise >= t.amountPaise : invoiceValuePaise > t.amountPaise;
}

/**
 * The Rule 46 checks before an invoice is issued (§6.4, §7.9.2):
 * - a registered client with no GSTIN → **block** ("costs a registered client their input tax credit");
 * - a GSTIN that isn't valid → block;
 * - an unregistered recipient (or unknown registration) where the invoice value exceeds ₹50,000 →
 *   the recipient's address and state are required;
 * - the recipient's name, the place of supply, and each line's description and SAC are required;
 *   the supplier's name, address and GSTIN when the supplier is given.
 */
export function validateRule46(input: Rule46Input, params: Pick<GstParams, "b2cAddressThreshold"> = GST_DEFAULTS): Rule46Result {
  const errors: FieldErrors = {};
  const warnings: string[] = [];
  const r = input.recipient;

  if (blank(r.name)) addError(errors, "client_name", "Enter the client's name: Rule 46 requires the recipient's name on the invoice.");

  if (r.gstRegistration === "registered") {
    if (blank(r.gstin)) addError(errors, "client_gstin", MISSING_RECIPIENT_GSTIN_MESSAGE);
    if (blank(r.address)) warnings.push("Add the client's address: Rule 46 asks for the recipient's name and address on the invoice.");
  }
  if (!blank(r.gstin)) {
    const g = validateGstin(r.gstin as string);
    if (!g.ok) addError(errors, "client_gstin", `${g.error} Fix it on the client's profile before invoicing.`);
  }
  if (r.gstRegistration !== "registered") {
    if (r.gstRegistration === "unknown") {
      warnings.push("The client's GST registration is unknown. Confirm it: a registered client needs their GSTIN on the invoice.");
    }
    if (needsB2cAddress(input.invoiceValuePaise, params)) {
      const over = formatINR(params.b2cAddressThreshold.amountPaise, { decimals: 0 });
      if (blank(r.address)) addError(errors, "client_address", `Add the client's address: an invoice over ${over} to an unregistered client must show it (Rule 46).`);
      const state = r.stateCode?.trim() ?? "";
      if (state === "" || !isValidStateCode(state)) {
        addError(errors, "client_state_code", `Add the client's state: an invoice over ${over} to an unregistered client must show it (Rule 46).`);
      }
    }
  }

  const pos = input.placeOfSupplyCode?.trim() ?? null;
  if (pos !== null && !isValidStateCode(pos)) addError(errors, "place_of_supply_code", "Pick the place of supply: the state name and code go on the invoice.");

  if (input.supplier) {
    const s = input.supplier;
    if (blank(s.name) || blank(s.address)) {
      addError(errors, "firm", "Add the firm's name and address in Settings → Firm details before issuing invoices.");
    }
    if (blank(s.gstin)) addError(errors, "firm_gstin", "Add the firm's GSTIN in Settings → Firm details before issuing invoices.");
    else if (!validateGstin(s.gstin as string).ok) addError(errors, "firm_gstin", "The firm's GSTIN in Settings → Firm details isn't valid. Correct it before issuing invoices.");
  }

  (input.lines ?? []).forEach((line, i) => {
    if (blank(line.description)) addError(errors, `items.${i}.description`, "Describe the service on this line.");
    if (blank(line.sacCode)) addError(errors, `items.${i}.sac_code`, "Enter the SAC for this line.");
  });

  const first = Object.values(errors)[0]?.[0];
  return first ? { ok: false, fieldErrors: errors, error: first, warnings } : { ok: true, fieldErrors: errors, warnings };
}

// -------------------------------------------------------------------------------------------------
// Rule 47: invoice within 30 days of supply (§6.4, §7.9.2)
// -------------------------------------------------------------------------------------------------

export type Rule47Flag = {
  /** `due_soon`: past the 25-day flag but still in time; `late`: past the 30-day Rule 47 limit. */
  level: "due_soon" | "late";
  daysSinceCompletion: number;
  /** The last day a tax invoice can be issued within Rule 47. */
  invoiceBy: DateString;
  message: string;
};

/**
 * The Rule 47 flag for completed, billable work with no invoice (§6.4, §7.9.2): nothing up to 25
 * days after completion; `due_soon` after 25 days; `late` once more than 30 days have passed.
 */
export function rule47Warning(
  workCompletedDate: DateString,
  today: DateString,
  params: Pick<GstParams, "invoiceIssueDays" | "unbilledFlagDays"> = GST_DEFAULTS,
): Rule47Flag | null {
  const days = diffDays(today, workCompletedDate);
  if (days <= params.unbilledFlagDays) return null;
  const invoiceBy = addDays(workCompletedDate, params.invoiceIssueDays);
  const done = `Work completed ${days} days ago (${displayDate(workCompletedDate)}) has no invoice.`;
  if (days > params.invoiceIssueDays) {
    return {
      level: "late",
      daysSinceCompletion: days,
      invoiceBy,
      message: `${done} Rule 47 required the tax invoice within ${params.invoiceIssueDays} days, by ${displayDate(invoiceBy)}. Invoice it now.`,
    };
  }
  return {
    level: "due_soon",
    daysSinceCompletion: days,
    invoiceBy,
    message: `${done} Rule 47 requires the tax invoice within ${params.invoiceIssueDays} days: issue it by ${displayDate(invoiceBy)}.`,
  };
}

// -------------------------------------------------------------------------------------------------
// Credit notes (s.34 CGST Act; §6.4, §7.9.7)
// -------------------------------------------------------------------------------------------------

/**
 * The s.34 deadline for a tax-reducing credit note against an invoice (§6.4): 30 November after the
 * end of the FY in which the supply was made, or the date the annual return for that FY was filed,
 * whichever is earlier.
 */
export function creditNoteDeadline(
  invoiceDate: DateString,
  annualReturnFiledOn?: DateString | null,
  params: Pick<GstParams, "creditNoteDeadline"> = GST_DEFAULTS,
): DateString {
  const fyEndYear = parseDateString(fyEnd(financialYearOf(invoiceDate))).year;
  const statutory = toDateString(fyEndYear, params.creditNoteDeadline.month, params.creditNoteDeadline.day);
  if (annualReturnFiledOn && compareDates(annualReturnFiledOn, statutory) < 0) return annualReturnFiledOn;
  return statutory;
}

export type CreditNoteCheck = {
  deadline: DateString;
  /** Days from the credit note date to the deadline (negative once it has passed). */
  daysLeft: number;
  /**
   * `ok`: in time · `warn`: within 30 days of the deadline · `refuse`: a tax-reducing note after the
   * deadline (refused) · `commercial`: a non-GST commercial credit (always allowed).
   */
  level: "ok" | "warn" | "refuse" | "commercial";
  /** Whether the credit note may be issued as asked. */
  allowed: boolean;
  message: string | null;
};

/**
 * Checks a credit note against the s.34 deadline (§6.4, §7.9.7): warns from 30 days before it and
 * refuses a tax-reducing credit note after it. A commercial (non-GST) credit is still allowed, with
 * a clear notice. On the deadline day itself the note is still in time ("no later than").
 */
export function checkCreditNote(
  input: { invoiceDate: DateString; annualReturnFiledOn?: DateString | null; creditNoteDate: DateString; reducesTax: boolean },
  params: Pick<GstParams, "creditNoteDeadline" | "creditNoteWarnDays"> = GST_DEFAULTS,
): CreditNoteCheck {
  const deadline = creditNoteDeadline(input.invoiceDate, input.annualReturnFiledOn, params);
  const daysLeft = diffDays(deadline, input.creditNoteDate);
  const why = input.annualReturnFiledOn && deadline === input.annualReturnFiledOn ? "the annual return was filed" : "s.34 deadline";
  if (!input.reducesTax) {
    return {
      deadline,
      daysLeft,
      level: "commercial",
      allowed: true,
      message: "This is a commercial credit: it reduces what the client owes but not the GST on the invoice, and it doesn't go into GSTR-1.",
    };
  }
  if (daysLeft < 0) {
    return {
      deadline,
      daysLeft,
      level: "refuse",
      allowed: false,
      message: `A credit note that reduces GST had to be issued by ${displayDate(deadline)} (${why}). You can still give a commercial credit, which reduces what the client owes but not the GST.`,
    };
  }
  if (daysLeft <= params.creditNoteWarnDays) {
    return {
      deadline,
      daysLeft,
      level: "warn",
      allowed: true,
      message: `A credit note that reduces GST must be issued by ${displayDate(deadline)} (${why}): ${daysLeft === 0 ? "today is the last day" : `${daysLeft} days left`}.`,
    };
  }
  return { deadline, daysLeft, level: "ok", allowed: true, message: null };
}

export type CreditNoteAmounts = TaxSplit & { taxablePaise: Paise; taxPaise: Paise; totalPaise: Paise };

/**
 * A credit note's GST (§7.9.7): the taxable amount to credit at the invoice's rate, split the same
 * way as the invoice (CGST + SGST or IGST by place of supply).
 */
export function creditNoteAmounts(
  taxablePaise: Paise,
  taxRate: number | string,
  placeOfSupplyCode: string,
  firmStateCode: string = FIRM_STATE_CODE_DEFAULT,
): CreditNoteAmounts {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise <= 0) throw new RangeError("The amount to credit must be more than 0.");
  const taxPaise = percentOf(taxablePaise, assertTaxRate(taxRate));
  const split = splitTax(taxPaise, isIntraState(placeOfSupplyCode, firmStateCode));
  return { taxablePaise, taxPaise, ...split, totalPaise: taxablePaise + taxPaise };
}

/**
 * The taxable amount to credit must be more than 0 and at most the invoice's remaining taxable
 * value (§7.9.7). Returns null when it's fine, otherwise the sentence for the field.
 */
export function validateCreditNoteTaxable(taxablePaise: Paise, remainingTaxablePaise: Paise): string | null {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise <= 0) return "Enter the taxable amount to credit.";
  if (taxablePaise > remainingTaxablePaise) {
    return `You can credit at most ${formatINR(Math.max(0, remainingTaxablePaise))}, the taxable value not yet credited on this invoice.`;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// E-invoicing (§6.4)
// -------------------------------------------------------------------------------------------------

/**
 * True when e-invoicing applies (§6.4): aggregate turnover above ₹5 crore. Unknown turnover → false
 * (Settings → "E-invoicing applies" is the switch the app actually follows).
 */
export function eInvoicingApplies(turnoverPaise: Paise | null, params: Pick<GstParams, "eInvoicingThresholdPaise"> = GST_DEFAULTS): boolean {
  return turnoverPaise !== null && turnoverPaise > params.eInvoicingThresholdPaise;
}

/**
 * Days after the invoice date within which the IRP must receive the e-invoice (§6.4): 30 where
 * turnover is ₹10 crore or more; null when there's no such limit (or e-invoicing doesn't apply).
 */
export function eInvoiceReportingDays(
  turnoverPaise: Paise | null,
  params: Pick<GstParams, "eInvoicingThresholdPaise" | "eInvoiceReportingWindow"> = GST_DEFAULTS,
): number | null {
  if (!eInvoicingApplies(turnoverPaise, params) || turnoverPaise === null) return null;
  return turnoverPaise >= params.eInvoiceReportingWindow.turnoverFromPaise ? params.eInvoiceReportingWindow.days : null;
}
