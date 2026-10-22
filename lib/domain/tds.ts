/**
 * TDS deducted by clients on TaxWise's fees, and invoice settlement (§6.5, §7.9.4, §7.9.9).
 *
 * - Rates and thresholds are data (§5.12): a table of `statutory_parameters` rows keyed by nature
 *   and looked up by **payment date**. Payments up to 31 March 2026 fall under the Income-tax Act,
 *   1961 (ss.194J, 194C, 194H, 194I); payments from 1 April 2026 under the Income-tax Act, 2025
 *   (s.393, one tabular section; [verify] entry numbers and thresholds). `TDS_SEED_PARAMETERS` holds
 *   the §6.5 seed rows (the same rows as `supabase/seed/40_params_gst_tds.sql`).
 * - Base: the fee **excluding GST** when GST is shown separately (CBDT Circular 23/2017), so the
 *   expected TDS is `taxable value × rate`, rounded half-up to the paisa.
 * - Settlement: `outstanding = total − amount_received − tds_credited − credit_noted`. A receipt may
 *   be settled wholly or partly by TDS; received + TDS may exceed the outstanding by at most ₹1.
 *
 * Pure and client-safe. Amounts are integer paise.
 */

import type { DateString } from "@/lib/domain/fy";
import { parameterInForce, readParameterNumber, type SeedParameterRow, type StatutoryParameterRow } from "@/lib/domain/gst";
import { formatINR, percentOf, sumPaise, toPaise, type Paise } from "@/lib/domain/money";
import type { FieldErrors } from "@/lib/result";

// -------------------------------------------------------------------------------------------------
// Natures and parameter keys (§6.5)
// -------------------------------------------------------------------------------------------------

/** What the client paid TaxWise for, which decides the TDS rate (§6.5). */
export const TDS_NATURES = [
  "professional",
  "technical",
  "commission",
  "rent_land_building",
  "rent_plant_machinery",
  "contract_individual_huf",
  "contract_others",
] as const;
export type TdsNature = (typeof TDS_NATURES)[number];

/** True for one of the seven natures. */
export function isTdsNature(v: unknown): v is TdsNature {
  return typeof v === "string" && (TDS_NATURES as readonly string[]).includes(v);
}

export const TDS_NATURE_LABELS: Readonly<Record<TdsNature, string>> = {
  professional: "Fees for professional services",
  technical: "Fees for technical services",
  commission: "Commission or brokerage",
  rent_land_building: "Rent: land or building",
  rent_plant_machinery: "Rent: plant or machinery",
  contract_individual_huf: "Contract work: individual or HUF",
  contract_others: "Contract work: others",
};

/**
 * The `statutory_parameters` keys per nature (§5.12; e.g. `tds.professional_fees.rate`). Rate values
 * are `{"rate": 10, "section": "194J"}`; threshold values `{"amount": 50000, "per": "year"}` in
 * rupees (`per`: `year` aggregate in the FY, `month`, or `payment` with an `annual` aggregate).
 */
export const TDS_PARAM_KEYS: Readonly<Record<TdsNature, { rate: string; threshold: string }>> = {
  professional: { rate: "tds.professional_fees.rate", threshold: "tds.professional_fees.threshold" },
  technical: { rate: "tds.technical_services.rate", threshold: "tds.technical_services.threshold" },
  commission: { rate: "tds.commission.rate", threshold: "tds.commission.threshold" },
  rent_land_building: { rate: "tds.rent_land_building.rate", threshold: "tds.rent_land_building.threshold" },
  rent_plant_machinery: { rate: "tds.rent_plant_machinery.rate", threshold: "tds.rent_plant_machinery.threshold" },
  contract_individual_huf: { rate: "tds.contract_individual_huf.rate", threshold: "tds.contract_individual_huf.threshold" },
  contract_others: { rate: "tds.contract_others.rate", threshold: "tds.contract_others.threshold" },
};

/** `true`: TDS is computed on the fee excluding GST shown separately (CBDT Circular 23/2017). */
export const TDS_BASE_PARAM_KEY = "tds.base_excludes_gst";

/** The receipt form's "TDS section" value for a section the table doesn't cover (§5.7). */
export const TDS_SECTION_OTHER = "OTHER";

