/**
 * The statutory calendar engine (§6.7, §7.7, §5.6, §5.12, §6.3).
 *
 * It turns a client's profile, the `due_date_rules` rows and the `due_date_overrides` rows into
 * compliance events, idempotent by `dedupe_key` (`client_id|form_code|filing_period`, §5.6):
 * - monthly and quarterly cadences cover the next 13 months, annual ones the current and the next
 *   financial year (§6.7); a monthly job tops the window up (§8);
 * - government extensions are data (`due_date_overrides`): they move only unfiled events and the
 *   event records the move with the circular reference (§5.12, §7.7);
 * - AGM-linked ROC dates are provisional (from the 30 September deadline) until the AGM date is
 *   entered (§6.7); DIR-3 KYC Web is tracked per DIN, once every three financial years;
 * - due dates are never moved off a Sunday: the event carries a `fallsOnSunday` hint (§6.3);
 * - GST returns carry their three-year filing bar, flagged within six months (§6.7); ROC events
 *   carry the per-day late fee (§6.7);
 * - ops templates (`recurring_compliance_templates`) add internal prep steps (§7.7), and
 *   `coverageGaps` lists active services with nothing planned ahead (§7.7).
 *
 * No due day, rate or threshold lives in the logic: the rules are data (`DUE_DATE_RULE_SEED` holds
 * the §6.7 seed and `scripts/gen-due-date-seed.ts` writes it to `supabase/seed/30_due_date_rules.sql`),
 * and the numbers the engine needs besides the rules are in `CalendarParams` (`CALENDAR_DEFAULTS`).
 *
 * Pure and client-safe. "Today" is always a parameter.
 */

import {
  ENTITY_TYPES,
  isEnumValue,
  SERVICE_TYPE_LABELS,
  SERVICE_TYPES,
  type ComplianceSource,
  type ComplianceStatus,
  type ComplianceType,
  type ComplianceWorkflow,
  type EntityType,
  type GstScheme,
  type ServiceFrequency,
  type ServiceType,
} from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  compareDates,
  daysInMonth,
  diffDays,
  endOfMonth,
  financialYearFromStartYear,
  financialYearOf,
  FY_DEFAULTS,
  fyEnd,
  fyStart,
  incomeTaxStatute,
  isDateString,
  isFinancialYear,
  isSunday,
  MONTH_ABBR,
  monthPeriodLabel,
  nextFinancialYear,
  parseDateString,
  parseFinancialYear,
  quarterRange,
  taxYearLabel,
  toDateString,
  type DateString,
  type FinancialYear,
  type FyQuarter,
  type StatuteParams,
} from "@/lib/domain/fy";
import { parameterInForce, readParameterNumber, type SeedParameterRow, type StatutoryParameterRow } from "@/lib/domain/gst";
import { toPaise, type Paise } from "@/lib/domain/money";
import { gstSchemeDecision, normaliseStateCode, resolveStateDay, SCALE_DEFAULTS, type ScaleParams, type StateDay, type StateDayParams } from "@/lib/domain/scale";

// =================================================================================================
// Rule JSON (`due_date_rules.rule`, §5.12)
// =================================================================================================

/** Keys any rule may carry besides its date shape. */
export type RuleExtras = {
  /** Form code for periods governed by the Income-tax Act, 2025 (§6.1), e.g. `Form 26`, `Form 130`. */
  formCode2025?: string;
  /** `taxYear`: annual periods are labelled `AY 2026-27` (1961 Act) / `Tax year 2026-27` (2025 Act). Default `FY 2026-27`. */
  periodLabel?: "taxYear";
  /** GST: the return can't be filed after the filing bar (`CalendarParams.filingBar`, §6.7). */
  filingBar?: boolean;
  /** ROC: a late fee accrues per day per form while overdue (`CalendarParams.rocLateFeePerDayPaise`, §6.7). */
  lateFee?: boolean;
  /** Advance tax: the cumulative share (%) of the year's estimated tax due by this instalment (§6.7). */
  cumulativePercent?: number;
  /** A sentence copied onto every event the rule generates. */
  note?: string;
};

/**
 * Day `day` of the month `monthOffset` months after a monthly period (`{ "monthOffset": 1, "day": 20 }`
 * → GSTR-3B for Sep 2026 is due 20 Oct 2026). Options: only months 1–2 of each FY quarter
 * (`monthsOfQuarter`, IFF / PMT-06); exceptions by period month (`exceptions`, TDS deposit: March →
 * 30 April); a state-dependent day (`stateDays`, §6.6). Days past a month's end clamp to its last day.
 */
export type MonthOffsetRule = RuleExtras & {
  monthOffset: number;
  day: number;
  monthsOfQuarter?: number[];
  exceptions?: MonthException[];
  stateDays?: StateDay[];
};
export type MonthException = { periodMonth: number; monthOffset: number; day: number };

/**
 * Day `day` of the month `monthOffset` months after a quarter's last month
 * (`{ "afterQuarterEnd": true, "monthOffset": 1, "day": 13 }` → GSTR-1 QRMP for Q2 is due 13 Oct).
 * Optional `quarters` (only those FY quarters, e.g. TDS statement Q4) and `stateDays` (QRMP GSTR-3B).
 */
export type QuarterEndRule = RuleExtras & {
  afterQuarterEnd: true;
  monthOffset: number;
  day: number;
  quarters?: FyQuarter[];
  stateDays?: StateDay[];
};

/** Part of a financial year an annual rule's period covers (default: the whole FY). */
export type SubPeriod = "Q1" | "Q2" | "Q3" | "Q4" | "H1" | "H2";

/**
 * A fixed `MM-DD` in the calendar year `FY start year + yearOffset`
 * (`{ "fixed": "07-31", "yearOffset": 1 }` → FY 2025-26 is due 31 Jul 2026). `period` narrows the
 * period to a quarter or half of the FY (advance tax instalments, MSME-1).
 */
export type FixedDateRule = RuleExtras & { fixed: string; yearOffset: number; period?: SubPeriod };

/**
 * `days` after the client's date for another event in the same FY (`{ "afterEvent": "AGM", "days": 30 }`).
 * `afterEvent` is the code of the rule whose event anchors this one. The client's actual date wins
 * (`agmDates`); until it's entered, the anchor rule's own due date is used and the event is provisional.
 */
export type AfterEventRule = RuleExtras & { afterEvent: string; days: number };

/** `daysAfterPeriodEnd` days after the period's last day (OPC AOC-4: 180 days after the FY end). */
export type AfterPeriodEndRule = RuleExtras & { daysAfterPeriodEnd: number };

/**
 * `days` after the due date that one of the listed rules gives the same period
 * (Form 16A: 15 days after the TDS statement due date).
 */
export type AfterRuleDueRule = RuleExtras & { afterRuleDue: string[]; days: number };

/**
 * Once every `everyNYears` financial years, by a fixed `MM-DD` (`{ "everyNYears": 3, "fixed": "06-30", "per": "DIN" }`):
 * DIR-3 KYC Web, tracked per DIN from the last FY it was filed (§6.7).
 */
export type EveryNYearsRule = RuleExtras & { everyNYears: number; fixed: string; yearOffset?: number; per: "DIN" };

export type DueRuleSpec =
  | MonthOffsetRule
  | QuarterEndRule
  | FixedDateRule
  | AfterEventRule
  | AfterPeriodEndRule
  | AfterRuleDueRule
  | EveryNYearsRule;

export type RuleKind = "monthOffset" | "quarterEnd" | "fixed" | "afterEvent" | "afterPeriodEnd" | "afterRuleDue" | "everyNYears";

type Classified =
  | { kind: "monthOffset"; spec: MonthOffsetRule }
  | { kind: "quarterEnd"; spec: QuarterEndRule }
  | { kind: "fixed"; spec: FixedDateRule }
  | { kind: "afterEvent"; spec: AfterEventRule }
  | { kind: "afterPeriodEnd"; spec: AfterPeriodEndRule }
  | { kind: "afterRuleDue"; spec: AfterRuleDueRule }
  | { kind: "everyNYears"; spec: EveryNYearsRule };

function classify(spec: DueRuleSpec): Classified {
  if ("everyNYears" in spec) return { kind: "everyNYears", spec };
  if ("afterQuarterEnd" in spec) return { kind: "quarterEnd", spec };
  if ("afterRuleDue" in spec) return { kind: "afterRuleDue", spec };
  if ("afterEvent" in spec) return { kind: "afterEvent", spec };
  if ("daysAfterPeriodEnd" in spec) return { kind: "afterPeriodEnd", spec };
  if ("fixed" in spec) return { kind: "fixed", spec };
  return { kind: "monthOffset", spec };
}

/** The date shape of a rule. */
export function ruleKind(spec: DueRuleSpec): RuleKind {
  return classify(spec).kind;
}

// =================================================================================================
// applies_to (`due_date_rules.applies_to`, §5.12)
// =================================================================================================

/** GST schemes the calendar distinguishes: the §5.1 enum plus composition. */
export type CalendarGstScheme = GstScheme | "composition";
export const CALENDAR_GST_SCHEMES = ["monthly", "qrmp", "composition"] as const;

/**
 * Who a rule applies to. Every key present must match; absent keys don't restrict.
 * - `serviceTypes`: the client has at least one of these active services.
 * - `entityTypes` / `excludeEntityTypes`: the client's entity type is (not) listed.
 * - `gstScheme`: the client's effective scheme (§6.6) is this one / one of these.
 * - `auditCase`: the ITR is an audit case (tax audit indicated, or accounts audited under another
 *   law, e.g. a company). `taxAudit`: a s.44AB / s.63 report is due. `tpCase`: a s.92E report is due.
 * - `presumptive`, `opc`: the client is / isn't presumptive (s.44AD/44ADA) / a One Person Company.
 * - `minTurnover` (₹, applies **above** it) and `maxTurnover` (₹, applies **up to and including** it).
 *   With no turnover recorded the band matches, because over-filing is safer than a missed return.
 * - `states`: the client's state code is listed (`state` is accepted as a one-state alias).
 * - `optIn`: generated only for clients whose `optIns` include this flag (optional filings such as
 *   IFF, GST TDS/TCS returns, belated / revised / updated returns).
 */
export type AppliesTo = {
  serviceTypes?: ServiceType[];
  entityTypes?: EntityType[];
  excludeEntityTypes?: EntityType[];
  gstScheme?: CalendarGstScheme | CalendarGstScheme[];
  auditCase?: boolean;
  taxAudit?: boolean;
  tpCase?: boolean;
  presumptive?: boolean;
  opc?: boolean;
  minTurnover?: number;
  maxTurnover?: number;
  states?: string[];
  optIn?: string;
};

// =================================================================================================
// Rows, parsing and validation
// =================================================================================================

/** A parsed `due_date_rules` row (§5.12), camel-cased. */
export type DueDateRule = {
  code: string;
  title: string;
  complianceType: ComplianceType;
  formCode: string | null;
  appliesTo: AppliesTo;
  frequency: ServiceFrequency;
  rule: DueRuleSpec;
  reminderDays: number;
  effectiveFrom: DateString;
  effectiveTo: DateString | null;
  sourceRef: string | null;
  verified: boolean;
  isActive: boolean;
};

/** A `due_date_rules` row as the database returns it. */
export type DueDateRuleRow = {
  code: string;
  title: string;
  compliance_type: string;
  form_code: string | null;
  applies_to: unknown;
  frequency: string;
  rule: unknown;
  reminder_days: number;
  effective_from: string;
  effective_to: string | null;
  source_ref: string | null;
  verified?: boolean | null;
  is_active?: boolean | null;
};

/** A `due_date_overrides` row (§5.12): a government extension for one rule and one period. */
export type DueDateOverride = {
  id?: string | null;
  ruleCode: string;
  /** The event's `filing_period`, e.g. `AY 2026-27`, `Sep 2026`, `Q2 2026-27`. */
  periodLabel: string;
  originalDue: DateString;
  extendedDue: DateString;
  scope?: string | null;
  /** e.g. `CBDT Circular 07/2026 dated 28 Sep 2026`. */
  sourceRef: string;
};

export type DueDateOverrideRow = {
  id?: string | null;
  rule_code: string;
  period_label: string;
  original_due: string;
  extended_due: string;
  scope?: string | null;
  source_ref: string;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function okResult<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}
function errResult<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/** True for `MM-DD` naming a real day in a leap year (`02-29` is allowed and clamps in other years). */
export function isMonthDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = MONTH_DAY.exec(value);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2028, month);
}

function intList(value: unknown, min: number, max: number): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => isInt(v, min, max))) return null;
  const list = value as number[];
  return new Set(list).size === list.length ? [...list] : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isNonEmptyString) ? [...(value as string[])] : null;
}

function stateCodeList(value: unknown): string[] | null {
  const list = stringList(value);
  return list && list.every((s) => /^\d{2}$/.test(s)) ? list : null;
}

function parseStateDays(value: unknown): ParseResult<StateDay[]> {
  if (!Array.isArray(value) || value.length === 0) return errResult("stateDays must be a non-empty list of { day, states }.");
  const out: StateDay[] = [];
  for (const entry of value) {
    const r = asRecord(entry);
    const states = r ? stateCodeList(r.states) : null;
    if (!r || !isInt(r.day, 1, 31) || !states || Object.keys(r).some((k) => k !== "day" && k !== "states")) {
      return errResult("Each stateDays entry needs a day (1–31) and a list of two-digit state codes.");
    }
    out.push({ day: r.day, states });
  }
  return okResult(out);
}

const EXTRA_KEYS: readonly string[] = ["formCode2025", "periodLabel", "filingBar", "lateFee", "cumulativePercent", "note"];

