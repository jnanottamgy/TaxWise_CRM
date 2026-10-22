/**
 * Scale-driven decisions about a client (§6.6):
 * - the GST filing scheme (QRMP up to the turnover limit, monthly above it or when no turnover is
 *   recorded), with a plain-words line for the onboarding wizard (§7.3.2);
 * - the QRMP GSTR-3B due day, which depends on the state of the principal place of business;
 * - the tax audit indication (s.44AB of the 1961 Act / s.63 of the 2025 Act). It is an *indication*
 *   for the partner to confirm, never a determination: the partner's decision is stored on the
 *   client (`tax_audit_applicable: yes/no/review`, with a note).
 *
 * Units: amounts about a client are integer paise (`lib/domain/money.ts`); the parameter rows in
 * `statutory_parameters` hold rupees, as the law states them, and `resolveScaleParams` converts
 * them. Percentages are plain numbers (5 means 5%). No threshold is hard-coded in the rules:
 * `SCALE_DEFAULTS` holds the §6.6 seed values and `SCALE_SEED_PARAMETERS` the same rows for the seed
 * SQL (`supabase/seed/30_due_date_rules.sql`).
 *
 * Pure and client-safe.
 */

import type { GstScheme } from "@/lib/domain/enums";
import type { DateString } from "@/lib/domain/fy";
import { parameterInForce, readParameterNumber, type SeedParameterRow, type StatutoryParameterRow } from "@/lib/domain/gst";
import { formatINR, toPaise, type Paise } from "@/lib/domain/money";

// -------------------------------------------------------------------------------------------------
// Parameters (§5.12)
// -------------------------------------------------------------------------------------------------

/** One "these states file on this day" entry of a state-dependent due day (§6.6). */
export type StateDay = { day: number; states: readonly string[] };

/** A due day that depends on the client's state code: `stateDays` first, else `defaultDay`. */
export type StateDayParams = { defaultDay: number; stateDays: readonly StateDay[] };

/** Thresholds for the tax audit indication (§6.6). Amounts in paise, percentages as numbers. */
export type TaxAuditParams = {
  /** Business: audit above this turnover (₹1 crore). */
  businessLimitPaise: Paise;
  /** Business: the limit when cash receipts and cash payments are each within `cashShareMaxPct` (₹10 crore). */
  businessLimitLowCashPaise: Paise;
  /** The cash share (%) that counts as "low cash" (5). */
  cashShareMaxPct: number;
  /** Profession: audit above these gross receipts (₹50 lakh). */
  professionLimitPaise: Paise;
  /** s.44ADA: receipts up to `maxReceiptsPaise` (₹50 lakh), or `maxReceiptsLowCashPaise` (₹75 lakh) with low cash receipts; declare at least `minIncomePct` (50). */
  presumptive44ada: { maxReceiptsPaise: Paise; maxReceiptsLowCashPaise: Paise; minIncomePct: number };
  /** s.44AD: turnover up to ₹2 crore, or ₹3 crore with low cash receipts; profit at least 6% of digital and 8% of other receipts. */
  presumptive44ad: {
    maxTurnoverPaise: Paise;
    maxTurnoverLowCashPaise: Paise;
    minProfitPctDigital: number;
    minProfitPctOther: number;
  };
};

/** Every number the §6.6 decisions need, resolved for one date. */
export type ScaleParams = {
  /** QRMP is available up to and including this aggregate turnover (₹5 crore). */
  qrmpMaxTurnoverPaise: Paise;
  /**
   * The QRMP GSTR-3B due day by state. The live source is the `GSTR3B_QRMP` row of
   * `due_date_rules` (its rule JSON carries the same `day` / `stateDays`), so the wizard and the
   * calendar always agree.
   */
  qrmpGstr3b: StateDayParams;
  taxAudit: TaxAuditParams;
};

/** State codes whose QRMP GSTR-3B falls on the 22nd (§6.6); every other state files on the 24th. */
export const QRMP_22ND_STATE_CODES = [
  "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37",
] as const;

/** The §6.6 seed values. */
export const SCALE_DEFAULTS: ScaleParams = {
  qrmpMaxTurnoverPaise: 5_00_00_000_00,
  qrmpGstr3b: { defaultDay: 24, stateDays: [{ day: 22, states: QRMP_22ND_STATE_CODES }] },
  taxAudit: {
    businessLimitPaise: 1_00_00_000_00,
    businessLimitLowCashPaise: 10_00_00_000_00,
    cashShareMaxPct: 5,
    professionLimitPaise: 50_00_000_00,
    presumptive44ada: { maxReceiptsPaise: 50_00_000_00, maxReceiptsLowCashPaise: 75_00_000_00, minIncomePct: 50 },
    presumptive44ad: {
      maxTurnoverPaise: 2_00_00_000_00,
      maxTurnoverLowCashPaise: 3_00_00_000_00,
      minProfitPctDigital: 6,
      minProfitPctOther: 8,
    },
  },
};