/**
 * Seed values for the app rules around TDS (not statutory numbers): the ₹1 by which received + TDS
 * may exceed the outstanding amount (§7.9.4), and the Circular 23/2017 base when no row is found.
 */
export const TDS_DEFAULTS = {
  receiptTolerancePaise: 100,
  baseExcludesGst: true,
} as const;

// -------------------------------------------------------------------------------------------------
// Seed rows (§6.5, §16)
// -------------------------------------------------------------------------------------------------

const ACT_1961 = "Income-tax Act, 1961";
const ACT_2025 = "Income-tax Act, 2025";
const FA_2025 = "Finance Act, 2025";
const FROM_2026 = "2026-04-01";
const UNTIL_2026 = "2026-03-31";
const S393_NOTE = "[verify] table entry number and threshold against s.393 (§6.5).";

type Act1961Row = {
  nature: TdsNature;
  part: "rate" | "threshold";
  value: unknown;
  from: DateString;
  to: DateString;
  sectionRef: string;
  sourceRef: string;
  notes: string;
};

function row1961(r: Act1961Row): SeedParameterRow {
  return {
    key: TDS_PARAM_KEYS[r.nature][r.part],
    value: r.value,
    effectiveFrom: r.from,
    effectiveTo: r.to,
    statute: ACT_1961,
    sectionRef: r.sectionRef,
    sourceRef: r.sourceRef,
    notes: r.notes,
    verified: true,
  };
}

function row2025(nature: TdsNature, part: "rate" | "threshold", value: unknown, notes: string): SeedParameterRow {
  return {
    key: TDS_PARAM_KEYS[nature][part],
    value,
    effectiveFrom: FROM_2026,
    effectiveTo: null,
    statute: ACT_2025,
    sectionRef: "s.393 (table entry [verify])",
    sourceRef: "Income-tax Act, 2025, s.393; in force for payments from 1 Apr 2026",
    notes: `${notes} ${S393_NOTE}`,
    verified: false,
  };
}

/**
 * The TDS rows of `supabase/seed/40_params_gst_tds.sql` (§6.5, §16). 1961-Act rows end on
 * 31 March 2026; the s.393 rows start on 1 April 2026 and are `verified: false` ([verify]).
 */