const SHAPES: Record<RuleKind, { keys: readonly string[]; frequencies: readonly ServiceFrequency[] }> = {
  monthOffset: { keys: ["monthOffset", "day", "monthsOfQuarter", "exceptions", "stateDays"], frequencies: ["monthly"] },
  quarterEnd: { keys: ["afterQuarterEnd", "monthOffset", "day", "quarters", "stateDays"], frequencies: ["quarterly"] },
  fixed: { keys: ["fixed", "yearOffset", "period"], frequencies: ["annual"] },
  afterEvent: { keys: ["afterEvent", "days"], frequencies: ["annual"] },
  afterPeriodEnd: { keys: ["daysAfterPeriodEnd"], frequencies: ["annual"] },
  afterRuleDue: { keys: ["afterRuleDue", "days"], frequencies: ["monthly", "quarterly"] },
  everyNYears: { keys: ["everyNYears", "fixed", "yearOffset", "per"], frequencies: ["annual"] },
};

function kindOfJson(o: Record<string, unknown>): RuleKind | null {
  if ("everyNYears" in o) return "everyNYears";
  if ("afterQuarterEnd" in o) return "quarterEnd";
  if ("afterRuleDue" in o) return "afterRuleDue";
  if ("afterEvent" in o) return "afterEvent";
  if ("daysAfterPeriodEnd" in o) return "afterPeriodEnd";
  if ("fixed" in o) return "fixed";
  if ("monthOffset" in o) return "monthOffset";
  return null;
}

function parseExtras(o: Record<string, unknown>): ParseResult<RuleExtras> {
  const extras: RuleExtras = {};
  if (o.formCode2025 !== undefined) {
    if (!isNonEmptyString(o.formCode2025)) return errResult("formCode2025 must be a form code.");
    extras.formCode2025 = o.formCode2025;
  }
  if (o.periodLabel !== undefined) {
    if (o.periodLabel !== "taxYear") return errResult('periodLabel can only be "taxYear".');
    extras.periodLabel = "taxYear";
  }
  for (const key of ["filingBar", "lateFee"] as const) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== "boolean") return errResult(`${key} must be true or false.`);
      extras[key] = o[key] as boolean;
    }
  }
  if (o.cumulativePercent !== undefined) {
    if (typeof o.cumulativePercent !== "number" || !(o.cumulativePercent > 0 && o.cumulativePercent <= 100)) {
      return errResult("cumulativePercent must be a percentage above 0 and up to 100.");
    }
    extras.cumulativePercent = o.cumulativePercent;
  }
  if (o.note !== undefined) {
    if (!isNonEmptyString(o.note)) return errResult("note must be a sentence.");
    extras.note = o.note;
  }
  return okResult(extras);
}

const SUB_PERIODS: readonly SubPeriod[] = ["Q1", "Q2", "Q3", "Q4", "H1", "H2"];

/**
 * Reads and validates a rule's JSON (§5.12) for a rule of the given frequency. Unknown keys are
 * refused, so a typo on the Law & rules page never silently changes a due date.
 */
export function parseRuleSpec(json: unknown, frequency: ServiceFrequency): ParseResult<DueRuleSpec> {
  const o = asRecord(json);
  if (!o) return errResult("The rule must be a JSON object.");
  const kind = kindOfJson(o);
  if (!kind) {
    return errResult("The rule needs a date shape: monthOffset, afterQuarterEnd, fixed, afterEvent, daysAfterPeriodEnd, afterRuleDue or everyNYears.");
  }
  const shape = SHAPES[kind];
  const unknown = Object.keys(o).filter((k) => !shape.keys.includes(k) && !EXTRA_KEYS.includes(k));
  if (unknown.length > 0) return errResult(`The rule has keys it doesn't understand: ${unknown.join(", ")}.`);
  if (!shape.frequencies.includes(frequency)) {
    return errResult(`This rule shape needs the frequency ${shape.frequencies.join(" or ")}, not ${frequency}.`);
  }
  const extrasResult = parseExtras(o);
  if (!extrasResult.ok) return extrasResult;
  const extras = extrasResult.value;

  switch (kind) {
    case "monthOffset": {
      if (!isInt(o.monthOffset, 0, 24)) return errResult("monthOffset must be a whole number of months from 0 to 24.");
      if (!isInt(o.day, 1, 31)) return errResult("day must be a day of the month (1–31).");
      const spec: MonthOffsetRule = { ...extras, monthOffset: o.monthOffset, day: o.day };
      if (o.monthsOfQuarter !== undefined) {
        const months = intList(o.monthsOfQuarter, 1, 3);
        if (!months) return errResult("monthsOfQuarter must list months of the quarter (1–3).");
        spec.monthsOfQuarter = months;
      }
      if (o.exceptions !== undefined) {
        if (!Array.isArray(o.exceptions) || o.exceptions.length === 0) return errResult("exceptions must be a non-empty list.");
        const exceptions: MonthException[] = [];
        for (const entry of o.exceptions) {
          const r = asRecord(entry);
          if (
            !r ||
            !isInt(r.periodMonth, 1, 12) ||
            !isInt(r.monthOffset, 0, 24) ||
            !isInt(r.day, 1, 31) ||
            Object.keys(r).some((k) => !["periodMonth", "monthOffset", "day"].includes(k))
          ) {
            return errResult("Each exception needs periodMonth (1–12), monthOffset (0–24) and day (1–31).");
          }
          exceptions.push({ periodMonth: r.periodMonth, monthOffset: r.monthOffset, day: r.day });
        }
        spec.exceptions = exceptions;
      }
      if (o.stateDays !== undefined) {
        const sd = parseStateDays(o.stateDays);
        if (!sd.ok) return sd;
        spec.stateDays = sd.value;
      }
      return okResult(spec);
    }
    case "quarterEnd": {
      if (o.afterQuarterEnd !== true) return errResult("afterQuarterEnd must be true.");
      if (!isInt(o.monthOffset, 0, 24)) return errResult("monthOffset must be a whole number of months from 0 to 24.");
      if (!isInt(o.day, 1, 31)) return errResult("day must be a day of the month (1–31).");
      const spec: QuarterEndRule = { ...extras, afterQuarterEnd: true, monthOffset: o.monthOffset, day: o.day };
      if (o.quarters !== undefined) {
        const quarters = intList(o.quarters, 1, 4);
        if (!quarters) return errResult("quarters must list FY quarters (1–4).");
        spec.quarters = quarters as FyQuarter[];
      }
      if (o.stateDays !== undefined) {
        const sd = parseStateDays(o.stateDays);
        if (!sd.ok) return sd;
        spec.stateDays = sd.value;
      }
      return okResult(spec);
    }
    case "fixed": {
      if (!isMonthDay(o.fixed)) return errResult('fixed must be a date written "MM-DD".');
      if (!isInt(o.yearOffset, -1, 10)) return errResult("yearOffset must be a whole number of years from -1 to 10.");
      const spec: FixedDateRule = { ...extras, fixed: o.fixed, yearOffset: o.yearOffset };
      if (o.period !== undefined) {
        if (typeof o.period !== "string" || !SUB_PERIODS.includes(o.period as SubPeriod)) {
          return errResult("period must be one of Q1, Q2, Q3, Q4, H1, H2.");
        }
        spec.period = o.period as SubPeriod;
      }
      return okResult(spec);
    }
    case "afterEvent": {
      if (!isNonEmptyString(o.afterEvent)) return errResult("afterEvent must name the anchoring rule, e.g. AGM.");
      if (!isInt(o.days, 0, 400)) return errResult("days must be a whole number from 0 to 400.");
      return okResult({ ...extras, afterEvent: o.afterEvent, days: o.days });
    }
    case "afterPeriodEnd": {
      if (!isInt(o.daysAfterPeriodEnd, 0, 800)) return errResult("daysAfterPeriodEnd must be a whole number from 0 to 800.");
      return okResult({ ...extras, daysAfterPeriodEnd: o.daysAfterPeriodEnd });
    }
    case "afterRuleDue": {
      const codes = stringList(o.afterRuleDue);
      if (!codes) return errResult("afterRuleDue must list rule codes.");
      if (!isInt(o.days, 0, 400)) return errResult("days must be a whole number from 0 to 400.");
      return okResult({ ...extras, afterRuleDue: codes, days: o.days });
    }
    case "everyNYears": {
      if (!isInt(o.everyNYears, 1, 10)) return errResult("everyNYears must be a whole number of years from 1 to 10.");
      if (!isMonthDay(o.fixed)) return errResult('fixed must be a date written "MM-DD".');
      if (o.per !== "DIN") return errResult('per must be "DIN".');
      const spec: EveryNYearsRule = { ...extras, everyNYears: o.everyNYears, fixed: o.fixed, per: "DIN" };
      if (o.yearOffset !== undefined) {
        if (!isInt(o.yearOffset, -1, 10)) return errResult("yearOffset must be a whole number of years from -1 to 10.");
        spec.yearOffset = o.yearOffset;
      }
      return okResult(spec);
    }
  }
}

const APPLIES_KEYS: readonly string[] = [
  "serviceTypes",
  "entityTypes",
  "excludeEntityTypes",
  "gstScheme",
  "auditCase",
  "taxAudit",
  "tpCase",
  "presumptive",
  "opc",
  "minTurnover",
  "maxTurnover",
  "states",
  "state",
  "optIn",
];

function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  const list = stringList(value);
  return list && list.every((v) => (allowed as readonly string[]).includes(v)) ? (list as T[]) : null;
}

/** Reads and validates a rule's `applies_to` JSON (§5.12). Unknown keys are refused. */
export function parseAppliesTo(json: unknown): ParseResult<AppliesTo> {
  if (json === null || json === undefined) return okResult({});
  const o = asRecord(json);
  if (!o) return errResult("applies_to must be a JSON object.");
  const unknown = Object.keys(o).filter((k) => !APPLIES_KEYS.includes(k));
  if (unknown.length > 0) return errResult(`applies_to has keys it doesn't understand: ${unknown.join(", ")}.`);
  const out: AppliesTo = {};
  if (o.serviceTypes !== undefined) {
    const list = enumList(o.serviceTypes, SERVICE_TYPES);
    if (!list) return errResult("applies_to.serviceTypes must list service types.");
    out.serviceTypes = list;
  }
  for (const key of ["entityTypes", "excludeEntityTypes"] as const) {
    if (o[key] !== undefined) {
      const list = enumList(o[key], ENTITY_TYPES);
      if (!list) return errResult(`applies_to.${key} must list entity types.`);
      out[key] = list;
    }
  }
  if (o.gstScheme !== undefined) {
    if (typeof o.gstScheme === "string") {
      if (!(CALENDAR_GST_SCHEMES as readonly string[]).includes(o.gstScheme)) return errResult("applies_to.gstScheme must be monthly, qrmp or composition.");
      out.gstScheme = o.gstScheme as CalendarGstScheme;
    } else {
      const list = enumList(o.gstScheme, CALENDAR_GST_SCHEMES);
      if (!list) return errResult("applies_to.gstScheme must be monthly, qrmp or composition (or a list of them).");
      out.gstScheme = list;
    }
  }
  for (const key of ["auditCase", "taxAudit", "tpCase", "presumptive", "opc"] as const) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== "boolean") return errResult(`applies_to.${key} must be true or false.`);
      out[key] = o[key] as boolean;
    }
  }
  for (const key of ["minTurnover", "maxTurnover"] as const) {
    if (o[key] !== undefined) {
      const v = o[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return errResult(`applies_to.${key} must be an amount in rupees.`);
      out[key] = v;
    }
  }
  if (o.states !== undefined || o.state !== undefined) {
    const list = o.states !== undefined ? stateCodeList(o.states) : stateCodeList([o.state]);
    if (!list) return errResult("applies_to.states must list two-digit state codes.");
    out.states = list;
  }
  if (o.optIn !== undefined) {
    if (!isNonEmptyString(o.optIn)) return errResult("applies_to.optIn must name a flag.");
    out.optIn = o.optIn;
  }
  return okResult(out);
}

/** Reads a `due_date_rules` row into a `DueDateRule`, or says in a sentence what is wrong with it. */
export function parseDueDateRuleRow(row: DueDateRuleRow): ParseResult<DueDateRule> {
  const where = `Rule ${row.code || "(no code)"}`;
  if (!isNonEmptyString(row.code)) return errResult("A rule needs a code.");
  if (!isNonEmptyString(row.title)) return errResult(`${where} needs a title.`);
  if (!isEnumValue("compliance_type", row.compliance_type)) return errResult(`${where}: unknown compliance type ${row.compliance_type}.`);
  if (!isEnumValue("service_frequency", row.frequency)) return errResult(`${where}: unknown frequency ${row.frequency}.`);
  if (!isInt(row.reminder_days, 0, 365)) return errResult(`${where}: reminder days must be 0–365.`);
  if (!isDateString(row.effective_from)) return errResult(`${where}: effective from must be a date.`);
  if (row.effective_to !== null && !isDateString(row.effective_to)) return errResult(`${where}: effective to must be a date.`);
  if (row.effective_to !== null && compareDates(row.effective_to, row.effective_from) < 0) {
    return errResult(`${where}: effective to is before effective from.`);
  }
  const spec = parseRuleSpec(row.rule, row.frequency);
  if (!spec.ok) return errResult(`${where}: ${spec.error}`);
  const applies = parseAppliesTo(row.applies_to);
  if (!applies.ok) return errResult(`${where}: ${applies.error}`);
  return okResult({
    code: row.code,
    title: row.title,
    complianceType: row.compliance_type,
    formCode: row.form_code && row.form_code.trim() ? row.form_code : null,
    appliesTo: applies.value,
    frequency: row.frequency,
    rule: spec.value,
    reminderDays: row.reminder_days,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    sourceRef: row.source_ref,
    verified: row.verified === true,
    isActive: row.is_active !== false,
  });
}