/** The `statutory_parameters` keys this module reads (rupee amounts inside the values). */
export const SCALE_PARAM_KEYS = {
  /** `{"amount": 50000000}`: QRMP up to this aggregate turnover (inclusive). */
  qrmpTurnoverLimit: "gst.qrmp_turnover_limit",
  /** `{"limit": 10000000, "limitLowCash": 100000000, "cashShareMaxPct": 5}`: s.44AB(a) / s.63. */
  taxAuditBusiness: "itr.tax_audit.business",
  /** `{"amount": 5000000}`: s.44AB(b) / s.63, gross receipts of a profession. */
  taxAuditProfession: "itr.tax_audit.profession",
  /** `{"maxReceipts": 5000000, "maxReceiptsLowCash": 7500000, "minIncomePct": 50}`: s.44ADA. */
  presumptive44ada: "itr.presumptive_44ada",
  /** `{"maxTurnover": 20000000, "maxTurnoverLowCash": 30000000, "minProfitPctDigital": 6, "minProfitPctOther": 8}`: s.44AD. */
  presumptive44ad: "itr.presumptive_44ad",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function field(value: unknown, name: string): number | null {
  const r = record(value);
  return r ? readParameterNumber(r[name]) : null;
}

function rupeesToPaise(rupees: number | null, fallback: Paise): Paise {
  return rupees === null ? fallback : toPaise(rupees);
}

/**
 * The §6.6 parameters in force on `on` (§5.12), from `statutory_parameters` rows. Any key that is
 * missing or unreadable keeps its `fallback` value. For the tax audit, pass the first day of the
 * financial year the turnover belongs to.
 */
export function resolveScaleParams(
  rows: readonly StatutoryParameterRow[],
  on: DateString,
  fallback: ScaleParams = SCALE_DEFAULTS,
): ScaleParams {
  const value = (key: string): unknown => parameterInForce(rows, key, on)?.value;
  const qrmp = value(SCALE_PARAM_KEYS.qrmpTurnoverLimit);
  const business = value(SCALE_PARAM_KEYS.taxAuditBusiness);
  const profession = value(SCALE_PARAM_KEYS.taxAuditProfession);
  const ada = value(SCALE_PARAM_KEYS.presumptive44ada);
  const ad = value(SCALE_PARAM_KEYS.presumptive44ad);
  const ta = fallback.taxAudit;
  return {
    qrmpMaxTurnoverPaise: rupeesToPaise(readParameterNumber(qrmp), fallback.qrmpMaxTurnoverPaise),
    qrmpGstr3b: fallback.qrmpGstr3b,
    taxAudit: {
      businessLimitPaise: rupeesToPaise(field(business, "limit"), ta.businessLimitPaise),
      businessLimitLowCashPaise: rupeesToPaise(field(business, "limitLowCash"), ta.businessLimitLowCashPaise),
      cashShareMaxPct: field(business, "cashShareMaxPct") ?? ta.cashShareMaxPct,
      professionLimitPaise: rupeesToPaise(readParameterNumber(profession), ta.professionLimitPaise),
      presumptive44ada: {
        maxReceiptsPaise: rupeesToPaise(field(ada, "maxReceipts"), ta.presumptive44ada.maxReceiptsPaise),
        maxReceiptsLowCashPaise: rupeesToPaise(field(ada, "maxReceiptsLowCash"), ta.presumptive44ada.maxReceiptsLowCashPaise),
        minIncomePct: field(ada, "minIncomePct") ?? ta.presumptive44ada.minIncomePct,
      },
      presumptive44ad: {
        maxTurnoverPaise: rupeesToPaise(field(ad, "maxTurnover"), ta.presumptive44ad.maxTurnoverPaise),
        maxTurnoverLowCashPaise: rupeesToPaise(field(ad, "maxTurnoverLowCash"), ta.presumptive44ad.maxTurnoverLowCashPaise),
        minProfitPctDigital: field(ad, "minProfitPctDigital") ?? ta.presumptive44ad.minProfitPctDigital,
        minProfitPctOther: field(ad, "minProfitPctOther") ?? ta.presumptive44ad.minProfitPctOther,
      },
    },
  };
}

const IT_1961 = "Income-tax Act, 1961";
const IT_2025 = "Income-tax Act, 2025";

/**
 * The §6.6 rows of `supabase/seed/30_due_date_rules.sql` (§16: statutory_parameters from §6.6).
 * 1961-Act rows end on 31 Mar 2026; the 2025-Act rows (s.63, same values) start on 1 Apr 2026 and
 * are [verify] until a Partner confirms them. Amounts in rupees.
 */
export const SCALE_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: SCALE_PARAM_KEYS.qrmpTurnoverLimit,
    value: { amount: 50000000 },
    effectiveFrom: "2021-01-01",
    effectiveTo: null,
    statute: "Central Goods and Services Tax Act, 2017",
    sectionRef: "s.39(1) proviso; Rule 61A",
    sourceRef: "Notification 84/2020-Central Tax dated 10 Nov 2020 (QRMP scheme)",
    notes: "Aggregate turnover up to ₹5 crore is eligible for QRMP (quarterly GSTR-1 and GSTR-3B, monthly PMT-06); above that, monthly is mandatory. With no turnover recorded, the app defaults to monthly (§6.6).",
    verified: true,
  },
  {
    key: SCALE_PARAM_KEYS.taxAuditBusiness,
    value: { limit: 10000000, limitLowCash: 100000000, cashShareMaxPct: 5 },
    effectiveFrom: "2020-04-01",
    effectiveTo: "2026-03-31",
    statute: IT_1961,
    sectionRef: "s.44AB(a) and its proviso",
    sourceRef: "Finance Act, 2021 (₹10 crore where cash receipts and cash payments are each within 5%)",
    notes: "Business: audit indicated above ₹1 crore turnover; the limit is ₹10 crore where cash receipts and cash payments are each 5% or less of the total (§6.6).",
    verified: true,
  },
  {
    key: SCALE_PARAM_KEYS.taxAuditBusiness,
    value: { limit: 10000000, limitLowCash: 100000000, cashShareMaxPct: 5 },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: IT_2025,
    sectionRef: "s.63",
    sourceRef: "Income-tax Act, 2025, s.63 (corresponding provision of s.44AB)",
    notes: "Same limits under the 2025 Act (§6.6). [verify] against s.63.",
    verified: false,
  },
  {
    key: SCALE_PARAM_KEYS.taxAuditProfession,
    value: { amount: 5000000 },
    effectiveFrom: "2016-04-01",
    effectiveTo: "2026-03-31",
    statute: IT_1961,
    sectionRef: "s.44AB(b)",
    sourceRef: "Finance Act, 2016 (₹50 lakh gross receipts of a profession)",
    notes: "Profession: audit indicated above ₹50 lakh gross receipts (§6.6).",
    verified: true,
  },
  {
    key: SCALE_PARAM_KEYS.taxAuditProfession,
    value: { amount: 5000000 },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: IT_2025,
    sectionRef: "s.63",
    sourceRef: "Income-tax Act, 2025, s.63 (corresponding provision of s.44AB)",
    notes: "Same limit under the 2025 Act (§6.6). [verify] against s.63.",
    verified: false,
  },
  {
    key: SCALE_PARAM_KEYS.presumptive44ada,
    value: { maxReceipts: 5000000, maxReceiptsLowCash: 7500000, minIncomePct: 50 },
    effectiveFrom: "2023-04-01",
    effectiveTo: "2026-03-31",
    statute: IT_1961,
    sectionRef: "s.44ADA; s.44AB(d)",
    sourceRef: "Finance Act, 2023 (₹75 lakh where cash receipts are within 5%)",
    notes: "A professional with receipts up to ₹75 lakh and cash receipts of 5% or less who declares at least 50% as income needs no audit (§6.6).",
    verified: true,
  },
  {
    key: SCALE_PARAM_KEYS.presumptive44ada,
    value: { maxReceipts: 5000000, maxReceiptsLowCash: 7500000, minIncomePct: 50 },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: IT_2025,
    sectionRef: "Presumptive taxation of professions (corresponding provision of s.44ADA)",
    sourceRef: "Income-tax Act, 2025 (corresponding provision of s.44ADA)",
    notes: "Same values under the 2025 Act (§6.6). [verify] the section and the values.",
    verified: false,
  },
  {
    key: SCALE_PARAM_KEYS.presumptive44ad,
    value: { maxTurnover: 20000000, maxTurnoverLowCash: 30000000, minProfitPctDigital: 6, minProfitPctOther: 8 },
    effectiveFrom: "2023-04-01",
    effectiveTo: "2026-03-31",
    statute: IT_1961,
    sectionRef: "s.44AD; s.44AB(e)",
    sourceRef: "Finance Act, 2023 (₹3 crore where cash receipts are within 5%)",
    notes: "Presumptive business: turnover up to ₹2 crore, or ₹3 crore where cash receipts are 5% or less. Declaring below 6% (digital receipts) / 8% (other receipts), with income above the basic exemption, triggers an audit (§6.6).",
    verified: true,
  },
  {
    key: SCALE_PARAM_KEYS.presumptive44ad,
    value: { maxTurnover: 20000000, maxTurnoverLowCash: 30000000, minProfitPctDigital: 6, minProfitPctOther: 8 },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: IT_2025,
    sectionRef: "Presumptive taxation of business (corresponding provision of s.44AD)",
    sourceRef: "Income-tax Act, 2025 (corresponding provision of s.44AD)",
    notes: "Same values under the 2025 Act (§6.6). [verify] the section and the values.",
    verified: false,
  },
];

