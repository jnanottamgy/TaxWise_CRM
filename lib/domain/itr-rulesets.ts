/**
 * Income-tax rule sets for the ITR computation engine (§6.11, §5.12, §16).
 *
 * - A rule set holds every statutory number the engine uses for one financial year: the slabs of
 *   both regimes (old-regime slabs by age band), the s.87A rebate (and its marginal relief), the
 *   standard deductions, the Chapter VI-A caps, the special rates for capital gains, the surcharge
 *   bands with their 15% cap for capital gains and dividends, the cess, the interest rules of
 *   ss.234A/234B/234C and the s.288A/288B rounding. The engine (`lib/domain/itr.ts`) hard-codes none
 *   of them.
 * - Rule sets are stored as `statutory_parameters` rows with key `itr.ruleset`; the value is the
 *   whole `ItrRuleSet` JSON, `effective_from` = 1 April and `effective_to` = 31 March of its FY.
 *   `ITR_RULESET_SEED_PARAMETERS` holds the rows of `supabase/seed/41_itr_rulesets.sql`, and
 *   `parseRuleSet` validates a value read back from the database.
 * - Amounts inside a rule set are whole RUPEES (as the Law & rules page shows them); rates are
 *   percentages (`12.5` = 12.5%). The engine converts amounts to paise before any arithmetic.
 * - Section references follow §6.1: FY 2025-26 and earlier are 1961-Act years; FY 2026-27 is the
 *   first tax year under the Income-tax Act, 2025. The 2025-Act numbers in `ITR_SECTIONS` that the
 *   spec marks [verify] (s.156 rebate, ss.423/424/425 interest, s.263 return) are `verified: false`.
 *
 * Pure and client-safe.
 */