/** Reads a `due_date_overrides` row. */
export function parseDueDateOverrideRow(row: DueDateOverrideRow): ParseResult<DueDateOverride> {
  if (!isNonEmptyString(row.rule_code) || !isNonEmptyString(row.period_label)) return errResult("An extension needs a rule and a period.");
  if (!isDateString(row.original_due) || !isDateString(row.extended_due)) return errResult("An extension needs the original and the extended due dates.");
  if (!isNonEmptyString(row.source_ref)) return errResult("An extension needs its source (the circular or notification).");
  return okResult({
    id: row.id ?? null,
    ruleCode: row.rule_code,
    periodLabel: row.period_label.trim(),
    originalDue: row.original_due,
    extendedDue: row.extended_due,
    scope: row.scope ?? null,
    sourceRef: row.source_ref,
  });
}

/** The state-dependent day of a rule (e.g. `GSTR3B_QRMP`), as `qrmpGstr3bDay` in `scale.ts` reads it. */
export function stateDayParamsOf(rule: DueDateRule): StateDayParams | null {
  const c = classify(rule.rule);
  if ((c.kind === "monthOffset" || c.kind === "quarterEnd") && c.spec.stateDays) {
    return { defaultDay: c.spec.day, stateDays: c.spec.stateDays };
  }
  return null;
}

// =================================================================================================
// Parameters (§5.12)
// =================================================================================================

export type FilingBarParams = {
  /** Returns can't be filed this many years after their due date (3). */
  years: number;
  /** Unfiled returns are flagged this many months before the bar (6). */
  warnMonths: number;
  /** The bar applies to periods ending on or after this date (the July 2025 tax period). */
  fromPeriod: DateString;
};

export type CalendarParams = {
  /** Monthly and quarterly cadences are generated this many months ahead (§6.7: 13). */
  horizonMonths: number;
  /** GST three-year filing bar (§6.7) [verify]. */
  filingBar: FilingBarParams;
  /** ROC late fee per day per form (§6.7: ₹100). */
  rocLateFeePerDayPaise: Paise;
  /** Which Income-tax Act governs a year (§6.1). */
  statute: StatuteParams;
  /** Entity types whose accounts are always audited under another law, making the ITR an audit case. */
  statutoryAuditEntityTypes: readonly EntityType[];
  /** To derive the GST scheme from turnover when the client has none recorded (§6.6). */
  scale: Pick<ScaleParams, "qrmpMaxTurnoverPaise">;
  coverage: {
    /** A monthly/quarterly service with nothing planned within this many months is a gap (§7.7). */
    minCoverMonths: number;
    /** The services the calendar fills (others have no statutory dates). */
    serviceTypes: readonly ServiceType[];
  };
};

/** Companies: their accounts are audited under the Companies Act, so their ITR is an audit case. */
export const COMPANY_ENTITY_TYPES: readonly EntityType[] = ["pvt_ltd", "public_ltd", "section_8"];

/** The §6.7 / §7.7 seed values. */
export const CALENDAR_DEFAULTS: CalendarParams = {
  horizonMonths: 13,
  filingBar: { years: 3, warnMonths: 6, fromPeriod: "2025-07-01" },
  rocLateFeePerDayPaise: 100_00,
  statute: FY_DEFAULTS,
  statutoryAuditEntityTypes: COMPANY_ENTITY_TYPES,
  scale: SCALE_DEFAULTS,
  coverage: { minCoverMonths: 6, serviceTypes: ["gst", "income_tax", "tds", "payroll", "company_law"] },
};

/** The `statutory_parameters` keys this module reads. */
export const CALENDAR_PARAM_KEYS = {
  /** `{"years": 3, "warnMonths": 6, "fromPeriod": "2025-07-01"}`: GST returns barred after 3 years [verify]. */
  gstFilingBar: "gst.filing_bar",
  /** `{"amount": 100}`: ROC late fee in rupees per day per form. */
  rocLateFeePerDay: "roc.late_fee_per_day",
} as const;

/** The calendar parameters in force on `on`, from `statutory_parameters` rows (missing keys keep `fallback`). */
export function resolveCalendarParams(
  rows: readonly StatutoryParameterRow[],
  on: DateString,
  fallback: CalendarParams = CALENDAR_DEFAULTS,
): CalendarParams {
  const bar = asRecord(parameterInForce(rows, CALENDAR_PARAM_KEYS.gstFilingBar, on)?.value);
  const fee = readParameterNumber(parameterInForce(rows, CALENDAR_PARAM_KEYS.rocLateFeePerDay, on)?.value);
  const years = bar ? readParameterNumber(bar.years) : null;
  const warnMonths = bar ? readParameterNumber(bar.warnMonths) : null;
  const fromPeriod = bar && isDateString(bar.fromPeriod) ? bar.fromPeriod : null;
  return {
    ...fallback,
    filingBar: {
      years: years ?? fallback.filingBar.years,
      warnMonths: warnMonths ?? fallback.filingBar.warnMonths,
      fromPeriod: fromPeriod ?? fallback.filingBar.fromPeriod,
    },
    rocLateFeePerDayPaise: fee === null ? fallback.rocLateFeePerDayPaise : toPaise(fee),
  };
}

/** The calendar's rows for the seed SQL (§16), next to the §6.6 rows from `scale.ts`. Amounts in rupees. */
export const CALENDAR_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: CALENDAR_PARAM_KEYS.gstFilingBar,
    value: { years: 3, warnMonths: 6, fromPeriod: "2025-07-01" },
    effectiveFrom: "2025-07-01",
    effectiveTo: null,
    statute: "Central Goods and Services Tax Act, 2017",
    sectionRef: "ss.37(5), 39(11), 44(2), 52(13)",
    sourceRef: "Finance Act, 2023; GSTN advisory on the three-year bar (reported effective from the July 2025 tax period)",
    notes: "Returns cannot be filed after three years from their due date. The app flags any unfiled return within 6 months of that bar in red (§6.7). [verify] the effective period.",
    verified: false,
  },
  {
    key: CALENDAR_PARAM_KEYS.rocLateFeePerDay,
    value: { amount: 100 },
    effectiveFrom: "2018-07-01",
    effectiveTo: null,
    statute: "Companies Act, 2013; Limited Liability Partnership Act, 2008",
    sectionRef: "Companies Act s.403; LLP Act s.69",
    sourceRef: "Companies (Registration Offices and Fees) Rules, 2014, as amended; LLP Rules, 2009",
    notes: "₹100 per day per form on most ROC forms; shown accruing on overdue ROC events (§6.7).",
    verified: true,
  },
];

// =================================================================================================
// The client profile and the events
// =================================================================================================

/** A director's KYC position: the last FY DIR-3 KYC Web was filed, or the next due FY (§7.15.1). */
export type DinKyc = {
  din: string;
  name?: string | null;
  lastKycFiledFy?: FinancialYear | null;
  /** Overrides the computed next due year. */
  nextDueFy?: FinancialYear | null;
};

/** What the engine needs to know about a client. */
export type CalendarClientProfile = {
  id: string;
  /** Active services (`client_services.is_active`). */
  serviceTypes: readonly ServiceType[];
  entityType: EntityType | null;
  /** `clients.gst_scheme` (null = derive from turnover, §6.6), or `composition`. */
  gstScheme: CalendarGstScheme | null;
  stateCode: string | null;
  /** Aggregate turnover in paise, or null when not recorded. */
  turnover: Paise | null;
  /** The partner's tax audit decision (`clients.tax_audit_applicable`); `review` and null count as not yet an audit case. */
  taxAuditApplicable: boolean | "yes" | "no" | "review" | null;
  /** Accounts audited under another law (Companies Act, LLP Act, trust law). Default: companies yes, others no. */
  statutoryAudit?: boolean | null;
  isTpCase?: boolean;
  isPresumptive?: boolean;
  isOpc?: boolean;
  /** AGM dates per FY, entered on the client's AGM event (§6.7). */
  agmDates?: Readonly<Partial<Record<FinancialYear, DateString>>>;
  /** Actual dates of other anchoring events, by rule code then FY (`agmDates` is `eventDates.AGM`). */
  eventDates?: Readonly<Record<string, Readonly<Partial<Record<FinancialYear, DateString>>>>>;
  dins?: readonly DinKyc[];
  /** Optional filings this client makes (`applies_to.optIn`): e.g. `iff`, `gst_tds`, `gst_tcs`, `itr_belated`. */
  optIns?: readonly string[];
};

/** A generated compliance event, ready for `compliance_events` (see `toComplianceEventInsert`). */
export type CalendarEvent = {
  /** `client_id|form_code|filing_period` (§5.6). */
  dedupeKey: string;
  clientId: string;
  ruleCode: string | null;
  type: ComplianceType;
  formCode: string | null;
  title: string;
  financialYear: FinancialYear;
  filingPeriod: string;
  periodStart: DateString;
  periodEnd: DateString;
  /** The date in force: the extended date when an override applies. */
  dueDate: DateString;
  /** The statutory date before a government extension; null when not extended. */
  originalDueDate: DateString | null;
  reminderDays: number;
  isStatutory: boolean;
  source: ComplianceSource;
  /** The legal source shown on the event (§6.7). */
  sourceRef: string | null;
  /** The circular behind an extension (§7.7: "Shows extended dates with a badge linking to the circular"). */
  overrideRef: string | null;
  overrideId: string | null;
  /** AGM-linked dates before the AGM date is entered, and DIN KYC dates with no filing history. */
  provisional: boolean;
  agmDate: DateString | null;
  /** §6.3: due dates are not moved off a Sunday; the UI shows "falls on a Sunday". */
  fallsOnSunday: boolean;
  serviceType: ServiceType | null;
  notes: string | null;
  /** GST: the last date the return can be filed at all (§6.7). */
  filingBarDate: DateString | null;
  /** ROC: the late fee per day while overdue (§6.7). */
  lateFeePerDayPaise: Paise | null;
  din: string | null;
};

export type GenerateOptions = {
  /** Today in IST (`todayIST()`). */
  today: DateString;
  /** Default `CALENDAR_DEFAULTS.horizonMonths` (13). */
  horizonMonths?: number;
  /** Earliest due date to generate (default `today`); pass an earlier date to backfill on onboarding. */
  from?: DateString;
  params?: CalendarParams;
};

// =================================================================================================
// Dates and periods
// =================================================================================================

/** `21 Nov 2026` (the display form of `lib/format.ts`, kept local so this module stays pure). */
export function formatDay(date: DateString): string {
  const { year, month, day } = parseDateString(date);
  return `${day} ${MONTH_ABBR[month - 1]} ${year}`;
}

function monthIndex(date: DateString): number {
  const { year, month } = parseDateString(date);
  return year * 12 + (month - 1);
}

function monthStart(index: number): DateString {
  const year = Math.floor(index / 12);
  return toDateString(year, index - year * 12 + 1, 1);
}

function dayInMonth(index: number, day: number): DateString {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return toDateString(year, month, Math.min(day, daysInMonth(year, month)));
}

function fyStartYear(fy: FinancialYear): number {
  const y = parseFinancialYear(fy);
  if (y === null) throw new RangeError(`Not a financial year (YYYY-YY): ${fy}`);
  return y;
}

function shiftFy(fy: FinancialYear, years: number): FinancialYear {
  return financialYearFromStartYear(fyStartYear(fy) + years);
}

function fixedDate(spec: string, year: number): DateString {
  const month = Number(spec.slice(0, 2));
  const day = Number(spec.slice(3, 5));
  return toDateString(year, month, Math.min(day, daysInMonth(year, month)));
}

/** Month 1, 2 or 3 of its FY quarter (April = 1, May = 2, June = 3, July = 1 …). */
function monthOfQuarter(date: DateString): number {
  const { month } = parseDateString(date);
  return ((month - 4 + 12) % 3) + 1;
}

type Period = { start: DateString; end: DateString; fy: FinancialYear; label: string; quarter: FyQuarter | null };

function monthPeriod(index: number): Period {
  const start = monthStart(index);
  return { start, end: endOfMonth(start), fy: financialYearOf(start), label: monthPeriodLabel(start), quarter: null };
}

function quarterPeriod(fy: FinancialYear, quarter: FyQuarter): Period {
  const range = quarterRange(fy, quarter);
  return { ...range, fy, label: `Q${quarter} ${fy}`, quarter };
}

function annualPeriod(fy: FinancialYear, spec: DueRuleSpec, statute: StatuteParams): Period {
  const sub = "period" in spec ? spec.period : undefined;
  if (sub === "H1" || sub === "H2") {
    const start = sub === "H1" ? fyStart(fy) : addMonths(fyStart(fy), 6);
    return { start, end: endOfMonth(addMonths(start, 5)), fy, label: `${sub} ${fy}`, quarter: null };
  }
  if (sub) {
    const q = Number(sub.slice(1)) as FyQuarter;
    return quarterPeriod(fy, q);
  }
  const label = spec.periodLabel === "taxYear" ? taxYearLabel(fy, statute) : `FY ${fy}`;
  return { start: fyStart(fy), end: fyEnd(fy), fy, label, quarter: null };
}

// =================================================================================================
// Matching a client to a rule
// =================================================================================================

