/**
 * Income-tax computation engine for individuals and HUFs, both regimes side by side (§6.11, §7.8.2).
 *
 * `computeItr(inputs, ruleSet, { filingDate, dueDate })` returns, for the new and the old regime,
 * a computation sheet with every line explained: income by head, house-property loss set-off,
 * gross total income, the deductions that regime allows, total income, slab tax, special-rate tax,
 * the s.87A rebate (with marginal relief), surcharge (with marginal relief at each threshold), cess,
 * interest under ss.234A/234B/234C, taxes paid and the balance payable or refund; then the
 * comparison, the saving and the recommended regime. Every statutory number comes from the
 * `ItrRuleSet` (`lib/domain/itr-rulesets.ts`); nothing is hard-coded here.
 *
 * Rounding rules (all arithmetic in integer paise, half-up = half away from zero):
 * 1. Each percentage (slab tax, special-rate tax, surcharge, cess, 80CCD(2) cap) is rounded half-up
 *    to the paisa on its own line (`percentOf`).
 * 2. Total income is rounded to the nearest ₹10 (s.288A; ₹5 rounds up) before tax is computed.
 *    Special-rate income keeps its exact amount; the rounding falls on normal-rate income.
 * 3. The tax liability (tax + surcharge − marginal relief + cess) is rounded to the nearest ₹10
 *    (s.288B). Interest is computed on that rounded figure.
 * 4. Interest under ss.234A/234B/234C is charged on the unpaid amount rounded DOWN to a multiple of
 *    ₹100 (Rule 119A), at 1% for every month or part of a month, so it is always whole rupees.
 * 5. The balance payable or refundable (liability + interest − taxes paid) is rounded to the
 *    nearest ₹10 (s.288B).
 *
 * Ordering rules where the law lets the taxpayer choose (taxpayer-favourable, as the e-filing
 * utility does; stated so every result can be reproduced by hand):
 * - The ₹1.25 lakh s.112A exemption and a resident's unused basic exemption (provisos to ss.111A,
 *   112, 112A) are applied to special-rate gains taxed at the highest rate first.
 * - A house-property loss (old regime) is set off against normal-rate income first, then against
 *   special-rate gains, highest rate first.
 * - For the 15% surcharge cap, dividends are taken as the top slice of normal-rate income.
 * - For surcharge marginal relief, income is brought down to the threshold by removing normal-rate
 *   income (other than dividends) first, then dividends, then special-rate gains (highest rate first).
 * - Interest under s.234B after a self-assessment payment restarts in the month after the payment
 *   month (the payment month is counted once).
 * - A "month" for s.234A runs from the day after the due date; any part of a month counts as a month.
 * - The recommended regime is the one with the lower tax liability plus interest; a tie goes to the
 *   new regime (the default).
 *
 * Not modelled (enter the computed figure instead): losses under heads other than house property,
 * set-off of brought-forward losses, relief u/s 89/90/91, the s.234C proviso for capital gains
 * arising after an instalment date, and the 20%-with-indexation option for land or buildings.
 *
 * Pure and client-safe. "Today" is never read: the filing date and due date are parameters.
 */

import {
  addDays,
  addMonths,
  assessmentYearOf,
  compareDates,
  fyEnd,
  isDateString,
  MONTH_ABBR,
  parseDateString,
  toDateString,
  type DateString,
  type FinancialYear,
} from "@/lib/domain/fy";
import {
  AGE_BANDS,
  REGIMES,
  SPECIAL_RATE_KINDS,
  type AgeBand,
  type InterestRules,
  type ItrRuleSet,
  type ItrStatute,
  type Regime,
  type RegimeRules,
  type SectionRef,
  type SectionTopic,
  type Slab,
  type SpecialRateKind,
} from "@/lib/domain/itr-rulesets";
import { divideRoundHalfUp, formatINR, isPaise, percentOf, type Paise } from "@/lib/domain/money";
import type { FieldErrors } from "@/lib/result";

// -------------------------------------------------------------------------------------------------
// Inputs (§7.8.2). All amounts are integer paise.
// -------------------------------------------------------------------------------------------------

export const ASSESSEE_TYPES = ["individual", "huf"] as const;
export type AssesseeType = (typeof ASSESSEE_TYPES)[number];

/** Capital gains taxed at special rates. */
export type SpecialGainsInput = { stcg111a?: Paise; ltcg112a?: Paise; ltcg112?: Paise };

export type ItrIncomeInputs = {
  /** Salary or pension, gross (before the standard deduction). */
  salaryGross?: Paise;
  /** s.10 exemptions (HRA, LTA …) and s.16(ii)/(iii) deductions (professional tax): old regime only. */
  salaryOldRegimeExemptions?: Paise;
  /** Income from house property, net; negative = loss. */
  houseProperty?: Paise;
  businessProfession?: Paise;
  /** Income from other sources, including `dividends`. */
  otherSources?: Paise;
  /** The dividends inside `otherSources` (their surcharge is capped at 15%). */
  dividends?: Paise;
  /** STCG on listed equity (s.111A), LTCG on listed equity (s.112A), other LTCG (s.112). */
  stcg111a?: Paise;
  ltcg112a?: Paise;
  ltcg112?: Paise;
  /** Gains on transfers before the rule set's cut-over date (23 Jul 2024; FY 2024-25 only). */
  earlierTransfers?: SpecialGainsInput;
};

export type ItrDeductionInputs = {
  /** 80C + 80CCC + 80CCD(1) together (old regime). */
  sec80CBasket?: Paise;
  /** Own NPS contribution, 80CCD(1B) (old regime). */
  sec80CCD1B?: Paise;
  /** Health insurance (old regime). `selfSenior` defaults to the assessee's own age band. */
  sec80D?: { selfFamily?: Paise; parents?: Paise; selfSenior?: boolean; parentsSenior?: boolean };
  /** The qualifying 80G amount, after the 50%/100% and 10%-of-income limits (old regime). */
  sec80G?: Paise;
  /** Interest claimed under 80TTA (savings interest) or 80TTB (resident senior citizens) (old regime). */
  sec80TTA_TTB?: Paise;
  /** Other Chapter VI-A deductions (80E, 80EEA, 80U …), already within their own limits (old regime). */
  otherOldRegime?: Paise;
  /** Employer NPS contribution, 80CCD(2) (both regimes). */
  employerNps80CCD2?: Paise;
  /** Basic salary + DA, for the 80CCD(2) cap. Gross salary is used when missing. */
  basicPlusDa?: Paise;
  /** The employer is the Central or a State Government (80CCD(2) cap). */
  governmentEmployer?: boolean;
  /** Deductions both regimes allow (80CCH, 80JJAA), already within their own limits. */
  otherBothRegimes?: Paise;
};

/** Advance tax paid in each instalment window (§6.7). */
export type AdvanceTaxPaid = {
  /** On or before 15 June. */
  q1?: Paise;
  /** 16 June – 15 September. */
  q2?: Paise;
  /** 16 September – 15 December. */
  q3?: Paise;
  /** 16 December – 15 March. */
  q4?: Paise;
  /** 16–31 March (counts for s.234B, not for the s.234C instalments). */
  afterQ4?: Paise;
};

export type SelfAssessmentPayment = { amount: Paise; paidOn: DateString };

export type ItrTaxesPaidInputs = {
  tdsTcs?: Paise;
  advanceTax?: AdvanceTaxPaid;
  /** Self-assessment tax already paid (after the year ended, on or before the filing date). */
  selfAssessment?: SelfAssessmentPayment[];
};

export type ItrInputs = {
  financialYear: FinancialYear;
  assesseeType: AssesseeType;
  /** Ignored for a HUF. */
  ageBand: AgeBand;
  /** Default true. Non-residents get no rebate, no senior slabs and no basic-exemption adjustment. */
  resident?: boolean;
  /** Presumptive income (44AD/44ADA): one advance-tax instalment by 15 March. */
  presumptive?: boolean;
  income: ItrIncomeInputs;
  deductions?: ItrDeductionInputs;
  taxesPaid?: ItrTaxesPaidInputs;
};

