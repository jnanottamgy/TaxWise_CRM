import { z } from "zod";
import {
  ASSESSEE_TYPES,
  computeItr,
  ItrInputError,
  validateItrInputs,
  type AssesseeType,
  type ItrDates,
  type ItrInputs,
  type ItrLine,
  type ItrResult,
  type RegimeComputation,
  type SectionCite,
} from "@/lib/domain/itr";
import { AGE_BANDS, AGE_BAND_LABELS, REGIMES, type AgeBand, type ItrRuleSet, type Regime } from "@/lib/domain/itr-rulesets";
import {
  addDays,
  addMonths,
  compareDates,
  fyEnd,
  isDateString,
  isFinancialYear,
  parseFinancialYear,
  toDateString,
  type DateString,
  type FinancialYear,
} from "@/lib/domain/fy";
import { paiseToDecimalString, parseAmount, type Paise } from "@/lib/domain/money";
import type { FieldErrors } from "@/lib/result";

/**
 * ITR computation workpaper (§6.11, §7.8.2): the editor's form values and the actions' inputs (one
 * zod schema shared by both, CONVENTIONS §5), the conversion to the engine's inputs
 * (lib/domain/itr.ts, amounts in integer paise) and back, the age band from the date of birth, the
 * return due date the interest is computed against, the register's filters and sorts, and the
 * side-by-side rows the screen and the PDF both draw from a result. Client-safe; no I/O.
 *
 * Money in the form is the rupee string a MoneyInput holds ("150000", "1500.50", "" when not
 * entered); it becomes paise here and is never a float (§0.1 rule 7). Field names follow the
 * engine's input paths (`income.salaryGross`, `taxesPaid.advanceTax.q1` …) so the engine's own
 * validation errors land on the right field.
 */

// =================================================================================================
// Vocabulary
// =================================================================================================

export const ITR_STATUSES = ["draft", "reviewed", "final"] as const;
export type ItrStatus = (typeof ITR_STATUSES)[number];

export const ITR_STATUS_INFO: Record<ItrStatus, { label: string; tone: "muted" | "violet" | "success"; meaning: string }> = {
  draft: {
    label: "Draft",
    tone: "muted",
    meaning: "Draft: being prepared. Save as often as you like; a reviewer marks it Reviewed and records the regime chosen.",
  },
  reviewed: {
    label: "Reviewed",
    tone: "violet",
    meaning: "Reviewed: checked by someone other than the preparer, with the regime chosen. A Manager or Partner marks it Final.",
  },
  final: {
    label: "Final",
    tone: "success",
    meaning: "Final: the computation the return is filed on. It is locked; a Manager or Partner can reopen it as a draft.",
  },
};

export const REGIME_LABEL: Record<Regime, string> = { new: "New regime", old: "Old regime" };

/** What decides the default due date of the return (§6.7 ITR rules). */
export const RETURN_KINDS = ["non_business", "business", "audit"] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

export const RETURN_KIND_LABEL: Record<ReturnKind, string> = {
  non_business: "No business income (ITR-1 / ITR-2)",
  business: "Business or profession, not audited (ITR-3 / ITR-4)",
  audit: "Accounts audited (audit case)",
};

/** The due_date_rules code for each kind (supabase/seed/30_due_date_rules.sql, §6.7). */
export const RETURN_KIND_RULE: Record<ReturnKind, string> = {
  non_business: "ITR_NON_AUDIT_1_2",
  business: "ITR_NON_AUDIT_3_4",
  audit: "ITR_AUDIT",
};

/** The version of the stored `inputs` shape. Bump it (and teach `storedToForm`) on a breaking change. */
export const ITR_INPUTS_VERSION = 1;

export const ITR_LIMITS = {
  label: 120,
  /** ₹10,000 crore: far above any individual's figure, well inside safe integers in paise. */
  maxAmountPaise: 10_000_000_000_000,
  selfAssessment: 12,
  note: 1000,
} as const;

// =================================================================================================
// Form values
// =================================================================================================

const amountText = z.union([z.string(), z.number()]).optional().default("").transform((v) => String(v ?? "").trim());