type Ctx = {
  profile: CalendarClientProfile;
  services: ReadonlySet<ServiceType>;
  scheme: CalendarGstScheme;
  stateCode: string | null;
  auditCase: boolean;
  taxAudit: boolean;
  params: CalendarParams;
  rulesByCode: ReadonlyMap<string, DueDateRule>;
  overrides: readonly DueDateOverride[];
  from: DateString;
  periodicEnd: DateString;
  annualEnd: DateString;
};

function taxAuditYes(value: CalendarClientProfile["taxAuditApplicable"]): boolean {
  return value === true || value === "yes";
}

/**
 * The GST scheme the calendar uses for a client (§6.6): composition as recorded; otherwise the
 * `gstSchemeDecision` (QRMP up to the limit unless the client chose monthly; monthly above it, and
 * monthly when no turnover is recorded).
 */
export function effectiveGstScheme(
  profile: Pick<CalendarClientProfile, "gstScheme" | "turnover">,
  params: Pick<ScaleParams, "qrmpMaxTurnoverPaise"> = SCALE_DEFAULTS,
): CalendarGstScheme {
  if (profile.gstScheme === "composition") return "composition";
  return gstSchemeDecision(profile.turnover, profile.gstScheme, params).scheme;
}

/**
 * Whether the client's ITR is an audit case (§6.7): a tax audit is indicated and confirmed, or the
 * accounts are audited under another law (by default, every company).
 */
export function isAuditCase(
  profile: Pick<CalendarClientProfile, "taxAuditApplicable" | "statutoryAudit" | "entityType">,
  params: Pick<CalendarParams, "statutoryAuditEntityTypes"> = CALENDAR_DEFAULTS,
): boolean {
  if (taxAuditYes(profile.taxAuditApplicable)) return true;
  if (profile.statutoryAudit === true) return true;
  if (profile.statutoryAudit === false) return false;
  return profile.entityType !== null && params.statutoryAuditEntityTypes.includes(profile.entityType);
}

type Match = { ok: boolean; notes: string[] };

function matchAppliesTo(a: AppliesTo, ctx: Ctx): Match {
  const p = ctx.profile;
  const notes: string[] = [];
  const no: Match = { ok: false, notes };
  if (a.serviceTypes && !a.serviceTypes.some((s) => ctx.services.has(s))) return no;
  if (a.entityTypes && (p.entityType === null || !a.entityTypes.includes(p.entityType))) return no;
  if (a.excludeEntityTypes && p.entityType !== null && a.excludeEntityTypes.includes(p.entityType)) return no;
  if (a.gstScheme !== undefined) {
    const schemes = Array.isArray(a.gstScheme) ? a.gstScheme : [a.gstScheme];
    if (!schemes.includes(ctx.scheme)) return no;
  }
  if (a.auditCase !== undefined && a.auditCase !== ctx.auditCase) return no;
  if (a.taxAudit !== undefined && a.taxAudit !== ctx.taxAudit) return no;
  if (a.tpCase !== undefined && a.tpCase !== (p.isTpCase === true)) return no;
  if (a.presumptive !== undefined && a.presumptive !== (p.isPresumptive === true)) return no;
  if (a.opc !== undefined && a.opc !== (p.isOpc === true)) return no;
  if (a.minTurnover !== undefined || a.maxTurnover !== undefined) {
    if (p.turnover === null) {
      notes.push("Turnover isn't recorded, so this return is included to be safe. Record the turnover to confirm it applies.");
    } else {
      if (a.minTurnover !== undefined && !(p.turnover > toPaise(a.minTurnover))) return no;
      if (a.maxTurnover !== undefined && !(p.turnover <= toPaise(a.maxTurnover))) return no;
    }
  }
  if (a.states && (ctx.stateCode === null || !a.states.includes(ctx.stateCode))) return no;
  if (a.optIn !== undefined && !(p.optIns ?? []).includes(a.optIn)) return no;
  return { ok: true, notes };
}

/** True when the rule applies to the client (§6.7: services, entity type, scheme, audit status, turnover band). */
export function ruleAppliesTo(rule: DueDateRule, profile: CalendarClientProfile, params: CalendarParams = CALENDAR_DEFAULTS): boolean {
  return matchAppliesTo(rule.appliesTo, makeCtx(profile, [rule], [], params.horizonMonths, "2000-01-01", "2000-01-01", params)).ok;
}

function inForce(rule: DueDateRule, periodStart: DateString): boolean {
  if (compareDates(periodStart, rule.effectiveFrom) < 0) return false;
  return rule.effectiveTo === null || compareDates(periodStart, rule.effectiveTo) <= 0;
}

/** The override for a rule and period label, if any (§5.12). */
export function findOverride(overrides: readonly DueDateOverride[], ruleCode: string, periodLabel: string): DueDateOverride | null {
  return overrides.find((o) => o.ruleCode === ruleCode && o.periodLabel === periodLabel) ?? null;
}

// =================================================================================================
// Due dates
// =================================================================================================

type Due = { due: DateString; notes: string[]; provisional: boolean; agmDate: DateString | null };

