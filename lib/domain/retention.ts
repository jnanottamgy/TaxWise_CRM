/**
 * Document retention (§6.8, §5.8 `documents.retention_until`, §7.15.4, §7.19).
 *
 * Every document gets `retention_until` from the **longest** rule that applies:
 * - Engagement documentation / working papers: at least **7 years from the date of the auditor's
 *   report** (SQC 1).
 * - A company's books held by the firm: **8 financial years** (Companies Act s.128(5)): the books of
 *   FY X are kept to the end of FY X + 8.
 * - GST records: **72 months from the due date of the annual return** for that year (CGST Act s.36);
 *   the annual return is due 31 December after the FY ends (s.44) unless an extension moved it.
 * - Income-tax records of professionals and businesses: **6 years from the end of the relevant
 *   assessment year** (Income-tax Rules, 1962, Rule 6F(5)) [verify the 2026 Rules]: records of FY X
 *   are kept to 31 March of the year X + 8 begins in, i.e. the end of the AY (FY X + 1) plus 6 years.
 * - When no rule applies: the upload date + 7 years (the §5.8 default).
 *
 * Purging before `retention_until` is blocked; after it the document goes on a "review for disposal"
 * list. Documents are never deleted automatically.
 *
 * Every period is a parameter (`RETENTION_DEFAULTS`, seeded by `RETENTION_SEED_PARAMETERS`). Pure
 * and client-safe; "today" is passed in.
 */

import { addMonths, daysInMonth, diffDays, financialYearFromStartYear, fyEnd, parseFinancialYear, toDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce, readParameterNumber } from "@/lib/domain/gst";
import { formatDayMonth } from "@/lib/domain/leave";

export type RetentionParams = {
  /** Working papers: years from the auditor's report date (SQC 1). */
  workingPapersYears: number;
  /** A company's books: financial years after the FY of the books (s.128(5)). */
  companyBooksFinancialYears: number;
  /** GST records: months from the annual return's due date (s.36). */
  gstRecordsMonths: number;
  /** The annual return is due on this day of the calendar year in which the FY ends + `yearOffset` (31 Dec, s.44). */
  gstAnnualReturnDue: { month: number; day: number; yearOffset: number };
  /** Income-tax records: years from the end of the relevant assessment year (Rule 6F(5)). */
  incomeTaxYearsAfterAssessmentYear: number;
  /** Fallback when no rule applies: years from the upload date (§5.8). */
  defaultYears: number;
};

/** The §6.8 / §5.8 values. */
export const RETENTION_DEFAULTS: RetentionParams = {
  workingPapersYears: 7,
  companyBooksFinancialYears: 8,
  gstRecordsMonths: 72,
  gstAnnualReturnDue: { month: 12, day: 31, yearOffset: 0 },
  incomeTaxYearsAfterAssessmentYear: 6,
  defaultYears: 7,
};

/** The `statutory_parameters` keys this module reads (documented in the seed file too). */
export const RETENTION_PARAM_KEYS = {
  /** 7: years from the auditor's report (SQC 1). */
  workingPapersYears: "retention.working_papers_years",
  /** 8: financial years for a company's books (s.128(5)). */
  companyBooksFinancialYears: "retention.company_books_financial_years",
  /** 72: months from the GST annual return's due date (s.36). */
  gstRecordsMonths: "retention.gst_records_months",
  /** `{"month": 12, "day": 31, "yearOffset": 0}`: the annual return's due date after the FY (s.44). */
  gstAnnualReturnDue: "retention.gst_annual_return_due",
  /** 6: years from the end of the relevant assessment year (Rule 6F(5)) [verify the 2026 Rules]. */
  incomeTaxYearsAfterAssessmentYear: "retention.income_tax_years_after_ay",
  /** 7: years from upload when no rule applies (§5.8). */
  defaultYears: "retention.default_years",
} as const;