import { fyEnd, fyStart, isDateString, isFinancialYear, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { parameterInForce, type SeedParameterRow, type StatutoryParameterRow } from "@/lib/domain/gst";

// -------------------------------------------------------------------------------------------------
// Vocabulary
// -------------------------------------------------------------------------------------------------

/** The `statutory_parameters` key every ITR rule set is stored under (§5.12). */
export const ITR_RULESET_PARAM_KEY = "itr.ruleset";

/** The shape version of the rule-set JSON. Bump it (and teach `parseRuleSet`) on a breaking change. */
export const ITR_RULESET_VERSION = 1;

/** The two regimes (§6.11): the new regime (s.115BAC) is the default; the old regime is optional. */
export const REGIMES = ["new", "old"] as const;
export type Regime = (typeof REGIMES)[number];

/** Age bands for the old-regime basic exemption (§6.11, §7.8.2). */
export const AGE_BANDS = ["below_60", "60_to_79", "80_plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const AGE_BAND_LABELS: Readonly<Record<AgeBand, string>> = {
  below_60: "Below 60",
  "60_to_79": "60 to 79 (senior citizen)",
  "80_plus": "80 and above (super senior citizen)",
};

/**
 * Income taxed at a special rate (§6.11): STCG on listed equity (s.111A), LTCG on listed equity
 * (s.112A), other LTCG (s.112). The order here is the fixed tie-break order the engine uses.
 */
export const SPECIAL_RATE_KINDS = ["111A", "112", "112A"] as const;
export type SpecialRateKind = (typeof SPECIAL_RATE_KINDS)[number];

/** The statutes a rule set can belong to (§6.1). */
export const ITR_STATUTES = ["1961", "2025"] as const;
export type ItrStatute = (typeof ITR_STATUTES)[number];

// -------------------------------------------------------------------------------------------------
// Rule-set shape (amounts in rupees, rates in %)
// -------------------------------------------------------------------------------------------------

/** One slab: income up to `upTo` rupees (null = no upper limit) is taxed at `rate` %. Ascending. */
export type Slab = { upTo: number | null; rate: number };

/** s.87A rebate (§6.11). */
export type RebateRule = {
  /** The rebate applies where total income does not exceed this. */
  limit: number;
  /** The rebate is up to this amount. */
  max: number;
  /** Marginal relief just above the limit: tax (excluding special-rate tax) never exceeds income − limit. */
  marginalRelief: boolean;
  /** Special-rate taxes the rebate never reduces. */
  notAgainst: SpecialRateKind[];
};

/** Surcharge applies at `rate` % where total income exceeds `above` rupees. Ascending. */
export type SurchargeBand = { above: number; rate: number };

export type SurchargeRule = {
  bands: SurchargeBand[];
  /** Cap (%) on the surcharge on tax on special-rate capital gains and dividends (§6.11). */
  specialIncomeCap: number;
};

/** Chapter VI-A caps the old regime allows (§6.11, §7.8.2). */
export type ChapterVIACaps = {
  /** 80C + 80CCC + 80CCD(1) together (s.80CCE). */
  sec80CBasket: number;
  sec80CCD1B: number;
  sec80D: { selfFamily: number; selfFamilySenior: number; parents: number; parentsSenior: number };
  /** Savings-account interest, everyone except resident senior citizens. */
  sec80TTA: number;
  /** Deposit interest, resident senior citizens. */
  sec80TTB: number;
};

/** Everything that differs between the two regimes. */
export type RegimeRules = {
  /** Slabs for an individual below 60, a HUF and a non-resident. */
  slabs: Slab[];
  /** Higher basic exemptions for resident senior citizens (old regime); null where none. */
  seniorSlabs: { "60_to_79": Slab[]; "80_plus": Slab[] } | null;
  /** Standard deduction on salary or pension (s.16(ia)). */
  standardDeduction: number;
  rebate: RebateRule;
  surcharge: SurchargeRule;
  /** Chapter VI-A caps; null when the regime allows none of these deductions (the new regime). */
  chapterVIA: ChapterVIACaps | null;
  /** Employer NPS (80CCD(2)) cap, % of basic salary + DA. */
  employerNpsCapPercent: number;
  /** The same for a Central or State Government employer. */
  employerNpsCapPercentGovernment: number;
  /** Whether s.10 salary exemptions (HRA, LTA …) and s.16(ii)/(iii) deductions are allowed. */
  salaryExemptionsAllowed: boolean;
  /** House-property loss: set off against other heads, up to the cap (null = no cap). */
  houseProperty: { lossSetOff: boolean; lossSetOffCap: number | null };
};

export type CapitalGainsRates = Record<SpecialRateKind, number>;

/** Special rates for capital gains (§6.11). */
export type CapitalGainsRules = {
  /** Rates for transfers on or after `cutoverDate` (or for the whole year when it is null). */
  rates: CapitalGainsRates;
  /** s.112A: LTCG on listed equity is taxed only above this, per year (all transfers together). */
  ltcg112aExemption: number;
  /** The first day the `rates` apply when the year straddles a rate change (23 Jul 2024). */
  cutoverDate: DateString | null;
  /** Rates for transfers before `cutoverDate`; null when the whole year uses `rates`. */
  earlierRates: CapitalGainsRates | null;
};

/** One advance-tax instalment (§6.7) and how s.234C charges a shortfall against it. */
export type AdvanceTaxInstalment = {
  month: number;
  day: number;
  /** Cumulative % of the tax due on returned income payable by this date. */
  cumulativePercent: number;
  /** No interest when at least this % was paid by the date (12% / 36%); null = no safe harbour. */
  safeHarbourPercent: number | null;
  /** Months of interest charged on the shortfall. */
  months: number;
};

/** Interest for default in return and advance tax (§6.11). */
export type InterestRules = {
  /** % per month, or part of a month, under ss.234A/234B/234C. */
  ratePerMonth: number;
  /** No advance tax (and so no 234B/234C) when the tax due, less TDS/TCS, is below this (s.208). */
  advanceTaxThreshold: number;
  /** s.234B applies when advance tax paid is less than this % of the assessed tax. */
  shortfall234BPercent: number;
  instalments: AdvanceTaxInstalment[];
  /** The single instalment for presumptive income (44AD/44ADA). */
  presumptiveInstalment: AdvanceTaxInstalment;
  /** A resident senior citizen with no business income pays no advance tax (s.207(2)). */
  seniorWithoutBusinessExempt: boolean;
  /** The amount interest is charged on is rounded DOWN to a multiple of this (Rule 119A). */
  interestBaseRoundDownTo: number;
};

/** s.288A: total income rounded to the nearest `totalIncomeTo`; s.288B: tax to `taxTo`. */
export type RoundingRules = { totalIncomeTo: number; taxTo: number };

/** A section as numbered in each Act (§6.1, `section_concordance`). */
export type SectionRef = { act1961: string; act2025: string | null; verified: boolean };

/** The provisions a computation sheet cites. */
export const SECTION_TOPICS = [
  "newRegime",
  "standardDeduction",
  "houseLossSetOff",
  "stcg111A",
  "ltcg112A",
  "ltcg112",
  "sec80CBasket",
  "sec80CCD1B",
  "sec80CCD2",
  "sec80D",
  "sec80G",
  "sec80TTA",
  "sec80TTB",
  "rebate",
  "advanceTax",
  "seniorAdvanceTax",
  "returnOfIncome",
  "interest234A",
  "interest234B",
  "interest234C",
  "roundingIncome",
  "roundingTax",
] as const;
export type SectionTopic = (typeof SECTION_TOPICS)[number];

/** Everything the engine needs for one financial year. */
export type ItrRuleSet = {
  version: typeof ITR_RULESET_VERSION;
  financialYear: FinancialYear;
  /** The Act that governs the year (§6.1): labels say "AY …" for 1961, "Tax year …" for 2025. */
  statute: ItrStatute;
  defaultRegime: Regime;
  regimes: Record<Regime, RegimeRules>;
  capitalGains: CapitalGainsRules;
  /** Health and education cess, %. */
  cessRate: number;
  interest: InterestRules;
  rounding: RoundingRules;
  sections: Record<SectionTopic, SectionRef>;
};

// -------------------------------------------------------------------------------------------------
// Seed values (§6.11)
// -------------------------------------------------------------------------------------------------

/**
 * Section concordance used on computation sheets (§6.1). Only the 2025-Act numbers the spec gives
 * are filled in, all [verify]; the rest print the 1961 section with "(corresponding provision of
 * the Income-tax Act, 2025)" until a Partner confirms the mapping.
 */
export const ITR_SECTIONS: Readonly<Record<SectionTopic, SectionRef>> = {
  newRegime: { act1961: "115BAC", act2025: null, verified: false },
  standardDeduction: { act1961: "16(ia)", act2025: null, verified: false },
  houseLossSetOff: { act1961: "71(3A)", act2025: null, verified: false },
  stcg111A: { act1961: "111A", act2025: null, verified: false },
  ltcg112A: { act1961: "112A", act2025: null, verified: false },
  ltcg112: { act1961: "112", act2025: null, verified: false },
  sec80CBasket: { act1961: "80C/80CCC/80CCD(1)", act2025: null, verified: false },
  sec80CCD1B: { act1961: "80CCD(1B)", act2025: null, verified: false },
  sec80CCD2: { act1961: "80CCD(2)", act2025: null, verified: false },
  sec80D: { act1961: "80D", act2025: null, verified: false },
  sec80G: { act1961: "80G", act2025: null, verified: false },
  sec80TTA: { act1961: "80TTA", act2025: null, verified: false },
  sec80TTB: { act1961: "80TTB", act2025: null, verified: false },
  rebate: { act1961: "87A", act2025: "156", verified: false },
  advanceTax: { act1961: "208", act2025: null, verified: false },
  seniorAdvanceTax: { act1961: "207(2)", act2025: null, verified: false },
  returnOfIncome: { act1961: "139", act2025: "263", verified: false },
  interest234A: { act1961: "234A", act2025: "423", verified: false },
  interest234B: { act1961: "234B", act2025: "424", verified: false },
  interest234C: { act1961: "234C", act2025: "425", verified: false },
  roundingIncome: { act1961: "288A", act2025: null, verified: false },
  roundingTax: { act1961: "288B", act2025: null, verified: false },
};

const NEW_SLABS_FROM_FY2025: Slab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 5 },
  { upTo: 1200000, rate: 10 },
  { upTo: 1600000, rate: 15 },
  { upTo: 2000000, rate: 20 },
  { upTo: 2400000, rate: 25 },
  { upTo: null, rate: 30 },
];

