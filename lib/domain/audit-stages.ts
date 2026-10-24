/**
 * Audit engagements run to the Standards on Auditing (§6.9, §7.15.5): the seven stages, the
 * SA-mapped checklist of each stage, sign-offs, materiality (SA 320), the CARO 2020 applicability
 * indication, the tax-audit report form for the year, the SA 230 file-assembly countdown and the
 * retention date.
 *
 * - **Stages:** Acceptance → Planning → Risk assessment → Execution → Completion → Reporting →
 *   Archive. Forward moves go one stage at a time with the engagement partner's approval; the
 *   acceptance gates (KYC, independence and conflict check, previous auditor, SA 210 letter, peer
 *   review, ceilings) live in lib/domain/ceiling.ts `checkAuditStageMove` and, as the real control,
 *   in the database (`audit_stage_gate`, migration 0196).
 * - **Checklist:** every step names its SA references, whether it needs evidence (a document from the
 *   vault tagged to the step) and whether it may be marked not applicable. A step is done when it is
 *   prepared (or marked not applicable, with a reason) and then reviewed by someone else. The same
 *   list is seeded into `audit_step_definitions` (0195); tests/db/quality.test.ts checks they match.
 * - **Materiality (SA 320):** a basis and a percentage give the overall figure; performance
 *   materiality and the clearly-trivial threshold are percentages of it. Benchmarks are guidance,
 *   so figures outside them warn and never block.
 * - **CARO 2020:** applies to companies except banking, insurance and Section 8 companies, one person
 *   companies and small companies (Companies Act s.2(85), with the limits in force for the year), and
 *   the private companies Para 1(2)(v) leaves out. An indication for the partner, who records the
 *   decision (`caro_applicable`).
 * - **SA 230:** the final file is assembled within 60 days of the report date; working papers are kept
 *   7 years from it (SQC 1).
 *
 * Every number is a parameter (`AUDIT_DEFAULTS`, seeded by `AUDIT_SEED_PARAMETERS`). Pure and
 * client-safe; dates are `'YYYY-MM-DD'` and "today" is passed in.
 */

import { AUDIT_STAGES, AUDIT_STAGE_LABELS, type AuditStage } from "@/lib/domain/ceiling";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce, readParameterNumber } from "@/lib/domain/gst";
import { addDays, addMonths, diffDays, fyEnd, incomeTaxStatute, isDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { percentOf, toPaise, type Paise } from "@/lib/domain/money";

export { AUDIT_STAGES, AUDIT_STAGE_LABELS, type AuditStage };

// -------------------------------------------------------------------------------------------------
// Audit types and stages
// -------------------------------------------------------------------------------------------------

/** `audit_engagements.audit_type` (§5.12). */
export const AUDIT_TYPES = ["statutory_companies_act", "tax_audit", "gst_audit", "internal", "bank_branch", "stock", "certification", "other"] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  statutory_companies_act: "Statutory audit (Companies Act)",
  tax_audit: "Tax audit",
  gst_audit: "GST audit",
  internal: "Internal audit",
  bank_branch: "Bank branch audit",
  stock: "Stock audit",
  certification: "Certification",
  other: "Other audit",
};

export function isAuditType(v: unknown): v is AuditType {
  return typeof v === "string" && (AUDIT_TYPES as readonly string[]).includes(v);
}

export function isAuditStage(v: unknown): v is AuditStage {
  return typeof v === "string" && (AUDIT_STAGES as readonly string[]).includes(v);
}

/** The Standards each stage is built on, for the stage tracker. */
export const STAGE_STANDARDS: Record<AuditStage, string> = {
  acceptance: "KYC Norms · Clause 8 · SA 210",
  planning: "SA 300 · SA 320",
  risk_assessment: "SA 315 · SA 240 · SA 250 · SA 550",
  execution: "SA 330 · SA 500 · SA 505 · SA 520 · SA 530 · SA 540",
  completion: "SA 450 · SA 560 · SA 570 · SA 580 · SA 260/265",
  reporting: "SA 700/705 · SA 701 · SA 706 · CARO 2020 · UDIN",
  archived: "SA 230 · SQC 1",
};

export function stageIndex(stage: AuditStage): number {
  return AUDIT_STAGES.indexOf(stage);
}

export function nextStage(stage: AuditStage): AuditStage | null {
  const i = stageIndex(stage);
  return i >= 0 && i < AUDIT_STAGES.length - 1 ? AUDIT_STAGES[i + 1] : null;
}

export function previousStage(stage: AuditStage): AuditStage | null {
  const i = stageIndex(stage);
  return i > 0 && stage !== "archived" ? AUDIT_STAGES[i - 1] : null;
}

/** `report_type` (§5.12, SA 700/705). */
export const REPORT_TYPES = ["unmodified", "qualified", "adverse", "disclaimer"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  unmodified: "Unmodified opinion (SA 700)",
  qualified: "Qualified opinion (SA 705)",
  adverse: "Adverse opinion (SA 705)",
  disclaimer: "Disclaimer of opinion (SA 705)",
};

// -------------------------------------------------------------------------------------------------
// The SA checklist (§6.9)
// -------------------------------------------------------------------------------------------------

/** A live fact the app checks beside the sign-off (the gate enforces it as well). */
export type SystemCheck =
  | "kyc"
  | "acceptance"
  | "previous_auditor"
  | "peer_review"
  | "limits"
  | "engagement_letter"
  | "materiality"
  | "opinion"
  | "caro"
  | "udin"
  | "assembly";

export type AuditStep = {
  /** Stable key, stored in the checklist and on evidence links ("plan.strategy"). */
  key: string;
  stage: AuditStage;
  title: string;
  /** Standards and rules it rests on ("SA 300"). */
  sa: readonly string[];
  /** What the preparer does and files, in one or two sentences. */
  guidance: string;
  /** The preparer can't sign without at least one document tagged to the step. */
  evidenceRequired: boolean;
  /** May be marked not applicable, with a reason (still reviewed). */
  allowNa: boolean;
  /** Only for these audit types; every type when absent. */
  auditTypes?: readonly AuditType[];
  system?: SystemCheck;
};

const STATUTORY: readonly AuditType[] = ["statutory_companies_act"];

/**
 * The checklist, in order (§6.9). Mirrored by `audit_step_definitions` (0195): change both together.
 * Archive-stage steps are signed while the engagement is at Reporting and must be done to archive.
 */
