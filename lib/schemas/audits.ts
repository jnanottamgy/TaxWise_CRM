/**
 * Audit engagements (§6.9, §7.15.5) and previous-auditor communications (§6.8 Clause 8): the zod
 * schemas shared by the forms and server/actions/{audits,previous-auditor}.ts, the list's sort and
 * filter keys, and the labels the screens use. Client-safe: pure.
 */

import { z } from "zod";
import { isDateString, isFinancialYear } from "@/lib/domain/fy";
import { parseAmount } from "@/lib/domain/money";
import {
  AUDIT_STAGES,
  AUDIT_TYPES,
  MATERIALITY_BASES,
  REPORT_TYPES,
  type AuditStage,
} from "@/lib/domain/audit-stages";

export const AUDIT_LIMITS = { notes: 4000, note: 2000, name: 160, objections: 4000, frn: 12 } as const;

// -------------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------------

const uuid = (what: string) => z.uuid({ error: `Choose ${what}.` });

export const concurrency = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });

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

/** "yes" / "no" / "" (not answered) → true / false / null. */
const triState = z
  .union([z.literal("yes"), z.literal("no"), z.literal(""), z.null(), z.boolean()])
  .optional()
  .transform((v) => (v === "yes" || v === true ? true : v === "no" || v === false ? false : null));

const fy = z.string({ error: "Choose the financial year." }).refine((v) => isFinancialYear(v), { error: "Choose the financial year (for example 2025-26)." });

/** Rupees typed into a field (`12,50,000`) → paise, or null when blank. */
const optionalPaise = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const r = parseAmount(String(v));
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    if (r.paise < 0) {
      ctx.addIssue({ code: "custom", message: "The amount can't be negative." });
      return z.NEVER;
    }
    return r.paise;
  });

const percent = (what: string, min: number, max: number) =>
  z
    .union([z.string(), z.number()], { error: `Enter ${what}.` })
    .transform((v) => (typeof v === "number" ? v : Number(String(v).trim().replace(/%$/, ""))))
    .pipe(
      z
        .number({ error: `Enter ${what} as a number.` })
        .finite({ error: `Enter ${what} as a number.` })
        .min(min, { error: `${what[0].toUpperCase()}${what.slice(1)} must be at least ${min}%.` })
        .max(max, { error: `${what[0].toUpperCase()}${what.slice(1)} can be at most ${max}%.` })
        .refine((n) => Math.round(n * 100) === n * 100, { error: "Use at most 2 decimal places." }),
    );

// -------------------------------------------------------------------------------------------------
// The list (/audits)
// -------------------------------------------------------------------------------------------------

export const AUDIT_LIST_SORTABLE = ["client_name", "financial_year", "stage", "report_date", "file_assembly_due", "updated_at"] as const;
export type AuditListSort = (typeof AUDIT_LIST_SORTABLE)[number];

/** Attention filters: what needs doing about the file. */
export const AUDIT_ATTENTION = ["assembly_due", "assembly_overdue", "no_udin", "open"] as const;
export type AuditAttention = (typeof AUDIT_ATTENTION)[number];

export const AUDIT_ATTENTION_LABELS: Record<AuditAttention, string> = {
  open: "Not archived",
  assembly_due: "File assembly due in 14 days",
  assembly_overdue: "File assembly overdue",
  no_udin: "Report signed, no UDIN",
};

export const AUDIT_LIST_FILTERS = {
  stage: AUDIT_STAGES,
  type: AUDIT_TYPES,
  partner: null,
  /** "year", not "fy": `fy` is the top bar's FY switcher, reserved by the table params. */
  year: null,
  attention: AUDIT_ATTENTION,
  client: null,
} as const;
export type AuditListFilter = keyof typeof AUDIT_LIST_FILTERS;

// -------------------------------------------------------------------------------------------------
// Create and edit
// -------------------------------------------------------------------------------------------------