const NEW_SLABS_FY2024: Slab[] = [
  { upTo: 300000, rate: 0 },
  { upTo: 700000, rate: 5 },
  { upTo: 1000000, rate: 10 },
  { upTo: 1200000, rate: 15 },
  { upTo: 1500000, rate: 20 },
  { upTo: null, rate: 30 },
];

const OLD_SLABS: Slab[] = [
  { upTo: 250000, rate: 0 },
  { upTo: 500000, rate: 5 },
  { upTo: 1000000, rate: 20 },
  { upTo: null, rate: 30 },
];

const OLD_SLABS_60_TO_79: Slab[] = [
  { upTo: 300000, rate: 0 },
  { upTo: 500000, rate: 5 },
  { upTo: 1000000, rate: 20 },
  { upTo: null, rate: 30 },
];

const OLD_SLABS_80_PLUS: Slab[] = [
  { upTo: 500000, rate: 0 },
  { upTo: 1000000, rate: 20 },
  { upTo: null, rate: 30 },
];

const SURCHARGE_OLD: SurchargeRule = {
  bands: [
    { above: 5000000, rate: 10 },
    { above: 10000000, rate: 15 },
    { above: 20000000, rate: 25 },
    { above: 50000000, rate: 37 },
  ],
  specialIncomeCap: 15,
};

/** The new regime stops at 25% (no 37% band above ₹5 crore). */
const SURCHARGE_NEW: SurchargeRule = {
  bands: [
    { above: 5000000, rate: 10 },
    { above: 10000000, rate: 15 },
    { above: 20000000, rate: 25 },
  ],
  specialIncomeCap: 15,
};

const ALL_SPECIAL: SpecialRateKind[] = ["111A", "112", "112A"];

const OLD_REGIME: RegimeRules = {
  slabs: OLD_SLABS,
  seniorSlabs: { "60_to_79": OLD_SLABS_60_TO_79, "80_plus": OLD_SLABS_80_PLUS },
  standardDeduction: 50000,
  // s.87A: up to ₹12,500 where total income ≤ ₹5 lakh; s.112A(6) keeps it off tax on 112A LTCG.
  rebate: { limit: 500000, max: 12500, marginalRelief: false, notAgainst: ["112A"] },
  surcharge: SURCHARGE_OLD,
  chapterVIA: {
    sec80CBasket: 150000,
    sec80CCD1B: 50000,
    sec80D: { selfFamily: 25000, selfFamilySenior: 50000, parents: 25000, parentsSenior: 50000 },
    sec80TTA: 10000,
    sec80TTB: 50000,
  },
  employerNpsCapPercent: 10,
  employerNpsCapPercentGovernment: 14,
  salaryExemptionsAllowed: true,
  houseProperty: { lossSetOff: true, lossSetOffCap: 200000 },
};

