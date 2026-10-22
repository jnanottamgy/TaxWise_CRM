/**
 * ICAI practice limits and gates (§6.8, §6.9, §7.15.1, §7.15.5): the tax-audit ceiling, the company
 * audit limit, the UDIN 60-day rule, peer review validity, KYC completeness and the audit stage gates.
 *
 * - **Tax audit ceiling** (Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025; in
 *   force from 1 April 2026): 60 tax audit reports per member per financial year, counted by the
 *   **date signed**. Counted: Form 3CA, and Form 3CB under s.44AB(a), (b) and "combined". Not counted:
 *   3CB under s.44AB(c), (d), (e). Form 26 (2025 Act): the equivalent categories [verify mapping].
 *   Head office and branch audits of the same assessee for the same year count as one; revised
 *   reports don't count separately; audits signed elsewhere are added. Warn at 50 and 58; a 61st
 *   needs a Partner's confirmation. Mirrors `tax_audit_ceiling_view` and the `udin_records` trigger.
 * - **Company audit limit** (Companies Act s.141(3)(g)): 20 per partner, excluding OPCs, small
 *   companies, dormant companies and private companies with paid-up capital under ₹100 crore. Warn
 *   from the 18th countable audit.
 * - **UDIN** within 60 days of signing; the dashboard shows days left, then days overdue.
 * - **Peer review:** the certificate must be valid on the acceptance date; warn 90 days before expiry.
 * - **Stage gates:** an audit can't move past Acceptance without complete KYC and an engagement
 *   letter at Issued (SA 210), and can't reach Planning without the previous-auditor letter with proof
 *   of delivery (CA Act, First Schedule, Part I, Clause 8). The engagement partner approves each move.
 *
 * Every number is a parameter (`CEILING_DEFAULTS`, seeded by `CEILING_SEED_PARAMETERS`). Pure and
 * client-safe; dates are `'YYYY-MM-DD'` and "today" is passed in.
 */

import type { AppRole, EngagementStatus } from "@/lib/domain/enums";
import { addDays, addMonths, diffDays, financialYearOf, type DateString, type FinancialYear } from "@/lib/domain/fy";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce, readParameterNumber } from "@/lib/domain/gst";
import { toPaise, type Paise } from "@/lib/domain/money";

// -------------------------------------------------------------------------------------------------
// Parameters
// -------------------------------------------------------------------------------------------------

/** `udin_records.report_form` values (§5.12). */
export const REPORT_FORMS = [
  "3CA",
  "3CB_44AB_a",
  "3CB_44AB_b",
  "3CB_combined",
  "3CB_44AB_c",
  "3CB_44AB_d",
  "3CB_44AB_e",
  "FORM_26",
  "audit_report",
  "certificate",
  "gst_audit",
  "other",
] as const;
export type ReportForm = (typeof REPORT_FORMS)[number];

/** Form 26 categories, named after the s.44AB clause they replace (2025 Act mapping [verify]). */
export const FORM_26_CATEGORIES = ["a", "b", "combined", "c", "d", "e"] as const;
export type Form26Category = (typeof FORM_26_CATEGORIES)[number];

export type CeilingParams = {
  /** Tax audit reports per member per FY (60). */
  taxAuditCeiling: number;
  /** Counts at which the member is warned (50, 58). */
  taxAuditWarnAt: readonly number[];
  /** The 3CB forms that count (3CA always counts). */
  countedForm3cb: readonly ReportForm[];
  /** Form 26 categories that count [verify]. */
  form26CountedCategories: readonly Form26Category[];
  /** Company audits per partner (20). */
  companyAuditLimit: number;
  /** Warn when the new audit would be this one or later (18). */
  companyAuditWarnFrom: number;
  /** Private companies with paid-up capital below this don't count (₹100 crore, in paise). */
  privateCompanyPaidUpExclusionPaise: Paise;
  /** UDIN within this many days of signing (60). */
  udinGenerationDays: number;
  /** Warn this many days before a peer review certificate expires (90). */
  peerReviewWarningDays: number;
  /** KYC is re-confirmed this many months after it was last verified (annually: 12). */
  kycReconfirmMonths: number;
};

