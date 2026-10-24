/**
 * The quality and risk module (§6.8 SQC 1 with the SQM 1 switch, §7.15.4, §12): its sections, the
 * quality manual's elements and SQM 1 components, the independence questionnaire, peer reviews and
 * restore drills. Zod schemas shared by the forms and server/actions/{quality,peer-reviews,
 * independence,kyc-register}.ts. Client-safe: pure.
 */

import { z } from "zod";
import { isDateString, isFinancialYear } from "@/lib/domain/fy";

// -------------------------------------------------------------------------------------------------
// Sections of /quality (?tab=…)
// -------------------------------------------------------------------------------------------------

export const QUALITY_TABS = [
  { id: "overview", label: "Overview", group: "Quality" },
  { id: "manual", label: "Quality manual", group: "Quality" },
  { id: "peer-reviews", label: "Peer review", group: "Quality" },
  { id: "acceptance", label: "Client acceptance", group: "Quality" },
  { id: "kyc", label: "KYC status", group: "Quality" },
  { id: "previous-auditors", label: "Previous auditors", group: "Quality" },
  { id: "independence", label: "Independence", group: "Quality" },
  { id: "retention", label: "Retention", group: "Quality" },
  { id: "restore-drills", label: "Restore drills", group: "Quality" },
  { id: "notices", label: "Privacy notices", group: "Data protection" },
  { id: "consents", label: "Consent records", group: "Data protection" },
  { id: "data-requests", label: "Data requests", group: "Data protection" },
  { id: "incidents", label: "Incidents", group: "Data protection" },
] as const;
export type QualityTab = (typeof QUALITY_TABS)[number]["id"];

export function isQualityTab(v: unknown): v is QualityTab {
  return typeof v === "string" && QUALITY_TABS.some((t) => t.id === v);
}

// -------------------------------------------------------------------------------------------------
// SQC 1 elements and SQM 1 components (§6.8)
// -------------------------------------------------------------------------------------------------

export const QUALITY_FRAMEWORKS = ["sqc1", "sqm1"] as const;
export type QualityFramework = (typeof QUALITY_FRAMEWORKS)[number];

export const QUALITY_FRAMEWORK_LABELS: Record<QualityFramework, string> = {
  sqc1: "SQC 1 (in force)",
  sqm1: "SQM 1 (risk-assessment approach)",
};

export const SQC1_ELEMENTS = ["leadership", "ethics_independence", "acceptance_continuance", "human_resources", "engagement_performance", "monitoring"] as const;
export type Sqc1Element = (typeof SQC1_ELEMENTS)[number];

export const SQC1_ELEMENT_LABELS: Record<Sqc1Element, string> = {
  leadership: "Leadership responsibilities for quality",
  ethics_independence: "Ethical requirements and independence",
  acceptance_continuance: "Acceptance and continuance of clients and engagements",
  human_resources: "Human resources",
  engagement_performance: "Engagement performance, review and consultation",
  monitoring: "Monitoring",
};

export const SQM1_COMPONENTS = [
  "risk_assessment_process",
  "governance_leadership",
  "relevant_ethical_requirements",
  "acceptance_continuance",
  "engagement_performance",
  "resources",
  "information_communication",
  "monitoring_remediation",
] as const;
export type Sqm1Component = (typeof SQM1_COMPONENTS)[number];

export const SQM1_COMPONENT_LABELS: Record<Sqm1Component, string> = {
  risk_assessment_process: "The firm's risk assessment process",
  governance_leadership: "Governance and leadership",
  relevant_ethical_requirements: "Relevant ethical requirements",
  acceptance_continuance: "Acceptance and continuance",
  engagement_performance: "Engagement performance",
  resources: "Resources",
  information_communication: "Information and communication",
  monitoring_remediation: "Monitoring and remediation",
};

/** Where an SQC 1 element sits under SQM 1, for a firm that adopts SQM 1. */
export const SQC1_TO_SQM1: Record<Sqc1Element, Sqm1Component> = {
  leadership: "governance_leadership",
  ethics_independence: "relevant_ethical_requirements",
  acceptance_continuance: "acceptance_continuance",
  human_resources: "resources",
  engagement_performance: "engagement_performance",
  monitoring: "monitoring_remediation",
};

