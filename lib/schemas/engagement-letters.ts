import { z } from "zod";
import { SERVICE_FREQUENCIES, SERVICE_FREQUENCY_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS, type EngagementStatus, type EntityType, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { addMonths, compareDates, diffDays, fyEnd, isDateString, isFinancialYear, nextFinancialYear, incomeTaxStatute, taxYearLabel, assessmentYearOf, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { fromPaise, multiplyPaise, parseAmount, paiseToDecimalString, sumPaise, toPaise, type Paise } from "@/lib/domain/money";

/**
 * Engagement letters (§7.15.3, §6.8 SA 210, §6.9, §4.1 Partner/Manager only): the letter form and
 * its status moves, the derived Expired, renewals for the next FY, the default terms for an audit,
 * the services schedule and the SA 210 sections the PDF prints. Mirrors 0193's guard. Client-safe.
 */

// =================================================================================================
// Status
// =================================================================================================

export type LetterDisplayStatus = EngagementStatus;

/** The moves the database allows (0193 engagement_letters_guard). */
export const LETTER_MOVES: Readonly<Record<EngagementStatus, readonly EngagementStatus[]>> = {
  draft: ["issued"],
  issued: ["signed", "declined", "expired", "draft"],
  signed: ["expired"],
  declined: ["draft"],
  expired: [],
};

export function canMoveLetter(from: EngagementStatus, to: EngagementStatus): boolean {
  return LETTER_MOVES[from].includes(to);
}

/**
 * The status shown (§0.1 rule 10): an Issued or Signed letter past its expiry date reads Expired
 * without anything being stored; every other status is as stored.
 */
export function letterDisplayStatus(status: EngagementStatus, expiresAt: DateString | null | undefined, today: DateString): LetterDisplayStatus {
  if ((status === "issued" || status === "signed") && expiresAt && compareDates(expiresAt, today) < 0) return "expired";
  return status;
}

/** Days before expiry that a letter shows in "Expiring" and gets the reminder (§7.15.3, §8). */
export const LETTER_EXPIRY_WINDOW_DAYS = 30;

/** An Issued or Signed letter expiring from today up to 30 days ahead, not yet renewed. */
export function isExpiringLetter(l: { status: EngagementStatus; expiresAt: DateString | null; renewed: boolean }, today: DateString, windowDays = LETTER_EXPIRY_WINDOW_DAYS): boolean {
  if (l.renewed || !l.expiresAt || (l.status !== "issued" && l.status !== "signed")) return false;
  const left = diffDays(l.expiresAt, today);
  return left >= 0 && left <= windowDays;
}

export const LETTER_VIEWS = ["letters", "missing", "expiring"] as const;
export type LetterView = (typeof LETTER_VIEWS)[number];

export const LETTER_VIEW_LABEL: Record<LetterView, string> = {
  letters: "Letters",
  missing: "No letter for the FY",
  expiring: "Expiring in 30 days",
};

/** `?view=`, with the jobs' links (`?missing=1`) honoured. */
export function parseLetterView(view: unknown, missing: unknown): LetterView {
  const v = Array.isArray(view) ? view[0] : view;
  if (typeof v === "string" && (LETTER_VIEWS as readonly string[]).includes(v)) return v as LetterView;
  const m = Array.isArray(missing) ? missing[0] : missing;
  return m === "1" ? "missing" : "letters";
}

export const LETTER_SORTABLE = ["updated_at", "client_name", "financial_year", "expires_at", "fee_agreed", "issued_at"] as const;
export const LetterListFilters = { status: ["draft", "issued", "signed", "declined", "expired"], service: SERVICE_TYPES, kind: ["audit", "non_audit"], client: null } as const;
export const GAP_SORTABLE = ["client_name", "client_code"] as const;

// =================================================================================================
// Audits (SA 210)
// =================================================================================================

export const LETTER_AUDIT_TYPES = ["statutory_companies_act", "tax_audit", "gst_audit", "internal", "bank_branch", "stock", "certification", "other"] as const;
export type LetterAuditType = (typeof LETTER_AUDIT_TYPES)[number];

export const LETTER_AUDIT_TYPE_LABEL: Record<LetterAuditType, string> = {
  statutory_companies_act: "Statutory audit (Companies Act)",
  tax_audit: "Tax audit",
  gst_audit: "GST audit / reconciliation",
  internal: "Internal audit",
  bank_branch: "Bank branch audit",
  stock: "Stock audit",
  certification: "Certification",
  other: "Other audit or assurance",
};

export function isAuditLetter(serviceTypes: readonly string[]): boolean {
  return serviceTypes.includes("audit");
}

/** The first FY governed by the Income-tax Act, 2025 (§6.1) is a parameter in lib/domain/fy.ts. */
function incomeTaxCitation(fy: FinancialYear): { act: string; section: string; report: string; yearLabel: string } {
  if (incomeTaxStatute(fy) === "2025") {
    return {
      act: "Income-tax Act, 2025",
      // §6.1: an unverified mapping prints the old section with the 2025-Act note.
      section: "section 44AB of the Income-tax Act, 1961 (corresponding provision of the Income-tax Act, 2025)",
      report: "the tax audit report in Form 26 under the Income-tax Act, 2025, which replaces Forms 3CA/3CB and 3CD",
      yearLabel: taxYearLabel(fy),
    };
  }
  return {
    act: "Income-tax Act, 1961",
    section: "section 44AB of the Income-tax Act, 1961",
    report: "the tax audit report in Form 3CA (where the accounts are audited under another law) or Form 3CB, with the statement of particulars in Form 3CD",
    yearLabel: `AY ${assessmentYearOf(fy)}`,
  };
}

/**
 * The applicable financial reporting framework a letter starts with (SA 210 para 10(d)); the
 * Partner edits it for the client (Ind AS companies, trusts under a state Act, and so on).
 */
export function defaultReportingFramework(auditType: LetterAuditType | null, entityType: EntityType | null, fy: FinancialYear): string {
  switch (auditType) {
    case "statutory_companies_act":
      return "The accounting principles generally accepted in India, including the Accounting Standards specified under section 133 of the Companies Act, 2013, with the financial statements presented in the form of Schedule III to the Act.";
    case "tax_audit": {
      const c = incomeTaxCitation(fy);
      return `The books of account and financial statements of the assessee prepared under the accounting principles generally accepted in India, and the particulars required under the ${c.act}.`;
    }
    case "gst_audit":
      return "The books of account and records maintained under the Central Goods and Services Tax Act, 2017, the Karnataka Goods and Services Tax Act, 2017 and the rules under them, read with the returns filed for the year.";
    case "internal":
      return "The scope, policies and procedures agreed with management, assessed with reference to the Standards on Internal Audit issued by the Institute of Chartered Accountants of India.";
    case "bank_branch":
      return "The bank's accounting policies, the Reserve Bank of India's directions applicable to the branch, and the closing instructions issued by the bank's central statutory auditors.";
    case "stock":
      return "The stock statements submitted to the lender, the books of account of the borrower and the lender's terms of sanction.";
    case "certification":
      return "The books of account and records of the client, and the requirements of the authority for which the certificate is issued, read with the ICAI Guidance Note on Reports or Certificates for Special Purposes.";
    default:
      if (entityType === "llp") return "The Accounting Standards issued by the Institute of Chartered Accountants of India as applicable to non-company entities, read with the Limited Liability Partnership Act, 2008.";
      if (entityType === "trust" || entityType === "section_8") return "The accounting principles generally accepted in India as applicable to not-for-profit entities, and the Act and rules under which the entity is registered.";
      return "The accounting principles generally accepted in India, including the Accounting Standards issued by the Institute of Chartered Accountants of India as applicable to the entity.";
  }
}

/** The expected form and content of the report a letter starts with (SA 210 para 10(e)). */
export function defaultReportForm(auditType: LetterAuditType | null, fy: FinancialYear): string {
  switch (auditType) {
    case "statutory_companies_act":
      return "An independent auditor's report under section 143 of the Companies Act, 2013, in the form set out in SA 700 (Revised), with the report under the Companies (Auditor's Report) Order, 2020 where it applies.";
    case "tax_audit": {
      const c = incomeTaxCitation(fy);
      return `${c.report[0].toUpperCase()}${c.report.slice(1)}, for ${c.yearLabel}.`;
    }
    case "gst_audit":
      return "A report on the reconciliation of the books of account with the GST returns for the year, with our observations.";
    case "internal":
      return "Internal audit reports for each period agreed, with our observations, the management responses and our recommendations.";
    case "bank_branch":
      return "The branch audit report and the long form audit report in the formats prescribed by the bank and the Reserve Bank of India.";
    case "stock":
      return "A stock audit report in the format prescribed by the lender.";
    case "certification":
      return "A certificate in the form the authority requires, or as agreed with you.";
    default:
      return "An independent auditor's report in the form set out in SA 700 (Revised).";
  }
}

/** What the audit is, in a sentence (the subject line and the objective). */
export function auditDescription(auditType: LetterAuditType | null, fy: FinancialYear, clientName: string): string {
  const yearEnd = fyEnd(fy);
  const endText = `31 March ${yearEnd.slice(0, 4)}`;
  switch (auditType) {
    case "statutory_companies_act":
      return `the audit of the financial statements of ${clientName} for the year ended ${endText}, under section 139 of the Companies Act, 2013`;
    case "tax_audit": {
      const c = incomeTaxCitation(fy);
      return `the tax audit of ${clientName} under ${c.section} for the year ended ${endText} (${c.yearLabel})`;
    }
    case "gst_audit":
      return `the review of ${clientName}'s GST records and returns for the year ended ${endText}`;
    case "internal":
      return `the internal audit of ${clientName} for the year ending ${endText}`;
    case "bank_branch":
      return `the audit of the branch for the year ended ${endText}`;
    case "stock":
      return `the stock audit of ${clientName} as at the dates the lender asks for during FY ${fy}`;
    case "certification":
      return `the certification work for ${clientName} for FY ${fy}`;
    default:
      return `the audit of the financial statements of ${clientName} for the year ended ${endText}`;
  }
}

export type LetterSection = { title: string; paragraphs: string[] };

/**
 * The SA 210 contents for an audit letter (§7.15.3; SA 210 para 10): objective and scope, the
 * auditor's responsibilities (with the inherent limitations), management's responsibilities (with
 * access to information and written representations, SA 580), the applicable framework, and the
 * expected form of the report, with the statement that it may differ. Scope and exclusions follow.
 */
export function sa210Sections(input: {
  auditType: LetterAuditType | null;
  fy: FinancialYear;
  clientName: string;
  framework: string;
  reportForm: string;
  scope: string | null;
  exclusions: string | null;
}): LetterSection[] {
  const what = auditDescription(input.auditType, input.fy, input.clientName);
  const internal = input.auditType === "internal";
  const certification = input.auditType === "certification";
  const sections: LetterSection[] = [
    {
      title: "Objective and scope",
      paragraphs: [
        internal
          ? `You have asked us to carry out ${what}. The objective is to give you an independent view of the design and operation of the processes and controls within the agreed scope, and to recommend improvements.`
          : certification
            ? `You have asked us to carry out ${what}. The objective is to report on the matters you ask us to certify, based on our examination of your records.`
            : `You have asked us to carry out ${what}. The objective of our audit is to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatement, whether due to fraud or error, and to issue a report that includes our opinion.`,
        ...(input.scope?.trim() ? [`The engagement covers: ${input.scope.trim()}`] : []),
        ...(input.exclusions?.trim() ? [`It does not cover: ${input.exclusions.trim()}`] : []),
      ],
    },
    {
      title: "Our responsibilities",
      paragraphs: [
        internal
          ? "We will carry out the work with reference to the Standards on Internal Audit issued by the Institute of Chartered Accountants of India, and comply with the ICAI Code of Ethics."
          : "We will conduct our audit in accordance with the Standards on Auditing issued by the Institute of Chartered Accountants of India. Those Standards require that we comply with ethical requirements and plan and perform the audit to obtain reasonable assurance about whether the financial statements are free from material misstatement.",
        "An audit involves performing procedures to obtain audit evidence about the amounts and disclosures. The procedures selected depend on our judgement, including the assessment of the risks of material misstatement, whether due to fraud or error. We consider internal control relevant to the preparation of the financial statements in order to design procedures that are appropriate in the circumstances, but not to express an opinion on the effectiveness of internal control, except where the law requires us to report on internal financial controls.",
        "Because of the inherent limitations of an audit, together with the inherent limitations of internal control, there is an unavoidable risk that some material misstatements may not be detected, even though the audit is properly planned and performed in accordance with the Standards on Auditing.",
        "We will tell those charged with governance in writing about any significant deficiencies in internal control that we identify during the audit (SA 265).",
      ],
    },
    {
      title: "Responsibilities of management",
      paragraphs: [
        "Our work is conducted on the basis that management and, where appropriate, those charged with governance acknowledge and understand that they are responsible for:",
        `(a) the preparation of the financial statements in accordance with the applicable financial reporting framework set out below, including their fair presentation;`,
        "(b) such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatement, whether due to fraud or error;",
        "(c) giving us access to all information of which management is aware that is relevant to the preparation of the financial statements, such as records, documentation and other matters; any additional information we request for the audit; and unrestricted access to persons within the entity from whom we decide it is necessary to obtain audit evidence.",
        "As part of our audit we will ask management and, where appropriate, those charged with governance for written confirmation of the representations made to us in connection with the audit (SA 580).",
      ],
    },
    {
      title: "Applicable financial reporting framework",
      paragraphs: [input.framework.trim()],
    },
    {
      title: "Expected form and content of our report",
      paragraphs: [
        input.reportForm.trim(),
        "The form and content of our report may need to be amended in the light of our findings. If we are unable to give an unmodified opinion, we will discuss the reasons with you before we issue the report.",
        "We will generate a Unique Document Identification Number (UDIN) for every report and certificate we sign, within 60 days of signing, as the ICAI requires.",
      ],
    },
  ];
  return sections;
}

/** The general terms of a non-audit letter: who does what, deadlines, and confidentiality. */
export function nonAuditTerms(clientName: string): LetterSection[] {
  return [
    {
      title: "Your responsibilities",
      paragraphs: [
        `${clientName} is responsible for the completeness and accuracy of the information, records and explanations given to us, and for keeping the books and records the law requires. We rely on that information and do not audit or verify it unless this letter says so.`,
        "Statutory deadlines are fixed by law. Please send the data and documents we ask for by the dates in our requests; we can't be responsible for a late filing, interest, late fees or penalties that follow from information reaching us late.",
        "Where you give us access to your government portal logins, we store them encrypted, use them only for this engagement, and every view of a stored password is logged.",
      ],
    },
    {
      title: "Our responsibilities",
      paragraphs: [
        "We will carry out the services with reasonable skill and care, in line with the law in force and the pronouncements of the Institute of Chartered Accountants of India, and will tell you promptly of any matter that needs your decision.",
      ],
    },
  ];
}

/** Confidentiality and data protection, for every letter (CA Act Second Schedule; DPDP Act 2023). */
export function confidentialityTerms(): LetterSection {
  return {
    title: "Confidentiality and your data",
    paragraphs: [
      "We keep information about your affairs confidential and do not disclose it to anyone without your consent, except where the law or a professional duty requires it (Chartered Accountants Act, 1949, Second Schedule, Part I, Clause 1).",
      "We process personal data you share with us only to provide these services and meet our legal duties, under the Digital Personal Data Protection Act, 2023. Our privacy notice explains how.",
    ],
  };
}

/** The fee paragraph: fixed, excluding GST, never contingent (§6.8, CA Act First Schedule Part I Clause 10). */
export function feeParagraph(feeText: string | null): string[] {
  const lines = [
    feeText
      ? `Our fee for this engagement is ${feeText}, excluding GST, which is charged at the rate in force when we invoice.`
      : "Our fees are as set out in the schedule above, excluding GST, which is charged at the rate in force when we invoice.",
    "Government fees, challans and other amounts we pay on your behalf as a pure agent are reimbursed at actuals and shown separately on our invoices. Invoices are payable within the credit period they state.",
    "Our fees are fixed for the services described. They do not depend on the findings or results of our work (Chartered Accountants Act, 1949, First Schedule, Part I, Clause 10).",
  ];
  return lines;
}

// =================================================================================================
// The services schedule (non-audit work)
// =================================================================================================

export type ScheduleRow = { service_type: ServiceType; description: string; frequency: ServiceFrequency; fee: string | null };

/** How many times a service is billed in a year, for the schedule's annual equivalent. */
export const OCCURRENCES_PER_YEAR: Record<ServiceFrequency, number> = { monthly: 12, quarterly: 4, annual: 1, one_time: 1 };

/** The schedule's rows from the client's active services (fees per occurrence, excl. GST). */
export function scheduleFromServices(services: ReadonlyArray<{ service_type: ServiceType; custom_name: string | null; frequency: ServiceFrequency; billing_frequency?: ServiceFrequency | null; agreed_fee: number | string | null }>): ScheduleRow[] {
  return services.map((s) => ({
    service_type: s.service_type,
    description: s.service_type === "other" && s.custom_name ? s.custom_name : SERVICE_TYPE_LABELS[s.service_type],
    frequency: s.billing_frequency ?? s.frequency,
    fee: s.agreed_fee === null || s.agreed_fee === undefined ? null : paiseToDecimalString(toPaise(s.agreed_fee)),
  }));
}

/** The year's fees from the schedule: each fee × its occurrences, in paise. Rows without a fee add nothing. */
export function scheduleAnnualPaise(rows: ReadonlyArray<Pick<ScheduleRow, "frequency" | "fee">>): Paise {
  return sumPaise(rows.map((r) => (r.fee ? multiplyPaise(toPaise(r.fee), OCCURRENCES_PER_YEAR[r.frequency]) : 0)));
}

export function frequencyLabel(f: ServiceFrequency): string {
  return SERVICE_FREQUENCY_LABELS[f];
}

// =================================================================================================
// Defaults and renewals
// =================================================================================================

/**
 * The expiry a new letter starts with: the end of its FY for ongoing services; for an audit, the end
 * of the following FY, since the audit of a year is done after it closes.
 */
export function defaultLetterExpiry(fy: FinancialYear, audit: boolean): DateString {
  return audit ? fyEnd(nextFinancialYear(fy)) : fyEnd(fy);
}

/** The renewal of a letter for the next FY (§7.15.3 "copies scope and services"). */
export function renewalOf(l: {
  client_id: string;
  financial_year: FinancialYear;
  service_types: readonly ServiceType[];
  scope: string | null;
  exclusions: string | null;
  fee_agreed: number | string | null;
  services_schedule: unknown;
  audit_type: string | null;
  reporting_framework: string | null;
  report_form: string | null;
  signatory_id: string | null;
  expires_at: DateString | null;
  notes?: string | null;
}): {
  client_id: string;
  financial_year: FinancialYear;
  service_types: ServiceType[];
  scope: string | null;
  exclusions: string | null;
  fee_agreed: string | null;
  services_schedule: ScheduleRow[];
  audit_type: string | null;
  reporting_framework: string | null;
  report_form: string | null;
  signatory_id: string | null;
  expires_at: DateString;
} {
  const fy = nextFinancialYear(l.financial_year);
  const audit = isAuditLetter(l.service_types);
  // A tax audit's report form follows the statute of the new year (§6.1).
  const reportForm = l.audit_type === "tax_audit" ? defaultReportForm("tax_audit", fy) : l.report_form;
  const framework = l.audit_type === "tax_audit" ? defaultReportingFramework("tax_audit", null, fy) : l.reporting_framework;
  return {
    client_id: l.client_id,
    financial_year: fy,
    service_types: [...l.service_types],
    scope: l.scope,
    exclusions: l.exclusions,
    fee_agreed: l.fee_agreed === null || l.fee_agreed === undefined ? null : paiseToDecimalString(toPaise(l.fee_agreed)),
    services_schedule: parseSchedule(l.services_schedule),
    audit_type: l.audit_type,
    reporting_framework: framework,
    report_form: reportForm,
    signatory_id: l.signatory_id,
    // A year on from the old expiry (31 March stays 31 March), or the new FY's default.
    expires_at: l.expires_at ? addMonths(l.expires_at, 12) : defaultLetterExpiry(fy, audit),
  };
}

/** The stored schedule, read defensively (jsonb). */
export function parseSchedule(value: unknown): ScheduleRow[] {
  if (!Array.isArray(value)) return [];
  const out: ScheduleRow[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.service_type !== "string" || !(SERVICE_TYPES as readonly string[]).includes(r.service_type)) continue;
    const frequency = typeof r.frequency === "string" && (SERVICE_FREQUENCIES as readonly string[]).includes(r.frequency) ? (r.frequency as ServiceFrequency) : "annual";
    const fee = typeof r.fee === "string" || typeof r.fee === "number" ? String(r.fee) : null;
    out.push({
      service_type: r.service_type as ServiceType,
      description: typeof r.description === "string" && r.description.trim() ? r.description.trim().slice(0, 200) : SERVICE_TYPE_LABELS[r.service_type as ServiceType],
      frequency,
      fee: fee && parseAmount(fee).ok ? paiseToDecimalString(toPaise(fee)) : null,
    });
  }
  return out;
}

/** "₹72,000.00" or null, for paragraphs (no float maths). */
export function rupees(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return fromPaise(toPaise(value));
}

// =================================================================================================
// Forms (zod)
// =================================================================================================

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep ${label} under ${max.toLocaleString("en-IN")} characters.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const amount = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null;
    const raw = String(v).trim();
    if (raw === "") return null;
    const p = parseAmount(raw);
    if (!p.ok) {
      ctx.addIssue({ code: "custom", message: p.error });
      return z.NEVER;
    }
    if (p.paise > 99_99_99_99_999_99) {
      ctx.addIssue({ code: "custom", message: "That amount is too large." });
      return z.NEVER;
    }
    return paiseToDecimalString(p.paise);
  });