/** The filing date (defaults to today in the UI) and the due date of the return (s.139 / s.263). */
export type ItrDates = { filingDate: DateString; dueDate: DateString };

// -------------------------------------------------------------------------------------------------
// Results
// -------------------------------------------------------------------------------------------------

/** A section cited on the sheet: `label` for screens, `pdfLabel` for PDFs (§6.1). */
export type SectionCite = { topic: SectionTopic; label: string; pdfLabel: string; verified: boolean };

/** One line of the computation sheet. */
export type ItrLine = { code: string; label: string; amount: Paise; note?: string; section?: SectionCite };

export type SlabLine = { from: Paise; to: Paise | null; rate: number; income: Paise; tax: Paise };

export type SpecialRateLine = {
  kind: SpecialRateKind;
  period: "current" | "earlier";
  rate: number;
  income: Paise;
  /** The s.112A exemption used against this gain. */
  exemption: Paise;
  /** A resident's unused basic exemption set against this gain. */
  basicExemptionUsed: Paise;
  taxable: Paise;
  tax: Paise;
};

export type DeductionLine = {
  code: string;
  label: string;
  claimed: Paise;
  allowed: Paise;
  note?: string;
  section?: SectionCite;
};

export type InstalmentInterest = {
  dueDate: DateString;
  cumulativePercent: number;
  due: Paise;
  paid: Paise;
  safeHarbourMet: boolean;
  shortfall: Paise;
  base: Paise;
  months: number;
  interest: Paise;
};

export type Interest234C = { applies: boolean; reason: string; taxDue: Paise; instalments: InstalmentInterest[]; interest: Paise };

export type Interest234BSegment = { from: DateString; to: DateString; months: number; shortfall: Paise; base: Paise; interest: Paise };

export type Interest234B = {
  applies: boolean;
  reason: string;
  assessedTax: Paise;
  advanceTaxPaid: Paise;
  segments: Interest234BSegment[];
  interest: Paise;
};

export type Interest234A = {
  applies: boolean;
  reason: string;
  base: Paise;
  from: DateString | null;
  to: DateString | null;
  months: number;
  interest: Paise;
};

export type RegimeComputation = {
  regime: Regime;
  income: {
    salaryGross: Paise;
    salaryExemptions: Paise;
    standardDeduction: Paise;
    salary: Paise;
    houseProperty: { entered: Paise; allowed: Paise; lossSetOff: Paise; lossCarriedForward: Paise; lossNotAllowed: Paise };
    business: Paise;
    otherSources: Paise;
    capitalGains: { kind: SpecialRateKind; period: "current" | "earlier"; amount: Paise }[];
    grossTotalIncome: Paise;
  };
  deductions: { lines: DeductionLine[]; total: Paise; notAllowedInRegime: Paise; limitedToNormalIncome: boolean };
  totalIncomeBeforeRounding: Paise;
  /** Rounded u/s 288A. */
  totalIncome: Paise;
  normalIncome: Paise;
  specialIncome: Paise;
  slabs: SlabLine[];
  normalTax: Paise;
  special: SpecialRateLine[];
  specialTax: Paise;
  taxBeforeRebate: Paise;
  rebate: Paise;
  taxAfterRebate: Paise;
  surcharge: { rate: number; threshold: Paise | null; gross: Paise; marginalRelief: Paise; net: Paise };
  cess: Paise;
  taxLiability: Paise;
  /** Rounded u/s 288B. */
  taxLiabilityRounded: Paise;
  interest: { s234A: Interest234A; s234B: Interest234B; s234C: Interest234C; total: Paise };
  taxesPaid: { tdsTcs: Paise; advanceTax: Paise; selfAssessment: Paise; total: Paise };
  /** Liability + interest: what the regimes are compared on. */
  totalTaxAndInterest: Paise;
  /** Rounded u/s 288B: positive = payable, negative = refund. */
  balance: Paise;
  payable: Paise;
  refund: Paise;
  lines: ItrLine[];
};

export type ItrComparison = {
  newRegime: Paise;
  oldRegime: Paise;
  recommendedRegime: Regime;
  saving: Paise;
  note: string;
};

export type ItrResult = {
  financialYear: FinancialYear;
  statute: ItrStatute;
  /** "AY 2026-27" (1961 Act) or "Tax year 2026-27" (2025 Act) (§6.1). */
  yearLabel: string;
  actName: string;
  dates: ItrDates;
  regimes: Record<Regime, RegimeComputation>;
  comparison: ItrComparison;
  recommendedRegime: Regime;
  saving: Paise;
  notes: string[];
};

/** Thrown by `computeItr` for inputs that fail `validateItrInputs`. */
export class ItrInputError extends RangeError {
  readonly fieldErrors: FieldErrors;
  constructor(fieldErrors: FieldErrors) {
    const first = Object.values(fieldErrors)[0]?.[0] ?? "Invalid inputs.";
    super(first);
    this.name = "ItrInputError";
    this.fieldErrors = fieldErrors;
  }
}

// -------------------------------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------------------------------

/** Whole rupees from a rule set to paise. */
function rupees(r: number): Paise {
  return Math.round(r * 100);
}