/** The retention rows of `supabase/seed/42_params_practice.sql` (§16: statutory_parameters from §6.8). */
export const RETENTION_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: RETENTION_PARAM_KEYS.workingPapersYears,
    value: 7,
    effectiveFrom: "2009-04-01",
    effectiveTo: null,
    statute: "ICAI Standard on Quality Control (SQC) 1",
    sectionRef: "SQC 1, retention of engagement documentation",
    sourceRef: "SQC 1 (continues to apply: SQM 1 and SQM 2 deferred by ICAI on 31 Mar 2026)",
    notes: "Engagement documentation and working papers are kept for at least 7 years from the date of the auditor's report (§6.8).",
    verified: true,
  },
  {
    key: RETENTION_PARAM_KEYS.companyBooksFinancialYears,
    value: 8,
    effectiveFrom: "2014-04-01",
    effectiveTo: null,
    statute: "Companies Act, 2013",
    sectionRef: "s.128(5)",
    sourceRef: "Companies Act, 2013, s.128(5)",
    notes: "A company's books of account are kept for at least 8 financial years, so the books of FY X held by the firm are kept to the end of FY X + 8 (§6.8).",
    verified: true,
  },
  {
    key: RETENTION_PARAM_KEYS.gstRecordsMonths,
    value: 72,
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: "Central Goods and Services Tax Act, 2017",
    sectionRef: "s.36",
    sourceRef: "CGST Act, 2017, s.36",
    notes: "GST accounts and records are kept until 72 months from the due date of the annual return for the year they relate to (§6.8).",
    verified: true,
  },
  {
    key: RETENTION_PARAM_KEYS.gstAnnualReturnDue,
    value: { month: 12, day: 31, yearOffset: 0 },
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: "Central Goods and Services Tax Act, 2017",
    sectionRef: "s.44",
    sourceRef: "CGST Act, 2017, s.44",
    notes: "The annual return is due on 31 December following the end of the FY. Where a notification extended it, retention runs from the extended date, which the caller passes in.",
    verified: true,
  },
  {
    key: RETENTION_PARAM_KEYS.incomeTaxYearsAfterAssessmentYear,
    value: 6,
    effectiveFrom: "1962-04-01",
    effectiveTo: "2026-03-31",
    statute: "Income-tax Rules, 1962",
    sectionRef: "Rule 6F(5)",
    sourceRef: "Income-tax Rules, 1962, Rule 6F(5)",
    notes: "Books and documents of specified professions are kept for 6 years from the end of the relevant assessment year (§6.8).",
    verified: true,
  },
  {
    key: RETENTION_PARAM_KEYS.incomeTaxYearsAfterAssessmentYear,
    value: 6,
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: "Income-tax Rules, 2026",
    sectionRef: "Rule 6F equivalent [verify]",
    sourceRef: "§6.8: the period the income-tax rules prescribe",
    notes: "Carried forward at 6 years from the end of the relevant year until the 2026 Rules are checked. [verify] the 2026 Rules (§6.8).",
    verified: false,
  },
  {
    key: RETENTION_PARAM_KEYS.defaultYears,
    value: 7,
    effectiveFrom: "2009-04-01",
    effectiveTo: null,
    statute: "Firm practice",
    sectionRef: "§5.8 documents.retention_until default",
    sourceRef: "TaxWise Practice OS specification §5.8",
    notes: "When no specific rule applies, a document is kept for 7 years from its upload date (§5.8).",
    verified: true,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type ResolvedRetentionParams = { params: RetentionParams; missing: string[]; unverified: string[] };

/** The retention periods in force on a date (§5.12), each falling back to its default when missing. */
export function resolveRetentionParams(rows: readonly StatutoryParameterRow[], on: DateString): ResolvedRetentionParams {
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
  const whole = (v: unknown): number | null => {
    const n = readParameterNumber(v);
    return n !== null && Number.isInteger(n) && n > 0 ? n : null;
  };
  const d = RETENTION_DEFAULTS;
  return {
    params: {
      workingPapersYears: read(RETENTION_PARAM_KEYS.workingPapersYears, whole, d.workingPapersYears),
      companyBooksFinancialYears: read(RETENTION_PARAM_KEYS.companyBooksFinancialYears, whole, d.companyBooksFinancialYears),
      gstRecordsMonths: read(RETENTION_PARAM_KEYS.gstRecordsMonths, whole, d.gstRecordsMonths),
      gstAnnualReturnDue: read(
        RETENTION_PARAM_KEYS.gstAnnualReturnDue,
        (v) => {
          const o = asRecord(v);
          const month = readParameterNumber(o?.month);
          const day = readParameterNumber(o?.day);
          const yearOffset = readParameterNumber(o?.yearOffset ?? 0);
          return month !== null && day !== null && yearOffset !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day, yearOffset } : null;
        },
        { ...d.gstAnnualReturnDue },
      ),
      incomeTaxYearsAfterAssessmentYear: read(RETENTION_PARAM_KEYS.incomeTaxYearsAfterAssessmentYear, whole, d.incomeTaxYearsAfterAssessmentYear),
      defaultYears: read(RETENTION_PARAM_KEYS.defaultYears, whole, d.defaultYears),
    },
    missing,
    unverified,
  };
}