export const CreateAuditSchema = z.object({
  clientId: uuid("the client"),
  auditType: z.enum(AUDIT_TYPES, { error: "Choose the type of audit." }),
  financialYear: fy,
  engagementPartnerId: uuid("the engagement partner"),
  reviewManagerId: optionalUuid,
  hadPreviousAuditor: triState,
  requiresPeerReviewedAuditor: z.boolean().default(false),
  notes: text(AUDIT_LIMITS.notes),
}).superRefine((v, ctx) => {
  if (v.reviewManagerId && v.reviewManagerId === v.engagementPartnerId) {
    ctx.addIssue({ code: "custom", path: ["reviewManagerId"], message: "The review manager can't be the engagement partner." });
  }
});
export type CreateAuditInput = z.input<typeof CreateAuditSchema>;

export const UpdateAuditSchema = z.object({
  id: uuid("the engagement"),
  updatedAt: concurrency,
  auditType: z.enum(AUDIT_TYPES, { error: "Choose the type of audit." }),
  financialYear: fy,
  engagementPartnerId: uuid("the engagement partner"),
  reviewManagerId: optionalUuid,
  hadPreviousAuditor: triState,
  requiresPeerReviewedAuditor: z.boolean().default(false),
  notes: text(AUDIT_LIMITS.notes),
}).superRefine((v, ctx) => {
  if (v.reviewManagerId && v.reviewManagerId === v.engagementPartnerId) {
    ctx.addIssue({ code: "custom", path: ["reviewManagerId"], message: "The review manager can't be the engagement partner." });
  }
});
export type UpdateAuditInput = z.input<typeof UpdateAuditSchema>;

export const AuditRefSchema = z.object({ id: uuid("the engagement") });

// -------------------------------------------------------------------------------------------------
// Materiality (SA 320)
// -------------------------------------------------------------------------------------------------

export const MaterialitySchema = z.object({
  id: uuid("the engagement"),
  updatedAt: concurrency,
  basis: z.enum(MATERIALITY_BASES, { error: "Choose the basis." }),
  baseAmount: z
    .union([z.string(), z.number()], { error: "Enter the benchmark figure." })
    .transform((v, ctx) => {
      const r = parseAmount(String(v));
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      }
      if (r.paise <= 0) {
        ctx.addIssue({ code: "custom", message: "The benchmark figure must be more than zero." });
        return z.NEVER;
      }
      return r.paise;
    }),
  percent: percent("the percentage", 0.01, 20),
  performancePercent: percent("performance materiality", 10, 100),
  trivialPercent: percent("the clearly-trivial threshold", 0.5, 20),
  rationale: z
    .string({ error: "Say why this basis and percentage." })
    .trim()
    .min(10, { error: "Say why this basis and percentage suit the entity (SA 320)." })
    .max(AUDIT_LIMITS.note, { error: "Keep it under 2,000 characters." }),
});
export type MaterialityInput = z.input<typeof MaterialitySchema>;

// -------------------------------------------------------------------------------------------------
// Company facts (CARO 2020, s.141(3)(g))
// -------------------------------------------------------------------------------------------------

/** The yes/no facts about a company, as one set of ticks on the form. */
export const COMPANY_FLAGS = [
  "isOnePersonCompany",
  "isSection8",
  "isBanking",
  "isInsurance",
  "isHoldingOrSubsidiary",
  "isHoldingOrSubsidiaryOfPublic",
  "isSpecialAct",
  "isDormant",
] as const;
export type CompanyFlag = (typeof COMPANY_FLAGS)[number];

export const COMPANY_FLAG_LABELS: Record<CompanyFlag, string> = {
  isOnePersonCompany: "One person company",
  isSection8: "Section 8 company",
  isBanking: "Banking company",
  isInsurance: "Insurance company",
  isHoldingOrSubsidiary: "Holding or subsidiary company",
  isHoldingOrSubsidiaryOfPublic: "Holding or subsidiary of a public company",
  isSpecialAct: "Governed by a special Act",
  isDormant: "Dormant company (s.455)",
};