function sum(values: readonly Paise[]): Paise {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function inr(p: Paise): string {
  return p % 100 === 0 ? formatINR(p, { decimals: 0 }) : formatINR(p);
}

function pct(rate: number): string {
  return `${rate}%`;
}

function fmtDate(d: DateString): string {
  const { year, month, day } = parseDateString(d);
  return `${day} ${MONTH_ABBR[month - 1]} ${year}`;
}

/** Rounds paise to the nearest multiple of `unitRupees` rupees, half-up (s.288A / s.288B). */
export function roundToNearestRupees(paise: Paise, unitRupees: number): Paise {
  const unit = rupees(unitRupees);
  const r = divideRoundHalfUp(paise, unit) * unit;
  return r === 0 ? 0 : r;
}

/** Rounds a positive amount DOWN to a multiple of `unitRupees` rupees (Rule 119A); 0 for ≤ 0. */
export function roundDownToRupees(paise: Paise, unitRupees: number): Paise {
  if (paise <= 0) return 0;
  const unit = rupees(unitRupees);
  return Math.floor(paise / unit) * unit;
}

/**
 * Months "or part of a month" from `start` to `end`, both inclusive (ss.234A/234B): a month runs
 * from `start` to the day before the same date next month, and any part counts as a whole month.
 * `monthsOrPartOfMonth('2026-08-01', '2026-09-10') === 2`. Zero when `end` is before `start`.
 */
export function monthsOrPartOfMonth(start: DateString, end: DateString): number {
  if (compareDates(end, start) < 0) return 0;
  let n = 1;
  while (compareDates(addMonths(start, n), end) <= 0) n++;
  return n;
}

/** The first day of the month after `date`'s month. */
function firstOfNextMonth(date: DateString): DateString {
  const { year, month } = parseDateString(date);
  return addMonths(toDateString(year, month, 1), 1);
}

/** Tax on normal-rate income by slabs (§6.11), each slab rounded half-up to the paisa. */
export function slabTax(income: Paise, slabs: readonly Slab[]): { tax: Paise; lines: SlabLine[] } {
  const lines: SlabLine[] = [];
  let lower = 0;
  let tax = 0;
  for (const s of slabs) {
    if (income <= lower) break;
    const upper = s.upTo === null ? null : rupees(s.upTo);
    const portion = (upper === null ? income : Math.min(income, upper)) - lower;
    const t = percentOf(portion, s.rate);
    lines.push({ from: lower, to: upper, rate: s.rate, income: portion, tax: t });
    tax += t;
    if (upper === null) break;
    lower = upper;
  }
  return { tax, lines };
}

/** The maximum amount not chargeable to tax: the top of the first slab when it is a nil slab. */
function basicExemption(slabs: readonly Slab[]): Paise {
  const first = slabs[0];
  if (!first || first.rate !== 0) return 0;
  return first.upTo === null ? Number.MAX_SAFE_INTEGER : rupees(first.upTo);
}

// -------------------------------------------------------------------------------------------------
// Section labels and year labels (§6.1)
// -------------------------------------------------------------------------------------------------

export type SectionLabelContext = "screen" | "pdf";

/**
 * The label for a section in a record of a given statute (§6.1): the 1961 number for 1961-Act years;
 * the 2025 number once its mapping is verified; otherwise, on PDFs, the old section with
 * "(corresponding provision of the Income-tax Act, 2025)", and on screens the new number marked as
 * not yet verified (or the PDF form when no 2025 number is known).
 */
export function sectionLabel(ref: SectionRef, statute: ItrStatute, context: SectionLabelContext = "screen"): string {
  if (statute === "1961") return `s.${ref.act1961}`;
  if (ref.act2025 && ref.verified) return `s.${ref.act2025}`;
  if (ref.act2025 && context === "screen") return `s.${ref.act2025} (s.${ref.act1961} of the 1961 Act; mapping not yet verified)`;
  return `s.${ref.act1961} (corresponding provision of the Income-tax Act, 2025)`;
}

/** The cited section for a topic in a rule set's statute. */
export function sectionCite(ruleSet: ItrRuleSet, topic: SectionTopic): SectionCite {
  const ref = ruleSet.sections[topic];
  return {
    topic,
    label: sectionLabel(ref, ruleSet.statute, "screen"),
    pdfLabel: sectionLabel(ref, ruleSet.statute, "pdf"),
    verified: ruleSet.statute === "1961" || (ref.act2025 !== null && ref.verified),
  };
}

/** "AY 2026-27" for a 1961-Act year, "Tax year 2026-27" for a 2025-Act year (§6.1). */
export function itrYearLabel(ruleSet: Pick<ItrRuleSet, "financialYear" | "statute">): string {
  return ruleSet.statute === "2025" ? `Tax year ${ruleSet.financialYear}` : `AY ${assessmentYearOf(ruleSet.financialYear)}`;
}

// -------------------------------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------------------------------

const NON_NEGATIVE_INCOME: readonly (keyof ItrIncomeInputs)[] = [
  "salaryGross",
  "salaryOldRegimeExemptions",
  "businessProfession",
  "otherSources",
  "dividends",
  "stcg111a",
  "ltcg112a",
  "ltcg112",
];

const DEDUCTION_AMOUNTS: readonly (keyof ItrDeductionInputs)[] = [
  "sec80CBasket",
  "sec80CCD1B",
  "sec80G",
  "sec80TTA_TTB",
  "otherOldRegime",
  "employerNps80CCD2",
  "basicPlusDa",
  "otherBothRegimes",
];

/**
 * Checks the inputs against the rule set (§7.8.2). Returns field errors keyed by input path
 * (e.g. `income.dividends`); empty when the inputs can be computed.
 */
export function validateItrInputs(inputs: ItrInputs, ruleSet: ItrRuleSet, dates: ItrDates): FieldErrors {
  const errors: FieldErrors = {};
  const add = (field: string, message: string) => {
    (errors[field] ??= []).push(message);
  };
  const amount = (field: string, v: unknown, allowNegative = false) => {
    if (v === undefined) return;
    if (!isPaise(v)) add(field, "Enter the amount in rupees and paise.");
    else if (!allowNegative && v < 0) add(field, "The amount can't be negative.");
  };

  if (inputs.financialYear !== ruleSet.financialYear) {
    add("financialYear", `The rule set is for FY ${ruleSet.financialYear}, not FY ${inputs.financialYear}.`);
  }
  if (!(ASSESSEE_TYPES as readonly string[]).includes(inputs.assesseeType)) add("assesseeType", "Choose individual or HUF.");
  if (!(AGE_BANDS as readonly string[]).includes(inputs.ageBand)) add("ageBand", "Choose an age band.");

  const inc = inputs.income ?? {};
  for (const key of NON_NEGATIVE_INCOME) amount(`income.${key}`, inc[key]);
  amount("income.houseProperty", inc.houseProperty, true);
  const earlier = inc.earlierTransfers ?? {};
  for (const key of ["stcg111a", "ltcg112a", "ltcg112"] as const) amount(`income.earlierTransfers.${key}`, earlier[key]);

  if ((inc.dividends ?? 0) > (inc.otherSources ?? 0)) add("income.dividends", "Dividends are part of other sources, so they can't exceed it.");
  if ((inc.salaryOldRegimeExemptions ?? 0) > (inc.salaryGross ?? 0)) {
    add("income.salaryOldRegimeExemptions", "Exemptions can't exceed the gross salary.");
  }
  if (inputs.assesseeType === "huf" && (inc.salaryGross ?? 0) > 0) add("income.salaryGross", "A HUF has no salary income.");
  const hasEarlier = (earlier.stcg111a ?? 0) + (earlier.ltcg112a ?? 0) + (earlier.ltcg112 ?? 0) > 0;
  if (hasEarlier && !ruleSet.capitalGains.earlierRates) {
    add("income.earlierTransfers", `FY ${ruleSet.financialYear} has a single set of capital-gains rates; enter all gains in the main fields.`);
  }

  const ded = inputs.deductions ?? {};
  for (const key of DEDUCTION_AMOUNTS) amount(`deductions.${key}`, ded[key]);
  amount("deductions.sec80D.selfFamily", ded.sec80D?.selfFamily);
  amount("deductions.sec80D.parents", ded.sec80D?.parents);

  const paid = inputs.taxesPaid ?? {};
  amount("taxesPaid.tdsTcs", paid.tdsTcs);
  for (const key of ["q1", "q2", "q3", "q4", "afterQ4"] as const) amount(`taxesPaid.advanceTax.${key}`, paid.advanceTax?.[key]);

  const datesOk = isDateString(dates.filingDate) && isDateString(dates.dueDate);
  if (!isDateString(dates.filingDate)) add("filingDate", "Enter the filing date as YYYY-MM-DD.");
  if (!isDateString(dates.dueDate)) add("dueDate", "Enter the due date as YYYY-MM-DD.");
  const yearEnd = ruleSet.financialYear ? fyEnd(ruleSet.financialYear) : null;
  if (datesOk && yearEnd && compareDates(dates.dueDate, yearEnd) <= 0) add("dueDate", "The due date of the return must fall after the year ends.");

  (paid.selfAssessment ?? []).forEach((p, i) => {
    const field = `taxesPaid.selfAssessment.${i}`;
    amount(`${field}.amount`, p.amount);
    if (!isDateString(p.paidOn)) {
      add(`${field}.paidOn`, "Enter the payment date as YYYY-MM-DD.");
      return;
    }
    if (yearEnd && compareDates(p.paidOn, yearEnd) <= 0) add(`${field}.paidOn`, "Tax paid during the year is advance tax; enter it under advance tax.");
    if (datesOk && compareDates(p.paidOn, dates.filingDate) > 0) add(`${field}.paidOn`, "Self-assessment tax is paid on or before the filing date.");
  });
  return errors;
}

// -------------------------------------------------------------------------------------------------
// Special-rate income and the tax pipeline
// -------------------------------------------------------------------------------------------------

type Bucket = { kind: SpecialRateKind; period: "current" | "earlier"; rate: number; amount: Paise };

/** Normal-rate income split into dividends and the rest, plus the special-rate buckets. */
type Composition = { other: Paise; dividends: Paise; buckets: Bucket[] };

/** Bucket indices, highest rate first; ties in `SPECIAL_RATE_KINDS` order, current before earlier. */
function rateOrder(buckets: readonly { kind: SpecialRateKind; period: "current" | "earlier"; rate: number }[]): number[] {
  return buckets
    .map((_, i) => i)
    .sort((a, b) => {
      const x = buckets[a];
      const y = buckets[b];
      if (x.rate !== y.rate) return y.rate - x.rate;
      const k = SPECIAL_RATE_KINDS.indexOf(x.kind) - SPECIAL_RATE_KINDS.indexOf(y.kind);
      if (k !== 0) return k;
      return x.period === y.period ? 0 : x.period === "current" ? -1 : 1;
    });
}

function compositionTotal(c: Composition): Paise {
  return c.other + c.dividends + sum(c.buckets.map((b) => b.amount));
}

/** Removes `amount` from a composition: other normal income, then dividends, then gains (highest rate first). */
function reduceComposition(c: Composition, amount: Paise): Composition {
  let left = amount;
  const take = (v: Paise) => {
    const used = Math.min(v, left);
    left -= used;
    return v - used;
  };
  const other = take(c.other);
  const dividends = take(c.dividends);
  const buckets = c.buckets.map((b) => ({ ...b }));
  for (const i of rateOrder(buckets)) buckets[i].amount = take(buckets[i].amount);
  return { other, dividends, buckets };
}

type PersonCtx = { rules: RegimeRules; ruleSet: ItrRuleSet; slabs: Slab[]; rebatePerson: boolean; resident: boolean };

type Pipeline = {
  totalIncome: Paise;
  normalIncome: Paise;
  slabLines: SlabLine[];
  normalTax: Paise;
  special: SpecialRateLine[];
  specialTax: Paise;
  rebate: Paise;
  rebateNote: string;
  taxAfterRebate: Paise;
  surchargeRate: number;
  surchargeThreshold: Paise | null;
  surchargeGross: Paise;
  cappedTax: Paise;
  fullRateTax: Paise;
};

/** Tax, rebate and surcharge (before marginal relief) on a composition of income. */
function taxPipeline(c: Composition, ctx: PersonCtx): Pipeline {
  const { rules, ruleSet } = ctx;
  const normalIncome = c.other + c.dividends;
  const totalIncome = compositionTotal(c);
  const { tax: normalTax, lines: slabLines } = slabTax(normalIncome, ctx.slabs);

  // Special-rate gains: the 112A exemption, then a resident's unused basic exemption, highest rate first.
  const special: SpecialRateLine[] = c.buckets.map((b) => ({
    kind: b.kind,
    period: b.period,
    rate: b.rate,
    income: b.amount,
    exemption: 0,
    basicExemptionUsed: 0,
    taxable: b.amount,
    tax: 0,
  }));
  const order = rateOrder(special);
  let exemptionLeft = rupees(ruleSet.capitalGains.ltcg112aExemption);
  for (const i of order) {
    if (special[i].kind !== "112A") continue;
    const used = Math.min(exemptionLeft, special[i].taxable);
    special[i].exemption = used;
    special[i].taxable -= used;
    exemptionLeft -= used;
  }
  if (ctx.resident) {
    let shortfall = Math.max(0, basicExemption(ctx.slabs) - normalIncome);
    for (const i of order) {
      const used = Math.min(shortfall, special[i].taxable);
      special[i].basicExemptionUsed = used;
      special[i].taxable -= used;
      shortfall -= used;
    }
  }
  for (const line of special) line.tax = percentOf(line.taxable, line.rate);
  const specialTax = sum(special.map((l) => l.tax));

  // s.87A rebate: on normal-rate tax and the special-rate taxes the rule set allows it against.
  const r = rules.rebate;
  const eligibleSpecial = sum(special.filter((l) => !r.notAgainst.includes(l.kind)).map((l) => l.tax));
  const eligibleTax = normalTax + eligibleSpecial;
  const limit = rupees(r.limit);
  let rebate = 0;
  let rebateNote: string;
  if (!ctx.rebatePerson) {
    rebateNote = "Only a resident individual gets the rebate.";
  } else if (totalIncome <= limit) {
    rebate = Math.min(rupees(r.max), eligibleTax);
    rebateNote = `Total income ${inr(totalIncome)} is within ${inr(limit)}: rebate up to ${inr(rupees(r.max))}`;
    if (r.notAgainst.length > 0 && specialTax > 0) rebateNote += `, not against tax under s.${r.notAgainst.join(", s.")}`;
    rebateNote += ".";
  } else if (r.marginalRelief && eligibleTax > totalIncome - limit) {
    rebate = eligibleTax - (totalIncome - limit);
    rebateNote = `Marginal relief: tax ${inr(eligibleTax)} is cut to the income above ${inr(limit)}, ${inr(totalIncome - limit)}.`;
  } else {
    rebateNote = `Total income is above ${inr(limit)}: no rebate.`;
  }

  // Allocate the rebate: normal-rate tax first, then the special-rate taxes it may reduce.
  const fromNormal = Math.min(rebate, normalTax);
  const normalAfter = normalTax - fromNormal;
  const specialAfter = specialTax - (rebate - fromNormal);
  const taxAfterRebate = normalAfter + specialAfter;

  // Surcharge: full rate on normal-rate tax; capped rate on special-rate tax and on dividends (top slice).
  const dividendPart = Math.min(c.dividends, normalIncome);
  const dividendTax = dividendPart > 0 ? normalTax - slabTax(normalIncome - dividendPart, ctx.slabs).tax : 0;
  const dividendAfter = Math.min(dividendTax, normalAfter);
  const fullRateTax = normalAfter - dividendAfter;
  const cappedTax = dividendAfter + specialAfter;
  let band: { above: number; rate: number } | null = null;
  for (const b of rules.surcharge.bands) if (totalIncome > rupees(b.above)) band = b;
  const surchargeRate = band?.rate ?? 0;
  const cappedRate = Math.min(surchargeRate, rules.surcharge.specialIncomeCap);
  const surchargeGross = surchargeRate > 0 ? percentOf(fullRateTax, surchargeRate) + percentOf(cappedTax, cappedRate) : 0;

  return {
    totalIncome,
    normalIncome,
    slabLines,
    normalTax,
    special,
    specialTax,
    rebate,
    rebateNote,
    taxAfterRebate,
    surchargeRate,
    surchargeThreshold: band ? rupees(band.above) : null,
    surchargeGross,
    cappedTax,
    fullRateTax,
  };
}

// -------------------------------------------------------------------------------------------------
// Interest u/s 234A, 234B, 234C (2025 Act: ss.423, 424, 425 [verify])
// -------------------------------------------------------------------------------------------------

/** Interest at the rule set's monthly rate on a base (already rounded down) for `months` months. */
function monthlyInterest(base: Paise, months: number, rules: InterestRules): Paise {
  return percentOf(base * months, rules.ratePerMonth);
}

/**
 * s.234A, late return: 1% a month (or part) from the day after the due date to the filing date, on
 * the tax on total income less advance tax, TDS/TCS and self-assessment tax paid on or before the
 * due date, rounded down to ₹100.
 */
export function interest234A(
  input: {
    tax: Paise;
    advanceTax: Paise;
    tdsTcs: Paise;
    selfAssessment: readonly SelfAssessmentPayment[];
    dueDate: DateString;
    filingDate: DateString;
  },
  rules: InterestRules,
): Interest234A {
  if (compareDates(input.filingDate, input.dueDate) <= 0) {
    return { applies: false, reason: "Filed on or before the due date.", base: 0, from: null, to: null, months: 0, interest: 0 };
  }
  const paidByDue = sum(input.selfAssessment.filter((p) => compareDates(p.paidOn, input.dueDate) <= 0).map((p) => p.amount));
  const unpaid = input.tax - input.advanceTax - input.tdsTcs - paidByDue;
  const base = roundDownToRupees(unpaid, rules.interestBaseRoundDownTo);
  const from = addDays(input.dueDate, 1);
  const months = monthsOrPartOfMonth(from, input.filingDate);
  if (base === 0) {
    return { applies: false, reason: "No tax was unpaid on the due date.", base: 0, from, to: input.filingDate, months, interest: 0 };
  }
  const interest = monthlyInterest(base, months, rules);
  return {
    applies: true,
    reason: `${pct(rules.ratePerMonth)} a month for ${months} month${months === 1 ? "" : "s"} on ${inr(base)} (unpaid tax rounded down to ${inr(rupees(rules.interestBaseRoundDownTo))}), ${fmtDate(from)} to ${fmtDate(input.filingDate)}.`,
    base,
    from,
    to: input.filingDate,
    months,
    interest,
  };
}

/**
 * s.234B, advance tax below 90% of the assessed tax (tax less TDS/TCS): 1% a month (or part) from
 * 1 April after the year to the filing date, on the shortfall rounded down to ₹100. A
 * self-assessment payment stops interest on the part it pays from the month after it is paid.
 */
export function interest234B(
  input: {
    liable: boolean;
    notLiableReason?: string;
    assessedTax: Paise;
    advanceTaxPaid: Paise;
    selfAssessment: readonly SelfAssessmentPayment[];
    financialYear: FinancialYear;
    filingDate: DateString;
  },
  rules: InterestRules,
): Interest234B {
  const none = (reason: string): Interest234B => ({
    applies: false,
    reason,
    assessedTax: input.assessedTax,
    advanceTaxPaid: input.advanceTaxPaid,
    segments: [],
    interest: 0,
  });
  if (!input.liable) return none(input.notLiableReason ?? "No advance tax was payable.");
  const required = percentOf(input.assessedTax, rules.shortfall234BPercent);
  if (input.advanceTaxPaid >= required) {
    return none(`Advance tax paid ${inr(input.advanceTaxPaid)} is at least ${pct(rules.shortfall234BPercent)} of the assessed tax ${inr(input.assessedTax)}.`);
  }
  const start = addDays(fyEnd(input.financialYear), 1);
  if (compareDates(input.filingDate, start) < 0) return none(`Interest starts on ${fmtDate(start)}, after the projected filing date.`);

  const payments = [...input.selfAssessment]
    .filter((p) => compareDates(p.paidOn, start) >= 0 && compareDates(p.paidOn, input.filingDate) <= 0)
    .sort((a, b) => compareDates(a.paidOn, b.paidOn));
  const segments: Interest234BSegment[] = [];
  let shortfall = input.assessedTax - input.advanceTaxPaid;
  let from = start;
  const addSegment = (to: DateString) => {
    const months = monthsOrPartOfMonth(from, to);
    const base = roundDownToRupees(shortfall, rules.interestBaseRoundDownTo);
    if (months > 0 && base > 0) segments.push({ from, to, months, shortfall, base, interest: monthlyInterest(base, months, rules) });
  };
  for (const p of payments) {
    if (shortfall <= 0) break;
    addSegment(p.paidOn);
    shortfall -= p.amount;
    from = firstOfNextMonth(p.paidOn);
  }
  if (shortfall > 0) addSegment(input.filingDate);
  const interest = sum(segments.map((s) => s.interest));
  const reason =
    segments.length === 0
      ? "The shortfall was paid before any interest arose."
      : segments
          .map((s) => `${s.months} month${s.months === 1 ? "" : "s"} on ${inr(s.base)} (${fmtDate(s.from)} to ${fmtDate(s.to)})`)
          .join("; ") + `, at ${pct(rules.ratePerMonth)} a month; advance tax paid was below ${pct(rules.shortfall234BPercent)} of ${inr(input.assessedTax)}.`;
  return { applies: segments.length > 0, reason, assessedTax: input.assessedTax, advanceTaxPaid: input.advanceTaxPaid, segments, interest };
}

/**
 * s.234C, deferment of advance tax: for each instalment, 1% a month for its months on the
 * shortfall (rounded down to ₹100) from its cumulative percentage of the tax due on the returned
 * income (tax less TDS/TCS). No interest for the June and September instalments when at least 12%
 * / 36% was paid (the safe harbours). Presumptive income (44AD/44ADA) has the single 15 March
 * instalment.
 */
export function interest234C(
  input: {
    liable: boolean;
    notLiableReason?: string;
    taxDue: Paise;
    advanceTax: AdvanceTaxPaid;
    presumptive: boolean;
    financialYear: FinancialYear;
  },
  rules: InterestRules,
): Interest234C {
  if (!input.liable) {
    return { applies: false, reason: input.notLiableReason ?? "No advance tax was payable.", taxDue: input.taxDue, instalments: [], interest: 0 };
  }
  const at = input.advanceTax;
  const q = [at.q1 ?? 0, at.q2 ?? 0, at.q3 ?? 0, at.q4 ?? 0];
  const cumulative = [q[0], q[0] + q[1], q[0] + q[1] + q[2], q[0] + q[1] + q[2] + q[3]];
  const schedule = input.presumptive ? [rules.presumptiveInstalment] : rules.instalments;
  const startYear = Number(input.financialYear.slice(0, 4));
  const instalments: InstalmentInterest[] = schedule.map((inst, i) => {
    const paid = input.presumptive ? cumulative[3] : cumulative[Math.min(i, 3)];
    const due = percentOf(input.taxDue, inst.cumulativePercent);
    const safeHarbourMet = inst.safeHarbourPercent !== null && paid >= percentOf(input.taxDue, inst.safeHarbourPercent);
    const shortfall = safeHarbourMet ? 0 : Math.max(0, due - paid);
    const base = roundDownToRupees(shortfall, rules.interestBaseRoundDownTo);
    return {
      dueDate: toDateString(inst.month >= 4 ? startYear : startYear + 1, inst.month, inst.day),
      cumulativePercent: inst.cumulativePercent,
      due,
      paid,
      safeHarbourMet,
      shortfall,
      base,
      months: inst.months,
      interest: monthlyInterest(base, inst.months, rules),
    };
  });
  const interest = sum(instalments.map((x) => x.interest));
  const reason = instalments
    .map((x) =>
      x.safeHarbourMet
        ? `${fmtDate(x.dueDate)}: paid ${inr(x.paid)}, safe harbour met`
        : x.base > 0
          ? `${fmtDate(x.dueDate)}: ${x.months} month${x.months === 1 ? "" : "s"} on ${inr(x.base)} (${pct(x.cumulativePercent)} due ${inr(x.due)}, paid ${inr(x.paid)})`
          : `${fmtDate(x.dueDate)}: paid in full`,
    )
    .join("; ");
  return { applies: interest > 0, reason: `${reason}.`, taxDue: input.taxDue, instalments, interest };
}

// -------------------------------------------------------------------------------------------------
// One regime
// -------------------------------------------------------------------------------------------------

const KIND_LABEL: Readonly<Record<SpecialRateKind, string>> = {
  "111A": "Short-term capital gains on listed equity",
  "112A": "Long-term capital gains on listed equity",
  "112": "Other long-term capital gains",
};

const KIND_TOPIC: Readonly<Record<SpecialRateKind, SectionTopic>> = { "111A": "stcg111A", "112A": "ltcg112A", "112": "ltcg112" };

function computeRegime(regime: Regime, inputs: ItrInputs, ruleSet: ItrRuleSet, dates: ItrDates): RegimeComputation {
  const rules = ruleSet.regimes[regime];
  const cite = (topic: SectionTopic) => sectionCite(ruleSet, topic);
  const individual = inputs.assesseeType === "individual";
  const resident = inputs.resident !== false;
  const seniorResident = individual && resident && inputs.ageBand !== "below_60";
  const slabs =
    seniorResident && rules.seniorSlabs && inputs.ageBand !== "below_60" ? rules.seniorSlabs[inputs.ageBand] : rules.slabs;
  const ctx: PersonCtx = { rules, ruleSet, slabs, rebatePerson: individual && resident, resident };
  const inc = inputs.income;
  const ded = inputs.deductions ?? {};
  const paid = inputs.taxesPaid ?? {};
  const lines: ItrLine[] = [];
  const push = (code: string, label: string, amount: Paise, extra: { note?: string; section?: SectionCite } = {}) => {
    lines.push({ code, label, amount, ...extra });
  };
  const regimeName = regime === "new" ? "new regime" : "old regime";

  // ---- Salary --------------------------------------------------------------------------------
  const salaryGross = inc.salaryGross ?? 0;
  const exemptionsEntered = inc.salaryOldRegimeExemptions ?? 0;
  const salaryExemptions = rules.salaryExemptionsAllowed ? Math.min(exemptionsEntered, salaryGross) : 0;
  const salaryAfterExemptions = salaryGross - salaryExemptions;
  const standardDeduction = Math.min(rupees(rules.standardDeduction), salaryAfterExemptions);
  const salary = salaryAfterExemptions - standardDeduction;
  push("salary.gross", "Salary (gross)", salaryGross);
  push("salary.exemptions", "Less: exemptions u/s 10 and deductions u/s 16(ii)/(iii)", -salaryExemptions, {
    note:
      !rules.salaryExemptionsAllowed && exemptionsEntered > 0
        ? `${inr(exemptionsEntered)} entered; not allowed in the ${regimeName}.`
        : undefined,
  });
  push("salary.standard_deduction", "Less: standard deduction", -standardDeduction, {
    note: salaryGross > 0 ? `${inr(rupees(rules.standardDeduction))}, or the salary if lower.` : undefined,
    section: cite("standardDeduction"),
  });
  push("income.salary", "Income from salary", salary);

  // ---- Other heads before set-off ------------------------------------------------------------
  const business = inc.businessProfession ?? 0;
  const otherSources = inc.otherSources ?? 0;
  const cg = ruleSet.capitalGains;
  const buckets: Bucket[] = [
    { kind: "111A", period: "current", rate: cg.rates["111A"], amount: inc.stcg111a ?? 0 },
    { kind: "112A", period: "current", rate: cg.rates["112A"], amount: inc.ltcg112a ?? 0 },
    { kind: "112", period: "current", rate: cg.rates["112"], amount: inc.ltcg112 ?? 0 },
  ];
  if (cg.earlierRates) {
    const e = inc.earlierTransfers ?? {};
    buckets.push(
      { kind: "111A", period: "earlier", rate: cg.earlierRates["111A"], amount: e.stcg111a ?? 0 },
      { kind: "112A", period: "earlier", rate: cg.earlierRates["112A"], amount: e.ltcg112a ?? 0 },
      { kind: "112", period: "earlier", rate: cg.earlierRates["112"], amount: e.ltcg112 ?? 0 },
    );
  }

  // ---- House property ------------------------------------------------------------------------
  const hpEntered = inc.houseProperty ?? 0;
  let hpAllowed = hpEntered;
  let lossSetOff = 0;
  let lossCarriedForward = 0;
  let lossNotAllowed = 0;
  let hpNote: string | undefined;
  const normalHeads = salary + business + otherSources;
  if (hpEntered < 0) {
    const loss = -hpEntered;
    if (!rules.houseProperty.lossSetOff) {
      hpAllowed = 0;
      lossNotAllowed = loss;
      hpNote = `Loss of ${inr(loss)} can't be set off against other income in the ${regimeName}.`;
    } else {
      const cap = rules.houseProperty.lossSetOffCap === null ? loss : Math.min(loss, rupees(rules.houseProperty.lossSetOffCap));
      lossSetOff = Math.min(cap, normalHeads + sum(buckets.map((b) => b.amount)));
      lossCarriedForward = loss - lossSetOff;
      hpAllowed = -lossSetOff;
      hpNote = `Loss of ${inr(loss)}; set off ${inr(lossSetOff)}`;
      if (rules.houseProperty.lossSetOffCap !== null) hpNote += ` (limit ${inr(rupees(rules.houseProperty.lossSetOffCap))})`;
      hpNote += lossCarriedForward > 0 ? `; ${inr(lossCarriedForward)} carried forward.` : ".";
    }
  }
  push("income.house_property", "Income from house property", hpAllowed, {
    note: hpNote,
    section: hpEntered < 0 ? cite("houseLossSetOff") : undefined,
  });
  push("income.business", "Profits and gains of business or profession", business);

  // The set-off reduces normal-rate income first, then gains (highest rate first).
  const lossAgainstNormal = Math.min(lossSetOff, normalHeads);
  let lossLeft = lossSetOff - lossAgainstNormal;
  for (const i of rateOrder(buckets)) {
    const used = Math.min(lossLeft, buckets[i].amount);
    buckets[i].amount -= used;
    lossLeft -= used;
  }
  for (const b of buckets) {
    if (b.period === "earlier" && b.amount === 0) continue;
    const when = cg.cutoverDate ? (b.period === "earlier" ? ` (transfers before ${fmtDate(cg.cutoverDate)})` : ` (transfers from ${fmtDate(cg.cutoverDate)})`) : "";
    push(`income.capital_gains.${b.kind}${b.period === "earlier" ? ".earlier" : ""}`, `${KIND_LABEL[b.kind]}${when}`, b.amount, {
      section: cite(KIND_TOPIC[b.kind]),
    });
  }
  push("income.other_sources", "Income from other sources", otherSources, {
    note: (inc.dividends ?? 0) > 0 ? `Includes dividends of ${inr(inc.dividends ?? 0)}.` : undefined,
  });

  const normalGti = normalHeads - lossAgainstNormal;
  const specialIncome = sum(buckets.map((b) => b.amount));
  const grossTotalIncome = normalGti + specialIncome;
  push("gti", "Gross total income", grossTotalIncome);

  // ---- Deductions ----------------------------------------------------------------------------
  const deductionLines: DeductionLine[] = [];
  let notAllowedInRegime = 0;
  const caps = rules.chapterVIA;
  const oldOnly = (code: string, label: string, claimed: Paise, topic: SectionTopic | null, allow: () => { allowed: Paise; note?: string }) => {
    if (caps) {
      const { allowed, note } = allow();
      deductionLines.push({ code, label, claimed, allowed, note, section: topic ? cite(topic) : undefined });
    } else {
      notAllowedInRegime += claimed;
      deductionLines.push({
        code,
        label,
        claimed,
        allowed: 0,
        note: claimed > 0 ? `Not allowed in the ${regimeName}.` : undefined,
        section: topic ? cite(topic) : undefined,
      });
    }
  };
  const capped = (claimed: Paise, capRupees: number) => {
    const cap = rupees(capRupees);
    return { allowed: Math.min(claimed, cap), note: claimed > cap ? `Limited to ${inr(cap)}.` : undefined };
  };

  oldOnly("deduction.80c", "80C / 80CCC / 80CCD(1) basket", ded.sec80CBasket ?? 0, "sec80CBasket", () => capped(ded.sec80CBasket ?? 0, caps!.sec80CBasket));
  oldOnly("deduction.80ccd1b", "NPS, own contribution (80CCD(1B))", ded.sec80CCD1B ?? 0, "sec80CCD1B", () => capped(ded.sec80CCD1B ?? 0, caps!.sec80CCD1B));
  const d80 = ded.sec80D ?? {};
  const selfSenior = d80.selfSenior ?? seniorResident;
  oldOnly("deduction.80d", "Health insurance (80D)", (d80.selfFamily ?? 0) + (d80.parents ?? 0), "sec80D", () => {
    const capSelf = rupees(selfSenior ? caps!.sec80D.selfFamilySenior : caps!.sec80D.selfFamily);
    const capParents = rupees(d80.parentsSenior ? caps!.sec80D.parentsSenior : caps!.sec80D.parents);
    const self = Math.min(d80.selfFamily ?? 0, capSelf);
    const parents = Math.min(d80.parents ?? 0, capParents);
    return { allowed: self + parents, note: `Self and family up to ${inr(capSelf)}; parents up to ${inr(capParents)}.` };
  });
  oldOnly("deduction.80g", "Donations (80G), qualifying amount", ded.sec80G ?? 0, "sec80G", () => ({ allowed: ded.sec80G ?? 0 }));
  const tt = seniorResident ? "80TTB" : "80TTA";
  oldOnly("deduction.80tta_ttb", `Interest (${tt})`, ded.sec80TTA_TTB ?? 0, seniorResident ? "sec80TTB" : "sec80TTA", () =>
    capped(ded.sec80TTA_TTB ?? 0, seniorResident ? caps!.sec80TTB : caps!.sec80TTA),
  );
  oldOnly("deduction.other_old", "Other Chapter VI-A deductions", ded.otherOldRegime ?? 0, null, () => ({ allowed: ded.otherOldRegime ?? 0 }));

  const npsClaimed = ded.employerNps80CCD2 ?? 0;
  const npsPercent = ded.governmentEmployer ? rules.employerNpsCapPercentGovernment : rules.employerNpsCapPercent;
  const npsBase = ded.basicPlusDa ?? salaryGross;
  const npsCap = percentOf(npsBase, npsPercent);
  deductionLines.push({
    code: "deduction.80ccd2",
    label: "Employer NPS contribution (80CCD(2))",
    claimed: npsClaimed,
    allowed: Math.min(npsClaimed, npsCap),
    note:
      npsClaimed > 0
        ? `Up to ${pct(npsPercent)} of ${ded.basicPlusDa !== undefined ? "basic salary + DA" : "gross salary (basic + DA not entered)"}: ${inr(npsCap)}.`
        : undefined,
    section: cite("sec80CCD2"),
  });
  const otherBoth = ded.otherBothRegimes ?? 0;
  deductionLines.push({ code: "deduction.other_both", label: "Other deductions allowed in both regimes", claimed: otherBoth, allowed: otherBoth });

  const deductionsBeforeLimit = sum(deductionLines.map((l) => l.allowed));
  const deductionsTotal = Math.min(deductionsBeforeLimit, normalGti);
  const limitedToNormalIncome = deductionsTotal < deductionsBeforeLimit;
  for (const l of deductionLines) push(l.code, `Less: ${l.label}`, -l.allowed, { note: l.note, section: l.section });
  push("deductions.total", "Total deductions", -deductionsTotal, {
    note: limitedToNormalIncome
      ? `Limited to gross total income excluding special-rate gains, ${inr(normalGti)}.`
      : notAllowedInRegime > 0
        ? `${inr(notAllowedInRegime)} of old-regime deductions not allowed in the ${regimeName}.`
        : undefined,
  });

  // ---- Total income (s.288A) -------------------------------------------------------------------
  const totalIncomeBeforeRounding = grossTotalIncome - deductionsTotal;
  const totalIncome = roundToNearestRupees(totalIncomeBeforeRounding, ruleSet.rounding.totalIncomeTo);
  push("total_income", "Total income", totalIncome, {
    note:
      totalIncome !== totalIncomeBeforeRounding
        ? `${inr(totalIncomeBeforeRounding)} rounded to the nearest ${inr(rupees(ruleSet.rounding.totalIncomeTo))}.`
        : `Rounded to the nearest ${inr(rupees(ruleSet.rounding.totalIncomeTo))}.`,
    section: cite("roundingIncome"),
  });

  const normalIncome = Math.max(0, totalIncome - specialIncome);
  const dividendsPart = Math.min(inc.dividends ?? 0, normalIncome);
  const composition: Composition = { other: normalIncome - dividendsPart, dividends: dividendsPart, buckets };
  const p = taxPipeline(composition, ctx);

  // ---- Tax ---------------------------------------------------------------------------------
  p.slabLines.forEach((s, i) => {
    const range = s.to === null ? `above ${inr(s.from)}` : s.from === 0 ? `up to ${inr(s.to)}` : `${inr(s.from + 100)} to ${inr(s.to)}`;
    push(`tax.slab.${i + 1}`, `Tax at ${pct(s.rate)} on income ${range}`, s.tax, { note: `${pct(s.rate)} of ${inr(s.income)}.` });
  });
  push("tax.normal", "Tax on normal-rate income", p.normalTax, {
    note: `On ${inr(p.normalIncome)} at the ${regimeName} slab rates${seniorResident && rules.seniorSlabs ? ` for age ${inputs.ageBand.replace(/_/g, " ")}` : ""}.`,
    section: regime === "new" ? cite("newRegime") : undefined,
  });
  for (const s of p.special) {
    if (s.income === 0) continue;
    const parts = [`${pct(s.rate)} of ${inr(s.taxable)}`];
    if (s.exemption > 0) parts.push(`after the ${inr(s.exemption)} exemption`);
    if (s.basicExemptionUsed > 0) parts.push(`after ${inr(s.basicExemptionUsed)} of unused basic exemption`);
    push(`tax.special.${s.kind}${s.period === "earlier" ? ".earlier" : ""}`, `Tax on ${KIND_LABEL[s.kind].toLowerCase()}`, s.tax, {
      note: `${parts.join(", ")}.`,
      section: cite(KIND_TOPIC[s.kind]),
    });
  }
  push("tax.special", "Tax on special-rate income", p.specialTax);
  const taxBeforeRebate = p.normalTax + p.specialTax;
  push("tax.before_rebate", "Tax before rebate", taxBeforeRebate);
  push("tax.rebate", "Less: rebate", -p.rebate, { note: p.rebateNote, section: cite("rebate") });
  push("tax.after_rebate", "Tax after rebate", p.taxAfterRebate);

  // ---- Surcharge with marginal relief ------------------------------------------------------
  let marginalRelief = 0;
  let mrNote: string | undefined;
  if (p.surchargeThreshold !== null) {
    const excess = p.totalIncome - p.surchargeThreshold;
    const atThreshold = taxPipeline(reduceComposition(composition, excess), ctx);
    const ceiling = atThreshold.taxAfterRebate + atThreshold.surchargeGross + excess;
    marginalRelief = Math.min(p.surchargeGross, Math.max(0, p.taxAfterRebate + p.surchargeGross - ceiling));
    mrNote =
      marginalRelief > 0
        ? `Tax and surcharge on ${inr(p.surchargeThreshold)} are ${inr(atThreshold.taxAfterRebate + atThreshold.surchargeGross)}; with the income above it (${inr(excess)}) the ceiling is ${inr(ceiling)}.`
        : undefined;
  }
  const surchargeNet = p.surchargeGross - marginalRelief;
  const capRate = Math.min(p.surchargeRate, rules.surcharge.specialIncomeCap);
  push("tax.surcharge", "Surcharge", p.surchargeGross, {
    note:
      p.surchargeRate === 0
        ? "Total income is within the first surcharge threshold."
        : `${pct(p.surchargeRate)} as total income exceeds ${inr(p.surchargeThreshold ?? 0)}` +
          (p.cappedTax > 0 && capRate < p.surchargeRate ? `; ${pct(capRate)} on tax of ${inr(p.cappedTax)} on capital gains and dividends.` : "."),
  });
  push("tax.marginal_relief", "Less: marginal relief on surcharge", -marginalRelief, { note: mrNote });

  // ---- Cess and liability (s.288B) --------------------------------------------------------
  const cess = percentOf(p.taxAfterRebate + surchargeNet, ruleSet.cessRate);
  push("tax.cess", "Health and education cess", cess, { note: `${pct(ruleSet.cessRate)} of ${inr(p.taxAfterRebate + surchargeNet)}.` });
  const taxLiability = p.taxAfterRebate + surchargeNet + cess;
  push("tax.liability", "Total tax liability", taxLiability);
  const taxLiabilityRounded = roundToNearestRupees(taxLiability, ruleSet.rounding.taxTo);
  push("tax.liability_rounded", "Total tax liability (rounded)", taxLiabilityRounded, { section: cite("roundingTax") });

  // ---- Interest ----------------------------------------------------------------------------
  const tdsTcs = paid.tdsTcs ?? 0;
  const at = paid.advanceTax ?? {};
  const advanceTax = (at.q1 ?? 0) + (at.q2 ?? 0) + (at.q3 ?? 0) + (at.q4 ?? 0) + (at.afterQ4 ?? 0);
  const selfAssessment = paid.selfAssessment ?? [];
  const selfAssessmentTotal = sum(selfAssessment.map((s) => s.amount));
  const taxDue = Math.max(0, taxLiabilityRounded - tdsTcs);
  const interestRules = ruleSet.interest;
  const seniorExempt = interestRules.seniorWithoutBusinessExempt && seniorResident && business === 0 && !inputs.presumptive;
  const belowThreshold = taxDue < rupees(interestRules.advanceTaxThreshold);
  const liable = !seniorExempt && !belowThreshold;
  const notLiableReason = seniorExempt
    ? `A resident senior citizen with no business income pays no advance tax (${cite("seniorAdvanceTax").label}).`
    : `Tax less TDS/TCS (${inr(taxDue)}) is below ${inr(rupees(interestRules.advanceTaxThreshold))}, so no advance tax was payable (${cite("advanceTax").label}).`;

  const s234A = interest234A({ tax: taxLiabilityRounded, advanceTax, tdsTcs, selfAssessment, dueDate: dates.dueDate, filingDate: dates.filingDate }, interestRules);
  const s234B = interest234B(
    { liable, notLiableReason, assessedTax: taxDue, advanceTaxPaid: advanceTax, selfAssessment, financialYear: ruleSet.financialYear, filingDate: dates.filingDate },
    interestRules,
  );
  const s234C = interest234C(
    { liable, notLiableReason, taxDue, advanceTax: at, presumptive: inputs.presumptive === true, financialYear: ruleSet.financialYear },
    interestRules,
  );
  const interestTotal = s234A.interest + s234B.interest + s234C.interest;
  push("interest.234A", "Interest for late filing", s234A.interest, { note: s234A.reason, section: cite("interest234A") });
  push("interest.234B", "Interest for default in advance tax", s234B.interest, { note: s234B.reason, section: cite("interest234B") });
  push("interest.234C", "Interest for deferment of advance tax", s234C.interest, { note: s234C.reason, section: cite("interest234C") });
  push("interest.total", "Total interest", interestTotal);

  // ---- Taxes paid and balance -------------------------------------------------------------
  const paidTotal = tdsTcs + advanceTax + selfAssessmentTotal;
  push("paid.tds_tcs", "Less: TDS / TCS", -tdsTcs);
  push("paid.advance_tax", "Less: advance tax", -advanceTax);
  push("paid.self_assessment", "Less: self-assessment tax paid", -selfAssessmentTotal);
  push("paid.total", "Total taxes paid", -paidTotal);
  const totalTaxAndInterest = taxLiabilityRounded + interestTotal;
  const balance = roundToNearestRupees(totalTaxAndInterest - paidTotal, ruleSet.rounding.taxTo);
  const payable = Math.max(0, balance);
  const refund = Math.max(0, -balance);
  push("balance", balance >= 0 ? "Tax payable" : "Refund due", balance, {
    note: `Rounded to the nearest ${inr(rupees(ruleSet.rounding.taxTo))}.`,
    section: cite("roundingTax"),
  });

  return {
    regime,
    income: {
      salaryGross,
      salaryExemptions,
      standardDeduction,
      salary,
      houseProperty: { entered: hpEntered, allowed: hpAllowed, lossSetOff, lossCarriedForward, lossNotAllowed },
      business,
      otherSources,
      capitalGains: buckets.map((b) => ({ kind: b.kind, period: b.period, amount: b.amount })),
      grossTotalIncome,
    },
    deductions: { lines: deductionLines, total: deductionsTotal, notAllowedInRegime, limitedToNormalIncome },
    totalIncomeBeforeRounding,
    totalIncome,
    normalIncome: p.normalIncome,
    specialIncome,
    slabs: p.slabLines,
    normalTax: p.normalTax,
    special: p.special,
    specialTax: p.specialTax,
    taxBeforeRebate,
    rebate: p.rebate,
    taxAfterRebate: p.taxAfterRebate,
    surcharge: { rate: p.surchargeRate, threshold: p.surchargeThreshold, gross: p.surchargeGross, marginalRelief, net: surchargeNet },
    cess,
    taxLiability,
    taxLiabilityRounded,
    interest: { s234A, s234B, s234C, total: interestTotal },
    taxesPaid: { tdsTcs, advanceTax, selfAssessment: selfAssessmentTotal, total: paidTotal },
    totalTaxAndInterest,
    balance,
    payable,
    refund,
    lines,
  };
}

// -------------------------------------------------------------------------------------------------
// Both regimes, compared (§6.11)
// -------------------------------------------------------------------------------------------------

/**
 * Computes the return for both regimes side by side and recommends the cheaper one (§6.11,
 * §7.8.2). Deterministic: the same inputs, rule set and dates always give the same result.
 * Throws `ItrInputError` (with field errors) for inputs that fail `validateItrInputs`.
 */
export function computeItr(inputs: ItrInputs, ruleSet: ItrRuleSet, dates: ItrDates): ItrResult {
  const errors = validateItrInputs(inputs, ruleSet, dates);
  if (Object.keys(errors).length > 0) throw new ItrInputError(errors);

  const regimes = {} as Record<Regime, RegimeComputation>;
  for (const regime of REGIMES) regimes[regime] = computeRegime(regime, inputs, ruleSet, dates);

  const newTotal = regimes.new.totalTaxAndInterest;
  const oldTotal = regimes.old.totalTaxAndInterest;
  const recommendedRegime: Regime = oldTotal < newTotal ? "old" : newTotal < oldTotal ? "new" : ruleSet.defaultRegime;
  const saving = Math.abs(newTotal - oldTotal);
  const name = (r: Regime) => (r === "new" ? "new regime" : "old regime");
  const comparisonNote =
    saving === 0
      ? `Both regimes cost ${inr(newTotal)}; the ${name(ruleSet.defaultRegime)} is the default.`
      : `The ${name(recommendedRegime)} saves ${inr(saving)} (tax and interest ${inr(Math.min(newTotal, oldTotal))} against ${inr(Math.max(newTotal, oldTotal))}).`;

  const notes: string[] = [];
  if ((inputs.income.businessProfession ?? 0) > 0) {
    notes.push(
      "With business or professional income, choosing the old regime needs a declaration (Form 10-IEA under the 1961 Act) by the due date, and a return to the new regime can be made only once.",
    );
  }
  if (ruleSet.statute === "2025" && Object.values(ruleSet.sections).some((s) => !(s.act2025 !== null && s.verified))) {
    notes.push("Some section numbers under the Income-tax Act, 2025 are not yet confirmed; PDFs cite the 1961 section as the corresponding provision.");
  }
  if (inputs.resident === false) notes.push("Non-resident: no rebate, no senior-citizen slabs and no basic-exemption adjustment against special-rate gains.");

  return {
    financialYear: ruleSet.financialYear,
    statute: ruleSet.statute,
    yearLabel: itrYearLabel(ruleSet),
    actName: `Income-tax Act, ${ruleSet.statute}`,
    dates,
    regimes,
    comparison: { newRegime: newTotal, oldRegime: oldTotal, recommendedRegime, saving, note: comparisonNote },
    recommendedRegime,
    saving,
    notes,
  };
}