function stateDay(spec: { day: number; stateDays?: StateDay[] }, ctx: Ctx, notes: string[]): number {
  if (!spec.stateDays) return spec.day;
  const r = resolveStateDay(ctx.stateCode, { defaultDay: spec.day, stateDays: spec.stateDays });
  if (r.basis === "unknown_state") notes.push(`The client's state isn't recorded, so the earlier date (the ${ordinal(r.day)}) is used.`);
  return r.day;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** The statutory (pre-override) due date of `rule` for `period`, or null when the rule gives none. */
function statutoryDue(rule: DueDateRule, period: Period, ctx: Ctx, depth = 0): Due | null {
  const c = classify(rule.rule);
  const notes: string[] = [];
  const plain = (due: DateString): Due => ({ due, notes, provisional: false, agmDate: null });
  switch (c.kind) {
    case "monthOffset": {
      if (c.spec.monthsOfQuarter && !c.spec.monthsOfQuarter.includes(monthOfQuarter(period.start))) return null;
      const periodMonth = parseDateString(period.start).month;
      const ex = c.spec.exceptions?.find((e) => e.periodMonth === periodMonth);
      const idx = monthIndex(period.start);
      if (ex) return plain(dayInMonth(idx + ex.monthOffset, ex.day));
      return plain(dayInMonth(idx + c.spec.monthOffset, stateDay(c.spec, ctx, notes)));
    }
    case "quarterEnd": {
      if (period.quarter === null) return null;
      if (c.spec.quarters && !c.spec.quarters.includes(period.quarter)) return null;
      return plain(dayInMonth(monthIndex(period.end) + c.spec.monthOffset, stateDay(c.spec, ctx, notes)));
    }
    case "fixed":
      return plain(fixedDate(c.spec.fixed, fyStartYear(period.fy) + c.spec.yearOffset));
    case "afterPeriodEnd":
      return plain(addDays(period.end, c.spec.daysAfterPeriodEnd));
    case "afterRuleDue": {
      if (depth > 3) return null;
      for (const code of c.spec.afterRuleDue) {
        const ref = ctx.rulesByCode.get(code);
        if (!ref || !inForce(ref, period.start) || ref.frequency !== rule.frequency) continue;
        const refDue = statutoryDue(ref, period, ctx, depth + 1);
        if (refDue) return plain(addDays(refDue.due, c.spec.days));
      }
      return null;
    }
    case "afterEvent": {
      if (depth > 3) return null;
      const actual = actualEventDate(c.spec.afterEvent, period.fy, ctx.profile);
      const isAgm = c.spec.afterEvent === "AGM";
      if (actual) {
        return { due: addDays(actual, c.spec.days), notes, provisional: false, agmDate: isAgm ? actual : null };
      }
      const anchorRule = ctx.rulesByCode.get(c.spec.afterEvent);
      if (!anchorRule || !inForce(anchorRule, period.start)) return null;
      const anchorPeriod = annualPeriod(period.fy, anchorRule.rule, ctx.params.statute);
      const anchorDue = statutoryDue(anchorRule, anchorPeriod, ctx, depth + 1);
      if (!anchorDue) return null;
      const anchorOverride = findOverride(ctx.overrides, anchorRule.code, anchorPeriod.label);
      const anchor = anchorOverride ? anchorOverride.extendedDue : anchorDue.due;
      const what = isAgm ? "an AGM" : `the ${anchorRule.title.toLowerCase()}`;
      if (matchAppliesTo(anchorRule.appliesTo, ctx).ok) {
        notes.push(
          `Provisional: dated from ${what} on ${formatDay(anchor)}. Enter the actual date on the ${anchorRule.formCode ?? anchorRule.code} event to fix this date.`,
        );
        return { due: addDays(anchor, c.spec.days), notes, provisional: true, agmDate: null };
      }
      notes.push(`Dated from the last date for ${what} (${formatDay(anchor)}).`);
      return plain(addDays(anchor, c.spec.days));
    }
    case "everyNYears":
      return plain(fixedDate(c.spec.fixed, fyStartYear(period.fy) + (c.spec.yearOffset ?? 0)));
  }
}

/**
 * The next FY DIR-3 KYC Web is due for a DIN: `everyNYears` financial years after the last one it
 * was filed in (§6.7: once every three financial years; a change of mobile, email or address filed
 * within 30 days doesn't reset the cycle). `'2025-26'` → `'2028-29'` (due by 30 June 2028).
 */
export function dir3KycNextDueFy(lastFiledFy: FinancialYear, everyNYears = 3): FinancialYear {
  return shiftFy(lastFiledFy, everyNYears);
}

// =================================================================================================
// Generation (§6.7, §7.7)
// =================================================================================================

function makeCtx(
  profile: CalendarClientProfile,
  rules: readonly DueDateRule[],
  overrides: readonly DueDateOverride[],
  horizonMonths: number,
  today: DateString,
  from: DateString,
  params: CalendarParams,
): Ctx {
  const periodicEnd = addMonths(today, horizonMonths);
  const annualByFy = fyEnd(nextFinancialYear(financialYearOf(today)));
  return {
    profile,
    services: new Set(profile.serviceTypes),
    scheme: effectiveGstScheme(profile, params.scale),
    stateCode: normaliseStateCode(profile.stateCode),
    auditCase: isAuditCase(profile, params),
    taxAudit: taxAuditYes(profile.taxAuditApplicable),
    params,
    rulesByCode: new Map(rules.map((r) => [r.code, r])),
    overrides,
    from,
    periodicEnd,
    annualEnd: compareDates(annualByFy, periodicEnd) >= 0 ? annualByFy : periodicEnd,
  };
}

function candidatePeriods(rule: DueDateRule, ctx: Ctx): Period[] {
  const out: Period[] = [];
  if (rule.frequency === "monthly") {
    for (let i = monthIndex(ctx.from) - 24; i <= monthIndex(ctx.periodicEnd); i++) out.push(monthPeriod(i));
  } else if (rule.frequency === "quarterly") {
    const last = fyStartYear(financialYearOf(ctx.periodicEnd));
    for (let y = fyStartYear(financialYearOf(ctx.from)) - 2; y <= last; y++) {
      const fy = financialYearFromStartYear(y);
      for (const q of [1, 2, 3, 4] as const) out.push(quarterPeriod(fy, q));
    }
  } else if (rule.frequency === "annual") {
    const last = fyStartYear(financialYearOf(ctx.annualEnd));
    for (let y = fyStartYear(financialYearOf(ctx.from)) - 8; y <= last; y++) {
      out.push(annualPeriod(financialYearFromStartYear(y), rule.rule, ctx.params.statute));
    }
  }
  return out;
}

function eventFormCode(rule: DueDateRule, fy: FinancialYear, params: CalendarParams): string | null {
  if (rule.rule.formCode2025 && incomeTaxStatute(fy, params.statute) === "2025") return rule.rule.formCode2025;
  return rule.formCode;
}

function firstService(rule: DueDateRule, ctx: Ctx): ServiceType | null {
  return rule.appliesTo.serviceTypes?.find((s) => ctx.services.has(s)) ?? null;
}

/** The last date a return can be filed at all: `years` after its due date (§6.7). */
export function filingBarDate(dueDate: DateString, years: number = CALENDAR_DEFAULTS.filingBar.years): DateString {
  return addMonths(dueDate, years * 12);
}

/** The client's actual date for an anchoring event (the AGM), by the anchoring rule's code and FY. */
function actualEventDate(code: string, fy: FinancialYear, profile: CalendarClientProfile): DateString | null {
  const dates = code === "AGM" ? profile.eventDates?.AGM ?? profile.agmDates : profile.eventDates?.[code];
  const value = dates?.[fy];
  return value && isDateString(value) ? value : null;
}

function buildEvent(rule: DueDateRule, period: Period, due: Due, ctx: Ctx, extra: { din?: DinKyc; labelSuffix?: string } = {}): CalendarEvent {
  const label = extra.labelSuffix ? `${period.label} ${extra.labelSuffix}` : period.label;
  const formCode = eventFormCode(rule, period.fy, ctx.params);
  const override = findOverride(ctx.overrides, rule.code, label);
  const dueDate = override ? override.extendedDue : due.due;
  // The anchoring event itself (the AGM) shows the date the client entered on it.
  const heldOn = extra.din ? null : actualEventDate(rule.code, period.fy, ctx.profile);
  const notes: string[] = [];
  if (heldOn) notes.push(`Held on ${formatDay(heldOn)}.`);
  if (rule.rule.cumulativePercent !== undefined) notes.push(`Cumulative ${rule.rule.cumulativePercent}% of the year's estimated tax.`);
  if (rule.rule.note && !heldOn) notes.push(rule.rule.note);
  notes.push(...due.notes);
  if (override) notes.push(`Extended from ${formatDay(due.due)} to ${formatDay(override.extendedDue)} by ${override.sourceRef}.`);
  const filingBar =
    rule.rule.filingBar === true && compareDates(period.end, ctx.params.filingBar.fromPeriod) >= 0
      ? filingBarDate(due.due, ctx.params.filingBar.years)
      : null;
  return {
    dedupeKey: `${ctx.profile.id}|${formCode ?? rule.code}|${label}`,
    clientId: ctx.profile.id,
    ruleCode: rule.code,
    type: rule.complianceType,
    formCode,
    title: `${rule.title} for ${label}`,
    financialYear: period.fy,
    filingPeriod: label,
    periodStart: period.start,
    periodEnd: period.end,
    dueDate,
    originalDueDate: override ? due.due : null,
    reminderDays: rule.reminderDays,
    isStatutory: true,
    source: "statutory_engine",
    sourceRef: rule.sourceRef,
    overrideRef: override ? override.sourceRef : null,
    overrideId: override?.id ?? null,
    provisional: due.provisional,
    agmDate: due.agmDate ?? (heldOn && rule.code === "AGM" ? heldOn : null),
    fallsOnSunday: isSunday(dueDate),
    serviceType: firstService(rule, ctx),
    notes: notes.length > 0 ? notes.join(" ") : null,
    filingBarDate: filingBar,
    lateFeePerDayPaise: rule.rule.lateFee === true ? ctx.params.rocLateFeePerDayPaise : null,
    din: extra.din?.din ?? null,
  };
}

function inWindow(due: DateString, from: DateString, end: DateString): boolean {
  return compareDates(due, from) >= 0 && compareDates(due, end) <= 0;
}

function dinEvents(rule: DueDateRule, spec: EveryNYearsRule, ctx: Ctx, matchNotes: string[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const din of ctx.profile.dins ?? []) {
    if (!isNonEmptyString(din.din)) continue;
    let fy: FinancialYear;
    let provisional = false;
    const notes = [...matchNotes];
    if (din.nextDueFy && isFinancialYear(din.nextDueFy)) {
      fy = din.nextDueFy;
    } else if (din.lastKycFiledFy && isFinancialYear(din.lastKycFiledFy)) {
      fy = dir3KycNextDueFy(din.lastKycFiledFy, spec.everyNYears);
    } else {
      // No history: the next deadline on or after `from`.
      fy = financialYearOf(ctx.from);
      const dueThisYear = fixedDate(spec.fixed, fyStartYear(fy) + (spec.yearOffset ?? 0));
      if (compareDates(dueThisYear, ctx.from) < 0) fy = nextFinancialYear(fy);
      provisional = true;
      notes.push("The last DIR-3 KYC Web filing isn't recorded for this DIN, so the next deadline is shown. Record the last filing year on the DIN register.");
    }
    const period: Period = { start: fyStart(fy), end: fyEnd(fy), fy, label: `FY ${fy}`, quarter: null };
    if (!inForce(rule, period.start)) continue;
    const due = statutoryDue(rule, period, ctx);
    if (!due) continue;
    const suffix = `(DIN ${din.din}${din.name ? `, ${din.name}` : ""})`;
    const event = buildEvent(rule, period, { ...due, notes: [...notes, ...due.notes], provisional }, ctx, { din, labelSuffix: `(DIN ${din.din})` });
    out.push({ ...event, title: `${rule.title} for ${period.label} ${suffix}` });
  }
  return out;
}

/**
 * Generates a client's statutory events from the rules and overrides (§6.7, §7.7):
 * - only active rules in force for the period (`effective_from ≤ period start ≤ effective_to`) whose
 *   `applies_to` matches the client;
 * - monthly/quarterly cadences: due dates from `from` (default today) to `today + horizonMonths`
 *   (13); annual ones: to the end of the next FY (§6.7 "the current and next FY");
 * - overrides replace the due date (`originalDueDate` keeps the statutory one, `overrideRef` the
 *   circular); the window is checked on the date in force;
 * - one event per `dedupeKey`: when two rules give the same key, the earlier due date wins
 *   (over-filing is safer than a missed return). Sorted by due date, then key.
 *
 * Calling it again with the same inputs returns the same events, so inserting with
 * `on conflict (dedupe_key) do nothing` is idempotent; `planEventSync` handles updates.
 */
export function generateEvents(
  profile: CalendarClientProfile,
  rules: readonly DueDateRule[],
  overrides: readonly DueDateOverride[],
  opts: GenerateOptions,
): CalendarEvent[] {
  if (!isDateString(opts.today)) throw new RangeError(`today must be a date (YYYY-MM-DD): ${String(opts.today)}`);
  const from = opts.from ?? opts.today;
  if (!isDateString(from)) throw new RangeError(`from must be a date (YYYY-MM-DD): ${String(from)}`);
  const params = opts.params ?? CALENDAR_DEFAULTS;
  const horizon = opts.horizonMonths ?? params.horizonMonths;
  if (!Number.isInteger(horizon) || horizon < 1) throw new RangeError("horizonMonths must be a whole number of months, at least 1.");
  const ctx = makeCtx(profile, rules, overrides, horizon, opts.today, from, params);

  // Each key's date is settled before the window is applied, so it never depends on the window.
  type Candidate = { event: CalendarEvent; end: DateString; lowerBound: boolean };
  const byKey = new Map<string, Candidate>();
  const keep = (candidate: Candidate) => {
    const existing = byKey.get(candidate.event.dedupeKey);
    if (!existing || compareDates(candidate.event.dueDate, existing.event.dueDate) < 0) byKey.set(candidate.event.dedupeKey, candidate);
  };

  for (const rule of rules) {
    if (!rule.isActive || rule.frequency === "one_time") continue;
    const match = matchAppliesTo(rule.appliesTo, ctx);
    if (!match.ok) continue;
    const c = classify(rule.rule);
    if (c.kind === "everyNYears") {
      // An unfiled KYC that is already late is still due, so DIN events have no lower bound.
      for (const event of dinEvents(rule, c.spec, ctx, match.notes)) keep({ event, end: ctx.annualEnd, lowerBound: false });
      continue;
    }
    const end = rule.frequency === "annual" ? ctx.annualEnd : ctx.periodicEnd;
    for (const period of candidatePeriods(rule, ctx)) {
      if (!inForce(rule, period.start)) continue;
      const due = statutoryDue(rule, period, ctx);
      if (!due) continue;
      keep({ event: buildEvent(rule, period, { ...due, notes: [...match.notes, ...due.notes] }, ctx), end, lowerBound: true });
    }
  }
  const events: CalendarEvent[] = [];
  for (const { event, end, lowerBound } of byKey.values()) {
    if (compareDates(event.dueDate, end) > 0) continue;
    if (lowerBound && compareDates(event.dueDate, from) < 0) continue;
    events.push(event);
  }
  return events.sort((a, b) => compareDates(a.dueDate, b.dueDate) || (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));
}

// =================================================================================================
// Overrides on stored events (§5.12, §7.7)
// =================================================================================================

/** The fields `applyOverride` reads and writes on an event (generated or loaded from the database). */
export type OverridableEvent = {
  ruleCode: string | null;
  filingPeriod: string | null;
  dueDate: DateString;
  originalDueDate?: DateString | null;
  status?: ComplianceStatus;
  workflowStatus?: ComplianceWorkflow;
  overrideRef?: string | null;
  overrideId?: string | null;
  fallsOnSunday?: boolean;
};

export type OverrideMove<T> = {
  before: T;
  after: T;
  /** The history line: "Due date moved from 31 Oct 2026 to 21 Nov 2026 by CBDT Circular …". */
  note: string;
  /** The event's statutory date differs from the override's `original_due` (worth a look). */
  originalMismatch: boolean;
};

/** Unfiled: still pending, and the workflow hasn't reached Filed or Completed (§7.7). */
export function isUnfiled(event: Pick<OverridableEvent, "status" | "workflowStatus">): boolean {
  const status = event.status ?? "pending";
  const workflow = event.workflowStatus ?? "not_started";
  return status === "pending" && workflow !== "filed" && workflow !== "completed";
}

function moveTo<T extends OverridableEvent>(event: T, dueDate: DateString, fields: Partial<OverridableEvent>): T {
  const sunday = "fallsOnSunday" in event ? { fallsOnSunday: isSunday(dueDate) } : {};
  return { ...event, ...fields, ...sunday, dueDate } as T;
}

/**
 * Applies a government extension (§5.12, §7.7): every **unfiled** event of the override's rule and
 * period moves to the extended date, keeps its statutory date in `originalDueDate`, and gets a
 * history note citing the circular. Filed, completed and cancelled events never move. Re-applying
 * the same override changes nothing. The caller also clears `reminder_sent_at` on moved events, so
 * the reminder is re-planned from the new date.
 */
export function applyOverride<T extends OverridableEvent>(events: readonly T[], override: DueDateOverride): { events: T[]; moved: OverrideMove<T>[] } {
  const moved: OverrideMove<T>[] = [];
  const out = events.map((event) => {
    if (event.ruleCode !== override.ruleCode || event.filingPeriod !== override.periodLabel) return event;
    if (!isUnfiled(event) || event.dueDate === override.extendedDue) return event;
    const original = event.originalDueDate ?? event.dueDate;
    const after = moveTo(event, override.extendedDue, {
      originalDueDate: original,
      overrideRef: override.sourceRef,
      overrideId: override.id ?? null,
    });
    moved.push({
      before: event,
      after,
      note: `Due date moved from ${formatDay(event.dueDate)} to ${formatDay(override.extendedDue)} by ${override.sourceRef}.`,
      originalMismatch: original !== override.originalDue,
    });
    return after;
  });
  return { events: out, moved };
}

/**
 * Undoes an extension that was deleted or entered by mistake: unfiled events it moved go back to
 * their statutory date, with a history note.
 */
export function removeOverride<T extends OverridableEvent>(events: readonly T[], override: DueDateOverride): { events: T[]; moved: OverrideMove<T>[] } {
  const moved: OverrideMove<T>[] = [];
  const out = events.map((event) => {
    if (event.ruleCode !== override.ruleCode || event.filingPeriod !== override.periodLabel) return event;
    if (!isUnfiled(event) || !event.originalDueDate) return event;
    if (event.overrideRef !== override.sourceRef && (override.id == null || event.overrideId !== override.id)) return event;
    const after = moveTo(event, event.originalDueDate, { originalDueDate: null, overrideRef: null, overrideId: null });
    moved.push({
      before: event,
      after,
      note: `Due date moved back from ${formatDay(event.dueDate)} to ${formatDay(event.originalDueDate)}: the extension (${override.sourceRef}) was removed.`,
      originalMismatch: false,
    });
    return after;
  });
  return { events: out, moved };
}

// =================================================================================================
// Syncing generated events with stored ones
// =================================================================================================

/** A stored event, as far as the sync plan needs it. */
export type StoredEvent = {
  id: string;
  dedupeKey: string | null;
  ruleCode: string | null;
  dueDate: DateString;
  status: ComplianceStatus;
  workflowStatus: ComplianceWorkflow;
  source: ComplianceSource;
  provisional: boolean;
  agmDate?: DateString | null;
};

export type EventSyncPlan = {
  insert: CalendarEvent[];
  update: { id: string; event: CalendarEvent; reason: string }[];
  unchanged: number;
};

/**
 * What to write after `generateEvents` (§7.7, idempotent by `dedupe_key`):
 * - new keys are inserted;
 * - an unfiled engine event is updated only when the facts behind it changed: a provisional date
 *   became firm or moved (AGM date entered), the AGM date changed, or a different rule now gives
 *   the key (e.g. the tax audit decision changed the ITR date);
 * - everything else is left alone, so a date a person changed by hand is never overwritten.
 */
export function planEventSync(existing: readonly StoredEvent[], generated: readonly CalendarEvent[]): EventSyncPlan {
  const byKey = new Map<string, StoredEvent>();
  for (const e of existing) if (e.dedupeKey) byKey.set(e.dedupeKey, e);
  const plan: EventSyncPlan = { insert: [], update: [], unchanged: 0 };
  for (const g of generated) {
    const e = byKey.get(g.dedupeKey);
    if (!e) {
      plan.insert.push(g);
      continue;
    }
    if (e.source !== "statutory_engine" || !isUnfiled(e)) {
      plan.unchanged++;
      continue;
    }
    let reason: string | null = null;
    if (e.ruleCode !== g.ruleCode) reason = "A different rule now applies to this client.";
    else if (e.provisional && (!g.provisional || e.dueDate !== g.dueDate)) reason = g.agmDate ? "The AGM date was entered." : "The provisional date was updated.";
    else if ((e.agmDate ?? null) !== (g.agmDate ?? null) && e.dueDate !== g.dueDate) reason = "The AGM date changed.";
    if (reason) plan.update.push({ id: e.id, event: g, reason });
    else plan.unchanged++;
  }
  return plan;
}

/** A `compliance_events` insert row for a generated event (§5.6). */
export type ComplianceEventInsert = {
  client_id: string;
  type: ComplianceType;
  form_code: string | null;
  title: string;
  description: string | null;
  financial_year: FinancialYear;
  filing_period: string;
  period_start: DateString;
  period_end: DateString;
  due_date: DateString;
  is_statutory: boolean;
  source: ComplianceSource;
  reminder_days: number;
  notes: string | null;
  dedupe_key: string;
  rule_code: string | null;
  source_ref: string | null;
  original_due_date: DateString | null;
  override_id: string | null;
  agm_date: DateString | null;
  is_provisional: boolean;
};

/** Maps an event to the `compliance_events` columns (status and workflow take their defaults). */
export function toComplianceEventInsert(event: CalendarEvent): ComplianceEventInsert {
  return {
    client_id: event.clientId,
    type: event.type,
    form_code: event.formCode,
    title: event.title,
    description: null,
    financial_year: event.financialYear,
    filing_period: event.filingPeriod,
    period_start: event.periodStart,
    period_end: event.periodEnd,
    due_date: event.dueDate,
    is_statutory: event.isStatutory,
    source: event.source,
    reminder_days: event.reminderDays,
    notes: event.notes,
    dedupe_key: event.dedupeKey,
    rule_code: event.ruleCode,
    source_ref: event.sourceRef,
    original_due_date: event.originalDueDate,
    override_id: event.overrideId,
    agm_date: event.agmDate,
    is_provisional: event.provisional,
  };
}

// =================================================================================================
// Flags on events: Sunday, reminders, the GST filing bar, ROC late fees
// =================================================================================================

/** The day the reminder goes out: `reminderDays` before the due date (§8 reminders job). */
export function reminderDate(dueDate: DateString, reminderDays: number): DateString {
  return addDays(dueDate, -Math.max(0, reminderDays));
}

/** §6.3: a hint only; statutory dates are never moved off a Sunday. */
export function sundayHint(dueDate: DateString): string | null {
  return isSunday(dueDate) ? "Falls on a Sunday" : null;
}

export type FilingBarStatus = {
  barDate: DateString;
  /** Unfiled, within `warnMonths` of the bar and not yet past it: shown in red (§6.7). */
  nearBar: boolean;
  /** Unfiled and past the bar: the return can no longer be filed. */
  barred: boolean;
};

/**
 * The GST filing bar for a return due on `dueDate` (§6.7): barred after `years`; flagged within
 * `warnMonths` before that. A filed return is never flagged.
 */
export function filingBarStatus(
  dueDate: DateString,
  today: DateString,
  opts: { filed?: boolean; params?: Pick<FilingBarParams, "years" | "warnMonths"> } = {},
): FilingBarStatus {
  const params = opts.params ?? CALENDAR_DEFAULTS.filingBar;
  const barDate = filingBarDate(dueDate, params.years);
  if (opts.filed) return { barDate, nearBar: false, barred: false };
  const barred = compareDates(today, barDate) > 0;
  const nearBar = !barred && compareDates(today, addMonths(barDate, -params.warnMonths)) >= 0;
  return { barDate, nearBar, barred };
}

/** True when an unfiled return is within `warnMonths` of its filing bar, or past it (§6.7). */
export function isNearFilingBar(barDate: DateString, today: DateString, warnMonths: number = CALENDAR_DEFAULTS.filingBar.warnMonths): boolean {
  return compareDates(today, addMonths(barDate, -warnMonths)) >= 0;
}

/**
 * The ROC late fee accrued on an overdue form (§6.7: ₹100 per day per form on most forms): whole
 * days after the due date up to `asOf` (today, or the filing date), times the daily fee. Nothing
 * accrues on or before the due date.
 */
export function lateFeeAccrued(
  dueDate: DateString,
  asOf: DateString,
  perDayPaise: Paise = CALENDAR_DEFAULTS.rocLateFeePerDayPaise,
): { daysLate: number; amountPaise: Paise } {
  if (!Number.isSafeInteger(perDayPaise) || perDayPaise < 0) throw new RangeError("The daily late fee must be a whole, non-negative number of paise.");
  const daysLate = Math.max(0, diffDays(asOf, dueDate));
  return { daysLate, amountPaise: daysLate * perDayPaise };
}

// =================================================================================================
// Ops templates (`recurring_compliance_templates`, §7.7)
// =================================================================================================

/**
 * An internal prep step ahead of statutory dates (§5.6). Due on `dueDayOfMonth`:
 * - monthly: of every month;
 * - quarterly: of month `dueMonth` (1–3, default 1) of every FY quarter;
 * - annual: of calendar month `dueMonth` (1–12) inside every FY.
 * `periodOffset` says which period the work is for: 0 = the period the due date falls in,
 * 1 = the one before (e.g. "collect bank statements on the 5th, for the previous month").
 */
export type OpsTemplate = {
  serviceType: ServiceType;
  complianceType: ComplianceType;
  title: string;
  description: string | null;
  frequency: ServiceFrequency;
  dueDayOfMonth: number;
  dueMonth: number | null;
  periodOffset: number;
  reminderDays: number;
  isActive: boolean;
};

const OPS_REMINDER_DAYS = 3;

function ops(
  serviceType: ServiceType,
  complianceType: ComplianceType,
  title: string,
  frequency: ServiceFrequency,
  dueDayOfMonth: number,
  dueMonth: number | null,
  periodOffset: number,
  description: string,
): OpsTemplate {
  return { serviceType, complianceType, title, description, frequency, dueDayOfMonth, dueMonth, periodOffset, reminderDays: OPS_REMINDER_DAYS, isActive: true };
}

/** The §7.7 ops-template defaults (seed for `recurring_compliance_templates`, §16). */
export const OPS_TEMPLATE_DEFAULTS: readonly OpsTemplate[] = [
  ops("bookkeeping", "custom", "Collect bank statements", "monthly", 5, null, 1, "Bank statements for the previous month."),
  ops("bookkeeping", "custom", "Collect sales data", "monthly", 7, null, 1, "Sales data for the previous month."),
  ops("bookkeeping", "custom", "Collect purchase data", "monthly", 7, null, 1, "Purchase data for the previous month."),
  ops("bookkeeping", "custom", "Collect expense receipts", "monthly", 10, null, 1, "Expense receipts for the previous month."),
  ops("gst", "gstr_1", "GSTR-1 data collection", "monthly", 5, null, 1, "Sales data for the previous month's GSTR-1."),
  ops("gst", "gstr_3b", "GSTR-3B reconciliation prep", "monthly", 14, null, 1, "Reconcile purchases with GSTR-2B / IMS for the previous month's GSTR-3B."),
  ops("income_tax", "itr", "Tax planning review", "annual", 1, 3, 0, "Review the year's tax position before the 15 March advance tax instalment."),
  ops("audit", "audit", "Audit documentation collection", "annual", 1, 9, 1, "Collect the documents for the previous financial year's audit."),
  ops("audit", "audit", "Financial statement preparation", "annual", 15, 9, 1, "Prepare the previous financial year's financial statements."),
];

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generates the internal prep steps for a client's active services (§7.7), with
 * `source = 'ops_template'` and `is_statutory = false`, over the same window as `generateEvents`
 * (monthly/quarterly: `from` to `today + horizonMonths`; annual: to the end of the next FY).
 * The dedupe key is `client_id|ops:<service>:<title>|<period>`.
 */
export function generateOpsEvents(
  profile: Pick<CalendarClientProfile, "id" | "serviceTypes">,
  templates: readonly OpsTemplate[],
  opts: GenerateOptions,
): CalendarEvent[] {
  if (!isDateString(opts.today)) throw new RangeError(`today must be a date (YYYY-MM-DD): ${String(opts.today)}`);
  const from = opts.from ?? opts.today;
  const params = opts.params ?? CALENDAR_DEFAULTS;
  const horizon = opts.horizonMonths ?? params.horizonMonths;
  const periodicEnd = addMonths(opts.today, horizon);
  const annualByFy = fyEnd(nextFinancialYear(financialYearOf(opts.today)));
  const annualEnd = compareDates(annualByFy, periodicEnd) >= 0 ? annualByFy : periodicEnd;
  const services = new Set(profile.serviceTypes);
  const out = new Map<string, CalendarEvent>();

  const add = (t: OpsTemplate, due: DateString, period: Period) => {
    const end = t.frequency === "annual" ? annualEnd : periodicEnd;
    if (!inWindow(due, from, end)) return;
    const event: CalendarEvent = {
      dedupeKey: `${profile.id}|ops:${t.serviceType}:${slug(t.title)}|${period.label}`,
      clientId: profile.id,
      ruleCode: null,
      type: t.complianceType,
      formCode: null,
      title: `${t.title} for ${period.label}`,
      financialYear: period.fy,
      filingPeriod: period.label,
      periodStart: period.start,
      periodEnd: period.end,
      dueDate: due,
      originalDueDate: null,
      reminderDays: t.reminderDays,
      isStatutory: false,
      source: "ops_template",
      sourceRef: null,
      overrideRef: null,
      overrideId: null,
      provisional: false,
      agmDate: null,
      fallsOnSunday: isSunday(due),
      serviceType: t.serviceType,
      notes: t.description,
      filingBarDate: null,
      lateFeePerDayPaise: null,
      din: null,
    };
    if (!out.has(event.dedupeKey)) out.set(event.dedupeKey, event);
  };

  for (const t of templates) {
    if (!t.isActive || !services.has(t.serviceType)) continue;
    if (!isInt(t.dueDayOfMonth, 1, 31) || !Number.isInteger(t.periodOffset)) continue;
    if (t.frequency === "monthly") {
      for (let i = monthIndex(from) - 1; i <= monthIndex(periodicEnd); i++) {
        add(t, dayInMonth(i, t.dueDayOfMonth), monthPeriod(i - t.periodOffset));
      }
    } else if (t.frequency === "quarterly") {
      const monthInQuarter = t.dueMonth !== null && isInt(t.dueMonth, 1, 3) ? t.dueMonth : 1;
      for (let y = fyStartYear(financialYearOf(from)) - 1; y <= fyStartYear(financialYearOf(periodicEnd)); y++) {
        for (const q of [1, 2, 3, 4] as const) {
          const quarterIndex = y * 4 + (q - 1) - t.periodOffset;
          const py = Math.floor(quarterIndex / 4);
          const pq = (quarterIndex - py * 4 + 1) as FyQuarter;
          const start = quarterRange(financialYearFromStartYear(y), q).start;
          add(t, dayInMonth(monthIndex(start) + monthInQuarter - 1, t.dueDayOfMonth), quarterPeriod(financialYearFromStartYear(py), pq));
        }
      }
    } else if (t.frequency === "annual") {
      if (t.dueMonth === null || !isInt(t.dueMonth, 1, 12)) continue;
      for (let y = fyStartYear(financialYearOf(from)) - 1; y <= fyStartYear(financialYearOf(annualEnd)); y++) {
        const calendarYear = t.dueMonth >= 4 ? y : y + 1;
        const due = toDateString(calendarYear, t.dueMonth, Math.min(t.dueDayOfMonth, daysInMonth(calendarYear, t.dueMonth)));
        const fy = financialYearFromStartYear(y - t.periodOffset);
        add(t, due, { start: fyStart(fy), end: fyEnd(fy), fy, label: `FY ${fy}`, quarter: null });
      }
    }
  }
  return [...out.values()].sort((a, b) => compareDates(a.dueDate, b.dueDate) || (a.dedupeKey < b.dedupeKey ? -1 : 1));
}

// =================================================================================================
// Coverage gaps (§7.7)
// =================================================================================================

export type CoverageService = {
  serviceType: ServiceType;
  frequency: ServiceFrequency;
  isActive?: boolean;
};

export type CoverageEvent = {
  serviceType?: ServiceType | null;
  type: ComplianceType;
  formCode?: string | null;
  ruleCode?: string | null;
  dueDate: DateString;
  status?: ComplianceStatus;
  source?: ComplianceSource;
  isStatutory?: boolean;
};

export type CoverageGap = {
  serviceType: ServiceType;
  kind: "no_upcoming_events" | "ends_soon";
  /** The last upcoming due date for the service, or null when there is none. */
  coveredUntil: DateString | null;
  /** One sentence, e.g. "GST returns is active, but nothing is planned after Dec 2026." */
  message: string;
  /** The one-click fix (§7.7): run "Generate deadlines" for the client. */
  fix: "generate_deadlines";
};

const SERVICE_OF_TYPE: Partial<Record<ComplianceType, ServiceType>> = {
  gstr_1: "gst",
  gstr_3b: "gst",
  tds: "tds",
  roc: "company_law",
  itr: "income_tax",
  advance_tax: "income_tax",
  pf_esic: "payroll",
  pt: "payroll",
  audit: "audit",
};

/**
 * The services an event counts for: its own `serviceType`, else its rule's services, else the
 * compliance type (GST forms recorded as `custom` are recognised by their form code).
 */
export function serviceTypesOfEvent(event: CoverageEvent, rulesByCode?: ReadonlyMap<string, DueDateRule>): ServiceType[] {
  if (event.serviceType) return [event.serviceType];
  const rule = event.ruleCode ? rulesByCode?.get(event.ruleCode) : undefined;
  if (rule?.appliesTo.serviceTypes?.length) return [...rule.appliesTo.serviceTypes];
  const byType = SERVICE_OF_TYPE[event.type];
  if (byType) return [byType];
  if (event.formCode && /^(GSTR|CMP|PMT|IFF)/i.test(event.formCode)) return ["gst"];
  return [];
}

/**
 * Active services with no statutory deadlines planned ahead (§7.7 coverage gaps): none at all, or
 * (for monthly and quarterly services) nothing within `minCoverMonths` (6) of today. Cancelled
 * events and ops-template steps don't count as cover. Only services the calendar fills are checked.
 */
export function coverageGaps(
  services: readonly CoverageService[],
  events: readonly CoverageEvent[],
  today: DateString,
  opts: { params?: CalendarParams; rules?: readonly DueDateRule[] } = {},
): CoverageGap[] {
  const params = opts.params ?? CALENDAR_DEFAULTS;
  const rulesByCode = opts.rules ? new Map(opts.rules.map((r) => [r.code, r])) : undefined;
  const coveredUntil = new Map<ServiceType, DateString>();
  for (const e of events) {
    if (e.status === "cancelled" || e.source === "ops_template" || e.isStatutory === false) continue;
    if (compareDates(e.dueDate, today) < 0) continue;
    for (const s of serviceTypesOfEvent(e, rulesByCode)) {
      const current = coveredUntil.get(s);
      if (!current || compareDates(e.dueDate, current) > 0) coveredUntil.set(s, e.dueDate);
    }
  }
  const threshold = addMonths(today, params.coverage.minCoverMonths);
  const seen = new Set<ServiceType>();
  const gaps: CoverageGap[] = [];
  for (const s of services) {
    if (s.isActive === false || s.frequency === "one_time") continue;
    if (!params.coverage.serviceTypes.includes(s.serviceType) || seen.has(s.serviceType)) continue;
    seen.add(s.serviceType);
    const label = SERVICE_TYPE_LABELS[s.serviceType];
    const until = coveredUntil.get(s.serviceType) ?? null;
    if (until === null) {
      gaps.push({ serviceType: s.serviceType, kind: "no_upcoming_events", coveredUntil: null, message: `${label} is active, but no deadlines are planned.`, fix: "generate_deadlines" });
    } else if ((s.frequency === "monthly" || s.frequency === "quarterly") && compareDates(until, threshold) < 0) {
      gaps.push({
        serviceType: s.serviceType,
        kind: "ends_soon",
        coveredUntil: until,
        message: `${label} is active, but nothing is planned after ${monthPeriodLabel(until)}.`,
        fix: "generate_deadlines",
      });
    }
  }
  return gaps;
}

// =================================================================================================
// The §6.7 seed (`supabase/seed/30_due_date_rules.sql`, written by scripts/gen-due-date-seed.ts)
// =================================================================================================

/** Effective from FY 2025-26, the first year this seed describes (period-based, see `generateEvents`). */
const SEED_FROM = "2025-04-01";

type SeedInput = Omit<DueDateRule, "effectiveFrom" | "effectiveTo" | "isActive" | "verified"> & {
  effectiveFrom?: DateString;
  verified?: boolean;
};

function seed(r: SeedInput): DueDateRule {
  return {
    ...r,
    effectiveFrom: r.effectiveFrom ?? SEED_FROM,
    effectiveTo: null,
    verified: r.verified ?? true,
    isActive: true,
  };
}

const GST: ServiceType[] = ["gst"];
const IT: ServiceType[] = ["income_tax"];
const IT_AUDIT: ServiceType[] = ["income_tax", "audit"];
const TDS: ServiceType[] = ["tds"];
const ROC: ServiceType[] = ["company_law"];
const PAYROLL: ServiceType[] = ["payroll"];
const COMPANIES: EntityType[] = [...COMPANY_ENTITY_TYPES];
const REGULAR_GST: CalendarGstScheme[] = ["monthly", "qrmp"];
const QRMP_3B = SCALE_DEFAULTS.qrmpGstr3b;

const ADVANCE_TAX_SOURCE =
  "Income-tax Act, 1961 s.211: 15 June (15%), 15 September (45%), 15 December (75%), 15 March (100%); s.44AD/44ADA cases pay 100% by 15 March";
const TDS_RETURN_SOURCE =
  "Income-tax Rules, 1962 r.31A: Q1 31 July, Q2 31 October, Q3 31 January, Q4 31 May; Forms 138/140/144 from tax year 2026-27 (Income-tax Act, 2025) [verify]";
const MSME_SOURCE =
  "Specified Companies (Furnishing of information about payment to micro and small enterprise suppliers) Order, 2019: half-yearly, 31 October (April–September) and 30 April (October–March)";
const KA_PT = "Karnataka Tax on Professions, Trades, Callings and Employments Act, 1976";

/** One row per §6.7 rule (§16). [verify] items are `verified: false`. */
export const DUE_DATE_RULE_SEED: readonly DueDateRule[] = [
  // ---- GST (§6.7) ----
  seed({
    code: "GSTR1_MONTHLY",
    title: "GSTR-1 (monthly)",
    complianceType: "gstr_1",
    formCode: "GSTR-1",
    appliesTo: { serviceTypes: GST, gstScheme: "monthly" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 11, filingBar: true },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.37(1); CGST Rules, 2017 r.59(1): 11th of the next month",
  }),
  seed({
    code: "IFF",
    title: "Invoice Furnishing Facility (IFF, optional)",
    complianceType: "gstr_1",
    formCode: "IFF",
    appliesTo: { serviceTypes: GST, gstScheme: "qrmp", optIn: "iff" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 13, monthsOfQuarter: [1, 2] },
    reminderDays: 7,
    sourceRef: "CGST Rules, 2017 r.59(2): optional, 13th of the next month for months 1–2 of the quarter (QRMP)",
  }),
  seed({
    code: "GSTR1_QRMP",
    title: "GSTR-1 (quarterly, QRMP)",
    complianceType: "gstr_1",
    formCode: "GSTR-1",
    appliesTo: { serviceTypes: GST, gstScheme: "qrmp" },
    frequency: "quarterly",
    rule: { afterQuarterEnd: true, monthOffset: 1, day: 13, filingBar: true },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.37(1) proviso; CGST Rules, 2017 r.59(1): 13th of the month after the quarter",
  }),
  seed({
    code: "GSTR3B_MONTHLY",
    title: "GSTR-3B (monthly)",
    complianceType: "gstr_3b",
    formCode: "GSTR-3B",
    appliesTo: { serviceTypes: GST, gstScheme: "monthly" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 20, filingBar: true },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.39(1); CGST Rules, 2017 r.61(5): 20th of the next month",
  }),
  seed({
    code: "GSTR3B_QRMP",
    title: "GSTR-3B (quarterly, QRMP)",
    complianceType: "gstr_3b",
    formCode: "GSTR-3B",
    appliesTo: { serviceTypes: GST, gstScheme: "qrmp" },
    frequency: "quarterly",
    rule: {
      afterQuarterEnd: true,
      monthOffset: 1,
      day: QRMP_3B.defaultDay,
      stateDays: QRMP_3B.stateDays.map((s) => ({ day: s.day, states: [...s.states] })),
      filingBar: true,
    },
    reminderDays: 7,
    sourceRef:
      "CGST Act, 2017 s.39(1) proviso; CGST Rules, 2017 r.61(5) proviso (Notification 82/2020-Central Tax): 22nd for state codes 22–37 (Karnataka 29 included), 24th for every other state",
  }),
  seed({
    code: "PMT06",
    title: "GST payment (PMT-06, QRMP)",
    complianceType: "gstr_3b",
    formCode: "PMT-06",
    appliesTo: { serviceTypes: GST, gstScheme: "qrmp" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 25, monthsOfQuarter: [1, 2] },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.39(7) proviso (Notification 85/2020-Central Tax): 25th of the next month, for months 1–2 of the quarter",
  }),
  seed({
    code: "CMP08",
    title: "CMP-08 statement (composition)",
    complianceType: "gstr_3b",
    formCode: "CMP-08",
    appliesTo: { serviceTypes: GST, gstScheme: "composition" },
    frequency: "quarterly",
    rule: { afterQuarterEnd: true, monthOffset: 1, day: 18 },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.10, s.39(2); CGST Rules, 2017 r.62(1)(i): 18th of the month after the quarter",
  }),
  seed({
    code: "GSTR4",
    title: "GSTR-4 annual return (composition)",
    complianceType: "custom",
    formCode: "GSTR-4",
    appliesTo: { serviceTypes: GST, gstScheme: "composition" },
    frequency: "annual",
    rule: { fixed: "04-30", yearOffset: 1, filingBar: true },
    reminderDays: 15,
    sourceRef: "CGST Act, 2017 s.39(2); CGST Rules, 2017 r.62(1)(ii): 30 April after the FY",
  }),
  seed({
    code: "GSTR7",
    title: "GSTR-7 (TDS under GST)",
    complianceType: "custom",
    formCode: "GSTR-7",
    appliesTo: { serviceTypes: GST, optIn: "gst_tds" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 10, filingBar: true },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.39(3), s.51; CGST Rules, 2017 r.66: 10th of the next month",
  }),
  seed({
    code: "GSTR8",
    title: "GSTR-8 (TCS by e-commerce operators)",
    complianceType: "custom",
    formCode: "GSTR-8",
    appliesTo: { serviceTypes: GST, optIn: "gst_tcs" },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 10, filingBar: true },
    reminderDays: 7,
    sourceRef: "CGST Act, 2017 s.52(4); CGST Rules, 2017 r.67: 10th of the next month",
  }),
  seed({
    code: "GSTR9",
    title: "GSTR-9 annual return",
    complianceType: "custom",
    formCode: "GSTR-9",
    appliesTo: { serviceTypes: GST, gstScheme: REGULAR_GST, minTurnover: 20000000 },
    frequency: "annual",
    rule: { fixed: "12-31", yearOffset: 1, filingBar: true },
    reminderDays: 15,
    sourceRef: "CGST Act, 2017 s.44; CGST Rules, 2017 r.80(1): 31 December after the FY; mandatory above ₹2 crore turnover [verify the optional-filing exemption for the year]",
    verified: false,
  }),
  seed({
    code: "GSTR9C",
    title: "GSTR-9C reconciliation statement",
    complianceType: "custom",
    formCode: "GSTR-9C",
    appliesTo: { serviceTypes: GST, gstScheme: REGULAR_GST, minTurnover: 50000000 },
    frequency: "annual",
    rule: { fixed: "12-31", yearOffset: 1, filingBar: true },
    reminderDays: 15,
    sourceRef: "CGST Act, 2017 s.44; CGST Rules, 2017 r.80(3): 31 December after the FY, above ₹5 crore turnover",
  }),

  // ---- Income tax: returns and audit reports (§6.7; FY 2025-26 / AY 2026-27 and later years) ----
  seed({
    code: "ITR_NON_AUDIT_1_2",
    title: "Income tax return, non-audit (ITR-1 / ITR-2)",
    complianceType: "itr",
    formCode: "ITR",
    appliesTo: { serviceTypes: IT, entityTypes: ["individual", "huf"], auditCase: false, tpCase: false },
    frequency: "annual",
    rule: { fixed: "07-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.139(1): 31 July (corresponding provision of the Income-tax Act, 2025 from tax year 2026-27)",
  }),
  seed({
    code: "ITR_NON_AUDIT_3_4",
    title: "Income tax return, non-audit business or profession (ITR-3 / ITR-4)",
    complianceType: "itr",
    formCode: "ITR",
    appliesTo: { serviceTypes: IT, entityTypes: ["proprietorship"], auditCase: false, tpCase: false },
    frequency: "annual",
    rule: { fixed: "08-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef:
      "Income-tax Act, 1961 s.139(1) as amended by the Finance Act, 2026: 31 August for non-audit business or profession cases, incl. partners of non-audited firms (reported as permanent) [verify]",
    verified: false,
  }),
  seed({
    code: "ITR_NON_AUDIT_5",
    title: "Income tax return, non-audit firm, LLP or AOP (ITR-5)",
    complianceType: "itr",
    formCode: "ITR",
    appliesTo: { serviceTypes: IT, entityTypes: ["partnership", "llp", "aop"], auditCase: false, tpCase: false },
    frequency: "annual",
    rule: { fixed: "07-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef:
      "Income-tax Act, 1961 s.139(1): 31 July for any other assessee. Not listed in §6.7: [verify] whether the Finance Act, 2026 31 August date for non-audit business cases covers firms",
    verified: false,
  }),
  seed({
    code: "TAX_AUDIT_REPORT",
    title: "Tax audit report",
    complianceType: "audit",
    formCode: "Form 3CA/3CB-3CD",
    appliesTo: { serviceTypes: IT_AUDIT, taxAudit: true },
    frequency: "annual",
    rule: { fixed: "09-30", yearOffset: 1, periodLabel: "taxYear", formCode2025: "Form 26" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.44AB: 30 September (Form 3CA/3CB-3CD); Income-tax Act, 2025 s.63: Form 26 [verify]",
    verified: false,
  }),
  seed({
    code: "ITR_AUDIT",
    title: "Income tax return, audit case",
    complianceType: "itr",
    formCode: "ITR",
    appliesTo: { serviceTypes: IT, auditCase: true, tpCase: false },
    frequency: "annual",
    rule: { fixed: "10-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.139(1): 31 October for companies and assessees whose accounts are audited",
  }),
  seed({
    code: "FORM_3CEB",
    title: "Transfer-pricing report (Form 3CEB)",
    complianceType: "audit",
    formCode: "Form 3CEB",
    appliesTo: { serviceTypes: IT_AUDIT, tpCase: true },
    frequency: "annual",
    rule: { fixed: "10-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.92E: 31 October",
  }),
  seed({
    code: "ITR_TP",
    title: "Income tax return, transfer-pricing case",
    complianceType: "itr",
    formCode: "ITR",
    appliesTo: { serviceTypes: IT, tpCase: true },
    frequency: "annual",
    rule: { fixed: "11-30", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.139(1): 30 November for assessees furnishing a s.92E report",
  }),
  seed({
    code: "ITR_BELATED",
    title: "Belated income tax return",
    complianceType: "itr",
    formCode: "ITR (belated)",
    appliesTo: { serviceTypes: IT, optIn: "itr_belated" },
    frequency: "annual",
    rule: { fixed: "12-31", yearOffset: 1, periodLabel: "taxYear" },
    reminderDays: 15,
    sourceRef: "Income-tax Act, 1961 s.139(4): 31 December",
  }),
  seed({
    code: "ITR_REVISED",
    title: "Revised income tax return (last date)",
    complianceType: "itr",
    formCode: "ITR (revised)",
    appliesTo: { serviceTypes: IT, optIn: "itr_revised" },
    frequency: "annual",
    rule: { fixed: "03-31", yearOffset: 2, periodLabel: "taxYear", note: "A fee applies after 9 months from the end of the tax year." },
    reminderDays: 30,
    sourceRef: "Income-tax Act, 1961 s.139(5) as amended by the Finance Act, 2026: up to 12 months from the end of the tax year, with a fee after 9 months [verify]",
    verified: false,
  }),
  seed({
    code: "ITR_UPDATED",
    title: "Updated return, ITR-U (last date)",
    complianceType: "itr",
    formCode: "ITR-U",
    appliesTo: { serviceTypes: IT, optIn: "itr_updated" },
    frequency: "annual",
    rule: { fixed: "03-31", yearOffset: 6, periodLabel: "taxYear", note: "Additional tax is payable with an updated return." },
    reminderDays: 30,
    // The 48-month window still reaches FY 2021-22 (AY 2022-23: open until 31 Mar 2027).
    effectiveFrom: "2021-04-01",
    sourceRef: "Income-tax Act, 1961 s.139(8A): up to 48 months from the end of the relevant assessment year",
  }),

  // ---- Income tax: all years (§6.7) ----
  seed({
    code: "ADVANCE_TAX_Q1",
    title: "Advance tax, 1st instalment",
    complianceType: "advance_tax",
    formCode: "Advance tax",
    appliesTo: { serviceTypes: IT, presumptive: false },
    frequency: "annual",
    rule: { fixed: "06-15", yearOffset: 0, period: "Q1", cumulativePercent: 15 },
    reminderDays: 7,
    sourceRef: ADVANCE_TAX_SOURCE,
  }),
  seed({
    code: "ADVANCE_TAX_Q2",
    title: "Advance tax, 2nd instalment",
    complianceType: "advance_tax",
    formCode: "Advance tax",
    appliesTo: { serviceTypes: IT, presumptive: false },
    frequency: "annual",
    rule: { fixed: "09-15", yearOffset: 0, period: "Q2", cumulativePercent: 45 },
    reminderDays: 7,
    sourceRef: ADVANCE_TAX_SOURCE,
  }),
  seed({
    code: "ADVANCE_TAX_Q3",
    title: "Advance tax, 3rd instalment",
    complianceType: "advance_tax",
    formCode: "Advance tax",
    appliesTo: { serviceTypes: IT, presumptive: false },
    frequency: "annual",
    rule: { fixed: "12-15", yearOffset: 0, period: "Q3", cumulativePercent: 75 },
    reminderDays: 7,
    sourceRef: ADVANCE_TAX_SOURCE,
  }),
  seed({
    code: "ADVANCE_TAX_Q4",
    title: "Advance tax, 4th instalment",
    complianceType: "advance_tax",
    formCode: "Advance tax",
    appliesTo: { serviceTypes: IT },
    frequency: "annual",
    rule: { fixed: "03-15", yearOffset: 1, period: "Q4", cumulativePercent: 100, note: "Presumptive cases (s.44AD / s.44ADA) pay all their advance tax by this date." },
    reminderDays: 7,
    sourceRef: ADVANCE_TAX_SOURCE,
  }),
  seed({
    code: "TDS_DEPOSIT",
    title: "TDS/TCS deposit",
    complianceType: "tds",
    formCode: "TDS deposit",
    appliesTo: { serviceTypes: TDS },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 7, exceptions: [{ periodMonth: 3, monthOffset: 1, day: 30 }] },
    reminderDays: 5,
    sourceRef: "Income-tax Rules, 1962 r.30 and r.37CA: 7th of the next month; tax deducted in March by 30 April",
  }),
  ...([1, 2, 3, 4] as const).map((q) =>
    seed({
      code: `TDS_RETURN_Q${q}`,
      title: "Quarterly TDS statement",
      complianceType: "tds",
      formCode: "24Q/26Q/27Q",
      appliesTo: { serviceTypes: TDS },
      frequency: "quarterly",
      rule: { afterQuarterEnd: true, monthOffset: q === 4 ? 2 : 1, day: 31, quarters: [q], formCode2025: "Form 138/140/144" },
      reminderDays: 10,
      sourceRef: TDS_RETURN_SOURCE,
      verified: false,
    }),
  ),
  seed({
    code: "FORM16",
    title: "Salary TDS certificates to employees",
    complianceType: "tds",
    formCode: "Form 16",
    appliesTo: { serviceTypes: ["tds", "payroll"] },
    frequency: "annual",
    rule: { fixed: "06-15", yearOffset: 1, formCode2025: "Form 130" },
    reminderDays: 15,
    sourceRef: "Income-tax Rules, 1962 r.31: Form 16 by 15 June after the FY; Form 130 from tax year 2026-27 (Income-tax Rules, 2026) [verify]",
    verified: false,
  }),
  seed({
    code: "FORM16A",
    title: "Non-salary TDS certificates",
    complianceType: "tds",
    formCode: "Form 16A",
    appliesTo: { serviceTypes: TDS },
    frequency: "quarterly",
    rule: { afterRuleDue: ["TDS_RETURN_Q1", "TDS_RETURN_Q2", "TDS_RETURN_Q3", "TDS_RETURN_Q4"], days: 15, formCode2025: "Form 131" },
    reminderDays: 7,
    sourceRef: "Income-tax Rules, 1962 r.31: Form 16A within 15 days of the TDS statement due date; Form 131 from tax year 2026-27 (Income-tax Rules, 2026) [verify]",
    verified: false,
  }),

  // ---- Companies Act 2013 and LLP Act 2008 (§6.7) ----
  seed({
    code: "AGM",
    title: "Annual general meeting (last date)",
    complianceType: "roc",
    formCode: "AGM",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES, opc: false },
    frequency: "annual",
    rule: { fixed: "09-30", yearOffset: 1, note: "Enter the AGM date on this event: ADT-1, AOC-4 and MGT-7 are dated from it." },
    reminderDays: 30,
    sourceRef: "Companies Act, 2013 s.96(1): within six months of the FY end (30 September for a March year-end)",
  }),
  seed({
    code: "ADT1",
    title: "Auditor appointment (ADT-1)",
    complianceType: "roc",
    formCode: "ADT-1",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES },
    frequency: "annual",
    rule: { afterEvent: "AGM", days: 15, lateFee: true },
    reminderDays: 7,
    sourceRef: "Companies Act, 2013 s.139(1); Companies (Audit and Auditors) Rules, 2014 r.4(2): within 15 days of the AGM",
  }),
  seed({
    code: "AOC4",
    title: "Financial statements (AOC-4)",
    complianceType: "roc",
    formCode: "AOC-4",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES, opc: false },
    frequency: "annual",
    rule: { afterEvent: "AGM", days: 30, lateFee: true },
    reminderDays: 15,
    sourceRef: "Companies Act, 2013 s.137(1): within 30 days of the AGM",
  }),
  seed({
    code: "AOC4_OPC",
    title: "Financial statements (AOC-4, One Person Company)",
    complianceType: "roc",
    formCode: "AOC-4",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES, opc: true },
    frequency: "annual",
    rule: { daysAfterPeriodEnd: 180, lateFee: true },
    reminderDays: 15,
    sourceRef: "Companies Act, 2013 s.137(1), first proviso: a One Person Company files within 180 days of the FY end",
  }),
  seed({
    code: "MGT7",
    title: "Annual return (MGT-7 / MGT-7A)",
    complianceType: "roc",
    formCode: "MGT-7/MGT-7A",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES },
    frequency: "annual",
    rule: { afterEvent: "AGM", days: 60, lateFee: true },
    reminderDays: 15,
    sourceRef: "Companies Act, 2013 s.92(4): within 60 days of the AGM",
  }),
  seed({
    code: "DPT3",
    title: "Return of deposits (DPT-3)",
    complianceType: "roc",
    formCode: "DPT-3",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES },
    frequency: "annual",
    rule: { fixed: "06-30", yearOffset: 1, lateFee: true },
    reminderDays: 15,
    sourceRef: "Companies (Acceptance of Deposits) Rules, 2014 r.16: 30 June",
  }),
  seed({
    code: "MSME1_H1",
    title: "MSME dues return (MSME-1), April–September",
    complianceType: "roc",
    formCode: "MSME-1",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES },
    frequency: "annual",
    rule: { fixed: "10-31", yearOffset: 0, period: "H1" },
    reminderDays: 15,
    sourceRef: MSME_SOURCE,
  }),
  seed({
    code: "MSME1_H2",
    title: "MSME dues return (MSME-1), October–March",
    complianceType: "roc",
    formCode: "MSME-1",
    appliesTo: { serviceTypes: ROC, entityTypes: COMPANIES },
    frequency: "annual",
    rule: { fixed: "04-30", yearOffset: 1, period: "H2" },
    reminderDays: 15,
    sourceRef: MSME_SOURCE,
  }),
  seed({
    code: "DIR3_KYC_WEB",
    title: "Director KYC (DIR-3 KYC Web)",
    complianceType: "roc",
    formCode: "DIR-3 KYC Web",
    appliesTo: { serviceTypes: ROC },
    frequency: "annual",
    rule: { everyNYears: 3, fixed: "06-30", per: "DIN" },
    reminderDays: 30,
    effectiveFrom: "2026-03-31",
    sourceRef:
      "Companies (Appointment and Qualification of Directors) Rules, 2014 r.12A, as amended by G.S.R. 943(E) dated 31 Dec 2025 (in force 31 Mar 2026): once every three financial years, by 30 June. A change of mobile, email or address is filed within 30 days and doesn't reset the cycle",
  }),
  seed({
    code: "LLP_FORM11",
    title: "LLP annual return (Form 11)",
    complianceType: "roc",
    formCode: "LLP Form 11",
    appliesTo: { serviceTypes: ROC, entityTypes: ["llp"] },
    frequency: "annual",
    rule: { fixed: "05-30", yearOffset: 1, lateFee: true },
    reminderDays: 15,
    sourceRef: "LLP Act, 2008 s.35; LLP Rules, 2009 r.25: 30 May",
  }),
  seed({
    code: "LLP_FORM8",
    title: "LLP statement of account and solvency (Form 8)",
    complianceType: "roc",
    formCode: "LLP Form 8",
    appliesTo: { serviceTypes: ROC, entityTypes: ["llp"] },
    frequency: "annual",
    rule: { fixed: "10-30", yearOffset: 1, lateFee: true },
    reminderDays: 15,
    sourceRef: "LLP Act, 2008 s.34; LLP Rules, 2009 r.24: 30 October",
  }),

  // ---- Labour and state (§6.7) ----
  seed({
    code: "PF_ESIC",
    title: "PF and ESIC contributions",
    complianceType: "pf_esic",
    formCode: "PF/ESIC",
    appliesTo: { serviceTypes: PAYROLL },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 15 },
    reminderDays: 5,
    sourceRef: "EPF Scheme, 1952 para 38; ESI (Central) Regulations, 1950 reg.31: 15th of the next month",
  }),
  seed({
    code: "PT_KA_MONTHLY",
    title: "Professional tax, Karnataka (employer remittance)",
    complianceType: "pt",
    formCode: "PT (Karnataka)",
    appliesTo: { serviceTypes: PAYROLL, states: ["29"] },
    frequency: "monthly",
    rule: { monthOffset: 1, day: 20 },
    reminderDays: 5,
    sourceRef: `${KA_PT}: employer remittance by the 20th of the next month [verify]`,
    verified: false,
  }),
  seed({
    code: "PT_KA_ANNUAL",
    title: "Professional tax enrolment payment, Karnataka",
    complianceType: "pt",
    formCode: "PT enrolment (Karnataka)",
    appliesTo: { serviceTypes: PAYROLL, states: ["29"] },
    frequency: "annual",
    rule: { fixed: "04-30", yearOffset: 0 },
    reminderDays: 15,
    sourceRef: `${KA_PT}: annual enrolment payment by 30 April [verify]`,
    verified: false,
  }),
];