export const AUDIT_STEPS: readonly AuditStep[] = [
  // 1. Acceptance and continuance
  {
    key: "acc.kyc",
    stage: "acceptance",
    title: "Client KYC complete and current",
    sa: ["ICAI KYC Norms"],
    guidance: "KYC for the client's category is complete and re-confirmed within the year: identity, PAN, business, last audited financial statements and the principal persons.",
    evidenceRequired: false,
    allowNa: false,
    system: "kyc",
  },
  {
    key: "acc.independence",
    stage: "acceptance",
    title: "Independence and conflict check",
    sa: ["SQC 1", "Code of Ethics"],
    guidance: "The conflict check is decided in the client acceptance register, and the independence questions (financial interest, relationships, other services, fee dependence) are answered with any threats and safeguards recorded.",
    evidenceRequired: false,
    allowNa: false,
    system: "acceptance",
  },
  {
    key: "acc.previous_auditor",
    stage: "acceptance",
    title: "Communication with the previous auditor",
    sa: ["CA Act 1949, First Schedule, Part I, Clause 8"],
    guidance: "Where another CA held the position, the letter to the outgoing auditor is recorded with proof of delivery, and the reply (or its absence) is noted. Not applicable for a first audit.",
    evidenceRequired: false,
    allowNa: true,
    system: "previous_auditor",
  },
  {
    key: "acc.peer_review",
    stage: "acceptance",
    title: "Peer review certificate valid on the acceptance date",
    sa: ["Peer Review Guidelines 2022"],
    guidance: "Where the entity needs a peer-reviewed auditor (listed entities, large unlisted public companies, public-interest entities), the firm's certificate is valid on the acceptance date.",
    evidenceRequired: false,
    allowNa: true,
    system: "peer_review",
  },
  {
    key: "acc.limits",
    stage: "acceptance",
    title: "Tax audit ceiling and company audit limit checked",
    sa: ["ICAI Tax Audit Guidelines 2025", "Companies Act s.141(3)(g)"],
    guidance: "The engagement partner stays within 60 tax audits in the year and 20 countable company audits. A tax audit over the ceiling needs a Partner's confirmation.",
    evidenceRequired: false,
    allowNa: true,
    system: "limits",
  },
  {
    key: "acc.ethics_fees",
    stage: "acceptance",
    title: "Fees agreed without a contingent or profit-based element",
    sa: ["CA Act 1949, First Schedule, Part I, Clause 10"],
    guidance: "The fee is fixed for the work, not a percentage of profits and not contingent on the findings or results.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "acc.engagement_letter",
    stage: "acceptance",
    title: "Engagement letter issued (SA 210)",
    sa: ["SA 210"],
    guidance: "The terms of the engagement are agreed in a letter at Issued or Signed for the year: objective and scope, responsibilities of auditor and management, the framework and the expected form of report.",
    evidenceRequired: false,
    allowNa: false,
    system: "engagement_letter",
  },
  // 2. Planning
  {
    key: "plan.strategy",
    stage: "planning",
    title: "Overall audit strategy and audit plan",
    sa: ["SA 300"],
    guidance: "The strategy sets scope, timing and direction; the plan sets the nature, timing and extent of procedures. File both.",
    evidenceRequired: true,
    allowNa: false,
  },
  {
    key: "plan.materiality",
    stage: "planning",
    title: "Materiality determined and documented",
    sa: ["SA 320"],
    guidance: "Record the basis, the overall materiality, performance materiality and the clearly-trivial threshold on the engagement.",
    evidenceRequired: false,
    allowNa: false,
    system: "materiality",
  },
  {
    key: "plan.team_briefing",
    stage: "planning",
    title: "Engagement team briefed",
    sa: ["SA 300", "SA 220"],
    guidance: "The team knows the client, the risks so far, materiality, the timetable and who reviews what.",
    evidenceRequired: false,
    allowNa: false,
  },
  // 3. Risk assessment
  {
    key: "risk.entity",
    stage: "risk_assessment",
    title: "Understanding of the entity, its environment and internal control",
    sa: ["SA 315"],
    guidance: "Document the business, the applicable framework, the internal control relevant to the audit and the walkthroughs done.",
    evidenceRequired: true,
    allowNa: false,
  },
  {
    key: "risk.significant",
    stage: "risk_assessment",
    title: "Risks of material misstatement and significant risks identified",
    sa: ["SA 315"],
    guidance: "Risks at the financial-statement and assertion levels, with the significant risks named.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "risk.fraud",
    stage: "risk_assessment",
    title: "Fraud risk assessed and discussed by the team",
    sa: ["SA 240"],
    guidance: "Management inquiries, the team discussion, revenue recognition and management override considered.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "risk.laws",
    stage: "risk_assessment",
    title: "Compliance with laws and regulations considered",
    sa: ["SA 250"],
    guidance: "Laws with a direct effect on the financial statements, and others fundamental to the business.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "risk.related_parties",
    stage: "risk_assessment",
    title: "Related parties and their transactions identified",
    sa: ["SA 550"],
    guidance: "The related-party list from management, checked against the records and the KYC principal persons.",
    evidenceRequired: false,
    allowNa: false,
  },
  // 4. Execution
  {
    key: "exec.responses",
    stage: "execution",
    title: "Responses to the assessed risks performed",
    sa: ["SA 330"],
    guidance: "Tests of controls and substantive procedures linked to each assessed risk.",
    evidenceRequired: true,
    allowNa: false,
  },
  {
    key: "exec.evidence",
    stage: "execution",
    title: "Sufficient appropriate audit evidence obtained",
    sa: ["SA 500"],
    guidance: "Working papers for each area, uploaded to the vault and tagged to this step.",
    evidenceRequired: true,
    allowNa: false,
  },
  {
    key: "exec.confirmations",
    stage: "execution",
    title: "External confirmations",
    sa: ["SA 505"],
    guidance: "Bank, debtor, creditor and other confirmations sent under the auditor's control, with replies and alternative procedures.",
    evidenceRequired: false,
    allowNa: true,
  },
  {
    key: "exec.analytics",
    stage: "execution",
    title: "Analytical procedures",
    sa: ["SA 520"],
    guidance: "Substantive analytics where used, and the overall review near the end of the audit.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "exec.sampling",
    stage: "execution",
    title: "Audit sampling",
    sa: ["SA 530"],
    guidance: "The population, sample size, selection method and the evaluation of results.",
    evidenceRequired: false,
    allowNa: true,
  },
  {
    key: "exec.estimates",
    stage: "execution",
    title: "Accounting estimates",
    sa: ["SA 540"],
    guidance: "How management made each estimate, and the auditor's evaluation of it.",
    evidenceRequired: false,
    allowNa: true,
  },
  // 5. Completion
  {
    key: "comp.misstatements",
    stage: "completion",
    title: "Misstatements evaluated",
    sa: ["SA 450"],
    guidance: "The summary of uncorrected misstatements against materiality, communicated to management.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "comp.subsequent_events",
    stage: "completion",
    title: "Subsequent events reviewed",
    sa: ["SA 560"],
    guidance: "Events between the balance sheet date and the report date.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "comp.going_concern",
    stage: "completion",
    title: "Going concern assessed",
    sa: ["SA 570"],
    guidance: "Management's assessment for at least twelve months, and any material uncertainty.",
    evidenceRequired: false,
    allowNa: false,
  },
  {
    key: "comp.representations",
    stage: "completion",
    title: "Written representations obtained",
    sa: ["SA 580"],
    guidance: "The management representation letter, signed and dated as near as practicable to the report date. Download the template from this engagement and file the signed copy.",
    evidenceRequired: true,
    allowNa: false,
  },
  {
    key: "comp.governance",
    stage: "completion",
    title: "Communication with those charged with governance",
    sa: ["SA 260", "SA 265"],
    guidance: "Significant findings and deficiencies in internal control communicated in writing.",
    evidenceRequired: false,
    allowNa: false,
  },
  // 6. Reporting
  {
    key: "rep.opinion",
    stage: "reporting",
    title: "Opinion formed and the report drafted",
    sa: ["SA 700", "SA 705"],
    guidance: "Record the report type and the report date on the engagement.",
    evidenceRequired: false,
    allowNa: false,
    system: "opinion",
  },
  {
    key: "rep.kam",
    stage: "reporting",
    title: "Key audit matters communicated",
    sa: ["SA 701"],
    guidance: "Required for listed entities and where the auditor decides to communicate them; otherwise not applicable.",
    evidenceRequired: false,
    allowNa: true,
    auditTypes: STATUTORY,
  },
  {
    key: "rep.eom",
    stage: "reporting",
    title: "Emphasis of matter and other matter paragraphs considered",
    sa: ["SA 706"],
    guidance: "Include them where needed; not applicable when there are none.",
    evidenceRequired: false,
    allowNa: true,
  },
  {
    key: "rep.caro",
    stage: "reporting",
    title: "CARO 2020 applicability decided and reported on",
    sa: ["CARO 2020", "Companies Act s.143(11)"],
    guidance: "CARO doesn't apply to small companies, one person companies, banking, insurance or Section 8 companies, or the private companies Para 1(2)(v) excludes. Record the decision.",
    evidenceRequired: false,
    allowNa: false,
    auditTypes: STATUTORY,
    system: "caro",
  },
  {
    key: "rep.tax_audit_form",
    stage: "reporting",
    title: "Tax audit report in the form for the year",
    sa: ["Income-tax Act 1961 s.44AB", "Income-tax Act 2025 s.63"],
    guidance: "Form 3CA or 3CB with 3CD up to AY 2026-27; Form 26 from tax year 2026-27.",
    evidenceRequired: true,
    allowNa: false,
    auditTypes: ["tax_audit"],
  },
  {
    key: "rep.udin",
    stage: "reporting",
    title: "UDIN generated within 60 days of signing",
    sa: ["ICAI UDIN Guidelines"],
    guidance: "Generate the UDIN on the ICAI portal, log it in the UDIN register and link it to this engagement.",
    evidenceRequired: false,
    allowNa: false,
    system: "udin",
  },
  // 7. Archive (signed at Reporting)
  {
    key: "arch.assembly",
    stage: "archived",
    title: "Final audit file assembled",
    sa: ["SA 230"],
    guidance: "Assemble the final file within 60 days of the report date. After archiving, nothing is changed or removed; any addition is logged as an amendment.",
    evidenceRequired: false,
    allowNa: false,
    system: "assembly",
  },
  {
    key: "arch.partner_review",
    stage: "archived",
    title: "Engagement partner's final review of the file",
    sa: ["SQC 1", "SA 220"],
    guidance: "The engagement partner is satisfied the file supports the report, before it is locked.",
    evidenceRequired: false,
    allowNa: false,
  },
];