const scheduleRow = z.object({
  service_type: z.enum(SERVICE_TYPES, { error: "Choose the service." }),
  description: z.string().trim().min(1, { error: "Describe the service." }).max(200, { error: "Keep the description under 200 characters." }),
  frequency: z.enum(SERVICE_FREQUENCIES, { error: "Choose how often." }),
  fee: amount,
});

const optionalDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    const s = (v ?? "").trim();
    if (!s) return null;
    if (!isDateString(s)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date." });
      return z.NEVER;
    }
    return s;
  });

const optionalUuid = z
  .union([z.uuid({ error: "Choose one from the list." }), z.literal(""), z.literal("none"), z.null()])
  .optional()
  .transform((v) => (v && v !== "none" ? v : null));

const letterFields = {
  financialYear: z.string({ error: "Choose the FY." }).refine((v) => isFinancialYear(v), { error: "Choose the FY." }),
  serviceTypes: z
    .array(z.enum(SERVICE_TYPES))
    .min(1, { error: "Choose at least one service the letter covers." })
    .transform((v) => [...new Set(v)]),
  scope: optionalText(8000, "the scope"),
  exclusions: optionalText(4000, "the exclusions"),
  feeAgreed: amount,
  servicesSchedule: z.array(scheduleRow).max(40, { error: "Keep the schedule to 40 services." }).default([]),
  expiresAt: optionalDate,
  auditType: z
    .union([z.enum(LETTER_AUDIT_TYPES), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  reportingFramework: optionalText(1000, "the framework"),
  reportForm: optionalText(1000, "the form of report"),
  auditEngagementId: optionalUuid,
  signatoryId: optionalUuid,
  notes: optionalText(4000, "the notes"),
};

function refineLetter(v: { serviceTypes: ServiceType[]; auditType: string | null; reportingFramework: string | null; reportForm: string | null }, ctx: z.RefinementCtx) {
  if (isAuditLetter(v.serviceTypes)) {
    if (!v.auditType) ctx.addIssue({ code: "custom", path: ["auditType"], message: "Choose the kind of audit (SA 210)." });
    if (!v.reportingFramework) ctx.addIssue({ code: "custom", path: ["reportingFramework"], message: "Name the applicable financial reporting framework (SA 210)." });
    if (!v.reportForm) ctx.addIssue({ code: "custom", path: ["reportForm"], message: "Describe the expected form of the report (SA 210)." });
  }
}

export const CreateLetterSchema = z.object({ clientId: z.uuid({ error: "Choose the client." }), ...letterFields }).superRefine(refineLetter);
export const UpdateLetterSchema = z.object({ id: z.uuid(), updatedAt: z.string().min(1), ...letterFields }).superRefine(refineLetter);
export type CreateLetterInput = z.input<typeof CreateLetterSchema>;
export type UpdateLetterInput = z.input<typeof UpdateLetterSchema>;

export const LetterRefSchema = z.object({ id: z.uuid(), updatedAt: z.string().min(1) });

const pastOrToday = (label: string) =>
  z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .refine((v) => isDateString(v), { error: `Enter the ${label}.` });

export const IssueLetterSchema = z.object({ id: z.uuid(), updatedAt: z.string().min(1), issuedOn: pastOrToday("issue date") });
export const SignLetterSchema = z.object({
  id: z.uuid(),
  updatedAt: z.string().min(1),
  signedOn: pastOrToday("date it was signed"),
  documentId: optionalUuid,
});
export const DeclineLetterSchema = z.object({
  id: z.uuid(),
  updatedAt: z.string().min(1),
  reason: z.string().trim().min(3, { error: "Say why the client declined." }).max(1000, { error: "Keep the reason under 1,000 characters." }),
});
export const AttachSignedCopySchema = z.object({ id: z.uuid(), updatedAt: z.string().min(1), documentId: z.uuid() });
export const RenewLetterSchema = z.object({ id: z.uuid() });
export const LetterClientContextSchema = z.object({ clientId: z.uuid() });

export const SendLetterSchema = z.object({
  id: z.uuid(),
  updatedAt: z.string().min(1),
  contactId: optionalUuid,
  to: z.email({ error: "Enter the email address to send it to." }),
  /** A fresh value per click, so a double click doesn't send twice and a resend is a new send. */
  nonce: z.string().trim().min(6).max(64),
});

/** A date at noon IST (a stored timestamp for a date the user picked). */
export function istNoon(date: DateString): string {
  return `${date}T12:00:00+05:30`;
}

// =================================================================================================
// The letter as printed
// =================================================================================================

/** Who a letter is addressed to, by the client's constitution (SA 210: management and those charged with governance). */
export function addresseeHeading(entityType: EntityType | null): string | null {
  switch (entityType) {
    case "pvt_ltd":
    case "public_ltd":
    case "section_8":
      return "The Board of Directors";
    case "llp":
      return "The Designated Partners";
    case "partnership":
      return "The Partners";
    case "trust":
      return "The Trustees";
    case "aop":
      return "The Members";
    case "huf":
      return "The Karta";
    default:
      return null;
  }
}

/** The letter's reference: "EL/2026-27/TW-C-0042" (the FY and the client code; unique enough to quote). */
export function letterReference(fy: FinancialYear, clientCode: string): string {
  return `EL/${fy}/${clientCode}`;
}

/** The PDF's file name: "Engagement-letter-2026-27-TW-C-0042.pdf". */
export function letterFileName(fy: FinancialYear, clientCode: string, draft: boolean): string {
  const safe = `${fy}-${clientCode}`.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `Engagement-letter-${safe}${draft ? "-draft" : ""}.pdf`;
}

/** The subject line of the letter. */
export function letterSubject(input: { fy: FinancialYear; clientName: string; auditType: LetterAuditType | null; audit: boolean; serviceCount: number }): string {
  if (input.audit) {
    const what = auditDescription(input.auditType, input.fy, input.clientName);
    const others = input.serviceCount > 1 ? ", and the other services in the schedule" : "";
    return `Engagement letter: ${what}${others}`;
  }
  return `Engagement letter for professional services to ${input.clientName}, FY ${input.fy}`;
}

/** The opening paragraph of a non-audit letter (an audit letter opens with SA 210's objective). */
export function nonAuditOpening(clientName: string, fy: FinancialYear): string {
  return `Thank you for appointing us. This letter sets out the services we will provide to ${clientName} for the financial year ${fy} (1 April ${fy.slice(0, 4)} to 31 March ${Number(fy.slice(0, 4)) + 1}), what each of us is responsible for, and our fees.`;
}

/** The closing paragraph: how the client accepts, and how long the letter runs. */
export function closingParagraphs(input: { expiresAt: DateString | null; renewedFromFy: string | null; formatDate: (d: DateString) => string }): string[] {
  const out: string[] = [];
  if (input.renewedFromFy) out.push(`This letter replaces our engagement letter for FY ${input.renewedFromFy} for the services it covers.`);
  out.push(
    input.expiresAt
      ? `These terms remain in force until ${input.formatDate(input.expiresAt)}, unless they are replaced by a new letter or ended in writing by either of us.`
      : "These terms remain in force until they are replaced by a new letter or ended in writing by either of us.",
  );
  out.push("Please sign and return a copy of this letter to confirm that it reflects your understanding of the arrangements for our work. If anything in it is not as you expect, please tell us before signing.");
  return out;
}