function newRegime(slabs: Slab[], rebate: RebateRule): RegimeRules {
  return {
    slabs,
    seniorSlabs: null,
    standardDeduction: 75000,
    rebate,
    surcharge: SURCHARGE_NEW,
    chapterVIA: null,
    employerNpsCapPercent: 14,
    employerNpsCapPercentGovernment: 14,
    salaryExemptionsAllowed: false,
    houseProperty: { lossSetOff: false, lossSetOffCap: null },
  };
}

const CAPITAL_GAINS_RATES: CapitalGainsRates = { "111A": 20, "112": 12.5, "112A": 12.5 };

const INTEREST: InterestRules = {
  ratePerMonth: 1,
  advanceTaxThreshold: 10000,
  shortfall234BPercent: 90,
  instalments: [
    { month: 6, day: 15, cumulativePercent: 15, safeHarbourPercent: 12, months: 3 },
    { month: 9, day: 15, cumulativePercent: 45, safeHarbourPercent: 36, months: 3 },
    { month: 12, day: 15, cumulativePercent: 75, safeHarbourPercent: null, months: 3 },
    { month: 3, day: 15, cumulativePercent: 100, safeHarbourPercent: null, months: 1 },
  ],
  presumptiveInstalment: { month: 3, day: 15, cumulativePercent: 100, safeHarbourPercent: null, months: 1 },
  seniorWithoutBusinessExempt: true,
  interestBaseRoundDownTo: 100,
};

const ROUNDING: RoundingRules = { totalIncomeTo: 10, taxTo: 10 };

function sectionsCopy(): Record<SectionTopic, SectionRef> {
  const out = {} as Record<SectionTopic, SectionRef>;
  for (const topic of SECTION_TOPICS) out[topic] = { ...ITR_SECTIONS[topic] };
  return out;
}

/**
 * FY 2024-25 (AY 2025-26, 1961 Act), for belated and revised work (§6.11): new-regime slabs
 * 0–3 L nil · 3–7 L 5% · 7–10 L 10% · 10–12 L 15% · 12–15 L 20% · above 15 L 30%; rebate up to
 * ₹25,000 where income ≤ ₹7 lakh, with marginal relief; standard deduction ₹75,000. Capital gains
 * changed on 23 July 2024: earlier transfers use 15% (111A), 10% above the exemption (112A) and 20%
 * (112); the ₹1.25 lakh 112A exemption covers the whole year.
 */
export const ITR_RULESET_FY2024_25: ItrRuleSet = {
  version: ITR_RULESET_VERSION,
  financialYear: "2024-25",
  statute: "1961",
  defaultRegime: "new",
  regimes: {
    new: newRegime(NEW_SLABS_FY2024, { limit: 700000, max: 25000, marginalRelief: true, notAgainst: ALL_SPECIAL }),
    old: OLD_REGIME,
  },
  capitalGains: {
    rates: CAPITAL_GAINS_RATES,
    ltcg112aExemption: 125000,
    cutoverDate: "2024-07-23",
    earlierRates: { "111A": 15, "112": 20, "112A": 10 },
  },
  cessRate: 4,
  interest: INTEREST,
  rounding: ROUNDING,
  sections: sectionsCopy(),
};

/**
 * FY 2025-26 (AY 2026-27, 1961 Act) (§6.11): new-regime slabs 0–4 L nil · 4–8 L 5% · 8–12 L 10% ·
 * 12–16 L 15% · 16–20 L 20% · 20–24 L 25% · above 24 L 30%; rebate up to ₹60,000 where total income
 * ≤ ₹12 lakh, with marginal relief, never on special-rate income.
 */
export const ITR_RULESET_FY2025_26: ItrRuleSet = {
  version: ITR_RULESET_VERSION,
  financialYear: "2025-26",
  statute: "1961",
  defaultRegime: "new",
  regimes: {
    new: newRegime(NEW_SLABS_FROM_FY2025, { limit: 1200000, max: 60000, marginalRelief: true, notAgainst: ALL_SPECIAL }),
    old: OLD_REGIME,
  },
  capitalGains: { rates: CAPITAL_GAINS_RATES, ltcg112aExemption: 125000, cutoverDate: null, earlierRates: null },
  cessRate: 4,
  interest: INTEREST,
  rounding: ROUNDING,
  sections: sectionsCopy(),
};

/**
 * Tax year 2026-27 (Income-tax Act, 2025) (§6.1, §6.11): the 2026 Budget left the slabs unchanged,
 * so the numbers equal FY 2025-26; only the statute (and so the labels) differ.
 */
export const ITR_RULESET_FY2026_27: ItrRuleSet = {
  ...ITR_RULESET_FY2025_26,
  financialYear: "2026-27",
  statute: "2025",
  sections: sectionsCopy(),
};

/** The seeded rule sets by FY (the engine's DEFAULTS; tests and the seed SQL use these). */
export const ITR_RULESETS: Readonly<Record<string, ItrRuleSet>> = {
  "2024-25": ITR_RULESET_FY2024_25,
  "2025-26": ITR_RULESET_FY2025_26,
  "2026-27": ITR_RULESET_FY2026_27,
};