/** Every value `quality_manual_items.element` takes (0197): the six SQC 1 elements and the SQM 1 components. */
export const QUALITY_ELEMENTS = [
  "leadership",
  "ethics_independence",
  "acceptance_continuance",
  "human_resources",
  "engagement_performance",
  "monitoring",
  "governance_leadership",
  "relevant_ethical_requirements",
  "resources",
  "information_communication",
  "monitoring_remediation",
  "risk_assessment_process",
] as const;
export type QualityElement = (typeof QUALITY_ELEMENTS)[number];

/** The group an item shows under, for the framework in force. */
export function qualityGroupOf(item: { element: string; sqm1Component: string | null }, framework: QualityFramework): string {
  if (framework === "sqc1") {
    return (SQC1_ELEMENTS as readonly string[]).includes(item.element) ? item.element : "monitoring";
  }
  if (item.sqm1Component && (SQM1_COMPONENTS as readonly string[]).includes(item.sqm1Component)) return item.sqm1Component;
  if ((SQM1_COMPONENTS as readonly string[]).includes(item.element)) return item.element;
  return SQC1_TO_SQM1[item.element as Sqc1Element] ?? "monitoring_remediation";
}

export function qualityGroupLabel(group: string): string {
  return (SQC1_ELEMENT_LABELS as Record<string, string>)[group] ?? (SQM1_COMPONENT_LABELS as Record<string, string>)[group] ?? group.replace(/_/g, " ");
}

// -------------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------------

const uuid = (what: string) => z.uuid({ error: `Choose ${what}.` });
const concurrency = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