export const TDS_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: TDS_BASE_PARAM_KEY,
    value: true,
    effectiveFrom: "2017-07-19",
    effectiveTo: null,
    statute: ACT_1961,
    sectionRef: "Chapter XVII-B (s.393 under the 2025 Act)",
    sourceRef: "CBDT Circular 23/2017 dated 19 Jul 2017",
    notes: "TDS applies to the fee excluding GST when GST is shown separately on the invoice (§6.5).",
    verified: true,
  },
  // Professional fees: 194J, 10% above ₹50,000 a year (threshold raised from ₹30,000 by the Finance Act, 2025).
  row1961({
    nature: "professional", part: "rate", value: { rate: 10, section: "194J" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194J(1)(a)", sourceRef: ACT_1961, notes: "Fees for professional services: 10%.",
  }),
  row1961({
    nature: "professional", part: "threshold", value: { amount: 50000, per: "year" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194J(1), proviso", sourceRef: `${FA_2025} (₹30,000 → ₹50,000 from 1 Apr 2025)`,
    notes: "No TDS while fees for professional services paid in the FY don't exceed ₹50,000.",
  }),
  row2025("professional", "rate", { rate: 10, section: "393" }, "Professional fees: 10%."),
  row2025("professional", "threshold", { amount: 50000, per: "year" }, "Professional fees: above an annual ₹50,000."),
  // Technical services: 194J, 2%.
  row1961({
    nature: "technical", part: "rate", value: { rate: 2, section: "194J" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194J(1)(b)", sourceRef: ACT_1961, notes: "Fees for technical services: 2%.",
  }),
  row1961({
    nature: "technical", part: "threshold", value: { amount: 50000, per: "year" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194J(1), proviso", sourceRef: `${FA_2025} (₹30,000 → ₹50,000 from 1 Apr 2025)`,
    notes: "No TDS while fees for technical services paid in the FY don't exceed ₹50,000.",
  }),
  row2025("technical", "rate", { rate: 2, section: "393" }, "Technical services: 2%."),
  row2025(
    "technical",
    "threshold",
    { amount: 50000, per: "year" },
    "§6.5 gives no separate threshold for technical services under s.393; seeded at the 194J value (₹50,000 a year).",
  ),
  // Commission/brokerage: 194H, 2% from 1 Oct 2024; threshold ₹15,000, then ₹20,000 from 1 Apr 2025.
  row1961({
    nature: "commission", part: "rate", value: { rate: 2, section: "194H" }, from: "2024-10-01", to: UNTIL_2026,
    sectionRef: "s.194H", sourceRef: "Finance (No. 2) Act, 2024 (5% → 2% from 1 Oct 2024)",
    notes: "Commission or brokerage: 2%.",
  }),
  row1961({
    nature: "commission", part: "threshold", value: { amount: 15000, per: "year" }, from: "2024-10-01", to: "2025-03-31",
    sectionRef: "s.194H, first proviso", sourceRef: ACT_1961,
    notes: "No TDS while commission paid in the FY doesn't exceed ₹15,000.",
  }),
  row1961({
    nature: "commission", part: "threshold", value: { amount: 20000, per: "year" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194H, first proviso", sourceRef: `${FA_2025} (₹15,000 → ₹20,000 from 1 Apr 2025)`,
    notes: "No TDS while commission paid in the FY doesn't exceed ₹20,000.",
  }),
  row2025("commission", "rate", { rate: 2, section: "393" }, "Commission/brokerage: 2%."),
  row2025("commission", "threshold", { amount: 20000, per: "year" }, "Commission/brokerage: above ₹20,000."),
  // Rent: 194I, 10% land/building, 2% plant/machinery, above ₹50,000 a month from 1 Apr 2025.
  row1961({
    nature: "rent_land_building", part: "rate", value: { rate: 10, section: "194I" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194-I(b)", sourceRef: ACT_1961, notes: "Rent for land, building or furniture: 10%.",
  }),
  row1961({
    nature: "rent_land_building", part: "threshold", value: { amount: 50000, per: "month" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194-I, first proviso", sourceRef: `${FA_2025} (₹2,40,000 a year → ₹50,000 a month from 1 Apr 2025)`,
    notes: "No TDS while rent doesn't exceed ₹50,000 for a month or part of a month.",
  }),
  row2025("rent_land_building", "rate", { rate: 10, section: "393" }, "Rent on land/building: 10%."),
  row2025("rent_land_building", "threshold", { amount: 50000, per: "month" }, "Rent: above ₹50,000 a month."),
  row1961({
    nature: "rent_plant_machinery", part: "rate", value: { rate: 2, section: "194I" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194-I(a)", sourceRef: ACT_1961, notes: "Rent for plant, machinery or equipment: 2%.",
  }),
  row1961({
    nature: "rent_plant_machinery", part: "threshold", value: { amount: 50000, per: "month" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194-I, first proviso", sourceRef: `${FA_2025} (₹2,40,000 a year → ₹50,000 a month from 1 Apr 2025)`,
    notes: "No TDS while rent doesn't exceed ₹50,000 for a month or part of a month.",
  }),
  row2025("rent_plant_machinery", "rate", { rate: 2, section: "393" }, "Rent on plant/machinery: 2%."),
  row2025("rent_plant_machinery", "threshold", { amount: 50000, per: "month" }, "Rent: above ₹50,000 a month."),
  // Contract work: 194C, 1% individuals/HUF, 2% others; ₹30,000 a payment or ₹1,00,000 in the FY.
  row1961({
    nature: "contract_individual_huf", part: "rate", value: { rate: 1, section: "194C" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194C(1)", sourceRef: ACT_1961, notes: "Contract work, payee an individual or HUF: 1%.",
  }),
  row1961({
    nature: "contract_individual_huf", part: "threshold", value: { amount: 30000, per: "payment", annual: 100000 }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194C(5)", sourceRef: ACT_1961,
    notes: "No TDS on a payment up to ₹30,000 unless the FY's payments exceed ₹1,00,000. Not stated in §6.5; settled s.194C(5) values.",
  }),
  row2025("contract_individual_huf", "rate", { rate: 1, section: "393" }, "Contract work, individuals/HUF: 1%."),
  row2025(
    "contract_individual_huf",
    "threshold",
    { amount: 30000, per: "payment", annual: 100000 },
    "§6.5 gives no contract threshold under s.393; seeded at the s.194C(5) values.",
  ),
  row1961({
    nature: "contract_others", part: "rate", value: { rate: 2, section: "194C" }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194C(1)", sourceRef: ACT_1961, notes: "Contract work, other payees: 2%.",
  }),
  row1961({
    nature: "contract_others", part: "threshold", value: { amount: 30000, per: "payment", annual: 100000 }, from: "2025-04-01", to: UNTIL_2026,
    sectionRef: "s.194C(5)", sourceRef: ACT_1961,
    notes: "No TDS on a payment up to ₹30,000 unless the FY's payments exceed ₹1,00,000. Not stated in §6.5; settled s.194C(5) values.",
  }),
  row2025("contract_others", "rate", { rate: 2, section: "393" }, "Contract work, others: 2%."),
  row2025(
    "contract_others",
    "threshold",
    { amount: 30000, per: "payment", annual: 100000 },
    "§6.5 gives no contract threshold under s.393; seeded at the s.194C(5) values.",
  ),
];

// -------------------------------------------------------------------------------------------------
// Rate lookup (§6.5)
// -------------------------------------------------------------------------------------------------

export type TdsThreshold = {
  /** The amount that must be exceeded before TDS applies. */
  amountPaise: Paise;
  /** `year`: payments in the FY · `month`: rent for a month · `payment`: a single payment. */
  per: "year" | "month" | "payment";
  /** For `payment` thresholds: the FY aggregate that also triggers TDS (s.194C(5)). */
  annualPaise: Paise | null;
};

export type TdsRule = {
  nature: TdsNature;
  label: string;
  /** The section the receipt records: `194J`, `194C`, `194H`, `194I`, or `393` (2025 Act). */
  section: string;
  statute: string | null;
  ratePercent: number;
  /** Null when no threshold row is in force (TDS on any amount). */
  threshold: TdsThreshold | null;
  /** False while either row awaits a Partner's confirmation ([verify]). */
  verified: boolean;
  sourceRef: string | null;
};

function readThreshold(value: unknown): TdsThreshold | null {
  const amount = readParameterNumber(value);
  if (amount === null) return null;
  const o = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const per = o.per === "month" || o.per === "payment" ? o.per : "year";
  const annual = readParameterNumber(o.annual);
  return { amountPaise: toPaise(amount), per, annualPaise: annual === null ? null : toPaise(annual) };
}

/**
 * The TDS rule for a nature on a payment date (§6.5), from `statutory_parameters` rows: the rate
 * row in force decides the section and rate (1961 Act up to 31 March 2026, s.393 from 1 April 2026),
 * plus the threshold row in force. Null when no rate row is in force on that date.
 */
export function tdsRuleFor(
  nature: TdsNature,
  paymentDate: DateString,
  rows: readonly StatutoryParameterRow[] = TDS_SEED_PARAMETERS,
): TdsRule | null {
  const keys = TDS_PARAM_KEYS[nature];
  const rateRow = parameterInForce(rows, keys.rate, paymentDate);
  const ratePercent = rateRow ? readParameterNumber(rateRow.value) : null;
  if (!rateRow || ratePercent === null) return null;
  const v = rateRow.value;
  const section =
    v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).section === "string"
      ? ((v as Record<string, unknown>).section as string)
      : TDS_SECTION_OTHER;
  const thresholdRow = parameterInForce(rows, keys.threshold, paymentDate);
  return {
    nature,
    label: TDS_NATURE_LABELS[nature],
    section,
    statute: rateRow.statute ?? null,
    ratePercent,
    threshold: thresholdRow ? readThreshold(thresholdRow.value) : null,
    verified: rateRow.verified !== false && (thresholdRow ? thresholdRow.verified !== false : true),
    sourceRef: rateRow.sourceRef ?? null,
  };
}

/** Every nature's rule in force on a payment date, for the receipt form's section picker (§7.9.4). */
export function tdsRulesOn(paymentDate: DateString, rows: readonly StatutoryParameterRow[] = TDS_SEED_PARAMETERS): TdsRule[] {
  return TDS_NATURES.map((n) => tdsRuleFor(n, paymentDate, rows)).filter((r): r is TdsRule => r !== null);
}

/** `194J · Fees for professional services · 10%`: how a rule reads in the picker. */
export function tdsRuleLabel(rule: TdsRule): string {
  const section = rule.section === "393" ? "s.393" : rule.section;
  return `${section} · ${rule.label} · ${rule.ratePercent}%`;
}

/**
 * Whether the client is expected to deduct (§6.5): the amount must exceed the threshold. `year`
 * thresholds compare the FY's payments to TaxWise (this one included); `month` the rent for the
 * month; `payment` the single payment, or the FY's payments against the annual figure.
 */
export function tdsThresholdExceeded(
  threshold: TdsThreshold | null,
  amounts: { paymentPaise: Paise; fyTotalPaise?: Paise; monthPaise?: Paise },
): boolean {
  if (!threshold) return true;
  const fy = amounts.fyTotalPaise ?? amounts.paymentPaise;
  switch (threshold.per) {
    case "year":
      return fy > threshold.amountPaise;
    case "month":
      return (amounts.monthPaise ?? amounts.paymentPaise) > threshold.amountPaise;
    case "payment":
      return amounts.paymentPaise > threshold.amountPaise || (threshold.annualPaise !== null && fy > threshold.annualPaise);
  }
}

// -------------------------------------------------------------------------------------------------
// Expected TDS (§6.5, CBDT Circular 23/2017)
// -------------------------------------------------------------------------------------------------

/**
 * The amount TDS is computed on (§6.5): the taxable value excluding GST when GST is shown separately
 * on the invoice (CBDT Circular 23/2017); otherwise the taxable value plus GST.
 */
export function tdsBase(
  invoice: { taxablePaise: Paise; gstPaise: Paise },
  opts: { gstShownSeparately?: boolean; baseExcludesGst?: boolean } = {},
): Paise {
  const shown = opts.gstShownSeparately ?? true;
  const excludes = opts.baseExcludesGst ?? TDS_DEFAULTS.baseExcludesGst;
  return shown && excludes ? invoice.taxablePaise : invoice.taxablePaise + invoice.gstPaise;
}

/**
 * Expected TDS (§6.5): `taxable value (excl. GST) × rate`, half-up to the paisa; with
 * `roundToRupee`, half-up to whole rupees (as many deductors round).
 */
export function expectedTds(taxablePaise: Paise, ratePercent: number | string, opts: { roundToRupee?: boolean } = {}): Paise {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) throw new RangeError("The taxable value must be a whole number of paise, 0 or more.");
  // Rounded once: to whole rupees directly (rate ÷ 100 gives rupees out of paise), never paise first.
  return opts.roundToRupee ? percentOf(taxablePaise, hundredthOf(ratePercent)) * 100 : percentOf(taxablePaise, ratePercent);
}

/** `rate ÷ 100` as an exact decimal string (`10 → "0.10"`, `7.5 → "0.075"`), for single rounding. */
function hundredthOf(rate: number | string): string {
  const text = String(rate).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new TypeError(`Not a rate: ${text}`);
  const digits = `${m[1]}${m[2] ?? ""}`;
  const point = m[1].length - 2;
  return point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${"0".repeat(-point)}${digits}`;
}

/**
 * The TDS to suggest on a receipt (§6.5, §7.9.4): the invoice's expected TDS less what earlier
 * receipts already recorded, never below 0.
 */
export function suggestReceiptTds(input: { taxablePaise: Paise; ratePercent: number | string; tdsAlreadyPaise?: Paise }): Paise {
  return Math.max(0, expectedTds(input.taxablePaise, input.ratePercent) - (input.tdsAlreadyPaise ?? 0));
}

export type TdsDifference = {
  /** `actual − expected`: negative when the client deducted less than expected. */
  differencePaise: Paise;
  kind: "matches" | "short" | "excess";
  message: string | null;
};

/** The difference between the expected and the actually deducted TDS, in words (§6.5). */
export function tdsDifference(expectedPaise: Paise, actualPaise: Paise): TdsDifference {
  const differencePaise = actualPaise - expectedPaise;
  if (differencePaise === 0) return { differencePaise: 0, kind: "matches", message: null };
  if (differencePaise < 0) {
    return {
      differencePaise,
      kind: "short",
      message: `The client deducted ${formatINR(-differencePaise)} less TDS than expected (${formatINR(expectedPaise)}).`,
    };
  }
  return {
    differencePaise,
    kind: "excess",
    message: `The client deducted ${formatINR(differencePaise)} more TDS than expected (${formatINR(expectedPaise)}).`,
  };
}

// -------------------------------------------------------------------------------------------------
// Settlement (§6.5, §7.9.4)
// -------------------------------------------------------------------------------------------------

export type Settlement = {
  totalPaise: Paise;
  receivedPaise: Paise;
  tdsPaise: Paise;
  creditNotedPaise: Paise;
  /** `total − received − tds − credit` (§6.5). */
  outstandingPaise: Paise;
};

/** `outstanding = total − amount_received − tds_credited − credit_noted` (§6.5). */
export function outstandingAmount(s: { totalPaise: Paise; receivedPaise: Paise; tdsPaise: Paise; creditNotedPaise: Paise }): Paise {
  return s.totalPaise - s.receivedPaise - s.tdsPaise - s.creditNotedPaise;
}

export type ReceiptRecord = { amountReceivedPaise: Paise; tdsPaise: Paise; reversed?: boolean };

/**
 * An invoice's settlement from its receipts and credit notes (§5.7, §6.5): reversed receipts don't
 * count (receipts are reversed, never deleted). Mirrors the `invoices_apply_settlement` trigger.
 */
export function settlementFrom(
  totalPaise: Paise,
  receipts: readonly ReceiptRecord[],
  creditNotes: ReadonlyArray<{ totalPaise: Paise }> = [],
): Settlement {
  const live = receipts.filter((r) => !r.reversed);
  const receivedPaise = sumPaise(live.map((r) => r.amountReceivedPaise));
  const tdsPaise = sumPaise(live.map((r) => r.tdsPaise));
  const creditNotedPaise = sumPaise(creditNotes.map((c) => c.totalPaise));
  return {
    totalPaise,
    receivedPaise,
    tdsPaise,
    creditNotedPaise,
    outstandingPaise: outstandingAmount({ totalPaise, receivedPaise, tdsPaise, creditNotedPaise }),
  };
}

export type ReceiptCheck = { ok: true } | { ok: false; error: string; fieldErrors: FieldErrors };

/** The advance guidance shown when a receipt is more than the outstanding amount (§7.9.4). */
export const RECORD_ADVANCE_SEPARATELY = "Record only what settles this invoice, and record the advance separately.";

/**
 * Validates a receipt (§7.9.4): amount received ≥ 0, TDS ≥ 0, something received, and
 * `received + TDS ≤ outstanding + ₹1`. Anything more is refused with the "record the advance
 * separately" guidance.
 */
export function validateReceipt(
  input: { amountReceivedPaise: Paise; tdsPaise: Paise; outstandingPaise: Paise },
  opts: { tolerancePaise?: Paise } = {},
): ReceiptCheck {
  const tolerance = opts.tolerancePaise ?? TDS_DEFAULTS.receiptTolerancePaise;
  const fieldErrors: FieldErrors = {};
  if (!Number.isSafeInteger(input.amountReceivedPaise) || input.amountReceivedPaise < 0) {
    fieldErrors.amount_received = ["The amount received can't be negative. Enter 0 if the client paid only by TDS."];
  }
  if (!Number.isSafeInteger(input.tdsPaise) || input.tdsPaise < 0) {
    fieldErrors.tds_amount = ["The TDS deducted can't be negative."];
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: Object.values(fieldErrors)[0][0], fieldErrors };

  const settled = input.amountReceivedPaise + input.tdsPaise;
  if (settled === 0) {
    const error = "Enter the amount received, the TDS deducted, or both.";
    return { ok: false, error, fieldErrors: { amount_received: [error] } };
  }
  if (settled > input.outstandingPaise + tolerance) {
    const outstanding = Math.max(0, input.outstandingPaise);
    const error =
      input.outstandingPaise <= 0
        ? `Nothing is outstanding on this invoice. ${RECORD_ADVANCE_SEPARATELY}`
        : `${formatINR(settled)} received and deducted is more than the ${formatINR(outstanding)} outstanding. ${RECORD_ADVANCE_SEPARATELY}`;
    return { ok: false, error, fieldErrors: { amount_received: [error] } };
  }
  return { ok: true };
}