/** The §6.8 values. */
export const CEILING_DEFAULTS: CeilingParams = {
  taxAuditCeiling: 60,
  taxAuditWarnAt: [50, 58],
  countedForm3cb: ["3CB_44AB_a", "3CB_44AB_b", "3CB_combined"],
  form26CountedCategories: ["a", "b", "combined"],
  companyAuditLimit: 20,
  companyAuditWarnFrom: 18,
  privateCompanyPaidUpExclusionPaise: 100_00_00_000_00, // ₹100 crore
  udinGenerationDays: 60,
  peerReviewWarningDays: 90,
  kycReconfirmMonths: 12,
};

/** The `statutory_parameters` keys this module reads (documented in the seed file too). */
export const CEILING_PARAM_KEYS = {
  /** 60: tax audit reports per member per FY (read by `tax_audit_ceiling_view`). */
  taxAuditCeiling: "audit.tax_audit_ceiling",
  /** `[50, 58]`: warning counts (read by `tax_audit_ceiling_view`). */
  taxAuditWarnAt: "audit.tax_audit_ceiling_warn_at",
  /** `{"counted": ["a","b","combined"], "notCounted": ["c","d","e"]}`: Form 26 categories [verify]. */
  form26Categories: "audit.tax_audit_form26_categories",
  /** 20: company audits per partner (s.141(3)(g)). */
  companyAuditLimit: "audit.company_audit_limit",
  /** 18: warn from this countable company audit. */
  companyAuditWarnFrom: "audit.company_audit_limit_warn_from",
  /** `{"amount": 1000000000}`: private companies below ₹100 crore paid-up don't count. */
  companyAuditPrivatePaidUpExclusion: "audit.company_audit_private_paid_up_exclusion",
  /** 60: UDIN within this many days of signing. */
  udinGenerationDays: "udin.generation_days",
  /** 90: warn this many days before a peer review certificate expires. */
  peerReviewWarningDays: "peer_review.expiry_warning_days",
  /** 12: KYC is re-confirmed annually (KYC Norms). */
  kycReconfirmMonths: "kyc.reconfirm_months",
} as const;

const TAX_AUDIT_GUIDELINES = "Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025";
const COMPANIES_ACT = "Companies Act, 2013";

/**
 * The ICAI rows of `supabase/seed/42_params_practice.sql` (§16: statutory_parameters from §6.8).
 * The Form 26 mapping is [verify], so it is seeded unverified.
 */