export const ItrIncomeFormSchema = z.object({
  salaryGross: amountText,
  salaryOldRegimeExemptions: amountText,
  houseProperty: amountText,
  businessProfession: amountText,
  otherSources: amountText,
  dividends: amountText,
  stcg111a: amountText,
  ltcg112a: amountText,
  ltcg112: amountText,
  earlierTransfers: z
    .object({ stcg111a: amountText, ltcg112a: amountText, ltcg112: amountText })
    .optional()
    .default({ stcg111a: "", ltcg112a: "", ltcg112: "" }),
});

export const ItrDeductionsFormSchema = z.object({
  sec80CBasket: amountText,
  sec80CCD1B: amountText,
  sec80D: z
    .object({ selfFamily: amountText, parents: amountText, parentsSenior: z.boolean().optional().default(false) })
    .optional()
    .default({ selfFamily: "", parents: "", parentsSenior: false }),
  sec80G: amountText,
  sec80TTA_TTB: amountText,
  otherOldRegime: amountText,
  employerNps80CCD2: amountText,
  basicPlusDa: amountText,
  governmentEmployer: z.boolean().optional().default(false),
  otherBothRegimes: amountText,
});

export const ItrSelfAssessmentFormSchema = z.object({
  key: z.string().max(64).optional().default(""),
  amount: amountText,
  paidOn: z.string().trim().optional().default(""),
});

export const ItrTaxesPaidFormSchema = z.object({
  tdsTcs: amountText,
  advanceTax: z
    .object({ q1: amountText, q2: amountText, q3: amountText, q4: amountText, afterQ4: amountText })
    .optional()
    .default({ q1: "", q2: "", q3: "", q4: "", afterQ4: "" }),
  selfAssessment: z
    .array(ItrSelfAssessmentFormSchema)
    .max(ITR_LIMITS.selfAssessment, { error: `Enter at most ${ITR_LIMITS.selfAssessment} self-assessment payments.` })
    .optional()
    .default([]),
});