/** The seeded rule set for an FY, or null when none is seeded. Production reads the database. */
export function seededRuleSetFor(fy: FinancialYear): ItrRuleSet | null {
  return ITR_RULESETS[fy] ?? null;
}

// -------------------------------------------------------------------------------------------------
// Seed rows (§16): supabase/seed/41_itr_rulesets.sql
// -------------------------------------------------------------------------------------------------

const ACT_1961 = "Income-tax Act, 1961";
const ACT_2025 = "Income-tax Act, 2025";

function seedRow(ruleSet: ItrRuleSet, meta: { sectionRef: string; sourceRef: string; notes: string; verified: boolean }): SeedParameterRow {
  return {
    key: ITR_RULESET_PARAM_KEY,
    value: ruleSet,
    effectiveFrom: fyStart(ruleSet.financialYear),
    effectiveTo: fyEnd(ruleSet.financialYear),
    statute: ruleSet.statute === "2025" ? ACT_2025 : ACT_1961,
    sectionRef: meta.sectionRef,
    sourceRef: meta.sourceRef,
    notes: meta.notes,
    verified: meta.verified,
  };
}

/**
 * The rows of `supabase/seed/41_itr_rulesets.sql` (§16). FY 2024-25 and FY 2025-26 are settled law;
 * the tax year 2026-27 row cites the 2025 Act's [verify] section numbers, so it is unverified.
 */
export const ITR_RULESET_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  seedRow(ITR_RULESET_FY2024_25, {
    sectionRef: "ss.115BAC, 87A, 111A, 112, 112A, 234A-234C, 288A, 288B; Chapter VI-A",
    sourceRef: "Finance (No. 2) Act, 2024 (slabs, standard deduction ₹75,000, capital-gains rates from 23 Jul 2024)",
    notes:
      "Rule set for FY 2024-25 (AY 2025-26), for belated and revised returns (§6.11). New regime rebate kept off special-rate income, as the e-filing utility applies it; the Bombay High Court (Jan 2025) allowed the claim against s.111A STCG to be made for AY 2024-25, so review any such case.",
    verified: true,
  }),
  seedRow(ITR_RULESET_FY2025_26, {
    sectionRef: "ss.115BAC, 87A, 111A, 112, 112A, 234A-234C, 288A, 288B; Chapter VI-A",
    sourceRef: "Finance Act, 2025 (new-regime slabs, ₹60,000 rebate up to ₹12 lakh with marginal relief)",
    notes: "Rule set for FY 2025-26 (AY 2026-27), the last year under the 1961 Act (§6.1, §6.11).",
    verified: true,
  }),
  seedRow(ITR_RULESET_FY2026_27, {
    sectionRef: "Income-tax Act, 2025: s.156 (rebate) and ss.423-425 (interest) [verify]; other sections cited by their 1961 numbers",
    sourceRef: "Finance Act, 2026 (2026 Budget left the slabs unchanged); Income-tax Act, 2025 in force from 1 Apr 2026",
    notes:
      "Rule set for tax year 2026-27, the first under the Income-tax Act, 2025 (§6.1, §6.11). Same numbers as FY 2025-26. [verify] the section mapping (87A to s.156, 234A/B/C to ss.423/424/425, 139 to s.263) against the CBDT concordance.",
    verified: false,
  }),
];

// -------------------------------------------------------------------------------------------------
// Loading and validation
// -------------------------------------------------------------------------------------------------

export type ParseRuleSetResult = { ok: true; ruleSet: ItrRuleSet } | { ok: false; errors: string[] };

type Ctx = { errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function record(v: unknown, path: string, ctx: Ctx): Record<string, unknown> {
  if (isRecord(v)) return v;
  ctx.errors.push(`${path}: expected an object.`);
  return {};
}

type NumberOpts = { min?: number; max?: number; integer?: boolean };

function numberAt(o: Record<string, unknown>, key: string, path: string, ctx: Ctx, opts: NumberOpts = {}): number {
  const v = o[key];
  const where = `${path}.${key}`;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    ctx.errors.push(`${where}: expected a number.`);
    return 0;
  }
  if (opts.integer && !Number.isSafeInteger(v)) ctx.errors.push(`${where}: expected a whole number.`);
  if (opts.min !== undefined && v < opts.min) ctx.errors.push(`${where}: must be at least ${opts.min}.`);
  if (opts.max !== undefined && v > opts.max) ctx.errors.push(`${where}: must be at most ${opts.max}.`);
  return v;
}

/** A whole number of rupees, zero or more (amounts are rupees in the JSON). */
function rupeesAt(o: Record<string, unknown>, key: string, path: string, ctx: Ctx): number {
  return numberAt(o, key, path, ctx, { min: 0, integer: true });
}

/** A percentage between 0 and 100 (decimals allowed, e.g. 12.5). */
function rateAt(o: Record<string, unknown>, key: string, path: string, ctx: Ctx): number {
  return numberAt(o, key, path, ctx, { min: 0, max: 100 });
}