const STEP_BY_KEY = new Map(AUDIT_STEPS.map((s) => [s.key, s]));

export function auditStep(key: string): AuditStep | null {
  return STEP_BY_KEY.get(key) ?? null;
}

export function stepApplies(step: AuditStep, auditType: AuditType): boolean {
  return !step.auditTypes || step.auditTypes.includes(auditType);
}

/** The steps for an audit type, optionally one stage's. */
export function stepsFor(auditType: AuditType, stage?: AuditStage): AuditStep[] {
  return AUDIT_STEPS.filter((s) => stepApplies(s, auditType) && (stage === undefined || s.stage === stage));
}

/**
 * The stages whose steps may be signed while the engagement is at `current`: its own, plus the
 * Archive steps while at Reporting (they must be done to archive). Nothing once archived.
 */
export function signableStages(current: AuditStage): AuditStage[] {
  if (current === "archived") return [];
  return current === "reporting" ? ["reporting", "archived"] : [current];
}

/** The steps the gate checks when leaving `from` for `to`: the stage being left, plus Archive's when archiving. */
export function gateSteps(auditType: AuditType, from: AuditStage, to: AuditStage): AuditStep[] {
  if (stageIndex(to) <= stageIndex(from)) return [];
  const stages: AuditStage[] = to === "archived" ? [from, "archived"] : [from];
  return AUDIT_STEPS.filter((s) => stepApplies(s, auditType) && stages.includes(s.stage));
}

// -------------------------------------------------------------------------------------------------
// Sign-offs (audit_engagements.checklist)
// -------------------------------------------------------------------------------------------------

export type StepSignoff = {
  preparedBy: string | null;
  preparedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notApplicable: boolean;
  naReason: string | null;
  note: string | null;
};