/** The CBDT Circular 07/2026 extensions for AY 2026-27 (§6.7, §16), as override rows (not rule changes). */
export const DUE_DATE_OVERRIDE_SEED: readonly DueDateOverride[] = [
  {
    ruleCode: "TAX_AUDIT_REPORT",
    periodLabel: "AY 2026-27",
    originalDue: "2026-09-30",
    extendedDue: "2026-10-21",
    scope: "Tax audit reports for AY 2026-27 (FY 2025-26)",
    sourceRef: "CBDT Circular 07/2026 dated 28 Sep 2026",
  },
  {
    ruleCode: "ITR_AUDIT",
    periodLabel: "AY 2026-27",
    originalDue: "2026-10-31",
    extendedDue: "2026-11-21",
    scope: "Returns for AY 2026-27 due on 31 October 2026 (audit cases)",
    sourceRef: "CBDT Circular 07/2026 dated 28 Sep 2026",
  },
];

/** The seed rules' `due_date_rules` rows (what the seed SQL inserts; `parseDueDateRuleRow` reads them back). */
export function dueDateRuleRow(rule: DueDateRule): DueDateRuleRow {
  return {
    code: rule.code,
    title: rule.title,
    compliance_type: rule.complianceType,
    form_code: rule.formCode,
    applies_to: rule.appliesTo,
    frequency: rule.frequency,
    rule: rule.rule,
    reminder_days: rule.reminderDays,
    effective_from: rule.effectiveFrom,
    effective_to: rule.effectiveTo,
    source_ref: rule.sourceRef,
    verified: rule.verified,
    is_active: rule.isActive,
  };
}