export const CompanyFactsSchema = z.object({
  id: uuid("the engagement"),
  updatedAt: concurrency,
  isPublic: z.enum(["public", "private"], { error: "Choose public or private." }),
  flags: z.array(z.enum(COMPANY_FLAGS)).max(COMPANY_FLAGS.length).default([]),
  paidUpCapital: optionalPaise,
  turnover: optionalPaise,
  capitalAndReserves: optionalPaise,
  maxBorrowings: optionalPaise,
  revenue: optionalPaise,
}).superRefine((v, ctx) => {
  if (v.flags.includes("isOnePersonCompany") && v.isPublic === "public") ctx.addIssue({ code: "custom", path: ["flags"], message: "A one person company is a private company." });
  if (v.flags.includes("isHoldingOrSubsidiaryOfPublic") && !v.flags.includes("isHoldingOrSubsidiary")) ctx.addIssue({ code: "custom", path: ["flags"], message: "Tick holding or subsidiary company too." });
});
export type CompanyFactsInput = z.input<typeof CompanyFactsSchema>;

// -------------------------------------------------------------------------------------------------
// Report (SA 700/705, CARO, UDIN)
// -------------------------------------------------------------------------------------------------

export const ReportSchema = z.object({
  id: uuid("the engagement"),
  updatedAt: concurrency,
  reportType: z.enum(REPORT_TYPES, { error: "Choose the type of opinion." }),
  reportDate: date("the report date"),
  udinRecordId: optionalUuid,
  caroApplicable: triState,
});
export type ReportInput = z.input<typeof ReportSchema>;

// -------------------------------------------------------------------------------------------------
// Stage moves, sign-offs, evidence, the ceiling confirmation
// -------------------------------------------------------------------------------------------------

export const AdvanceStageSchema = z.object({
  id: uuid("the engagement"),
  updatedAt: concurrency,
  to: z.enum(AUDIT_STAGES, { error: "Choose the stage." }),
  note: text(AUDIT_LIMITS.note),
});
export type AdvanceStageInput = z.input<typeof AdvanceStageSchema>;

export const SIGNOFF_ACTIONS = ["prepare", "not_applicable", "review", "reopen"] as const;

export const SignoffSchema = z
  .object({
    id: uuid("the engagement"),
    step: z.string().trim().min(3).max(60).regex(/^[a-z]+\.[a-z_]+$/, { error: "That step isn't valid." }),
    action: z.enum(SIGNOFF_ACTIONS),
    note: text(AUDIT_LIMITS.note),
  })
  .superRefine((v, ctx) => {
    if (v.action === "not_applicable" && (!v.note || v.note.length < 5)) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Say why the step doesn't apply." });
    }
  });
export type SignoffInput = z.input<typeof SignoffSchema>;

export const AttachEvidenceSchema = z.object({
  id: uuid("the engagement"),
  step: z.string().trim().min(3).max(60).regex(/^[a-z]+\.[a-z_]+$/, { error: "That step isn't valid." }),
  documentIds: z.array(z.uuid({ error: "That document isn't valid." })).min(1, { error: "Choose at least one document." }).max(50, { error: "Attach at most 50 at a time." }),
  note: text(AUDIT_LIMITS.note),
});
export type AttachEvidenceInput = z.input<typeof AttachEvidenceSchema>;

export const DetachEvidenceSchema = z.object({ linkId: uuid("the working paper") });

export const LimitOverrideSchema = z.object({
  id: uuid("the engagement"),
  note: z
    .string({ error: "Record why." })
    .trim()
    .min(10, { error: "Record why the firm is taking this tax audit over the ceiling." })
    .max(AUDIT_LIMITS.note, { error: "Keep it under 2,000 characters." }),
});

// -------------------------------------------------------------------------------------------------
// Previous-auditor communications (Clause 8)
// -------------------------------------------------------------------------------------------------

export const SENT_VIA = ["registered_post", "speed_post", "email", "hand_delivery", "courier"] as const;
export type SentVia = (typeof SENT_VIA)[number];
export const SENT_VIA_LABELS: Record<SentVia, string> = {
  registered_post: "Registered post (AD)",
  speed_post: "Speed post",
  email: "Email",
  hand_delivery: "Hand delivery",
  courier: "Courier",
};

export const PREVIOUS_AUDITOR_OUTCOMES = ["no_objection", "objection_resolved", "objection_unresolved"] as const;
export type PreviousAuditorOutcome = (typeof PREVIOUS_AUDITOR_OUTCOMES)[number];
export const PREVIOUS_AUDITOR_OUTCOME_LABELS: Record<PreviousAuditorOutcome, string> = {
  no_objection: "No objection",
  objection_resolved: "Objection raised and resolved",
  objection_unresolved: "Objection not resolved",
};