export const EMPTY_SIGNOFF: StepSignoff = { preparedBy: null, preparedAt: null, reviewedBy: null, reviewedAt: null, notApplicable: false, naReason: null, note: null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * The checklist column as stored: `{ "steps": { "<key>": { prepared_by, prepared_at, reviewed_by,
 * reviewed_at, na, na_reason, note } } }`. Anything malformed reads as not started.
 */
export function readChecklist(value: unknown): Record<string, StepSignoff> {
  const root = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const steps = root.steps !== null && typeof root.steps === "object" && !Array.isArray(root.steps) ? (root.steps as Record<string, unknown>) : {};
  const out: Record<string, StepSignoff> = {};
  for (const [key, raw] of Object.entries(steps)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    out[key] = {
      preparedBy: str(r.prepared_by),
      preparedAt: str(r.prepared_at),
      reviewedBy: str(r.reviewed_by),
      reviewedAt: str(r.reviewed_at),
      notApplicable: r.na === true,
      naReason: str(r.na_reason),
      note: str(r.note),
    };
  }
  return out;
}

export type StepState = "not_started" | "prepared" | "not_applicable" | "reviewed";

export const STEP_STATE_LABELS: Record<StepState, string> = {
  not_started: "To prepare",
  prepared: "Awaiting review",
  not_applicable: "Not applicable, awaiting review",
  reviewed: "Reviewed",
};

/** Where a step stands: reviewed (done), prepared or marked N/A (awaiting review), or not started. */
export function stepState(s: StepSignoff | undefined | null): StepState {
  if (!s) return "not_started";
  const prepared = Boolean(s.preparedAt) || s.notApplicable;
  if (prepared && s.reviewedAt) return "reviewed";
  if (s.notApplicable) return "not_applicable";
  return s.preparedAt ? "prepared" : "not_started";
}

/** Done: prepared (or N/A) and reviewed. Mirrors `audit_step_done` (0196). */
export function stepDone(s: StepSignoff | undefined | null): boolean {
  return stepState(s) === "reviewed";
}

export type StageProgress = { stage: AuditStage; total: number; done: number; awaitingReview: number; notStarted: AuditStep[]; complete: boolean };

/** How far a stage's checklist has got. */
export function stageProgress(auditType: AuditType, stage: AuditStage, checklist: Record<string, StepSignoff>): StageProgress {
  const steps = stepsFor(auditType, stage);
  let done = 0;
  let awaiting = 0;
  const notStarted: AuditStep[] = [];
  for (const step of steps) {
    const st = stepState(checklist[step.key]);
    if (st === "reviewed") done++;
    else if (st === "prepared" || st === "not_applicable") awaiting++;
    else notStarted.push(step);
  }
  return { stage, total: steps.length, done, awaitingReview: awaiting, notStarted, complete: steps.length > 0 && done === steps.length };
}

export type SignoffAction = "prepare" | "not_applicable" | "review" | "reopen";

export type SignoffCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether `actorId` may take a sign-off action on a step (mirrors `audit_step_signoff`, 0196):
 * only steps of the stages signable now; preparing an evidence step needs a document tagged to it;
 * N/A needs the step to allow it and a reason; review needs it prepared or N/A, and a reviewer who
 * didn't prepare it (nobody reviews their own work); a reviewed step is reopened before it changes.
 */
export function checkSignoff(input: {
  step: AuditStep;
  auditType: AuditType;
  currentStage: AuditStage;
  signoff: StepSignoff | null | undefined;
  action: SignoffAction;
  actorId: string;
  evidenceCount: number;
  reason?: string | null;
}): SignoffCheck {
  const { step, signoff, action } = input;
  const s = signoff ?? EMPTY_SIGNOFF;
  if (input.currentStage === "archived") return { ok: false, error: "This audit file is archived and read-only." };
  if (!stepApplies(step, input.auditType)) return { ok: false, error: "That step isn't part of this type of audit." };
  if (!signableStages(input.currentStage).includes(step.stage)) {
    return { ok: false, error: `This step belongs to ${AUDIT_STAGE_LABELS[step.stage]}. Sign off the steps of the stage the engagement is at.` };
  }
  const state = stepState(s);
  switch (action) {
    case "prepare":
      if (state === "reviewed") return { ok: false, error: "This step is already reviewed. Reopen it to change it." };
      if (step.evidenceRequired && input.evidenceCount === 0) return { ok: false, error: "Attach the working paper for this step before signing it as prepared." };
      return { ok: true };
    case "not_applicable":
      if (!step.allowNa) return { ok: false, error: "This step can't be marked not applicable." };
      if (state === "reviewed") return { ok: false, error: "This step is already reviewed. Reopen it to change it." };
      if (!input.reason || input.reason.trim().length < 5) return { ok: false, error: "Say why the step doesn't apply." };
      return { ok: true };
    case "review":
      if (state === "reviewed") return { ok: false, error: "This step is already reviewed." };
      if (state === "not_started") return { ok: false, error: "The step has to be prepared (or marked not applicable) before it is reviewed." };
      if (s.preparedBy && s.preparedBy === input.actorId) return { ok: false, error: "You prepared this step, so someone else has to review it." };
      return { ok: true };
    case "reopen":
      if (state === "not_started") return { ok: false, error: "Nothing has been signed on this step yet." };
      return { ok: true };
  }
}

// -------------------------------------------------------------------------------------------------
// Materiality (SA 320)
// -------------------------------------------------------------------------------------------------

export const MATERIALITY_BASES = ["profit_before_tax", "revenue", "total_assets", "equity", "total_expenses", "gross_profit"] as const;
export type MaterialityBasis = (typeof MATERIALITY_BASES)[number];

export const MATERIALITY_BASIS_LABELS: Record<MaterialityBasis, string> = {
  profit_before_tax: "Profit before tax",
  revenue: "Revenue",
  total_assets: "Total assets",
  equity: "Equity",
  total_expenses: "Total expenses",
  gross_profit: "Gross profit",
};

/** Commonly used percentage ranges per basis (guidance from practice, not a rule of SA 320). */
export const MATERIALITY_BENCHMARKS: Record<MaterialityBasis, { min: number; max: number; typical: number }> = {
  profit_before_tax: { min: 5, max: 10, typical: 5 },
  revenue: { min: 0.5, max: 2, typical: 1 },
  total_assets: { min: 0.5, max: 2, typical: 1 },
  equity: { min: 1, max: 5, typical: 2 },
  total_expenses: { min: 0.5, max: 2, typical: 1 },
  gross_profit: { min: 1, max: 5, typical: 2 },
};

/** Performance materiality as a % of overall (50–75 in practice) and clearly trivial (up to 5). */
export const PERFORMANCE_RANGE = { min: 50, max: 75, typical: 75 } as const;
export const TRIVIAL_RANGE = { min: 1, max: 5, typical: 5 } as const;

export type MaterialityInput = {
  basis: MaterialityBasis;
  /** The benchmark figure in paise (e.g. the year's revenue). */
  baseAmountPaise: Paise;
  /** % of the base for overall materiality (up to 2 decimals). */
  percent: number;
  /** % of overall for performance materiality. */
  performancePercent: number;
  /** % of overall for the clearly-trivial threshold. */
  trivialPercent: number;
};

export type MaterialityResult = {
  overallPaise: Paise;
  performancePaise: Paise;
  trivialPaise: Paise;
  /** Figures outside the usual ranges: a reason to document, never a block. */
  warnings: string[];
};

/**
 * Overall, performance and clearly-trivial materiality (SA 320), rounded to the paisa. Overall is
 * `base × percent`; performance and trivial are percentages of overall. Warns when a percentage is
 * outside the usual range for the basis, when the base isn't positive, and when trivial isn't
 * below performance.
 */
export function computeMateriality(input: MaterialityInput): MaterialityResult {
  const warnings: string[] = [];
  const bench = MATERIALITY_BENCHMARKS[input.basis];
  const overall = percentOf(Math.max(0, input.baseAmountPaise), input.percent);
  const performance = percentOf(overall, input.performancePercent);
  const trivial = percentOf(overall, input.trivialPercent);
  if (input.baseAmountPaise <= 0) warnings.push(`The ${MATERIALITY_BASIS_LABELS[input.basis].toLowerCase()} isn't positive, so it can't anchor materiality. Choose another basis.`);
  if (input.percent < bench.min || input.percent > bench.max) {
    warnings.push(`${input.percent}% of ${MATERIALITY_BASIS_LABELS[input.basis].toLowerCase()} is outside the usual ${bench.min}–${bench.max}%. Record why.`);
  }
  if (input.performancePercent < PERFORMANCE_RANGE.min || input.performancePercent > PERFORMANCE_RANGE.max) {
    warnings.push(`Performance materiality at ${input.performancePercent}% of overall is outside the usual ${PERFORMANCE_RANGE.min}–${PERFORMANCE_RANGE.max}%.`);
  }
  if (input.trivialPercent > TRIVIAL_RANGE.max) warnings.push(`A clearly-trivial threshold above ${TRIVIAL_RANGE.max}% of overall is unusually high.`);
  if (trivial >= performance && performance > 0) warnings.push("The clearly-trivial threshold should be well below performance materiality.");
  return { overallPaise: overall, performancePaise: performance, trivialPaise: trivial, warnings };
}

/** Materiality as stored on the engagement (`materiality` jsonb; amounts in rupees with 2 decimals). */
export type StoredMateriality = {
  basis: MaterialityBasis;
  base_amount: number;
  percent: number;
  overall: number;
  performance_percent: number;
  performance: number;
  trivial_percent: number;
  trivial: number;
  rationale: string | null;
  determined_on: DateString;
  determined_by: string | null;
};

const num = (v: unknown): number | null => {
  const n = readParameterNumber(v);
  return n !== null && Number.isFinite(n) ? n : null;
};

/** The stored materiality, or null when it isn't recorded (or is malformed). */
export function readMateriality(value: unknown): StoredMateriality | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const basis = r.basis;
  if (typeof basis !== "string" || !(MATERIALITY_BASES as readonly string[]).includes(basis)) return null;
  const overall = num(r.overall);
  const performance = num(r.performance);
  const trivial = num(r.trivial);
  if (overall === null || performance === null || trivial === null) return null;
  return {
    basis: basis as MaterialityBasis,
    base_amount: num(r.base_amount) ?? 0,
    percent: num(r.percent) ?? 0,
    overall,
    performance_percent: num(r.performance_percent) ?? 0,
    performance,
    trivial_percent: num(r.trivial_percent) ?? 0,
    trivial,
    rationale: str(r.rationale),
    determined_on: isDateString(r.determined_on) ? r.determined_on : "",
    determined_by: str(r.determined_by),
  };
}

/**
 * Whether stored materiality is usable for the Planning gate (mirrors 0196): overall > 0,
 * 0 < performance ≤ overall, 0 < trivial < performance.
 */
export function materialityComplete(m: StoredMateriality | null): boolean {
  if (!m) return false;
  const o = toPaise(m.overall);
  const p = toPaise(m.performance);
  const t = toPaise(m.trivial);
  return o > 0 && p > 0 && p <= o && t > 0 && t < p;
}

// -------------------------------------------------------------------------------------------------
// File assembly (SA 230) and retention (SQC 1)
// -------------------------------------------------------------------------------------------------

export type AuditParams = {
  /** SA 230: the final file is assembled within this many days of the report date (60). */
  fileAssemblyDays: number;
  /** Warn this many days before the assembly date (14). */
  fileAssemblyWarnDays: number;
  /** SQC 1: working papers kept this many years from the report date (7). */
  retentionYears: number;
  /** Companies Act s.2(85) limits, rupees in paise. */
  smallCompany: { paidUpCapitalPaise: Paise; turnoverPaise: Paise };
  /** CARO 2020 Para 1(2)(v): private companies at or under all three are excluded. */
  caroPrivateExemption: { capitalAndReservesPaise: Paise; borrowingsPaise: Paise; revenuePaise: Paise };
};