const optionalUuid = z
  .union([z.uuid(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const dateText = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isDateString(v), { error: `Enter the ${label}, for example 31 Jul 2026.` });

export const ITR_SAVE_INTENTS = ["autosave", "save"] as const;
export type ItrSaveIntent = (typeof ITR_SAVE_INTENTS)[number];

/** The editor's values (§7.8.2). */
export const ItrFormSchema = z.object({
  id: optionalUuid,
  updated_at: z.string().nullish().transform((v) => (v ? v : null)),
  client_id: z.string().trim().refine((v) => z.uuid().safeParse(v).success, { error: "Choose the client." }),
  financial_year: z.string().trim().refine((v) => isFinancialYear(v), { error: "Choose the financial year." }),
  label: z
    .string()
    .trim()
    .max(ITR_LIMITS.label, { error: `Keep the name under ${ITR_LIMITS.label} characters.` })
    .optional()
    .default(""),
  age_band: z.enum(AGE_BANDS, { error: "Choose an age band." }),
  age_band_source: z.enum(["auto", "manual"]).optional().default("auto"),
  resident: z.boolean().optional().default(true),
  presumptive: z.boolean().optional().default(false),
  return_kind: z.enum(RETURN_KINDS).optional().default("non_business"),
  filing_date: dateText("filing date"),
  due_date: dateText("due date of the return"),
  due_date_source: z.enum(["rule", "manual"]).optional().default("rule"),
  income: ItrIncomeFormSchema,
  deductions: ItrDeductionsFormSchema,
  taxesPaid: ItrTaxesPaidFormSchema,
  intent: z.enum(ITR_SAVE_INTENTS).optional().default("save"),
});
export type ItrFormInput = z.input<typeof ItrFormSchema>;
export type ItrFormValues = z.output<typeof ItrFormSchema>;

/** The engine paths whose error belongs to a differently named form field. */
const FIELD_ALIASES: Record<string, string> = {
  filingDate: "filing_date",
  dueDate: "due_date",
  financialYear: "financial_year",
  ageBand: "age_band",
  assesseeType: "client_id",
  "income.earlierTransfers": "income.earlierTransfers.stcg111a",
};

/** Moves the engine's field errors (input paths) onto the form's field names. */
export function engineErrorsToFormErrors(errors: FieldErrors): FieldErrors {
  const out: FieldErrors = {};
  for (const [path, messages] of Object.entries(errors)) {
    const field = FIELD_ALIASES[path] ?? path;
    (out[field] ??= []).push(...messages);
  }
  return out;
}

/** An empty form for a client and year. */
export function blankItrForm(p: {
  clientId: string;
  financialYear: FinancialYear;
  ageBand: AgeBand;
  ageBandSource: "auto" | "manual";
  filingDate: DateString;
  dueDate: DateString;
  returnKind: ReturnKind;
  /** "manual" when no due-date rule gave the date. */
  dueDateSource?: "rule" | "manual";
}): ItrFormInput {
  return {
    id: null,
    updated_at: null,
    client_id: p.clientId,
    financial_year: p.financialYear,
    label: "",
    age_band: p.ageBand,
    age_band_source: p.ageBandSource,
    resident: true,
    presumptive: false,
    return_kind: p.returnKind,
    filing_date: p.filingDate,
    due_date: p.dueDate,
    due_date_source: p.dueDateSource ?? "rule",
    income: {
      salaryGross: "",
      salaryOldRegimeExemptions: "",
      houseProperty: "",
      businessProfession: "",
      otherSources: "",
      dividends: "",
      stcg111a: "",
      ltcg112a: "",
      ltcg112: "",
      earlierTransfers: { stcg111a: "", ltcg112a: "", ltcg112: "" },
    },
    deductions: {
      sec80CBasket: "",
      sec80CCD1B: "",
      sec80D: { selfFamily: "", parents: "", parentsSenior: false },
      sec80G: "",
      sec80TTA_TTB: "",
      otherOldRegime: "",
      employerNps80CCD2: "",
      basicPlusDa: "",
      governmentEmployer: false,
      otherBothRegimes: "",
    },
    taxesPaid: {
      tdsTcs: "",
      advanceTax: { q1: "", q2: "", q3: "", q4: "", afterQ4: "" },
      selfAssessment: [],
    },
    intent: "save",
  };
}

// =================================================================================================
// Form ↔ engine inputs
// =================================================================================================

/** What `inputs` holds in itr_computations (§5.10). */
export type StoredItrInputs = {
  version: typeof ITR_INPUTS_VERSION;
  engine: ItrInputs;
  dates: ItrDates;
  ageBandSource: "auto" | "manual";
  dueDateSource: "rule" | "manual";
  returnKind: ReturnKind;
};

export type FormToInputsResult = { ok: true; stored: StoredItrInputs } | { ok: false; fieldErrors: FieldErrors };

/**
 * The form's values as the engine's inputs (paise). The assessee type comes from the client, never
 * from the form. Every amount is checked here (rupees and paise, at most ₹10,000 crore); the
 * engine's own rules (dividends within other sources, a HUF has no salary, dates …) are checked by
 * `validateItrInputs` when the result is computed.
 */
export function formToStoredInputs(values: ItrFormValues, assesseeType: AssesseeType): FormToInputsResult {
  const errors: FieldErrors = {};
  const add = (field: string, message: string) => {
    (errors[field] ??= []).push(message);
  };
  const amount = (field: string, text: string, allowNegative = false): Paise | undefined => {
    const t = text.trim();
    if (t === "") return undefined;
    const r = parseAmount(t, { allowNegative });
    if (!r.ok) {
      add(field, r.error);
      return undefined;
    }
    if (Math.abs(r.paise) > ITR_LIMITS.maxAmountPaise) {
      add(field, "That amount is too large. Check the figure.");
      return undefined;
    }
    return r.paise;
  };
  const clean = <T extends Record<string, unknown>>(o: T): T => {
    const out = {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return out as T;
  };

  const inc = values.income;
  const earlier = clean({
    stcg111a: amount("income.earlierTransfers.stcg111a", inc.earlierTransfers.stcg111a),
    ltcg112a: amount("income.earlierTransfers.ltcg112a", inc.earlierTransfers.ltcg112a),
    ltcg112: amount("income.earlierTransfers.ltcg112", inc.earlierTransfers.ltcg112),
  });
  const income = clean({
    salaryGross: amount("income.salaryGross", inc.salaryGross),
    salaryOldRegimeExemptions: amount("income.salaryOldRegimeExemptions", inc.salaryOldRegimeExemptions),
    houseProperty: amount("income.houseProperty", inc.houseProperty, true),
    businessProfession: amount("income.businessProfession", inc.businessProfession),
    otherSources: amount("income.otherSources", inc.otherSources),
    dividends: amount("income.dividends", inc.dividends),
    stcg111a: amount("income.stcg111a", inc.stcg111a),
    ltcg112a: amount("income.ltcg112a", inc.ltcg112a),
    ltcg112: amount("income.ltcg112", inc.ltcg112),
    earlierTransfers: Object.keys(earlier).length ? earlier : undefined,
  });

  const d = values.deductions;
  const sec80D = clean({
    selfFamily: amount("deductions.sec80D.selfFamily", d.sec80D.selfFamily),
    parents: amount("deductions.sec80D.parents", d.sec80D.parents),
    parentsSenior: d.sec80D.parentsSenior ? true : undefined,
  });
  const deductions = clean({
    sec80CBasket: amount("deductions.sec80CBasket", d.sec80CBasket),
    sec80CCD1B: amount("deductions.sec80CCD1B", d.sec80CCD1B),
    sec80D: Object.keys(sec80D).length ? sec80D : undefined,
    sec80G: amount("deductions.sec80G", d.sec80G),
    sec80TTA_TTB: amount("deductions.sec80TTA_TTB", d.sec80TTA_TTB),
    otherOldRegime: amount("deductions.otherOldRegime", d.otherOldRegime),
    employerNps80CCD2: amount("deductions.employerNps80CCD2", d.employerNps80CCD2),
    basicPlusDa: amount("deductions.basicPlusDa", d.basicPlusDa),
    governmentEmployer: d.governmentEmployer ? true : undefined,
    otherBothRegimes: amount("deductions.otherBothRegimes", d.otherBothRegimes),
  });

  const p = values.taxesPaid;
  const advanceTax = clean({
    q1: amount("taxesPaid.advanceTax.q1", p.advanceTax.q1),
    q2: amount("taxesPaid.advanceTax.q2", p.advanceTax.q2),
    q3: amount("taxesPaid.advanceTax.q3", p.advanceTax.q3),
    q4: amount("taxesPaid.advanceTax.q4", p.advanceTax.q4),
    afterQ4: amount("taxesPaid.advanceTax.afterQ4", p.advanceTax.afterQ4),
  });
  const selfAssessment: { amount: Paise; paidOn: DateString }[] = [];
  p.selfAssessment.forEach((row, i) => {
    const blank = row.amount.trim() === "" && row.paidOn.trim() === "";
    if (blank) return;
    const a = amount(`taxesPaid.selfAssessment.${i}.amount`, row.amount);
    if (row.amount.trim() === "") add(`taxesPaid.selfAssessment.${i}.amount`, "Enter the amount paid.");
    if (!isDateString(row.paidOn)) add(`taxesPaid.selfAssessment.${i}.paidOn`, "Enter the date it was paid.");
    if (a !== undefined && isDateString(row.paidOn)) selfAssessment.push({ amount: a, paidOn: row.paidOn });
  });
  const taxesPaid = clean({
    tdsTcs: amount("taxesPaid.tdsTcs", p.tdsTcs),
    advanceTax: Object.keys(advanceTax).length ? advanceTax : undefined,
    selfAssessment: selfAssessment.length ? selfAssessment : undefined,
  });

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };

  const engine: ItrInputs = clean({
    financialYear: values.financial_year,
    assesseeType,
    ageBand: assesseeType === "huf" ? "below_60" : values.age_band,
    resident: values.resident === false ? false : undefined,
    presumptive: values.presumptive ? true : undefined,
    income,
    deductions: Object.keys(deductions).length ? deductions : undefined,
    taxesPaid: Object.keys(taxesPaid).length ? taxesPaid : undefined,
  }) as ItrInputs;
  return {
    ok: true,
    stored: {
      version: ITR_INPUTS_VERSION,
      engine,
      dates: { filingDate: values.filing_date, dueDate: values.due_date },
      ageBandSource: values.age_band_source,
      dueDateSource: values.due_date_source,
      returnKind: values.return_kind,
    },
  };
}

function money(p: Paise | undefined): string {
  return p === undefined ? "" : paiseToDecimalString(p).replace(/\.00$/, "");
}

/** Reads `inputs` as stored; null when it isn't in a shape this version knows. */
export function readStoredInputs(json: unknown): StoredItrInputs | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.version !== ITR_INPUTS_VERSION) return null;
  const engine = o.engine as ItrInputs | undefined;
  const dates = o.dates as ItrDates | undefined;
  if (!engine || typeof engine !== "object" || !engine.income || typeof engine.income !== "object") return null;
  if (!dates || !isDateString(dates.filingDate) || !isDateString(dates.dueDate)) return null;
  if (!(ASSESSEE_TYPES as readonly string[]).includes(engine.assesseeType) || !(AGE_BANDS as readonly string[]).includes(engine.ageBand)) return null;
  return {
    version: ITR_INPUTS_VERSION,
    engine,
    dates,
    ageBandSource: o.ageBandSource === "manual" ? "manual" : "auto",
    dueDateSource: o.dueDateSource === "manual" ? "manual" : "rule",
    returnKind: (RETURN_KINDS as readonly unknown[]).includes(o.returnKind) ? (o.returnKind as ReturnKind) : "non_business",
  };
}