/** ICAI firm registration numbers ("012345S") and member numbers ("123456"); upper-case. */
const frn = z
  .string()
  .trim()
  .toUpperCase()
  .max(AUDIT_LIMITS.frn, { error: "That registration number is too long." })
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[0-9A-Z]{6,12}$/.test(v), { error: "Enter the FRN as letters and digits only (for example 012345S)." });

export const PreviousAuditorSchema = z
  .object({
    id: optionalUuid,
    updatedAt: z.string().nullish(),
    clientId: uuid("the client"),
    auditEngagementId: optionalUuid,
    engagementType: z.enum(AUDIT_TYPES, { error: "Choose the type of audit." }),
    previousAuditorName: requiredText("the previous auditor's name", 2, AUDIT_LIMITS.name),
    previousAuditorFrn: frn,
    letterSentOn: date("the date the letter was sent"),
    sentVia: z
      .union([z.enum(SENT_VIA), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    deliveryProofDocumentId: optionalUuid,
    replyReceivedOn: optionalDate("the date of the reply"),
    objections: text(AUDIT_LIMITS.objections),
    outcome: z
      .union([z.enum(PREVIOUS_AUDITOR_OUTCOMES), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    notes: text(AUDIT_LIMITS.notes),
  })
  .superRefine((v, ctx) => {
    if (v.replyReceivedOn && v.replyReceivedOn < v.letterSentOn) {
      ctx.addIssue({ code: "custom", path: ["replyReceivedOn"], message: "The reply can't come before the letter." });
    }
    if (v.outcome && v.outcome !== "no_objection" && !v.objections) {
      ctx.addIssue({ code: "custom", path: ["objections"], message: "Record the objections raised." });
    }
  });
export type PreviousAuditorInput = z.input<typeof PreviousAuditorSchema>;

export const DeletePreviousAuditorSchema = z.object({ id: uuid("the letter") });

// -------------------------------------------------------------------------------------------------
// Labels and presentation helpers
// -------------------------------------------------------------------------------------------------

/** The stage chip: tone and meaning (§3.4 status never by colour alone). */
export const STAGE_CHIP: Record<AuditStage, { label: string; tone: "muted" | "info" | "violet" | "warning" | "success"; meaning: string }> = {
  acceptance: { label: "Acceptance", tone: "warning", meaning: "Acceptance: KYC, independence, the previous auditor, the SA 210 letter and the ceilings are checked before work starts." },
  planning: { label: "Planning", tone: "info", meaning: "Planning: strategy and plan (SA 300) and materiality (SA 320)." },
  risk_assessment: { label: "Risk assessment", tone: "info", meaning: "Risk assessment: the entity, significant and fraud risks, laws and related parties (SA 315, 240, 250, 550)." },
  execution: { label: "Execution", tone: "info", meaning: "Execution: responses to risk and evidence (SA 330, 500–540), working papers tagged to each step." },
  completion: { label: "Completion", tone: "violet", meaning: "Completion: misstatements, subsequent events, going concern, written representations, governance (SA 450–580, 260/265)." },
  reporting: { label: "Reporting", tone: "violet", meaning: "Reporting: the opinion, KAMs, EOM, CARO and the UDIN within 60 days of signing." },
  archived: { label: "Archived", tone: "success", meaning: "Archived: the file is assembled and read-only (SA 230); later additions are amendments. Kept 7 years from the report date." },
};

/** "AY 2026-27" for a 1961-Act year, "Tax year 2026-27" for a 2025-Act year, "FY …" otherwise. */
export function auditYearLabel(auditType: string, fy: string, taxYearLabel: (fy: string) => string): string {
  return auditType === "tax_audit" ? taxYearLabel(fy) : `FY ${fy}`;
}

/**
 * The year a new engagement starts on: an audit is of a completed year, so the one before the
 * current FY, unless the top bar has an earlier year chosen. `years` is newest first.
 */
export function defaultAuditFy(years: readonly string[], selected: string): string {
  const current = years[0] ?? selected;
  if (selected !== current && years.includes(selected)) return selected;
  return years[1] ?? current;
}