export const AUDIT_DEFAULTS: AuditParams = {
  fileAssemblyDays: 60,
  fileAssemblyWarnDays: 14,
  retentionYears: 7,
  smallCompany: { paidUpCapitalPaise: 10_00_00_000_00, turnoverPaise: 100_00_00_000_00 },
  caroPrivateExemption: { capitalAndReservesPaise: 1_00_00_000_00, borrowingsPaise: 1_00_00_000_00, revenuePaise: 10_00_00_000_00 },
};

/** The `statutory_parameters` keys read here (seeded by migration 0199). */
export const AUDIT_PARAM_KEYS = {
  smallCompanyLimits: "company.small_company_limits",
  caroPrivateExemption: "caro.private_company_exemption",
  fileAssemblyWarnDays: "audit.file_assembly_warn_days",
} as const;

/** Rows seeded by 0199 (amounts in rupees). The 1 Dec 2025 small-company limits are [verify]. */
export const AUDIT_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: AUDIT_PARAM_KEYS.smallCompanyLimits,
    value: { paid_up_capital: 20000000, turnover: 200000000 },
    effectiveFrom: "2021-04-01",
    effectiveTo: "2022-09-14",
    statute: "Companies Act, 2013",
    sectionRef: "s.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)",
    sourceRef: "G.S.R. 92(E) dated 1 Feb 2021",
    notes: "Small company: not a public company, paid-up capital up to ₹2 crore and turnover up to ₹20 crore. Holding, subsidiary, Section 8 and special-Act companies are never small.",
    verified: true,
  },
  {
    key: AUDIT_PARAM_KEYS.smallCompanyLimits,
    value: { paid_up_capital: 40000000, turnover: 400000000 },
    effectiveFrom: "2022-09-15",
    effectiveTo: "2025-11-30",
    statute: "Companies Act, 2013",
    sectionRef: "s.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)",
    sourceRef: "G.S.R. 700(E) dated 15 Sep 2022",
    notes: "Small company: paid-up capital up to ₹4 crore and turnover up to ₹40 crore.",
    verified: true,
  },
  {
    key: AUDIT_PARAM_KEYS.smallCompanyLimits,
    value: { paid_up_capital: 100000000, turnover: 1000000000 },
    effectiveFrom: "2025-12-01",
    effectiveTo: null,
    statute: "Companies Act, 2013",
    sectionRef: "s.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)",
    sourceRef: "MCA amendment in force from 1 Dec 2025 [verify]",
    notes: "Small company: paid-up capital up to ₹10 crore and turnover up to ₹100 crore, as amended with effect from 1 Dec 2025 (§6.9). [verify] the notification.",
    verified: false,
  },
  {
    key: AUDIT_PARAM_KEYS.caroPrivateExemption,
    value: { capital_and_reserves: 10000000, borrowings: 10000000, revenue: 100000000 },
    effectiveFrom: "2021-04-01",
    effectiveTo: null,
    statute: "Companies (Auditor's Report) Order, 2020",
    sectionRef: "Para 1(2)(v)",
    sourceRef: "CARO 2020, S.O. 849(E) dated 25 Feb 2020, applicable from FY 2021-22",
    notes: "CARO doesn't apply to a private company (not a holding or subsidiary of a public company) with paid-up capital and reserves up to ₹1 crore, borrowings from banks and financial institutions never above ₹1 crore in the year, and revenue up to ₹10 crore.",
    verified: true,
  },
  {
    key: AUDIT_PARAM_KEYS.fileAssemblyWarnDays,
    value: 14,
    effectiveFrom: "2009-04-01",
    effectiveTo: null,
    statute: "Firm practice",
    sectionRef: "SA 230 file assembly reminder",
    sourceRef: "TaxWise Practice OS specification §6.9",
    notes: "Remind the engagement partner this many days before the 60-day file assembly date.",
    verified: true,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The audit parameters in force on a date, each falling back to its default. */
export function resolveAuditParams(rows: readonly StatutoryParameterRow[], on: DateString): { params: AuditParams; missing: string[]; unverified: string[] } {
  const missing: string[] = [];
  const unverified: string[] = [];
  const d = AUDIT_DEFAULTS;
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
  const rupees = (v: unknown) => {
    const n = readParameterNumber(v);
    return n !== null && n >= 0 ? toPaise(n) : null;
  };
  return {
    params: {
      fileAssemblyDays: d.fileAssemblyDays,
      retentionYears: d.retentionYears,
      fileAssemblyWarnDays: read(AUDIT_PARAM_KEYS.fileAssemblyWarnDays, (v) => {
        const n = readParameterNumber(v);
        return n !== null && Number.isInteger(n) && n > 0 ? n : null;
      }, d.fileAssemblyWarnDays),
      smallCompany: read(
        AUDIT_PARAM_KEYS.smallCompanyLimits,
        (v) => {
          const o = asRecord(v);
          const cap = rupees(o?.paid_up_capital);
          const turnover = rupees(o?.turnover);
          return cap !== null && turnover !== null ? { paidUpCapitalPaise: cap, turnoverPaise: turnover } : null;
        },
        { ...d.smallCompany },
      ),
      caroPrivateExemption: read(
        AUDIT_PARAM_KEYS.caroPrivateExemption,
        (v) => {
          const o = asRecord(v);
          const a = rupees(o?.capital_and_reserves);
          const b = rupees(o?.borrowings);
          const c = rupees(o?.revenue);
          return a !== null && b !== null && c !== null ? { capitalAndReservesPaise: a, borrowingsPaise: b, revenuePaise: c } : null;
        },
        { ...d.caroPrivateExemption },
      ),
    },
    missing,
    unverified,
  };
}

/** SA 230: the final file is assembled by report date + 60 days (the generated `file_assembly_due`). */
export function fileAssemblyDue(reportDate: DateString, params: Pick<AuditParams, "fileAssemblyDays"> = AUDIT_DEFAULTS): DateString {
  return addDays(reportDate, params.fileAssemblyDays);
}

export type AssemblyState = "no_report" | "running" | "due_soon" | "overdue" | "assembled" | "assembled_late";

export type AssemblyCountdown = {
  state: AssemblyState;
  due: DateString | null;
  /** Days left while open (0 on the last day). */
  daysLeft: number | null;
  /** Days past the due date (open and overdue, or archived late). */
  daysLate: number | null;
};

/**
 * The file-assembly countdown (§7.15.5): nothing until there is a report date; then days left, "due
 * soon" inside the warning window, overdue after; once archived, on time or late by N days.
 */
export function fileAssemblyCountdown(
  input: { reportDate: DateString | null; archivedOn: DateString | null; today: DateString },
  params: Pick<AuditParams, "fileAssemblyDays" | "fileAssemblyWarnDays"> = AUDIT_DEFAULTS,
): AssemblyCountdown {
  if (!input.reportDate) return { state: "no_report", due: null, daysLeft: null, daysLate: null };
  const due = fileAssemblyDue(input.reportDate, params);
  if (input.archivedOn) {
    const late = diffDays(input.archivedOn, due);
    return late > 0 ? { state: "assembled_late", due, daysLeft: null, daysLate: late } : { state: "assembled", due, daysLeft: null, daysLate: null };
  }
  const left = diffDays(due, input.today);
  if (left < 0) return { state: "overdue", due, daysLeft: null, daysLate: -left };
  return { state: left <= params.fileAssemblyWarnDays ? "due_soon" : "running", due, daysLeft: left, daysLate: null };
}

/** SQC 1: working papers are kept until report date + 7 years (`retain_until`). */
export function auditRetainUntil(reportDate: DateString, params: Pick<AuditParams, "retentionYears"> = AUDIT_DEFAULTS): DateString {
  return addMonths(reportDate, params.retentionYears * 12);
}

// -------------------------------------------------------------------------------------------------
// Company facts: small company, CARO 2020, company audit limit
// -------------------------------------------------------------------------------------------------

/** What the engagement records about the company (`company_profile` jsonb), amounts in rupees. */
export type CompanyFacts = {
  isPublic: boolean | null;
  isOnePersonCompany: boolean;
  isSection8: boolean;
  isBanking: boolean;
  isInsurance: boolean;
  isHoldingOrSubsidiary: boolean;
  /** Holding or subsidiary of a public company (CARO Para 1(2)(v)). */
  isHoldingOrSubsidiaryOfPublic: boolean;
  isSpecialAct: boolean;
  isDormant: boolean;
  paidUpCapital: number | null;
  turnover: number | null;
  /** Paid-up capital plus reserves and surplus at the balance sheet date. */
  capitalAndReserves: number | null;
  /** Highest borrowings from banks or financial institutions at any time in the year. */
  maxBorrowings: number | null;
  /** Total revenue as in Schedule III, discontinued operations included. */
  revenue: number | null;
};

export const EMPTY_COMPANY_FACTS: CompanyFacts = {
  isPublic: null,
  isOnePersonCompany: false,
  isSection8: false,
  isBanking: false,
  isInsurance: false,
  isHoldingOrSubsidiary: false,
  isHoldingOrSubsidiaryOfPublic: false,
  isSpecialAct: false,
  isDormant: false,
  paidUpCapital: null,
  turnover: null,
  capitalAndReserves: null,
  maxBorrowings: null,
  revenue: null,
};

const bool = (v: unknown) => v === true;
const nullableBool = (v: unknown) => (v === true ? true : v === false ? false : null);
const amount = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

/** `company_profile` as stored (snake_case keys) → CompanyFacts. */
export function readCompanyFacts(value: unknown): CompanyFacts {
  const r = asRecord(value) ?? {};
  return {
    isPublic: nullableBool(r.is_public),
    isOnePersonCompany: bool(r.is_one_person_company),
    isSection8: bool(r.is_section_8),
    isBanking: bool(r.is_banking),
    isInsurance: bool(r.is_insurance),
    isHoldingOrSubsidiary: bool(r.is_holding_or_subsidiary),
    isHoldingOrSubsidiaryOfPublic: bool(r.is_holding_or_subsidiary_of_public),
    isSpecialAct: bool(r.is_special_act),
    isDormant: bool(r.is_dormant),
    paidUpCapital: amount(r.paid_up_capital),
    turnover: amount(r.turnover),
    capitalAndReserves: amount(r.capital_and_reserves),
    maxBorrowings: amount(r.max_borrowings),
    revenue: amount(r.revenue),
  };
}

/** CompanyFacts → the stored `company_profile`. */
export function toStoredCompanyFacts(f: CompanyFacts): Record<string, boolean | number | null> {
  return {
    is_public: f.isPublic,
    is_one_person_company: f.isOnePersonCompany,
    is_section_8: f.isSection8,
    is_banking: f.isBanking,
    is_insurance: f.isInsurance,
    is_holding_or_subsidiary: f.isHoldingOrSubsidiary,
    is_holding_or_subsidiary_of_public: f.isHoldingOrSubsidiaryOfPublic,
    is_special_act: f.isSpecialAct,
    is_dormant: f.isDormant,
    paid_up_capital: f.paidUpCapital,
    turnover: f.turnover,
    capital_and_reserves: f.capitalAndReserves,
    max_borrowings: f.maxBorrowings,
    revenue: f.revenue,
  };
}

/**
 * Small company (Companies Act s.2(85)) with the limits in force: not public, not a holding or
 * subsidiary company, not Section 8 or special-Act, and paid-up capital and turnover both within
 * the limits. Null when the facts needed aren't recorded. Mirrors `is_small_company` (0196).
 */
export function isSmallCompany(f: CompanyFacts, limits: AuditParams["smallCompany"] = AUDIT_DEFAULTS.smallCompany): boolean | null {
  if (f.isPublic === true || f.isHoldingOrSubsidiary || f.isSection8 || f.isSpecialAct) return false;
  if (f.isPublic === null || f.paidUpCapital === null || f.turnover === null) return null;
  return toPaise(f.paidUpCapital) <= limits.paidUpCapitalPaise && toPaise(f.turnover) <= limits.turnoverPaise;
}

export type CaroIndication = { applicable: boolean | null; reason: string };

/**
 * Whether CARO 2020 applies (§6.9): an indication for the partner, who records the decision.
 * Excluded: banking, insurance and Section 8 companies, OPCs, small companies, and private companies
 * that aren't a holding or subsidiary of a public company and are within all three Para 1(2)(v)
 * limits. Null with the reason when a fact it needs isn't recorded.
 */
export function caroApplicability(f: CompanyFacts, params: Pick<AuditParams, "smallCompany" | "caroPrivateExemption"> = AUDIT_DEFAULTS): CaroIndication {
  if (f.isBanking) return { applicable: false, reason: "CARO 2020 doesn't apply to a banking company (Para 1(2)(i))." };
  if (f.isInsurance) return { applicable: false, reason: "CARO 2020 doesn't apply to an insurance company (Para 1(2)(ii))." };
  if (f.isSection8) return { applicable: false, reason: "CARO 2020 doesn't apply to a Section 8 company (Para 1(2)(iii))." };
  if (f.isOnePersonCompany) return { applicable: false, reason: "CARO 2020 doesn't apply to a one person company (Para 1(2)(iv))." };
  const small = isSmallCompany(f, params.smallCompany);
  if (small === true) return { applicable: false, reason: "CARO 2020 doesn't apply to a small company (Para 1(2)(iv)), on the limits in force for the year." };
  if (f.isPublic === null) return { applicable: null, reason: "Record whether the company is public or private." };
  if (f.isPublic === false && !f.isHoldingOrSubsidiaryOfPublic) {
    const e = params.caroPrivateExemption;
    if (f.capitalAndReserves === null || f.maxBorrowings === null || f.revenue === null) {
      if (small === null) return { applicable: null, reason: "Record paid-up capital and turnover (small company), and capital and reserves, borrowings and revenue (Para 1(2)(v))." };
      return { applicable: null, reason: "Record capital and reserves, the highest borrowings in the year and revenue to check the private company exclusion (Para 1(2)(v))." };
    }
    if (toPaise(f.capitalAndReserves) <= e.capitalAndReservesPaise && toPaise(f.maxBorrowings) <= e.borrowingsPaise && toPaise(f.revenue) <= e.revenuePaise) {
      return { applicable: false, reason: "CARO 2020 doesn't apply: a private company within the capital and reserves, borrowings and revenue limits of Para 1(2)(v)." };
    }
  }
  if (small === null && f.isPublic === false) return { applicable: null, reason: "Record paid-up capital and turnover to check the small company exclusion." };
  return { applicable: true, reason: "CARO 2020 applies: none of the exclusions in Para 1(2) is met." };
}

/**
 * Whether the audit counts towards the 20-audit limit (§6.8, s.141(3)(g)): not OPCs, small or
 * dormant companies, or private companies with paid-up capital under ₹100 crore. Null when the facts
 * aren't recorded. Mirrors `company_counts_towards_audit_limit` (0196).
 */
export function countsTowardsCompanyLimit(f: CompanyFacts, privatePaidUpExclusionPaise: Paise, limits: AuditParams["smallCompany"] = AUDIT_DEFAULTS.smallCompany): boolean | null {
  if (f.isOnePersonCompany || f.isDormant) return false;
  const small = isSmallCompany(f, limits);
  if (small === true) return false;
  if (f.isPublic === null) return null;
  if (f.isPublic === false) {
    if (f.paidUpCapital === null) return null;
    return toPaise(f.paidUpCapital) >= privatePaidUpExclusionPaise;
  }
  return true;
}

// -------------------------------------------------------------------------------------------------
// Tax audit report form (§6.1, §6.9)
// -------------------------------------------------------------------------------------------------

/** "Form 3CA/3CB with 3CD" for 1961-Act years (AY up to 2026-27), "Form 26" from tax year 2026-27. */
export function taxAuditReportForm(fy: FinancialYear): string {
  return incomeTaxStatute(fy) === "2025" ? "Form 26" : "Form 3CA/3CB with Form 3CD";
}

/** The balance sheet date an audit of `fy` reports on (31 March). */
export function balanceSheetDate(fy: FinancialYear): DateString {
  return fyEnd(fy);
}

// -------------------------------------------------------------------------------------------------
// Gate messages (the database returns codes; these are the words)
// -------------------------------------------------------------------------------------------------

/** One reason a stage move is refused, as `audit_stage_gate` returns it. */
export type GateItem = { code: string; message: string; step?: string | null };

export type GateResult = { ok: boolean; missing: GateItem[]; warnings: GateItem[]; from: AuditStage; to: AuditStage; isEngagementPartner: boolean };

/** Reads the jsonb `audit_stage_gate` returns, defensively. */
export function readGate(value: unknown, fallback: { from: AuditStage; to: AuditStage }): GateResult {
  const r = asRecord(value) ?? {};
  const items = (v: unknown): GateItem[] =>
    Array.isArray(v)
      ? v
          .map((x) => asRecord(x))
          .filter((x): x is Record<string, unknown> => x !== null && typeof x.message === "string")
          .map((x) => ({ code: typeof x.code === "string" ? x.code : "other", message: x.message as string, step: typeof x.step === "string" ? x.step : null }))
      : [];
  return {
    ok: r.ok === true,
    missing: items(r.missing),
    warnings: items(r.warnings),
    from: isAuditStage(r.from) ? r.from : fallback.from,
    to: isAuditStage(r.to) ? r.to : fallback.to,
    isEngagementPartner: r.is_engagement_partner === true,
  };
}

/** "Before Planning: …; …." from the gate's items (the action's error sentence). */
export function gateSentence(to: AuditStage, missing: readonly GateItem[]): string {
  if (missing.length === 0) return "";
  const parts = missing.map((m) => m.message.replace(/\.$/, ""));
  return `Before ${AUDIT_STAGE_LABELS[to]}: ${parts.join("; ")}.`;
}

// -------------------------------------------------------------------------------------------------
// Written representations (SA 580): the management representation letter template (§6.9, §11)
// -------------------------------------------------------------------------------------------------

export type RepresentationSection = { title: string; items: string[] };

export type RepresentationLetter = {
  /** "Audit of the financial statements for the year ended 31 March 2026". */
  subject: string;
  /** The paragraph that says what the letter is for and the framework. */
  opening: string;
  /** "We confirm, to the best of our knowledge and belief, …". */
  lead: string;
  sections: RepresentationSection[];
  /** Who signs for the entity, by its type ("Managing Director", "Chief Financial Officer"). */
  signatories: string[];
  /** SA 580 para 14: dated as near as practicable to, but not after, the auditor's report. */
  dateNote: string;
  /** Whether the letter carries the schedule of uncorrected misstatements (SA 450). */
  misstatementSchedule: boolean;
};

const COMPANY_ENTITIES = ["pvt_ltd", "public_ltd", "section_8"];

/** Who signs the representations for an entity of this type (SA 580: those with responsibility for the financial statements). */
export function representationSignatories(entityType: string | null): string[] {
  switch (entityType) {
    case "pvt_ltd":
    case "public_ltd":
    case "section_8":
      return ["Managing Director / Whole-time Director", "Chief Financial Officer"];
    case "llp":
      return ["Designated Partner", "Designated Partner"];
    case "partnership":
      return ["Partner", "Partner"];
    case "proprietorship":
    case "individual":
      return ["Proprietor"];
    case "trust":
      return ["Trustee", "Trustee"];
    case "huf":
      return ["Karta"];
    case "aop":
      return ["Principal officer"];
    default:
      return ["Authorised signatory"];
  }
}

/** The reporting framework the financial statements follow, in the letter's words. */
export function reportingFramework(auditType: AuditType, entityType: string | null): string {
  if (COMPANY_ENTITIES.includes(entityType ?? "") || auditType === "statutory_companies_act") {
    return "the Companies Act, 2013, including Schedule III, and the accounting standards notified under section 133 of the Act";
  }
  if (entityType === "llp") return "the Limited Liability Partnership Act, 2008 and the accounting standards issued by the Institute of Chartered Accountants of India";
  return "the accounting standards issued by the Institute of Chartered Accountants of India and the other accounting principles generally accepted in India";
}

/**
 * The SA 580 written representations for an engagement: the representations SA 580 requires
 * (management's responsibility for the financial statements as agreed in the engagement letter;
 * information and access provided; all transactions recorded), the specific ones other Standards
 * ask for (SA 240 fraud, SA 250 laws and regulations, SA 450 uncorrected misstatements, SA 501
 * litigation, SA 540 estimates, SA 550 related parties, SA 560 subsequent events, SA 570 going
 * concern), and those the type of engagement adds (Companies Act and CARO 2020 for a company audit,
 * the tax audit report's particulars, GST returns, stock, bank branch and certification work).
 * Pure: the PDF route prints it.
 */
export function representationLetter(input: {
  auditType: AuditType;
  entityName: string;
  entityType: string | null;
  financialYear: FinancialYear;
  engagementLetterDate: DateString | null;
  reportDate: DateString | null;
  caroApplicable: boolean | null;
  /** The framework the engagement letter names (SA 210); the usual one for the entity otherwise. */
  framework?: string | null;
  /** Formats a date ("22 Oct 2026"); passed in so this stays pure and locale-free. */
  formatDate: (d: DateString) => string;
}): RepresentationLetter {
  const { auditType, entityName } = input;
  const yearEnd = input.formatDate(fyEnd(input.financialYear));
  const terms = input.engagementLetterDate ? `as set out in the terms of the audit engagement dated ${input.formatDate(input.engagementLetterDate)}` : "as set out in the terms of the audit engagement";
  const framework = input.framework?.trim() || reportingFramework(auditType, input.entityType);
  const act2025 = incomeTaxStatute(input.financialYear) === "2025";
  const fsAudit = auditType === "statutory_companies_act" || auditType === "tax_audit" || auditType === "bank_branch" || auditType === "other";

  const subjects: Record<AuditType, string> = {
    statutory_companies_act: `Statutory audit of the financial statements for the year ended ${yearEnd}`,
    tax_audit: act2025 ? `Tax audit for tax year ${input.financialYear} (Income-tax Act, 2025)` : `Tax audit for the year ended ${yearEnd} (section 44AB, Income-tax Act, 1961)`,
    gst_audit: `Examination of GST records and the annual return reconciliation for the year ended ${yearEnd}`,
    internal: `Internal audit for the year ended ${yearEnd}`,
    bank_branch: `Audit of the branch's returns for the year ended ${yearEnd}`,
    stock: `Stock audit as at ${yearEnd}`,
    certification: `Certification engagement for the year ended ${yearEnd}`,
    other: `Audit of the financial statements for the year ended ${yearEnd}`,
  };

  const purpose: Record<AuditType, string> = {
    statutory_companies_act: `your audit of the financial statements of ${entityName} for the year ended ${yearEnd}, for the purpose of expressing an opinion on whether they give a true and fair view in accordance with ${framework}`,
    tax_audit: act2025
      ? `your audit of the accounts of ${entityName} for tax year ${input.financialYear} under the Income-tax Act, 2025, and the report you are to furnish in Form 26`
      : `your audit of the accounts of ${entityName} for the year ended ${yearEnd} under section 44AB of the Income-tax Act, 1961, and the report you are to furnish in Form 3CA/3CB with the particulars in Form 3CD`,
    gst_audit: `your examination of the GST records of ${entityName} for the year ended ${yearEnd} and the reconciliation of its annual return with the audited financial statements`,
    internal: `your internal audit of ${entityName} for the year ended ${yearEnd}, within the scope agreed in the engagement letter`,
    bank_branch: `your audit of the returns and financial information of the branch for the year ended ${yearEnd}`,
    stock: `your audit of the stocks of ${entityName} as at ${yearEnd}`,
    certification: `the certificate you are to issue for ${entityName} on the particulars set out in the engagement letter`,
    other: `your audit of the financial statements of ${entityName} for the year ended ${yearEnd}, in accordance with ${framework}`,
  };

  const sections: RepresentationSection[] = [];

  if (fsAudit) {
    sections.push({
      title: "Financial statements",
      items: [
        `We have fulfilled our responsibilities, ${terms}, for the preparation of the financial statements in accordance with ${framework}; in particular, the financial statements give a true and fair view (SA 580).`,
        "The methods, data and significant assumptions used in making accounting estimates, and the related disclosures, are appropriate and reasonable (SA 540).",
        "Related party relationships and transactions have been appropriately accounted for and disclosed (SA 550).",
        "All events after the balance sheet date for which the framework requires adjustment or disclosure have been adjusted or disclosed (SA 560).",
        "The effects of the uncorrected misstatements summarised in the schedule to this letter are immaterial, individually and in aggregate, to the financial statements as a whole (SA 450).",
        "All known actual or possible litigation and claims whose effects should be considered in preparing the financial statements have been disclosed to you and accounted for and disclosed in accordance with the framework (SA 501).",
        "We have assessed the entity's ability to continue as a going concern for at least twelve months from the balance sheet date, and have disclosed to you every event or condition that may cast significant doubt on it (SA 570).",
      ],
    });
  } else {
    sections.push({
      title: "Responsibilities",
      items: [`We have fulfilled our responsibilities ${terms}, and the records and statements given to you are complete and accurate.`],
    });
  }

  sections.push({
    title: "Information provided",
    items: [
      "We have provided you with access to all information we are aware of that is relevant to your work, such as records, documentation and other matters.",
      "We have provided the additional information you requested from us for the purpose of your work.",
      "We have given you unrestricted access to persons within the entity from whom you determined it necessary to obtain evidence.",
      "All transactions have been recorded in the accounting records and are reflected in the financial statements and the returns given to you.",
    ],
  });

  sections.push({
    title: "Fraud",
    items: [
      "We acknowledge our responsibility for the design, implementation and maintenance of internal control to prevent and detect fraud (SA 240).",
      "We have disclosed to you the results of our assessment of the risk that the financial statements may be materially misstated as a result of fraud.",
      "We have disclosed to you all information about fraud or suspected fraud that we are aware of and that affects the entity and involves management, employees who have significant roles in internal control, or others where the fraud could have a material effect.",
      "We have disclosed to you all information about allegations of fraud, or suspected fraud, affecting the entity's financial statements communicated by employees, former employees, analysts, regulators or others.",
    ],
  });

  sections.push({
    title: "Laws, regulations and related parties",
    items: [
      "We have disclosed to you all known instances of non-compliance or suspected non-compliance with laws and regulations whose effects should be considered when preparing the financial statements (SA 250).",
      "We have disclosed to you the identity of the entity's related parties and all the related party relationships and transactions of which we are aware (SA 550).",
    ],
  });

  switch (auditType) {
    case "statutory_companies_act":
      sections.push({
        title: "Companies Act, 2013",
        items: [
          "Proper books of account have been kept as required by section 128 of the Act, and the financial statements agree with them.",
          "We are responsible for establishing and maintaining internal financial controls with reference to the financial statements, and they operated effectively during the year (section 143(3)(i)).",
          "No director is disqualified from being appointed as a director under section 164(2) of the Act.",
          ...(input.entityType === "public_ltd" ? ["The managerial remuneration paid or provided is within the limits of section 197 of the Act, read with Schedule V."] : []),
          ...(input.caroApplicable === false
            ? []
            : ["We have given you the information and explanations you need to report on the matters in paragraphs 3 and 4 of the Companies (Auditor's Report) Order, 2020."]),
        ],
      });
      break;
    case "tax_audit":
      sections.push({
        title: act2025 ? "Tax audit report (Form 26)" : "Tax audit report (Form 3CD)",
        items: [
          `The particulars given to you for the ${act2025 ? "report in Form 26" : "statement of particulars in Form 3CD"} are true, correct and complete, and are drawn from the books of account and other records.`,
          act2025
            ? "All payments and expenses to which the disallowance provisions of the Income-tax Act, 2025 apply, and every detail of tax deducted or collected at source, have been disclosed to you."
            : "All payments and expenses to which sections 40(a), 40A(2)(b) and 40A(3) of the Income-tax Act, 1961 apply, and every detail of tax deducted or collected at source, have been disclosed to you.",
          "The method of accounting and the method of valuing closing stock were followed consistently, and any change has been disclosed to you.",
        ],
      });
      break;
    case "gst_audit":
      sections.push({
        title: "GST",
        items: [
          "The outward supplies in the returns filed (GSTR-1, GSTR-3B and the annual return) agree with the books of account, and any difference has been explained to you.",
          "Input tax credit claimed is supported by tax invoices or debit notes, the goods or services were received, and the conditions of section 16 of the CGST Act, 2017 are met.",
        ],
      });
      break;
    case "bank_branch":
      sections.push({
        title: "Branch returns",
        items: [
          "The branch returns are prepared from the branch's books and records, and advances are classified and provided for under the Reserve Bank of India's prudential norms on income recognition, asset classification and provisioning.",
        ],
      });
      break;
    case "stock":
      sections.push({
        title: "Stock",
        items: [
          "The stock statements given to you are complete, the quantities were physically verified, and stock is valued on the basis disclosed to you.",
          "Stock is free of charges other than those disclosed to you.",
        ],
      });
      break;
    case "certification":
      sections.push({
        title: "The particulars certified",
        items: ["The particulars on which you are to certify are true and correct and agree with the books of account and other records shown to you."],
      });
      break;
    case "internal":
    case "other":
      break;
  }

  return {
    subject: subjects[auditType],
    opening: `We provide this representation letter in connection with ${purpose[auditType]}.`,
    lead: "We confirm, to the best of our knowledge and belief, having made such enquiries as we considered necessary to inform ourselves properly, that:",
    sections,
    signatories: representationSignatories(input.entityType),
    dateNote: input.reportDate
      ? `Date this letter as near as practicable to, but not after, the date of the auditor's report (${input.formatDate(input.reportDate)}) (SA 580 para 14).`
      : "Date this letter as near as practicable to, but not after, the date of the auditor's report (SA 580 para 14).",
    misstatementSchedule: fsAudit,
  };
}

// -------------------------------------------------------------------------------------------------
// KYC re-confirmation reminders (§6.8 "Re-confirm annually")
// -------------------------------------------------------------------------------------------------

/** The date the client's KYC is next re-confirmed: next_review_on, else verified_on + 12 months; null when never verified. */
export function kycReviewDate(nextReviewOn: DateString | null, verifiedOn: DateString | null, months = 12): DateString | null {
  return nextReviewOn ?? (verifiedOn ? addMonths(verifiedOn, months) : null);
}

/** "due_soon" inside `warnDays` of the review date (the day included), "due" once it has passed. */
export function kycReminder(reviewOn: DateString | null, today: DateString, warnDays = 30): "due_soon" | "due" | null {
  if (!reviewOn) return null;
  const left = diffDays(reviewOn, today);
  if (left < 0) return "due";
  return left <= warnDays ? "due_soon" : null;
}