// -------------------------------------------------------------------------------------------------
// retention_until (§6.8)
// -------------------------------------------------------------------------------------------------

export type RetentionRule = "working_papers" | "company_books" | "gst_records" | "income_tax_records" | "default";

/** What the caller knows about the document; each filled field makes its rule apply. */
export type RetentionContext = {
  /** Upload date (IST), for the fallback. */
  uploadedOn: DateString;
  /** Engagement documentation / working papers: the auditor's report date. */
  auditReportDate?: DateString | null;
  /** A company's books held by the firm: the FY the books relate to. */
  companyBooksFinancialYear?: FinancialYear | null;
  /** GST records: the FY they relate to. */
  gstFinancialYear?: FinancialYear | null;
  /** GST records: the annual return's actual due date for that FY, when an extension moved it. */
  gstAnnualReturnDueDate?: DateString | null;
  /** Income-tax records: the FY (previous year / tax year) they relate to. */
  incomeTaxFinancialYear?: FinancialYear | null;
};

export type RetentionCandidate = { rule: RetentionRule; until: DateString; explanation: string };

export type RetentionResult = RetentionCandidate & { candidates: RetentionCandidate[] };

function fyStartYear(fy: FinancialYear): number {
  const y = parseFinancialYear(fy);
  if (y === null) throw new RangeError(`Not a financial year (YYYY-YY): ${fy}`);
  return y;
}