/** The stored inputs back as form values (the editor reopens a saved computation). */
export function storedToForm(stored: StoredItrInputs, row: { id: string; updated_at: string; client_id: string; label: string | null }): ItrFormInput {
  const e = stored.engine;
  const inc = e.income ?? {};
  const ear = inc.earlierTransfers ?? {};
  const d = e.deductions ?? {};
  const p = e.taxesPaid ?? {};
  const at = p.advanceTax ?? {};
  return {
    id: row.id,
    updated_at: row.updated_at,
    client_id: row.client_id,
    financial_year: e.financialYear,
    label: row.label ?? "",
    age_band: e.ageBand,
    age_band_source: stored.ageBandSource,
    resident: e.resident !== false,
    presumptive: e.presumptive === true,
    return_kind: stored.returnKind,
    filing_date: stored.dates.filingDate,
    due_date: stored.dates.dueDate,
    due_date_source: stored.dueDateSource,
    income: {
      salaryGross: money(inc.salaryGross),
      salaryOldRegimeExemptions: money(inc.salaryOldRegimeExemptions),
      houseProperty: money(inc.houseProperty),
      businessProfession: money(inc.businessProfession),
      otherSources: money(inc.otherSources),
      dividends: money(inc.dividends),
      stcg111a: money(inc.stcg111a),
      ltcg112a: money(inc.ltcg112a),
      ltcg112: money(inc.ltcg112),
      earlierTransfers: { stcg111a: money(ear.stcg111a), ltcg112a: money(ear.ltcg112a), ltcg112: money(ear.ltcg112) },
    },
    deductions: {
      sec80CBasket: money(d.sec80CBasket),
      sec80CCD1B: money(d.sec80CCD1B),
      sec80D: { selfFamily: money(d.sec80D?.selfFamily), parents: money(d.sec80D?.parents), parentsSenior: d.sec80D?.parentsSenior === true },
      sec80G: money(d.sec80G),
      sec80TTA_TTB: money(d.sec80TTA_TTB),
      otherOldRegime: money(d.otherOldRegime),
      employerNps80CCD2: money(d.employerNps80CCD2),
      basicPlusDa: money(d.basicPlusDa),
      governmentEmployer: d.governmentEmployer === true,
      otherBothRegimes: money(d.otherBothRegimes),
    },
    taxesPaid: {
      tdsTcs: money(p.tdsTcs),
      advanceTax: { q1: money(at.q1), q2: money(at.q2), q3: money(at.q3), q4: money(at.q4), afterQ4: money(at.afterQ4) },
      selfAssessment: (p.selfAssessment ?? []).map((s, i) => ({ key: `sa${i}`, amount: money(s.amount), paidOn: s.paidOn })),
    },
    intent: "save",
  };
}