function booleanAt(o: Record<string, unknown>, key: string, path: string, ctx: Ctx): boolean {
  const v = o[key];
  if (typeof v !== "boolean") {
    ctx.errors.push(`${path}.${key}: expected true or false.`);
    return false;
  }
  return v;
}

function arrayAt(o: Record<string, unknown>, key: string, path: string, ctx: Ctx): unknown[] {
  const v = o[key];
  if (Array.isArray(v)) return v;
  ctx.errors.push(`${path}.${key}: expected a list.`);
  return [];
}

function parseSlabs(v: unknown, path: string, ctx: Ctx): Slab[] {
  if (!Array.isArray(v) || v.length === 0) {
    ctx.errors.push(`${path}: expected a non-empty list of slabs.`);
    return [];
  }
  const slabs: Slab[] = v.map((item, i) => {
    const o = record(item, `${path}[${i}]`, ctx);
    const upTo = o.upTo === null ? null : rupeesAt(o, "upTo", `${path}[${i}]`, ctx);
    return { upTo, rate: rateAt(o, "rate", `${path}[${i}]`, ctx) };
  });
  slabs.forEach((s, i) => {
    const last = i === slabs.length - 1;
    if (last && s.upTo !== null) ctx.errors.push(`${path}: the last slab must have no upper limit (upTo null).`);
    if (!last && s.upTo === null) ctx.errors.push(`${path}[${i}]: only the last slab may have no upper limit.`);
    const prev = slabs[i - 1];
    if (i > 0 && s.upTo !== null && prev.upTo !== null && s.upTo <= prev.upTo) {
      ctx.errors.push(`${path}[${i}]: slab limits must increase.`);
    }
  });
  return slabs;
}

function parseKindList(v: unknown, path: string, ctx: Ctx): SpecialRateKind[] {
  if (!Array.isArray(v)) {
    ctx.errors.push(`${path}: expected a list of special-rate sections.`);
    return [];
  }
  const out: SpecialRateKind[] = [];
  for (const k of v) {
    if (typeof k === "string" && (SPECIAL_RATE_KINDS as readonly string[]).includes(k)) out.push(k as SpecialRateKind);
    else ctx.errors.push(`${path}: unknown special-rate section ${JSON.stringify(k)}.`);
  }
  return out;
}

function parseSurcharge(v: unknown, path: string, ctx: Ctx): SurchargeRule {
  const o = record(v, path, ctx);
  const bands = arrayAt(o, "bands", path, ctx).map((item, i) => {
    const b = record(item, `${path}.bands[${i}]`, ctx);
    return { above: rupeesAt(b, "above", `${path}.bands[${i}]`, ctx), rate: rateAt(b, "rate", `${path}.bands[${i}]`, ctx) };
  });
  bands.forEach((b, i) => {
    if (i > 0 && b.above <= bands[i - 1].above) ctx.errors.push(`${path}.bands[${i}]: thresholds must increase.`);
  });
  return { bands, specialIncomeCap: rateAt(o, "specialIncomeCap", path, ctx) };
}

function parseChapterVIA(v: unknown, path: string, ctx: Ctx): ChapterVIACaps | null {
  if (v === null) return null;
  const o = record(v, path, ctx);
  const d = record(o.sec80D, `${path}.sec80D`, ctx);
  return {
    sec80CBasket: rupeesAt(o, "sec80CBasket", path, ctx),
    sec80CCD1B: rupeesAt(o, "sec80CCD1B", path, ctx),
    sec80D: {
      selfFamily: rupeesAt(d, "selfFamily", `${path}.sec80D`, ctx),
      selfFamilySenior: rupeesAt(d, "selfFamilySenior", `${path}.sec80D`, ctx),
      parents: rupeesAt(d, "parents", `${path}.sec80D`, ctx),
      parentsSenior: rupeesAt(d, "parentsSenior", `${path}.sec80D`, ctx),
    },
    sec80TTA: rupeesAt(o, "sec80TTA", path, ctx),
    sec80TTB: rupeesAt(o, "sec80TTB", path, ctx),
  };
}