/** The GST annual return's statutory due date for an FY (31 Dec after it ends, s.44), clamped to the month. */
export function gstAnnualReturnDueDate(fy: FinancialYear, params: RetentionParams = RETENTION_DEFAULTS): DateString {
  const { month, day, yearOffset } = params.gstAnnualReturnDue;
  const year = fyStartYear(fy) + 1 + yearOffset;
  return toDateString(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * Every rule that applies to the document with its date (§6.8). The fallback (upload + 7 years)
 * appears only when no other rule applies.
 */
export function retentionCandidates(ctx: RetentionContext, params: RetentionParams = RETENTION_DEFAULTS): RetentionCandidate[] {
  const out: RetentionCandidate[] = [];
  if (ctx.auditReportDate) {
    out.push({
      rule: "working_papers",
      until: addMonths(ctx.auditReportDate, params.workingPapersYears * 12),
      explanation: `Working papers: ${params.workingPapersYears} years from the auditor's report (SQC 1)`,
    });
  }
  if (ctx.companyBooksFinancialYear) {
    const lastFy = financialYearFromStartYear(fyStartYear(ctx.companyBooksFinancialYear) + params.companyBooksFinancialYears);
    out.push({
      rule: "company_books",
      until: fyEnd(lastFy),
      explanation: `Company books: ${params.companyBooksFinancialYears} financial years (Companies Act s.128(5))`,
    });
  }
  if (ctx.gstFinancialYear || ctx.gstAnnualReturnDueDate) {
    const due = ctx.gstAnnualReturnDueDate ?? gstAnnualReturnDueDate(ctx.gstFinancialYear as FinancialYear, params);
    out.push({
      rule: "gst_records",
      until: addMonths(due, params.gstRecordsMonths),
      explanation: `GST records: ${params.gstRecordsMonths} months from the annual return due date (CGST Act s.36)`,
    });
  }
  if (ctx.incomeTaxFinancialYear) {
    const assessmentYearEnd = fyEnd(financialYearFromStartYear(fyStartYear(ctx.incomeTaxFinancialYear) + 1));
    out.push({
      rule: "income_tax_records",
      until: addMonths(assessmentYearEnd, params.incomeTaxYearsAfterAssessmentYear * 12),
      explanation: `Income-tax records: ${params.incomeTaxYearsAfterAssessmentYear} years from the end of the assessment year`,
    });
  }
  if (out.length === 0) {
    out.push({
      rule: "default",
      until: addMonths(ctx.uploadedOn, params.defaultYears * 12),
      explanation: `${params.defaultYears} years from upload (no specific rule applies)`,
    });
  }
  return out;
}

/** `retention_until`: the longest rule that applies (§6.8), with the rule that set it and every candidate. */
export function retentionUntil(ctx: RetentionContext, params: RetentionParams = RETENTION_DEFAULTS): RetentionResult {
  const candidates = retentionCandidates(ctx, params);
  const longest = candidates.reduce((best, c) => (diffDays(c.until, best.until) > 0 ? c : best));
  return { ...longest, candidates };
}

// -------------------------------------------------------------------------------------------------
// Purging and disposal review (§6.8, §7.15.4, §7.19)
// -------------------------------------------------------------------------------------------------

/** True once retention has run out: today is after `retention_until` (the date itself is still kept). */
export function retentionExpired(retentionUntilDate: DateString | null, today: DateString): boolean {
  return retentionUntilDate !== null && diffDays(today, retentionUntilDate) > 0;
}

/**
 * Whether a document may be purged (§6.8, §7.19): blocked until `retention_until` has passed, and
 * blocked when no retention date is recorded.
 */
export function canPurge(retentionUntilDate: DateString | null, today: DateString): { ok: true } | { ok: false; error: string } {
  if (retentionUntilDate === null) return { ok: false, error: "This document has no retention date, so it can't be purged. Set one first." };
  if (!retentionExpired(retentionUntilDate, today)) {
    return { ok: false, error: `This document must be kept until ${formatDayMonth(retentionUntilDate, true)} under the retention rules, so it can't be purged yet.` };
  }
  return { ok: true };
}

export type RetainedDocument = { id: string; retentionUntil: DateString | null; deletedAt?: string | null };

/**
 * The "review for disposal" list (§6.8, §7.15.4): documents whose retention has run out, oldest
 * first. Purged documents are left out. Nothing is ever deleted automatically.
 */
export function reviewForDisposal<D extends RetainedDocument>(docs: readonly D[], today: DateString): D[] {
  return docs
    .filter((d) => !d.deletedAt && retentionExpired(d.retentionUntil, today))
    .sort((a, b) => diffDays(a.retentionUntil as DateString, b.retentionUntil as DateString));
}

/** The retention summary (§7.15.4): documents by the calendar year retention ends, ascending. */
export function retentionByYear(docs: readonly RetainedDocument[]): { year: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const d of docs) {
    if (d.deletedAt || d.retentionUntil === null) continue;
    const year = Number(d.retentionUntil.slice(0, 4));
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
}