const requiredText = (what: string, min: number, max: number) =>
  z
    .string({ error: `Enter ${what}.` })
    .trim()
    .min(min, { error: `Enter ${what}.` })
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` });

const date = (what: string) => z.string({ error: `Enter ${what}.` }).refine((v) => isDateString(v), { error: `Enter ${what} as a date.` });

const optionalDate = (what: string) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isDateString(v), { error: `Enter ${what} as a date.` });

const optionalUuid = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.uuid().safeParse(v).success, { error: "That choice isn't valid." });

const fy = z.string({ error: "Choose the financial year." }).refine((v) => isFinancialYear(v), { error: "Choose the financial year (for example 2026-27)." });

const wholeNumber = (what: string, min: number, max: number) =>
  z
    .union([z.string(), z.number()], { error: `Enter ${what}.` })
    .transform((v) => (typeof v === "number" ? v : Number(String(v).trim())))
    .pipe(z.number({ error: `Enter ${what} as a number.` }).int({ error: `Enter ${what} as a whole number.` }).min(min, { error: `At least ${min}.` }).max(max, { error: `At most ${max}.` }));

const optionalWholeNumber = (what: string, min: number, max: number) =>
  z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : typeof v === "number" ? v : Number(v.trim())))
    .refine((v) => v === null || (Number.isInteger(v) && v >= min && v <= max), { error: `Enter ${what} as a whole number from ${min} to ${max}.` });

// -------------------------------------------------------------------------------------------------
// Quality manual (quality_manual_items)
// -------------------------------------------------------------------------------------------------

export const QualityItemSchema = z.object({
  id: optionalUuid,
  updatedAt: z.string().nullish(),
  element: z.enum(QUALITY_ELEMENTS, { error: "Choose the element." }),
  title: requiredText("what the firm does", 3, 300),
  ownerEmployeeId: optionalUuid,
  lastReviewedOn: optionalDate("the last review"),
  reviewEveryMonths: wholeNumber("how often it is reviewed", 1, 60),
  notes: text(4000),
  sqm1Component: z
    .union([z.enum(SQM1_COMPONENTS), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  qualityObjective: text(2000),
  qualityRisk: text(2000),
  riskResponse: text(2000),
});
export type QualityItemInput = z.input<typeof QualityItemSchema>;

export const ItemReviewedSchema = z.object({ id: uuid("the item"), updatedAt: concurrency, note: text(2000) });
export const DeleteItemSchema = z.object({ id: uuid("the item") });

export const FrameworkSchema = z.object({
  framework: z.enum(QUALITY_FRAMEWORKS, { error: "Choose the framework." }),
  updatedAt: concurrency,
});

/** Whether an item's review is due (last reviewed + its cycle has passed, or never reviewed). */
export function qualityItemReviewDue(lastReviewedOn: string | null, everyMonths: number, today: string, addMonths: (d: string, m: number) => string): boolean {
  if (!lastReviewedOn) return true;
  return addMonths(lastReviewedOn, everyMonths) < today;
}

// -------------------------------------------------------------------------------------------------
// Peer review (§6.8)
// -------------------------------------------------------------------------------------------------

export const PEER_REVIEW_STATUSES = ["scheduled", "in_progress", "completed"] as const;
export const PEER_REVIEW_STATUS_INFO: Record<(typeof PEER_REVIEW_STATUSES)[number], { label: string; tone: "muted" | "info" | "success"; meaning: string }> = {
  scheduled: { label: "Scheduled", tone: "muted", meaning: "Scheduled: the review is planned. Prepare the files the reviewer will sample." },
  in_progress: { label: "In progress", tone: "info", meaning: "In progress: the reviewer is examining the firm's records." },
  completed: { label: "Completed", tone: "success", meaning: "Completed: the certificate is issued. Its validity is checked before each audit that needs a peer-reviewed auditor." },
};

export const PeerReviewSchema = z
  .object({
    id: optionalUuid,
    updatedAt: z.string().nullish(),
    periodFrom: date("the start of the period reviewed"),
    periodTo: date("the end of the period reviewed"),
    reviewerName: requiredText("the reviewer's name", 2, 160),
    reviewerFrn: z
      .string()
      .trim()
      .toUpperCase()
      .max(12)
      .nullish()
      .transform((v) => (v ? v : null)),
    status: z.enum(PEER_REVIEW_STATUSES, { error: "Choose the status." }),
    reviewedOn: optionalDate("the review date"),
    certificateNo: text(80),
    validUntil: optionalDate("the date the certificate is valid until"),
    observations: text(4000),
    notes: text(4000),
  })
  .superRefine((v, ctx) => {
    if (v.periodTo < v.periodFrom) ctx.addIssue({ code: "custom", path: ["periodTo"], message: "The period can't end before it starts." });
    if (v.status === "completed") {
      if (!v.certificateNo) ctx.addIssue({ code: "custom", path: ["certificateNo"], message: "Enter the certificate number." });
      if (!v.reviewedOn) ctx.addIssue({ code: "custom", path: ["reviewedOn"], message: "Enter the review date." });
      if (!v.validUntil) ctx.addIssue({ code: "custom", path: ["validUntil"], message: "Enter the date the certificate is valid until." });
    }
    if (v.validUntil && v.reviewedOn && v.validUntil < v.reviewedOn) ctx.addIssue({ code: "custom", path: ["validUntil"], message: "The certificate can't expire before the review date." });
  });
export type PeerReviewInput = z.input<typeof PeerReviewSchema>;

export const DeletePeerReviewSchema = z.object({ id: uuid("the peer review") });

// -------------------------------------------------------------------------------------------------
// Independence declarations (§6.8: yes/no questionnaire plus details, annual, per staff member)
// -------------------------------------------------------------------------------------------------

export const INDEPENDENCE_QUESTIONS = [
  { key: "financial_interest", text: "Do you, or a close family member, hold shares, debentures or another financial interest in any client of the firm?" },
  { key: "loans_guarantees", text: "Have you, or a close family member, taken or given a loan or guarantee to or from an audit client or its directors?" },
  { key: "business_relationship", text: "Do you have a business relationship with an audit client, its directors or promoters, other than as their auditor?" },
  { key: "family_relationship", text: "Is a relative of yours a director, partner or officer of a client, or in a position to influence its accounts?" },
  { key: "employment", text: "Were you employed by, or a director of, any audit client in the last two years?" },
  { key: "other_services", text: "Have you provided services to an audit client that the Code of Ethics doesn't allow alongside the audit (for example bookkeeping for a listed client, internal audit outsourcing)?" },
  { key: "fee_dependence", text: "Are you aware of fees from one client making up an unduly large share of the firm's or your income?" },
  { key: "gifts_hospitality", text: "Have you accepted gifts or hospitality from a client beyond what is clearly insignificant?" },
] as const;
export type IndependenceKey = (typeof INDEPENDENCE_QUESTIONS)[number]["key"];

const yesNo = z.enum(["yes", "no"], { error: "Answer yes or no." });

export const IndependenceSchema = z
  .object({
    financialYear: fy,
    employeeId: optionalUuid,
    answers: z.object(Object.fromEntries(INDEPENDENCE_QUESTIONS.map((q) => [q.key, yesNo])) as Record<IndependenceKey, typeof yesNo>),
    details: text(4000),
    updatedAt: z.string().nullish(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v.answers).some((a) => a === "yes") && !v.details) {
      ctx.addIssue({ code: "custom", path: ["details"], message: "Give the details for each yes, and the safeguards in place." });
    }
  });
export type IndependenceInput = z.input<typeof IndependenceSchema>;

/** The stored answers ({ key: true|false }). */
export function storedAnswers(answers: Record<IndependenceKey, "yes" | "no">): Record<string, boolean> {
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v === "yes"]));
}

/** Stored answers → the form's yes/no (unknown keys dropped, missing ones blank). */
export function formAnswers(stored: unknown): Partial<Record<IndependenceKey, "yes" | "no">> {
  const o = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out: Partial<Record<IndependenceKey, "yes" | "no">> = {};
  for (const q of INDEPENDENCE_QUESTIONS) {
    if (o[q.key] === true) out[q.key] = "yes";
    else if (o[q.key] === false) out[q.key] = "no";
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Restore drills (§12)
// -------------------------------------------------------------------------------------------------

export const RESTORE_OUTCOMES = ["passed", "passed_with_issues", "failed"] as const;
export type RestoreOutcome = (typeof RESTORE_OUTCOMES)[number];
export const RESTORE_OUTCOME_INFO: Record<RestoreOutcome, { label: string; tone: "success" | "warning" | "danger"; meaning: string }> = {
  passed: { label: "Passed", tone: "success", meaning: "Passed: the backup restored completely and the checks matched." },
  passed_with_issues: { label: "Passed with issues", tone: "warning", meaning: "Passed with issues: restored, but something needs fixing before the next drill." },
  failed: { label: "Failed", tone: "danger", meaning: "Failed: the backup couldn't be restored as expected. Fix it and run the drill again." },
};

export const RestoreDrillSchema = z
  .object({
    performedOn: date("the date of the drill"),
    outcome: z.enum(RESTORE_OUTCOMES, { error: "Choose the outcome." }),
    backupReference: text(200),
    restoredTo: text(200),
    durationMinutes: optionalWholeNumber("the minutes taken", 1, 10080),
    checks: text(4000),
    issues: text(4000),
    notes: text(4000),
  })
  .superRefine((v, ctx) => {
    if (v.outcome !== "passed" && !v.issues) ctx.addIssue({ code: "custom", path: ["issues"], message: "Record what went wrong and what will be fixed." });
  });
export type RestoreDrillInput = z.input<typeof RestoreDrillSchema>;

/** The calendar quarter a date falls in ("2026-Q4"). */
export function calendarQuarter(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// -------------------------------------------------------------------------------------------------
// KYC register
// -------------------------------------------------------------------------------------------------

export const KYC_STATES = ["missing", "incomplete", "review_due", "current"] as const;
export type KycState = (typeof KYC_STATES)[number];
export const KYC_STATE_INFO: Record<KycState, { label: string; tone: "danger" | "warning" | "success"; meaning: string }> = {
  missing: { label: "No KYC", tone: "danger", meaning: "No KYC: nothing recorded yet. Audit and certification work can't move past Acceptance." },
  incomplete: { label: "Incomplete", tone: "danger", meaning: "Incomplete: something the client's category needs is missing. Audit work stays at Acceptance." },
  review_due: { label: "Re-confirm", tone: "warning", meaning: "Re-confirm: the annual KYC re-confirmation is due. Audit work stays at Acceptance until it is done." },
  current: { label: "Current", tone: "success", meaning: "Current: complete for the client's category and re-confirmed within the year." },
};

export const KYC_SORTABLE = ["client_name", "next_review_on", "verified_on", "kyc_state"] as const;
export const KYC_FILTERS = { state: KYC_STATES, audits: ["open"] } as const;

export const ReconfirmKycSchema = z.object({ clientId: uuid("the client"), kycUpdatedAt: concurrency });

// -------------------------------------------------------------------------------------------------
// Retention (§6.8)
// -------------------------------------------------------------------------------------------------

export const DISPOSAL_SORTABLE = ["retention_until", "client_name", "title"] as const;