function parseRegime(v: unknown, path: string, ctx: Ctx): RegimeRules {
  const o = record(v, path, ctx);
  let seniorSlabs: RegimeRules["seniorSlabs"] = null;
  if (o.seniorSlabs !== null) {
    const s = record(o.seniorSlabs, `${path}.seniorSlabs`, ctx);
    seniorSlabs = {
      "60_to_79": parseSlabs(s["60_to_79"], `${path}.seniorSlabs.60_to_79`, ctx),
      "80_plus": parseSlabs(s["80_plus"], `${path}.seniorSlabs.80_plus`, ctx),
    };
  }
  const r = record(o.rebate, `${path}.rebate`, ctx);
  const hp = record(o.houseProperty, `${path}.houseProperty`, ctx);
  return {
    slabs: parseSlabs(o.slabs, `${path}.slabs`, ctx),
    seniorSlabs,
    standardDeduction: rupeesAt(o, "standardDeduction", path, ctx),
    rebate: {
      limit: rupeesAt(r, "limit", `${path}.rebate`, ctx),
      max: rupeesAt(r, "max", `${path}.rebate`, ctx),
      marginalRelief: booleanAt(r, "marginalRelief", `${path}.rebate`, ctx),
      notAgainst: parseKindList(r.notAgainst, `${path}.rebate.notAgainst`, ctx),
    },
    surcharge: parseSurcharge(o.surcharge, `${path}.surcharge`, ctx),
    chapterVIA: parseChapterVIA(o.chapterVIA, `${path}.chapterVIA`, ctx),
    employerNpsCapPercent: rateAt(o, "employerNpsCapPercent", path, ctx),
    employerNpsCapPercentGovernment: rateAt(o, "employerNpsCapPercentGovernment", path, ctx),
    salaryExemptionsAllowed: booleanAt(o, "salaryExemptionsAllowed", path, ctx),
    houseProperty: {
      lossSetOff: booleanAt(hp, "lossSetOff", `${path}.houseProperty`, ctx),
      lossSetOffCap: hp.lossSetOffCap === null ? null : rupeesAt(hp, "lossSetOffCap", `${path}.houseProperty`, ctx),
    },
  };
}

function parseRates(v: unknown, path: string, ctx: Ctx): CapitalGainsRates {
  const o = record(v, path, ctx);
  return { "111A": rateAt(o, "111A", path, ctx), "112": rateAt(o, "112", path, ctx), "112A": rateAt(o, "112A", path, ctx) };
}

function parseInstalment(v: unknown, path: string, ctx: Ctx): AdvanceTaxInstalment {
  const o = record(v, path, ctx);
  const month = numberAt(o, "month", path, ctx, { min: 1, max: 12, integer: true });
  const day = numberAt(o, "day", path, ctx, { min: 1, max: 31, integer: true });
  return {
    month,
    day,
    cumulativePercent: rateAt(o, "cumulativePercent", path, ctx),
    safeHarbourPercent: o.safeHarbourPercent === null ? null : rateAt(o, "safeHarbourPercent", path, ctx),
    months: numberAt(o, "months", path, ctx, { min: 0, integer: true }),
  };
}

function parseInterest(v: unknown, path: string, ctx: Ctx): InterestRules {
  const o = record(v, path, ctx);
  const instalments = arrayAt(o, "instalments", path, ctx).map((x, i) => parseInstalment(x, `${path}.instalments[${i}]`, ctx));
  if (instalments.length === 0) ctx.errors.push(`${path}.instalments: expected at least one instalment.`);
  instalments.forEach((x, i) => {
    if (i > 0 && x.cumulativePercent < instalments[i - 1].cumulativePercent) {
      ctx.errors.push(`${path}.instalments[${i}]: cumulative percentages must not fall.`);
    }
  });
  if (instalments.length > 0 && instalments[instalments.length - 1].cumulativePercent !== 100) {
    ctx.errors.push(`${path}.instalments: the last instalment must reach 100%.`);
  }
  return {
    ratePerMonth: rateAt(o, "ratePerMonth", path, ctx),
    advanceTaxThreshold: rupeesAt(o, "advanceTaxThreshold", path, ctx),
    shortfall234BPercent: rateAt(o, "shortfall234BPercent", path, ctx),
    instalments,
    presumptiveInstalment: parseInstalment(o.presumptiveInstalment, `${path}.presumptiveInstalment`, ctx),
    seniorWithoutBusinessExempt: booleanAt(o, "seniorWithoutBusinessExempt", path, ctx),
    interestBaseRoundDownTo: numberAt(o, "interestBaseRoundDownTo", path, ctx, { min: 1, integer: true }),
  };
}

function parseSections(v: unknown, path: string, ctx: Ctx): Record<SectionTopic, SectionRef> {
  const o = record(v, path, ctx);
  const out = {} as Record<SectionTopic, SectionRef>;
  for (const topic of SECTION_TOPICS) {
    const s = record(o[topic], `${path}.${topic}`, ctx);
    const act1961 = s.act1961;
    const act2025 = s.act2025;
    if (typeof act1961 !== "string" || act1961.trim() === "") ctx.errors.push(`${path}.${topic}.act1961: expected a section number.`);
    if (act2025 !== null && (typeof act2025 !== "string" || act2025.trim() === "")) {
      ctx.errors.push(`${path}.${topic}.act2025: expected a section number or null.`);
    }
    out[topic] = {
      act1961: typeof act1961 === "string" ? act1961 : "",
      act2025: typeof act2025 === "string" ? act2025 : null,
      verified: booleanAt(s, "verified", `${path}.${topic}`, ctx),
    };
  }
  return out;
}

/**
 * Validates a rule set read from `statutory_parameters.value` (key `itr.ruleset`) and returns a
 * typed copy holding only the known fields (§5.12). Every problem is listed with its JSON path, so
 * the Law & rules page can show what a Partner needs to fix.
 */