// -------------------------------------------------------------------------------------------------
// Plain-words amounts
// -------------------------------------------------------------------------------------------------

const LAKH_PAISE = 1_00_000_00;
const CRORE_PAISE = 1_00_00_000_00;

function trimDecimal(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/**
 * An amount in plain words for explanations: `₹5 crore`, `₹1.25 crore`, `₹75 lakh`. Amounts that
 * aren't a round number of lakh or crore (to two decimals) are shown in full (`₹1,23,45,678`), so a
 * figure just under a limit never reads as the limit itself.
 */
export function amountInPlainWords(paise: Paise): string {
  const abs = Math.abs(paise);
  const sign = paise < 0 ? "-" : "";
  if (abs >= CRORE_PAISE && abs % (CRORE_PAISE / 100) === 0) return `${sign}₹${trimDecimal(abs / (CRORE_PAISE / 100))} crore`;
  if (abs >= LAKH_PAISE && abs % (LAKH_PAISE / 100) === 0) return `${sign}₹${trimDecimal(abs / (LAKH_PAISE / 100))} lakh`;
  return formatINR(paise, { decimals: paise % 100 === 0 ? 0 : 2 });
}

function pct(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

function assertTurnover(turnover: Paise | null, what: string): void {
  if (turnover === null) return;
  if (!Number.isSafeInteger(turnover) || turnover < 0) throw new RangeError(`The ${what} must be a whole, non-negative number of paise.`);
}

function assertPct(value: number | null | undefined, what: string): void {
  if (value === null || value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`The ${what} must be a percentage from 0 to 100.`);
}

// -------------------------------------------------------------------------------------------------
// GST filing scheme (§6.6)
// -------------------------------------------------------------------------------------------------

export type GstSchemeDecision = {
  scheme: GstScheme;
  /** What decided it: the client's recorded choice, the turnover, or the no-turnover default. */
  basis: "choice" | "turnover" | "no_turnover";
  /** Whether the turnover allows QRMP; null when no turnover is recorded. */
  qrmpEligible: boolean | null;
  /** One or two plain sentences for the wizard's live line (§7.3.2). */
  explanation: string;
  /** Set when the recorded choice can't be honoured or couldn't be checked. */
  warning?: string;
};

/**
 * The GST filing scheme (§6.6). Aggregate turnover up to and including the limit (₹5 crore) is
 * eligible for QRMP, which is the automatic answer there; the client may opt for monthly. Above the
 * limit, monthly is mandatory whatever was recorded. With no turnover recorded the answer is
 * monthly, because over-filing is safer than a missed return (a recorded QRMP choice is kept, with a
 * warning that eligibility couldn't be checked).
 *
 * `turnover` is in paise; `clientChoice` is `clients.gst_scheme` (null = "Auto from turnover").
 */
export function gstSchemeDecision(
  turnover: Paise | null,
  clientChoice: GstScheme | null,
  params: Pick<ScaleParams, "qrmpMaxTurnoverPaise"> = SCALE_DEFAULTS,
): GstSchemeDecision {
  assertTurnover(turnover, "turnover");
  const limit = amountInPlainWords(params.qrmpMaxTurnoverPaise);
  const qrmpLine = "GSTR-1 and GSTR-3B are filed quarterly, and tax is paid monthly through PMT-06.";

  if (turnover === null) {
    if (clientChoice === "qrmp") {
      return {
        scheme: "qrmp",
        basis: "choice",
        qrmpEligible: null,
        explanation: "QRMP, as recorded for this client.",
        warning: `No turnover is recorded, so QRMP eligibility (turnover up to ${limit}) hasn't been checked. Record the turnover to confirm it.`,
      };
    }
    if (clientChoice === "monthly") {
      return { scheme: "monthly", basis: "choice", qrmpEligible: null, explanation: "Monthly filing, as recorded for this client." };
    }
    return {
      scheme: "monthly",
      basis: "no_turnover",
      qrmpEligible: null,
      explanation: `No turnover is recorded, so the client files monthly: over-filing is safer than a missed return. Record the turnover to check whether QRMP (up to ${limit}) is available.`,
    };
  }

  const amount = amountInPlainWords(turnover);
  if (turnover > params.qrmpMaxTurnoverPaise) {
    const decision: GstSchemeDecision = {
      scheme: "monthly",
      basis: "turnover",
      qrmpEligible: false,
      explanation: `Turnover of ${amount} is above ${limit}, so monthly filing is mandatory.`,
    };
    if (clientChoice === "qrmp") {
      decision.warning = `This client is recorded as QRMP, but QRMP isn't available above ${limit}. Monthly due dates are used.`;
    }
    return decision;
  }

  if (clientChoice === "monthly") {
    return {
      scheme: "monthly",
      basis: "choice",
      qrmpEligible: true,
      explanation: `Turnover of ${amount} is within ${limit}, so QRMP is available, but the client has chosen to file monthly.`,
    };
  }
  return {
    scheme: "qrmp",
    basis: clientChoice === "qrmp" ? "choice" : "turnover",
    qrmpEligible: true,
    explanation:
      clientChoice === "qrmp"
        ? `Turnover of ${amount} is within ${limit}, so the client is eligible for QRMP: ${qrmpLine}`
        : `Turnover of ${amount} is within ${limit}, so the client is eligible for QRMP: ${qrmpLine} Choose Monthly if the client prefers to file every month.`,
  };
}

// -------------------------------------------------------------------------------------------------
// QRMP GSTR-3B due day by state (§6.6)
// -------------------------------------------------------------------------------------------------

/** `'7'`, `7` or `' 07 '` → `'07'`; null for anything that isn't one or two digits. */
export function normaliseStateCode(code: string | number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const text = String(code).trim();
  return /^\d{1,2}$/.test(text) ? text.padStart(2, "0") : null;
}

export type StateDayResolution = {
  day: number;
  /** `state_list`: the state is listed; `other_state`: the default day; `unknown_state`: no state recorded. */
  basis: "state_list" | "other_state" | "unknown_state";
};

/**
 * The due day for a state-dependent return (§6.6): the day whose list contains the state code,
 * otherwise the default day. With no state recorded, the earliest possible day is used, because an
 * early reminder is safer than a missed return.
 */
export function resolveStateDay(stateCode: string | number | null | undefined, params: StateDayParams): StateDayResolution {
  const code = normaliseStateCode(stateCode);
  if (code === null) {
    const days = [params.defaultDay, ...params.stateDays.map((s) => s.day)];
    return { day: Math.min(...days), basis: "unknown_state" };
  }
  for (const entry of params.stateDays) {
    if (entry.states.includes(code)) return { day: entry.day, basis: "state_list" };
  }
  return { day: params.defaultDay, basis: "other_state" };
}

/**
 * The QRMP GSTR-3B due day after the quarter end (§6.6): the 22nd for state codes 22–37
 * (Karnataka, 29, included), the 24th for every other state. No state → the 22nd (the earlier date).
 */
export function qrmpGstr3bDay(stateCode: string | number | null | undefined, params: StateDayParams = SCALE_DEFAULTS.qrmpGstr3b): number {
  return resolveStateDay(stateCode, params).day;
}

// -------------------------------------------------------------------------------------------------
// Tax audit indication (§6.6)
// -------------------------------------------------------------------------------------------------

/** How the client's income is earned, for the tax audit indication. */
export type IncomeNature = "business" | "profession" | "presumptive_44ad" | "presumptive_44ada";

export type TaxAuditInput = {
  nature: IncomeNature;
  /** Turnover (business) or gross receipts (profession), in paise; null when not entered. */
  turnover: Paise | null;
  /** Cash receipts as a % of total receipts. */
  cashReceiptsPct?: number | null;
  /** Cash payments as a % of total payments. */
  cashPaymentsPct?: number | null;
  /** Profit or income declared, as a % of turnover / gross receipts (presumptive cases). */
  declaredProfitPct?: number | null;
  /** Whether total income is above the basic exemption limit (presumptive cases declaring less). */
  incomeAboveBasicExemption?: boolean | null;
};

export type TaxAuditIndication = {
  indication: "yes" | "no" | "review";
  /** The reasoning in plain sentences, in order, ending with what to do next when unsure. */
  reasons: string[];
  /** True when the answer depends on the cash share: the wizard asks the cash-ratio question. */
  askCashRatio: boolean;
};

/** Shown with every indication (§6.6). */
export const TAX_AUDIT_DISCLAIMER = "This is an indication for the partner to confirm, not a determination.";

type Outcome = TaxAuditIndication;

function outcome(indication: Outcome["indication"], reasons: string[], askCashRatio = false): Outcome {
  return { indication, reasons, askCashRatio };
}

function businessIndication(turnover: Paise, input: TaxAuditInput, p: TaxAuditParams, lead: string[]): Outcome {
  const amount = amountInPlainWords(turnover);
  const low = amountInPlainWords(p.businessLimitPaise);
  const high = amountInPlainWords(p.businessLimitLowCashPaise);
  const cap = pct(p.cashShareMaxPct);
  if (turnover <= p.businessLimitPaise) {
    return outcome("no", [...lead, `Turnover of ${amount} is within ${low}, so no tax audit is indicated.`]);
  }
  if (turnover > p.businessLimitLowCashPaise) {
    return outcome("yes", [...lead, `Turnover of ${amount} is above ${high}, so a tax audit is indicated whatever the cash share.`]);
  }
  const reasons = [
    ...lead,
    `Turnover of ${amount} is above ${low}. Up to ${high}, no audit is needed if cash receipts and cash payments are each ${cap} or less of the total.`,
  ];
  const cr = input.cashReceiptsPct ?? null;
  const cp = input.cashPaymentsPct ?? null;
  const over: string[] = [];
  if (cr !== null && cr > p.cashShareMaxPct) over.push(`cash receipts are ${pct(cr)}`);
  if (cp !== null && cp > p.cashShareMaxPct) over.push(`cash payments are ${pct(cp)}`);
  if (over.length > 0) {
    const what = over.join(" and ");
    return outcome("yes", [...reasons, `${what.charAt(0).toUpperCase()}${what.slice(1)}, above ${cap}, so the ${low} limit applies and a tax audit is indicated.`], true);
  }
  if (cr === null || cp === null) {
    return outcome("review", [...reasons, "Ask the client what share of receipts and of payments was in cash to complete the indication."], true);
  }
  return outcome(
    "no",
    [...reasons, `Cash receipts (${pct(cr)}) and cash payments (${pct(cp)}) are each within ${cap}, so the ${high} limit applies and no tax audit is indicated.`],
    true,
  );
}

function belowPresumptiveRate(input: TaxAuditInput, reasons: string[], askCashRatio: boolean): Outcome {
  const above = input.incomeAboveBasicExemption ?? null;
  if (above === true) {
    return outcome("yes", [...reasons, "Total income is above the basic exemption limit, so declaring less than the presumptive rate means a tax audit is indicated."], askCashRatio);
  }
  if (above === false) {
    return outcome("no", [...reasons, "Total income is within the basic exemption limit, so no tax audit is indicated even though less than the presumptive rate is declared."], askCashRatio);
  }
  return outcome("review", [...reasons, "A tax audit is indicated if total income is above the basic exemption limit: confirm the total income."], askCashRatio);
}

function professionBand(receipts: Paise, input: TaxAuditInput, p: TaxAuditParams, lead: string[]): Outcome {
  // Receipts above the profession limit and within the s.44ADA low-cash limit.
  const ada = p.presumptive44ada;
  const cap = pct(p.cashShareMaxPct);
  const reasons = [
    ...lead,
    `Gross receipts of ${amountInPlainWords(receipts)} are above ${amountInPlainWords(p.professionLimitPaise)}, which normally means a tax audit. Up to ${amountInPlainWords(ada.maxReceiptsLowCashPaise)}, with cash receipts of ${cap} or less, declaring at least ${pct(ada.minIncomePct)} as income under the presumptive scheme (s.44ADA) needs no audit.`,
  ];
  const cr = input.cashReceiptsPct ?? null;
  const dp = input.declaredProfitPct ?? null;
  if (cr !== null && cr > p.cashShareMaxPct) {
    return outcome("yes", [...reasons, `Cash receipts are ${pct(cr)}, above ${cap}, so the presumptive scheme isn't available and a tax audit is indicated.`], true);
  }
  if (dp !== null && dp < ada.minIncomePct) {
    return outcome("yes", [...reasons, `Declared income is ${pct(dp)} of receipts, below ${pct(ada.minIncomePct)}, so a tax audit is indicated.`], true);
  }
  if (cr === null || dp === null) {
    const ask = [cr === null ? "the share of receipts in cash" : null, dp === null ? "the income declared as a share of receipts" : null]
      .filter((x): x is string => x !== null)
      .join(" and ");
    return outcome("review", [...reasons, `Ask the client for ${ask} to complete the indication.`], true);
  }
  return outcome(
    "no",
    [...reasons, `Cash receipts are ${pct(cr)} and declared income is ${pct(dp)} of receipts, so the presumptive scheme applies and no tax audit is indicated.`],
    true,
  );
}

function professionIndication(receipts: Paise, input: TaxAuditInput, p: TaxAuditParams, lead: string[]): Outcome {
  const amount = amountInPlainWords(receipts);
  if (receipts <= p.professionLimitPaise) {
    return outcome("no", [...lead, `Gross receipts of ${amount} are within ${amountInPlainWords(p.professionLimitPaise)}, so no tax audit is indicated.`]);
  }
  if (receipts > p.presumptive44ada.maxReceiptsLowCashPaise) {
    return outcome("yes", [
      ...lead,
      `Gross receipts of ${amount} are above ${amountInPlainWords(p.professionLimitPaise)}, and above the presumptive scheme's ${amountInPlainWords(p.presumptive44ada.maxReceiptsLowCashPaise)} limit, so a tax audit is indicated.`,
    ]);
  }
  return professionBand(receipts, input, p, lead);
}

function presumptive44adaIndication(receipts: Paise, input: TaxAuditInput, p: TaxAuditParams): Outcome {
  const ada = p.presumptive44ada;
  if (receipts > ada.maxReceiptsLowCashPaise) {
    return professionIndication(receipts, input, p, [
      `Receipts above ${amountInPlainWords(ada.maxReceiptsLowCashPaise)} can't use the presumptive scheme (s.44ADA), so the regular limits apply.`,
    ]);
  }
  if (receipts > ada.maxReceiptsPaise) return professionBand(receipts, input, p, []);
  const reasons = [`Gross receipts of ${amountInPlainWords(receipts)} are within the presumptive scheme's ${amountInPlainWords(ada.maxReceiptsPaise)} limit (s.44ADA).`];
  const dp = input.declaredProfitPct ?? null;
  if (dp === null) {
    return outcome("review", [...reasons, "Enter the income declared as a share of receipts to complete the indication."]);
  }
  if (dp >= ada.minIncomePct) {
    return outcome("no", [...reasons, `Declared income of ${pct(dp)} meets the ${pct(ada.minIncomePct)} presumptive rate, so no tax audit is indicated.`]);
  }
  return belowPresumptiveRate(input, [...reasons, `Declared income of ${pct(dp)} is below the ${pct(ada.minIncomePct)} presumptive rate.`], false);
}

function presumptive44adIndication(turnover: Paise, input: TaxAuditInput, p: TaxAuditParams): Outcome {
  const ad = p.presumptive44ad;
  const amount = amountInPlainWords(turnover);
  const cap = pct(p.cashShareMaxPct);
  const cr = input.cashReceiptsPct ?? null;
  let askCashRatio = false;
  const reasons: string[] = [];

  if (turnover > ad.maxTurnoverLowCashPaise) {
    return businessIndication(turnover, input, p, [
      `Turnover of ${amount} is above the presumptive scheme's ${amountInPlainWords(ad.maxTurnoverLowCashPaise)} limit (s.44AD), so the regular business limits apply.`,
    ]);
  }
  if (turnover > ad.maxTurnoverPaise) {
    askCashRatio = true;
    const band = `Turnover of ${amount} is above ${amountInPlainWords(ad.maxTurnoverPaise)}. The presumptive scheme (s.44AD) is available up to ${amountInPlainWords(ad.maxTurnoverLowCashPaise)} only if cash receipts are ${cap} or less.`;
    if (cr === null) {
      return outcome("review", [band, "Ask the client what share of receipts was in cash to complete the indication."], true);
    }
    if (cr > p.cashShareMaxPct) {
      const fallback = businessIndication(turnover, input, p, [band, `Cash receipts are ${pct(cr)}, above ${cap}, so the regular business limits apply.`]);
      return { ...fallback, askCashRatio: true };
    }
    reasons.push(band, `Cash receipts are ${pct(cr)}, so the presumptive scheme is available.`);
  } else {
    reasons.push(`Turnover of ${amount} is within the presumptive scheme's ${amountInPlainWords(ad.maxTurnoverPaise)} limit (s.44AD).`);
  }

  const dp = input.declaredProfitPct ?? null;
  const rates = `${pct(ad.minProfitPctDigital)} of digital receipts and ${pct(ad.minProfitPctOther)} of the rest`;
  if (dp === null) {
    return outcome("review", [...reasons, "Enter the profit declared as a share of turnover to complete the indication."], askCashRatio);
  }
  if (dp >= ad.minProfitPctOther) {
    return outcome("no", [...reasons, `Declared profit of ${pct(dp)} meets the presumptive rate (${rates}), so no tax audit is indicated.`], askCashRatio);
  }
  if (dp >= ad.minProfitPctDigital) {
    if (cr === null) {
      return outcome(
        "review",
        [...reasons, `Declared profit of ${pct(dp)} is enough only if most receipts were digital (${rates}). Ask the client what share of receipts was in cash.`],
        true,
      );
    }
    // The minimum is digitalRate on the digital share plus otherRate on the cash share.
    const required = (ad.minProfitPctDigital * (100 - cr) + ad.minProfitPctOther * cr) / 100;
    if (dp * 100 >= ad.minProfitPctDigital * (100 - cr) + ad.minProfitPctOther * cr) {
      return outcome("no", [...reasons, `With ${pct(cr)} of receipts in cash, the presumptive minimum is ${pct(required)}; declared profit of ${pct(dp)} meets it, so no tax audit is indicated.`], true);
    }
    return belowPresumptiveRate(input, [...reasons, `With ${pct(cr)} of receipts in cash, the presumptive minimum is ${pct(required)}; declared profit of ${pct(dp)} is below it.`], true);
  }
  return belowPresumptiveRate(input, [...reasons, `Declared profit of ${pct(dp)} is below the presumptive rate (${rates}).`], askCashRatio);
}

/**
 * The tax audit indication (§6.6), with the reasoning in plain sentences:
 * - **Business:** audit above ₹1 crore turnover; the limit is ₹10 crore where cash receipts and
 *   cash payments are each ≤ 5% of the total. Between the two, the cash-ratio question is asked
 *   (`askCashRatio`) and, until it's answered, the indication is `review`.
 * - **Profession:** audit above ₹50 lakh gross receipts, except a professional eligible for the
 *   presumptive scheme (s.44ADA: receipts up to ₹75 lakh with cash receipts ≤ 5%) who declares at
 *   least 50% as income.
 * - **Presumptive business (s.44AD):** available up to ₹2 crore, or ₹3 crore where cash receipts
 *   ≤ 5%. Declaring below 6% (digital) / 8% (other receipts), with income above the basic
 *   exemption, indicates an audit. Above the s.44AD limit the business rules apply.
 * - **Presumptive profession (s.44ADA):** within the limit, declaring below 50% with income above
 *   the basic exemption indicates an audit; above it the profession rules apply.
 *
 * Limits are exclusive ("above ₹1 crore"), shares inclusive ("5% or less"). No turnover → `review`.
 */
export function taxAuditIndication(input: TaxAuditInput, params: TaxAuditParams = SCALE_DEFAULTS.taxAudit): TaxAuditIndication {
  assertTurnover(input.turnover, "turnover");
  assertPct(input.cashReceiptsPct, "cash receipts share");
  assertPct(input.cashPaymentsPct, "cash payments share");
  assertPct(input.declaredProfitPct, "declared profit share");
  if (input.turnover === null) {
    const what = input.nature === "profession" || input.nature === "presumptive_44ada" ? "gross receipts" : "turnover";
    return outcome("review", [`Enter the ${what} to see whether a tax audit is indicated.`]);
  }
  switch (input.nature) {
    case "business":
      return businessIndication(input.turnover, input, params, []);
    case "profession":
      return professionIndication(input.turnover, input, params, []);
    case "presumptive_44ad":
      return presumptive44adIndication(input.turnover, input, params);
    case "presumptive_44ada":
      return presumptive44adaIndication(input.turnover, input, params);
  }
}