export type ComputeOutcome = { ok: true; result: ItrResult } | { ok: false; fieldErrors: FieldErrors };

/**
 * Computes both regimes for stored inputs with a rule set (§6.11), with the engine's validation
 * errors moved onto the form's fields. The server calls this on every save; the editor calls it
 * for the live preview (the saved figures are always the server's).
 */
export function computeStored(stored: StoredItrInputs, ruleSet: ItrRuleSet): ComputeOutcome {
  const errors = validateItrInputs(stored.engine, ruleSet, stored.dates);
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: engineErrorsToFormErrors(errors) };
  try {
    return { ok: true, result: computeItr(stored.engine, ruleSet, stored.dates) };
  } catch (err) {
    if (err instanceof ItrInputError) return { ok: false, fieldErrors: engineErrorsToFormErrors(err.fieldErrors) };
    throw err;
  }
}

/** True when two results say the same thing (a stored result against a fresh computation). */
export function sameResult(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

// =================================================================================================
// Age band and the due date of the return
// =================================================================================================

/**
 * The age band for the old-regime basic exemption (§6.11, §7.8.2) from the date of birth: the age
 * attained by the end of the FY, a person attaining an age on the day before the anniversary of
 * their birth (so someone born on 1 April 1966 is 60 in FY 2025-26). Null without a valid date of
 * birth or FY.
 */
export function ageBandFor(dateOfBirth: string | null | undefined, fy: FinancialYear): AgeBand | null {
  if (!dateOfBirth || !isDateString(dateOfBirth) || !isFinancialYear(fy)) return null;
  const dayAfterYearEnd = addDays(fyEnd(fy), 1);
  if (compareDates(dateOfBirth, dayAfterYearEnd) > 0) return null;
  const attained = (years: number) => compareDates(addMonths(dateOfBirth, years * 12), dayAfterYearEnd) <= 0;
  if (attained(80)) return "80_plus";
  if (attained(60)) return "60_to_79";
  return "below_60";
}

export function ageBandLabel(band: AgeBand): string {
  return AGE_BAND_LABELS[band];
}

/** A `{ fixed: "MM-DD", yearOffset }` due-date rule (§5.12 due_date_rules.rule). */
export type FixedRule = { fixed: string; yearOffset: number };

export function readFixedRule(rule: unknown): FixedRule | null {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const o = rule as Record<string, unknown>;
  if (typeof o.fixed !== "string" || !/^\d{2}-\d{2}$/.test(o.fixed)) return null;
  const yearOffset = typeof o.yearOffset === "number" && Number.isInteger(o.yearOffset) ? o.yearOffset : 0;
  return { fixed: o.fixed, yearOffset };
}

/** The date a fixed rule gives for an FY: `07-31` with offset 1 → 31 July after the year. */
export function fixedRuleDate(rule: FixedRule, fy: FinancialYear): DateString | null {
  const start = parseFinancialYear(fy);
  if (start === null) return null;
  const month = Number(rule.fixed.slice(0, 2));
  const day = Number(rule.fixed.slice(3, 5));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = start + rule.yearOffset;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toDateString(year, month, Math.min(day, last));
}

export type ReturnDueDate = {
  date: DateString;
  /** "31 July after the year (s.139(1))", or the circular that extended it. */
  basis: string;
  extended: boolean;
};

/**
 * The due date of the return for each kind of case and FY (§6.7): the rule's date, moved by a
 * government extension recorded for that rule and year (due_date_overrides, by the year's label,
 * e.g. "AY 2026-27").
 */
export function returnDueDates(input: {
  fy: FinancialYear;
  yearLabel: string;
  rules: ReadonlyArray<{ code: string; title: string; rule: unknown; sourceRef: string | null }>;
  overrides: ReadonlyArray<{ ruleCode: string; periodLabel: string; extendedDue: DateString; sourceRef: string }>;
}): Partial<Record<ReturnKind, ReturnDueDate>> {
  const out: Partial<Record<ReturnKind, ReturnDueDate>> = {};
  for (const kind of RETURN_KINDS) {
    const code = RETURN_KIND_RULE[kind];
    const rule = input.rules.find((r) => r.code === code);
    const fixed = rule ? readFixedRule(rule.rule) : null;
    const base = fixed ? fixedRuleDate(fixed, input.fy) : null;
    if (!rule || !base) continue;
    const override = input.overrides.find((o) => o.ruleCode === code && o.periodLabel === input.yearLabel && isDateString(o.extendedDue));
    out[kind] = override
      ? { date: override.extendedDue, basis: `Extended by ${override.sourceRef}`, extended: true }
      : { date: base, basis: rule.sourceRef ?? rule.title, extended: false };
  }
  return out;
}

/** The kind of case to default to: audited when the client's tax audit is confirmed, business when there is business income. */
export function defaultReturnKind(p: { taxAuditApplicable: string | null | undefined; businessIncome: boolean }): ReturnKind {
  if (p.taxAuditApplicable === "yes") return "audit";
  return p.businessIncome ? "business" : "non_business";
}

// =================================================================================================
// The register's filters and sorts (§2.3)
// =================================================================================================

export const ITR_LIST_SORTABLE = ["client_name", "financial_year", "status", "saving_paise", "balance_paise", "updated_at"] as const;
export type ItrListSort = (typeof ITR_LIST_SORTABLE)[number];

export const ITR_LIST_FILTERS = {
  status: ITR_STATUSES,
  fy: null,
  regime: REGIMES,
  client: null,
  mine: ["1"],
} as const;
export type ItrListFilter = keyof typeof ITR_LIST_FILTERS;

// =================================================================================================
// Status changes
// =================================================================================================

const updatedAt = z.string().min(1, { error: "Reload the computation and try again." });

export const ItrRefSchema = z.object({ id: z.uuid(), updatedAt });

export const ItrStatusSchema = z
  .object({
    id: z.uuid(),
    updatedAt,
    status: z.enum(ITR_STATUSES),
    regime: z.union([z.enum(REGIMES), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
    note: z
      .string()
      .trim()
      .max(ITR_LIMITS.note, { error: `Keep the note under ${ITR_LIMITS.note.toLocaleString("en-IN")} characters.` })
      .optional()
      .default(""),
  })
  .superRefine((v, ctx) => {
    if (v.status === "reviewed" && !v.regime) ctx.addIssue({ code: "custom", path: ["regime"], message: "Choose the regime the return will be filed under." });
    if (v.status === "draft" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say why it goes back to Draft, so the preparer knows what to change." });
  });
export type ItrStatusInput = z.input<typeof ItrStatusSchema>;

export const ItrClientSearchSchema = z.object({ q: z.string().trim().max(100).optional().default("") });
export const ItrClientContextSchema = z.object({ clientId: z.uuid(), financialYear: z.string().refine((v) => isFinancialYear(v)) });

/** What a person may do with a computation (the screen's buttons; the database decides again). */
export function itrActions(
  s: { status: ItrStatus; preparedBy: string | null },
  viewer: { id: string; role: "partner" | "manager" | "employee" },
): { edit: boolean; review: boolean; changeRegime: boolean; finalise: boolean; sendBack: boolean; reopen: boolean; delete: boolean } {
  const mp = viewer.role === "partner" || viewer.role === "manager";
  const notPreparer = s.preparedBy !== viewer.id || viewer.role === "partner";
  return {
    edit: s.status !== "final",
    review: s.status === "draft" && notPreparer,
    changeRegime: s.status === "reviewed" && notPreparer,
    finalise: s.status === "reviewed" && mp,
    sendBack: s.status === "reviewed",
    reopen: s.status === "final" && mp,
    delete: s.status !== "final" && mp,
  };
}

// =================================================================================================
// The side-by-side sheet (§6.11 "a computation sheet with every line explained, the regime
// comparison, the saving, and the recommended regime")
// =================================================================================================

export type SheetCell = { amount: Paise; note?: string; detail?: string };

export type SheetRow = {
  code: string;
  label: string;
  section?: SectionCite;
  /** Subtotals and the balance print in bold. */
  emphasis: boolean;
  /** A heading row (no figures) that starts a group. */
  group?: string;
  cells: Partial<Record<Regime, SheetCell>>;
};

const EMPHASIS = new Set(["income.salary", "gti", "deductions.total", "total_income", "tax.normal", "tax.special", "tax.after_rebate", "tax.liability_rounded", "interest.total", "paid.total", "balance"]);

const GROUP_STARTS: ReadonlyArray<[string, string]> = [
  ["salary.gross", "Income"],
  ["deduction.", "Deductions (Chapter VI-A)"],
  ["tax.slab.", "Tax"],
  ["interest.234A", "Interest"],
  ["paid.tds_tcs", "Taxes paid and balance"],
];

/** Lines that say nothing in either regime (an untouched deduction, a nil sub-line) are left out. */
const ALWAYS = new Set(["income.salary", "gti", "deductions.total", "total_income", "tax.normal", "tax.before_rebate", "tax.after_rebate", "tax.cess", "tax.liability", "tax.liability_rounded", "interest.total", "paid.total", "balance"]);

function slabIndex(code: string): number | null {
  const m = /^tax\.slab\.(\d+)$/.exec(code);
  return m ? Number(m[1]) : null;
}

/**
 * The two regimes' lines aligned row by row: one row per line code in the engine's order (a code
 * only one regime has, such as its own slab bands, sits where that regime puts it). A slab row is
 * labelled by its number; each cell carries its own regime's wording ("5% on ₹4,00,001 to
 * ₹8,00,000") and the engine's explanation.
 */
export function sideBySideRows(result: Pick<ItrResult, "regimes">): SheetRow[] {
  const byRegime: Record<Regime, ItrLine[]> = { new: result.regimes.new.lines, old: result.regimes.old.lines };
  const order: string[] = byRegime.new.map((l) => l.code);
  let anchor = -1;
  for (const l of byRegime.old) {
    const at = order.indexOf(l.code);
    if (at >= 0) {
      anchor = at;
      continue;
    }
    order.splice(anchor + 1, 0, l.code);
    anchor += 1;
  }

  const rows: SheetRow[] = [];
  const seenGroups = new Set<string>();
  for (const code of order) {
    const cells: Partial<Record<Regime, SheetCell>> = {};
    let label = "";
    let section: SectionCite | undefined;
    for (const regime of REGIMES) {
      const line = byRegime[regime].find((l) => l.code === code);
      if (!line) continue;
      const slab = slabIndex(code);
      cells[regime] = { amount: line.amount === 0 ? 0 : line.amount, note: line.note, detail: slab !== null ? line.label : undefined };
      if (!label) label = slab !== null ? `Tax on slab ${slab}` : line.label;
      section ??= line.section;
    }
    // A deduction nobody claimed is nil in both regimes; its cap note alone doesn't earn it a row.
    const nothing = REGIMES.every((r) => !cells[r] || (cells[r]!.amount === 0 && (code.startsWith("deduction.") || !cells[r]!.note)));
    if (nothing && !ALWAYS.has(code)) continue;
    const group = GROUP_STARTS.find(([prefix, name]) => !seenGroups.has(name) && (code === prefix || code.startsWith(prefix)))?.[1];
    if (group) seenGroups.add(group);
    rows.push({ code, label, section, emphasis: EMPHASIS.has(code), group, cells });
  }
  return rows;
}

/** One figure for each regime, for the comparison strip. */
export function regimeSummary(c: RegimeComputation): { totalIncome: Paise; liability: Paise; interest: Paise; taxAndInterest: Paise; paid: Paise; balance: Paise } {
  return {
    totalIncome: c.totalIncome,
    liability: c.taxLiabilityRounded,
    interest: c.interest.total,
    taxAndInterest: c.totalTaxAndInterest,
    paid: c.taxesPaid.total,
    balance: c.balance,
  };
}

/** "Tax payable ₹12,340" / "Refund due ₹4,560" / "Nothing payable". */
export function balanceWords(balance: Paise, format: (p: Paise) => string): string {
  if (balance > 0) return `Tax payable ${format(balance)}`;
  if (balance < 0) return `Refund due ${format(-balance)}`;
  return "Nothing payable or refundable";
}

/** The labels a screen or PDF uses for the interest sections of the year's statute (§6.1). */
export function interestSectionLabels(result: Pick<ItrResult, "regimes">, context: "screen" | "pdf"): { s234A: string; s234B: string; s234C: string } {
  const find = (code: string) => result.regimes.new.lines.find((l) => l.code === code)?.section;
  const pick = (code: string, fallback: string) => {
    const s = find(code);
    return s ? (context === "pdf" ? s.pdfLabel : s.label) : fallback;
  };
  return { s234A: pick("interest.234A", "s.234A"), s234B: pick("interest.234B", "s.234B"), s234C: pick("interest.234C", "s.234C") };
}

/** The short section number for a heading ("s.234A", or "s.423" under the 2025 Act). */
export function shortSection(cite: SectionCite | undefined, statute: "1961" | "2025"): string | null {
  if (!cite) return null;
  const m = /^s\.(\S+)/.exec(cite.label);
  if (!m) return null;
  return statute === "2025" && !cite.verified ? `s.${m[1]} [verify]` : `s.${m[1]}`;
}