export function parseRuleSet(json: unknown): ParseRuleSetResult {
  const ctx: Ctx = { errors: [] };
  const o = record(json, "ruleSet", ctx);
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  if (o.version !== ITR_RULESET_VERSION) ctx.errors.push(`ruleSet.version: expected ${ITR_RULESET_VERSION}.`);
  const financialYear = o.financialYear;
  if (!isFinancialYear(financialYear)) ctx.errors.push("ruleSet.financialYear: expected a financial year such as 2026-27.");
  const statute = o.statute;
  if (!(ITR_STATUTES as readonly unknown[]).includes(statute)) ctx.errors.push('ruleSet.statute: expected "1961" or "2025".');
  const defaultRegime = o.defaultRegime;
  if (!(REGIMES as readonly unknown[]).includes(defaultRegime)) ctx.errors.push('ruleSet.defaultRegime: expected "new" or "old".');

  const regimes = record(o.regimes, "ruleSet.regimes", ctx);
  const parsedRegimes: Record<Regime, RegimeRules> = {
    new: parseRegime(regimes.new, "ruleSet.regimes.new", ctx),
    old: parseRegime(regimes.old, "ruleSet.regimes.old", ctx),
  };

  const cg = record(o.capitalGains, "ruleSet.capitalGains", ctx);
  const cutoverDate = cg.cutoverDate;
  if (cutoverDate !== null && !isDateString(cutoverDate)) ctx.errors.push("ruleSet.capitalGains.cutoverDate: expected YYYY-MM-DD or null.");
  const earlierRates = cg.earlierRates === null ? null : parseRates(cg.earlierRates, "ruleSet.capitalGains.earlierRates", ctx);
  if ((cutoverDate === null) !== (earlierRates === null)) {
    ctx.errors.push("ruleSet.capitalGains: cutoverDate and earlierRates must both be set or both be null.");
  }
  if (isDateString(cutoverDate) && isFinancialYear(financialYear)) {
    if (cutoverDate <= fyStart(financialYear) || cutoverDate > fyEnd(financialYear)) {
      ctx.errors.push("ruleSet.capitalGains.cutoverDate: must fall inside the financial year (after 1 April).");
    }
  }
  const capitalGains: CapitalGainsRules = {
    rates: parseRates(cg.rates, "ruleSet.capitalGains.rates", ctx),
    ltcg112aExemption: rupeesAt(cg, "ltcg112aExemption", "ruleSet.capitalGains", ctx),
    cutoverDate: isDateString(cutoverDate) ? cutoverDate : null,
    earlierRates,
  };

  const roundingObj = record(o.rounding, "ruleSet.rounding", ctx);
  const rounding: RoundingRules = {
    totalIncomeTo: numberAt(roundingObj, "totalIncomeTo", "ruleSet.rounding", ctx, { min: 1, integer: true }),
    taxTo: numberAt(roundingObj, "taxTo", "ruleSet.rounding", ctx, { min: 1, integer: true }),
  };

  const ruleSet: ItrRuleSet = {
    version: ITR_RULESET_VERSION,
    financialYear: typeof financialYear === "string" ? financialYear : "",
    statute: statute === "2025" ? "2025" : "1961",
    defaultRegime: defaultRegime === "old" ? "old" : "new",
    regimes: parsedRegimes,
    capitalGains,
    cessRate: rateAt(o, "cessRate", "ruleSet", ctx),
    interest: parseInterest(o.interest, "ruleSet.interest", ctx),
    rounding,
    sections: parseSections(o.sections, "ruleSet.sections", ctx),
  };
  return ctx.errors.length > 0 ? { ok: false, errors: ctx.errors } : { ok: true, ruleSet };
}

export type ResolvedRuleSet =
  | { ok: true; ruleSet: ItrRuleSet; verified: boolean; sourceRef: string | null }
  | { ok: false; error: string };

/**
 * The rule set for an FY from `statutory_parameters` rows (§5.12): the `itr.ruleset` row in force
 * on 1 April of that FY, validated with `parseRuleSet`. `verified` tells the sheet to show
 * "awaiting partner confirmation" when the row is unverified.
 */
export function resolveItrRuleSet(rows: readonly StatutoryParameterRow[], fy: FinancialYear): ResolvedRuleSet {
  if (!isFinancialYear(fy)) return { ok: false, error: `Not a financial year: ${fy}.` };
  const row = parameterInForce(rows, ITR_RULESET_PARAM_KEY, fyStart(fy));
  if (!row) return { ok: false, error: `No income-tax rule set is recorded for FY ${fy}. Add it under Settings → Law & rules.` };
  const parsed = parseRuleSet(row.value);
  if (!parsed.ok) return { ok: false, error: `The income-tax rule set for FY ${fy} is invalid: ${parsed.errors.join(" ")}` };
  if (parsed.ruleSet.financialYear !== fy) {
    return { ok: false, error: `The rule set in force on ${fyStart(fy)} is for FY ${parsed.ruleSet.financialYear}, not FY ${fy}.` };
  }
  return { ok: true, ruleSet: parsed.ruleSet, verified: row.verified ?? false, sourceRef: row.sourceRef ?? null };
}