export const CEILING_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: CEILING_PARAM_KEYS.udinGenerationDays,
    value: 60,
    effectiveFrom: "2021-09-17",
    effectiveTo: null,
    statute: "ICAI UDIN Guidelines",
    sectionRef: "UDIN for certificates, GST/tax audit reports and audit reports",
    sourceRef: "ICAI Council decision dated 17 Sep 2021",
    notes: "A UDIN must be generated within 60 days of signing the document, or at once if a regulator asks (§6.8). The dashboard lists signed documents with no UDIN and the days left.",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.taxAuditCeiling,
    value: 60,
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: TAX_AUDIT_GUIDELINES,
    sectionRef: "Tax audits per member per financial year",
    sourceRef: "ICAI Guidelines, 2025, in force from 1 Apr 2026; enforced on the UDIN portal (FAQs on UDIN ceiling on tax audit)",
    notes: "60 tax audit reports per member per FY, counted by the date signed. Counted: 3CA, 3CB u/s 44AB(a), (b) and combined. Not counted: 3CB u/s 44AB(c), (d), (e). Head office and branch audits of the same assessee and year count as one; revised reports don't count separately; audits in individual capacity and across firms are aggregated.",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.taxAuditWarnAt,
    value: [50, 58],
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: TAX_AUDIT_GUIDELINES,
    sectionRef: "§6.8 firm practice: ceiling warnings",
    sourceRef: "TaxWise Practice OS specification §6.8",
    notes: "Warn the partner at 50 and 58 tax audits in the FY; logging a 61st needs a Partner's confirmation (§6.8).",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.form26Categories,
    value: { counted: ["a", "b", "combined"], notCounted: ["c", "d", "e"] },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: TAX_AUDIT_GUIDELINES,
    sectionRef: "Form 26 under the Income-tax Act, 2025 [verify]",
    sourceRef: "§6.8: the equivalent categories apply to Form 26",
    notes: "Form 26 reports count like 3CB under the s.44AB clause they replace: (a), (b) and combined count; (c), (d) and (e) don't. [verify] the mapping to the 2025 Act's tax audit provision.",
    verified: false,
  },
  {
    key: CEILING_PARAM_KEYS.companyAuditLimit,
    value: 20,
    effectiveFrom: "2014-04-01",
    effectiveTo: null,
    statute: COMPANIES_ACT,
    sectionRef: "s.141(3)(g)",
    sourceRef: "Companies Act, 2013, s.141(3)(g), as amended",
    notes: "No more than 20 company audits per partner, excluding one person companies, small companies, dormant companies and private companies with paid-up share capital under ₹100 crore.",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.companyAuditWarnFrom,
    value: 18,
    effectiveFrom: "2014-04-01",
    effectiveTo: null,
    statute: COMPANIES_ACT,
    sectionRef: "§6.8 firm practice: company audit warning",
    sourceRef: "TaxWise Practice OS specification §6.8",
    notes: "Warn when a Partner is engaging partner on the 18th or later countable company audit (§6.8).",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.companyAuditPrivatePaidUpExclusion,
    value: { amount: 1000000000 },
    effectiveFrom: "2015-06-05",
    effectiveTo: null,
    statute: COMPANIES_ACT,
    sectionRef: "s.141(3)(g)",
    sourceRef: "Companies Act, 2013, s.141(3)(g), as amended (MCA exemption notification for private companies, G.S.R. 464(E) dated 5 Jun 2015)",
    notes: "Private companies with paid-up share capital under ₹100 crore (₹1,00,00,00,000) don't count towards the 20-audit limit. Amount in rupees.",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.peerReviewWarningDays,
    value: 90,
    effectiveFrom: "2022-10-01",
    effectiveTo: null,
    statute: "ICAI Peer Review Guidelines 2022",
    sectionRef: "§6.8 firm practice: certificate expiry warning",
    sourceRef: "Peer Review Guidelines 2022 (effective 1 Oct 2022); TaxWise Practice OS specification §6.8",
    notes: "Warn 90 days before the peer review certificate expires; check it is valid on the acceptance date of a statutory audit that needs a peer-reviewed auditor.",
    verified: true,
  },
  {
    key: CEILING_PARAM_KEYS.kycReconfirmMonths,
    value: 12,
    effectiveFrom: "2017-01-01",
    effectiveTo: null,
    statute: "ICAI KYC Norms for members in practice",
    sectionRef: "Annual re-confirmation of client KYC",
    sourceRef: "ICAI KYC Norms, mandatory for attest engagements from 1 Jan 2017",
    notes: "Client KYC is complete before an audit or certification engagement moves past acceptance, and is re-confirmed annually (§6.8).",
    verified: true,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type ResolvedCeilingParams = { params: CeilingParams; missing: string[]; unverified: string[] };

/** The ICAI parameters in force on a date (§5.12), each falling back to its default when missing. */
export function resolveCeilingParams(rows: readonly StatutoryParameterRow[], on: DateString): ResolvedCeilingParams {
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
  const positiveInt = (v: unknown): number | null => {
    const n = readParameterNumber(v);
    return n !== null && Number.isInteger(n) && n > 0 ? n : null;
  };
  const d = CEILING_DEFAULTS;
  const params: CeilingParams = {
    taxAuditCeiling: read(CEILING_PARAM_KEYS.taxAuditCeiling, positiveInt, d.taxAuditCeiling),
    taxAuditWarnAt: read(
      CEILING_PARAM_KEYS.taxAuditWarnAt,
      (v) => (Array.isArray(v) && v.every((x) => Number.isInteger(x) && (x as number) > 0) ? [...(v as number[])].sort((a, b) => a - b) : null),
      [...d.taxAuditWarnAt],
    ),
    countedForm3cb: [...d.countedForm3cb],
    form26CountedCategories: read(
      CEILING_PARAM_KEYS.form26Categories,
      (v) => {
        const counted = asRecord(v)?.counted;
        return Array.isArray(counted) && counted.every((c) => (FORM_26_CATEGORIES as readonly unknown[]).includes(c)) ? (counted as Form26Category[]) : null;
      },
      [...d.form26CountedCategories],
    ),
    companyAuditLimit: read(CEILING_PARAM_KEYS.companyAuditLimit, positiveInt, d.companyAuditLimit),
    companyAuditWarnFrom: read(CEILING_PARAM_KEYS.companyAuditWarnFrom, positiveInt, d.companyAuditWarnFrom),
    privateCompanyPaidUpExclusionPaise: read(
      CEILING_PARAM_KEYS.companyAuditPrivatePaidUpExclusion,
      (v) => {
        const n = readParameterNumber(v);
        return n === null || n < 0 ? null : toPaise(n);
      },
      d.privateCompanyPaidUpExclusionPaise,
    ),
    udinGenerationDays: read(CEILING_PARAM_KEYS.udinGenerationDays, positiveInt, d.udinGenerationDays),
    peerReviewWarningDays: read(CEILING_PARAM_KEYS.peerReviewWarningDays, positiveInt, d.peerReviewWarningDays),
    kycReconfirmMonths: read(CEILING_PARAM_KEYS.kycReconfirmMonths, positiveInt, d.kycReconfirmMonths),
  };
  return { params, missing, unverified };
}

// -------------------------------------------------------------------------------------------------
// Tax audit ceiling (§6.8)
// -------------------------------------------------------------------------------------------------

/**
 * Whether one report counts towards the ceiling (§6.8; same rule as the `udin_records` trigger):
 * revised reports never; 3CA and 3CB u/s 44AB(a), (b), combined yes; Form 26 by its category
 * (counted when the category isn't recorded, as the trigger defaults); everything else no. Null when
 * the report form isn't recorded.
 */
export function countsTowardsTaxAuditCeiling(
  report: { reportForm: ReportForm | null; isRevised: boolean; form26Category?: Form26Category | null },
  params: CeilingParams = CEILING_DEFAULTS,
): boolean | null {
  if (report.isRevised) return false;
  if (report.reportForm === null) return null;
  if (report.reportForm === "3CA") return true;
  if (params.countedForm3cb.includes(report.reportForm)) return true;
  if (report.reportForm === "FORM_26") return report.form26Category ? params.form26CountedCategories.includes(report.form26Category) : true;
  return false;
}

/** A UDIN record as the ceiling count reads it. */
export type CeilingUdinRecord = {
  id: string;
  signingMemberId: string | null;
  signedOn: DateString;
  reportForm: ReportForm | null;
  isRevised: boolean;
  /** The assessee; head office and branch reports of the same client and year count once. */
  clientId: string | null;
  /** The FY the report covers (`udin_records.financial_year`), for the head-office/branch rule. */
  financialYear?: FinancialYear | null;
  form26Category?: Form26Category | null;
};

export type CeilingWarning = "near" | "at_ceiling" | "over";

export type TaxAuditCount = {
  memberId: string;
  financialYear: FinancialYear;
  /** Reports signed in this firm that count, after the head-office/branch rule. */
  signedInFirm: number;
  /** "Audits signed elsewhere" the partner entered (other firms, individual capacity). */
  signedElsewhere: number;
  total: number;
  ceiling: number;
  remaining: number;
  /** The highest warning count reached (50, 58), or null. */
  warnLevel: number | null;
  warning: CeilingWarning | null;
};

/** The ceiling state for a total (same wording as `tax_audit_ceiling_view.warning`). */
export function ceilingWarning(total: number, params: CeilingParams = CEILING_DEFAULTS): CeilingWarning | null {
  if (total > params.taxAuditCeiling) return "over";
  if (total === params.taxAuditCeiling) return "at_ceiling";
  return params.taxAuditWarnAt.some((w) => total >= w) ? "near" : null;
}

/**
 * One member's tax-audit count for an FY (§6.8): reports they signed in that FY (by the date
 * signed) that count, with head office and branch audits of the same assessee and covered year
 * counted once and revised reports left out, plus the audits signed elsewhere.
 */
export function taxAuditCount(
  records: readonly CeilingUdinRecord[],
  memberId: string,
  fy: FinancialYear,
  signedElsewhere = 0,
  params: CeilingParams = CEILING_DEFAULTS,
): TaxAuditCount {
  const keys = new Set<string>();
  for (const r of records) {
    if (r.signingMemberId !== memberId || financialYearOf(r.signedOn) !== fy) continue;
    if (countsTowardsTaxAuditCeiling(r, params) !== true) continue;
    keys.add(r.clientId === null ? `id|${r.id}` : `client|${r.clientId}|${r.financialYear ?? `id:${r.id}`}`);
  }
  const elsewhere = Math.max(0, Math.trunc(signedElsewhere));
  const total = keys.size + elsewhere;
  const reached = params.taxAuditWarnAt.filter((w) => total >= w);
  return {
    memberId,
    financialYear: fy,
    signedInFirm: keys.size,
    signedElsewhere: elsewhere,
    total,
    ceiling: params.taxAuditCeiling,
    remaining: params.taxAuditCeiling - total,
    warnLevel: reached.length ? Math.max(...reached) : null,
    warning: ceilingWarning(total, params),
  };
}

export type NewTaxAuditCheck = {
  /** The count this report would make (current total + 1). */
  position: number;
  level: "ok" | "warn" | "confirm";
  /** False only past the ceiling without a Partner's confirmation. */
  allowed: boolean;
  message: string | null;
};

/**
 * Logging one more counted tax audit (§6.8): from the 50th it warns (the message names the 58th
 * too); past the ceiling (the 61st) it needs a Partner's confirmation, and only a Partner can give it.
 */
export function checkNewTaxAudit(
  input: { currentTotal: number; actorRole: AppRole | null; confirmed: boolean },
  params: CeilingParams = CEILING_DEFAULTS,
): NewTaxAuditCheck {
  const position = input.currentTotal + 1;
  const ceiling = params.taxAuditCeiling;
  if (position > ceiling) {
    const allowed = input.actorRole === "partner" && input.confirmed;
    const message = allowed
      ? `Logged as tax audit ${position} for the year, over the ICAI ceiling of ${ceiling}, with a Partner's confirmation.`
      : `This would be tax audit ${position} for the year, over the ICAI ceiling of ${ceiling}. A Partner must confirm it to log it.`;
    return { position, level: "confirm", allowed, message };
  }
  const reached = params.taxAuditWarnAt.filter((w) => position >= w);
  if (reached.length > 0) {
    return { position, level: "warn", allowed: true, message: `This is tax audit ${position} of ${ceiling} for the year (${ceiling - position} left).` };
  }
  return { position, level: "ok", allowed: true, message: null };
}

/**
 * The thresholds a count crossed going from `before` to `after` (the §9 "Tax-audit ceiling at 50 /
 * 58 / 60" notifications): each warning count and the ceiling itself, ascending.
 */
export function ceilingThresholdsCrossed(before: number, after: number, params: CeilingParams = CEILING_DEFAULTS): number[] {
  const marks = [...new Set([...params.taxAuditWarnAt, params.taxAuditCeiling])].sort((a, b) => a - b);
  return marks.filter((m) => before < m && after >= m);
}

// -------------------------------------------------------------------------------------------------
// Company audit limit (§6.8, Companies Act s.141(3)(g))
// -------------------------------------------------------------------------------------------------

export type CompanyProfile = {
  isOnePersonCompany?: boolean;
  isSmallCompany?: boolean;
  isDormant?: boolean;
  isPrivate: boolean;
  /** Paid-up share capital in paise, or null when unknown (an unknown private company counts). */
  paidUpCapitalPaise: Paise | null;
};

/**
 * Whether auditing this company counts towards the 20 (§6.8): not OPCs, small companies, dormant
 * companies, or private companies with paid-up capital below ₹100 crore.
 */
export function countsTowardsCompanyAuditLimit(company: CompanyProfile, params: CeilingParams = CEILING_DEFAULTS): boolean {
  if (company.isOnePersonCompany || company.isSmallCompany || company.isDormant) return false;
  if (company.isPrivate && company.paidUpCapitalPaise !== null && company.paidUpCapitalPaise < params.privateCompanyPaidUpExclusionPaise) return false;
  return true;
}

export type CompanyAuditCheck = { position: number; level: "ok" | "warn" | "block"; message: string | null };

/**
 * Taking on one more countable company audit as engaging partner (§6.8): warn from the 18th; over
 * the limit (a 21st) is refused, since the Act disqualifies the appointment.
 */
export function checkCompanyAuditLimit(currentCountable: number, params: CeilingParams = CEILING_DEFAULTS): CompanyAuditCheck {
  const position = currentCountable + 1;
  const limit = params.companyAuditLimit;
  if (position > limit) {
    return { position, level: "block", message: `This would be company audit ${position} for this partner, over the limit of ${limit} (Companies Act s.141(3)(g)).` };
  }
  if (position >= params.companyAuditWarnFrom) {
    return { position, level: "warn", message: `This is company audit ${position} of ${limit} for this partner (${limit - position} left).` };
  }
  return { position, level: "ok", message: null };
}

// -------------------------------------------------------------------------------------------------
// UDIN 60 days (§6.8, §7.15.1)
// -------------------------------------------------------------------------------------------------

export type UdinState = "generated" | "generated_late" | "pending" | "overdue";

export type UdinStatus = {
  state: UdinState;
  /** The last day to generate it: signed on + 60 days. */
  dueBy: DateString;
  /** Days left while pending (0 on the last day); null otherwise. */
  daysLeft: number | null;
  /** Days past `dueBy` (overdue, or generated late); null otherwise. */
  daysLate: number | null;
  /** Days since signing (the §9 "signed N days ago" notification). */
  daysSinceSigning: number;
};

/**
 * Where a signed document stands on its UDIN (§6.8): generated within 60 days of signing, generated
 * late, pending with days left, or overdue with days late.
 */
export function udinStatus(input: { signedOn: DateString; generatedOn: DateString | null; today: DateString }, params: CeilingParams = CEILING_DEFAULTS): UdinStatus {
  const dueBy = addDays(input.signedOn, params.udinGenerationDays);
  const daysSinceSigning = diffDays(input.today, input.signedOn);
  if (input.generatedOn !== null) {
    const late = diffDays(input.generatedOn, dueBy);
    return late > 0
      ? { state: "generated_late", dueBy, daysLeft: null, daysLate: late, daysSinceSigning }
      : { state: "generated", dueBy, daysLeft: null, daysLate: null, daysSinceSigning };
  }
  const left = diffDays(dueBy, input.today);
  return left >= 0
    ? { state: "pending", dueBy, daysLeft: left, daysLate: null, daysSinceSigning }
    : { state: "overdue", dueBy, daysLeft: null, daysLate: -left, daysSinceSigning };
}

/**
 * The UDIN register's warning on save (§7.15.1: "warn if more than 60 days after signing"), or null.
 * Also refuses the impossible: generated before signing.
 */
export function udinDatesWarning(signedOn: DateString, generatedOn: DateString, params: CeilingParams = CEILING_DEFAULTS): string | null {
  const after = diffDays(generatedOn, signedOn);
  if (after < 0) return "The UDIN can't be generated before the document is signed.";
  if (after > params.udinGenerationDays) return `Generated ${after} days after signing; ICAI requires a UDIN within ${params.udinGenerationDays} days.`;
  return null;
}

// -------------------------------------------------------------------------------------------------
// Peer review (§6.8)
// -------------------------------------------------------------------------------------------------

export type PeerReviewState = "missing" | "valid" | "expiring" | "expired";

/**
 * The firm's peer review certificate (§6.8): missing, valid, expiring (within 90 days, the last day
 * included), or expired. `daysLeft` counts to `valid_until`.
 */
export function peerReviewStatus(validUntil: DateString | null, today: DateString, params: CeilingParams = CEILING_DEFAULTS): { state: PeerReviewState; daysLeft: number | null } {
  if (validUntil === null) return { state: "missing", daysLeft: null };
  const daysLeft = diffDays(validUntil, today);
  if (daysLeft < 0) return { state: "expired", daysLeft };
  return { state: daysLeft <= params.peerReviewWarningDays ? "expiring" : "valid", daysLeft };
}

/** True when the certificate is valid on a date (checked on the acceptance date, §6.8). */
export function peerReviewValidOn(validUntil: DateString | null, date: DateString): boolean {
  return validUntil !== null && diffDays(validUntil, date) >= 0;
}

// -------------------------------------------------------------------------------------------------
// KYC (§6.8, `client_kyc`)
// -------------------------------------------------------------------------------------------------

export type KycCategory = "individual_proprietor" | "corporate" | "non_corporate";

export type KycPerson = { name?: string | null; address?: string | null; pan?: string | null; din?: string | null };

export type KycRecord = {
  entityCategory: KycCategory;
  /** The client's name. */
  name?: string | null;
  pan?: string | null;
  cinLlpin?: string | null;
  businessDescription?: string | null;
  lastAuditedFsDocumentId?: string | null;
  engagementTypes?: readonly string[] | null;
  /** Directors, partners or trustees. */
  principalPersons?: readonly KycPerson[] | null;
  verifiedOn?: DateString | null;
  nextReviewOn?: DateString | null;
};

export type KycCheck = {
  /** Every field the category needs is filled. */
  complete: boolean;
  /** What is missing, in plain words. */
  missing: string[];
  /** The annual re-confirmation is due (or it was never verified). */
  reviewDue: boolean;
  /** Complete and not due for review: the gate passes. */
  current: boolean;
};

const filled = (v: string | null | undefined): boolean => !!v && v.trim().length > 0;

/**
 * KYC completeness for the client's category (§6.8, KYC Norms): everyone needs name, PAN, business
 * description, last audited financial statements and engagement type; a corporate adds its CIN and
 * each director's name, address and DIN; a non-corporate entity adds each partner's or trustee's
 * name, address and PAN or DIN. Re-confirmed annually: due once `next_review_on` has passed (or
 * `kycReconfirmMonths` after `verified_on` when no review date is set; at once when never verified).
 */
export function kycCompleteness(kyc: KycRecord | null, today: DateString, params: CeilingParams = CEILING_DEFAULTS): KycCheck {
  if (kyc === null) return { complete: false, missing: ["the KYC record"], reviewDue: true, current: false };
  const missing: string[] = [];
  if (!filled(kyc.name)) missing.push("name");
  if (!filled(kyc.pan)) missing.push("PAN");
  if (!filled(kyc.businessDescription)) missing.push("business description");
  if (!filled(kyc.lastAuditedFsDocumentId)) missing.push("last audited financial statements");
  if (!kyc.engagementTypes || kyc.engagementTypes.length === 0) missing.push("engagement type");
  const people = kyc.principalPersons ?? [];
  if (kyc.entityCategory === "corporate") {
    if (!filled(kyc.cinLlpin)) missing.push("CIN");
    if (people.length === 0) missing.push("directors");
    else if (!people.every((p) => filled(p.name) && filled(p.address) && filled(p.din))) missing.push("each director's name, address and DIN");
  } else if (kyc.entityCategory === "non_corporate") {
    if (people.length === 0) missing.push("partners or trustees");
    else if (!people.every((p) => filled(p.name) && filled(p.address) && (filled(p.pan) || filled(p.din)))) {
      missing.push("each partner's or trustee's name, address and PAN or DIN");
    }
  }
  const reviewOn = kyc.nextReviewOn ?? (kyc.verifiedOn ? addMonths(kyc.verifiedOn, params.kycReconfirmMonths) : null);
  const reviewDue = reviewOn === null || diffDays(today, reviewOn) > 0;
  const complete = missing.length === 0;
  return { complete, missing, reviewDue, current: complete && !reviewDue };
}

// -------------------------------------------------------------------------------------------------
// Audit stage gates (§6.9, §7.15.5)
// -------------------------------------------------------------------------------------------------

export const AUDIT_STAGES = ["acceptance", "planning", "risk_assessment", "execution", "completion", "reporting", "archived"] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

export const AUDIT_STAGE_LABELS: Record<AuditStage, string> = {
  acceptance: "Acceptance",
  planning: "Planning",
  risk_assessment: "Risk assessment",
  execution: "Execution",
  completion: "Completion",
  reporting: "Reporting",
  archived: "Archive",
};

export type AuditStageMove = {
  from: AuditStage;
  to: AuditStage;
  /** The engagement partner approves every move (§7.15.5). */
  actorIsEngagementPartner: boolean;
  /** From `kycCompleteness`. */
  kyc: KycCheck;
  /** Another CA held the position, so the previous auditor must be written to (Clause 8). */
  previousAuditorRequired: boolean;
  /** A `previous_auditor_communications` record exists with proof of delivery. */
  previousAuditorCommunicated: boolean;
  /** The engagement letter's status for this engagement's FY, or null when there is none. */
  engagementLetterStatus: EngagementStatus | null;
  /** The entity needs a peer-reviewed auditor (`requires_peer_reviewed_auditor`). */
  peerReviewRequired: boolean;
  /** The firm's certificate is valid on the acceptance date (`peerReviewValidOn`). */
  peerReviewValid: boolean;
  /** The company-audit / tax-audit ceiling check for this engagement, when it applies. */
  limitCheck?: { level: "ok" | "warn" | "block" | "confirm"; allowed?: boolean; message: string | null } | null;
};

export type StageMoveCheck = { ok: true } | { ok: false; error: string; missing: string[] };

const LETTER_READY: readonly EngagementStatus[] = ["issued", "signed"];

/**
 * Whether an audit engagement may move stage (§6.9, §6.8, §7.15.5). Archived files are read-only;
 * forward moves go one stage at a time with the engagement partner's approval; moves back are
 * allowed. Leaving Acceptance needs: KYC complete and current; an engagement letter at Issued (or
 * Signed); the previous-auditor communication with proof of delivery where another CA held the
 * position; a valid peer review certificate where the entity needs one; and no ceiling block.
 */
export function checkAuditStageMove(move: AuditStageMove): StageMoveCheck {
  const fromIndex = AUDIT_STAGES.indexOf(move.from);
  const toIndex = AUDIT_STAGES.indexOf(move.to);
  const refuse = (error: string, missing: string[] = []): StageMoveCheck => ({ ok: false, error, missing });
  if (move.from === "archived") return refuse("This audit file is archived and read-only.");
  if (fromIndex === toIndex) return refuse(`The engagement is already at ${AUDIT_STAGE_LABELS[move.to]}.`);
  if (!move.actorIsEngagementPartner) return refuse("Only the engagement partner can approve moving the engagement to another stage.");
  if (toIndex < fromIndex) return { ok: true };
  if (toIndex > fromIndex + 1) return refuse(`Move one stage at a time: ${AUDIT_STAGE_LABELS[AUDIT_STAGES[fromIndex + 1]]} comes next.`);
  if (move.from !== "acceptance") return { ok: true };

  const missing: string[] = [];
  if (!move.kyc.complete) missing.push(`complete the client's KYC (${move.kyc.missing.join(", ")})`);
  else if (move.kyc.reviewDue) missing.push("re-confirm the client's KYC (the annual review is due)");
  if (move.engagementLetterStatus === null || !LETTER_READY.includes(move.engagementLetterStatus)) missing.push("issue the engagement letter (SA 210)");
  if (move.previousAuditorRequired && !move.previousAuditorCommunicated) missing.push("record the letter to the previous auditor with proof of delivery");
  if (move.peerReviewRequired && !move.peerReviewValid) missing.push("hold a peer review certificate valid on the acceptance date");
  if (move.limitCheck && (move.limitCheck.level === "block" || move.limitCheck.allowed === false)) {
    missing.push(move.limitCheck.message ? `resolve the audit limit: ${move.limitCheck.message}` : "resolve the audit limit check");
  }
  if (missing.length === 0) return { ok: true };
  return refuse(`Before ${AUDIT_STAGE_LABELS[move.to]}: ${missing.join("; ")}.`, missing);
}
