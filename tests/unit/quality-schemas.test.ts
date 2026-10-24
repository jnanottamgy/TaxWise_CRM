import { describe, expect, it } from "vitest";
import { AUDIT_DEFAULTS, EMPTY_COMPANY_FACTS, type AuditStage } from "@/lib/domain/audit-stages";
import { CEILING_DEFAULTS } from "@/lib/domain/ceiling";
import { addMonths } from "@/lib/domain/fy";
import { AdvanceStageSchema, CompanyFactsSchema, MaterialitySchema, PreviousAuditorSchema, SignoffSchema, auditYearLabel, defaultAuditFy } from "@/lib/schemas/audits";
import { IndependenceSchema, PeerReviewSchema, RestoreDrillSchema, calendarQuarter, formAnswers, qualityGroupOf, qualityItemReviewDue, storedAnswers, INDEPENDENCE_QUESTIONS } from "@/lib/schemas/quality";
import { DataRequestStatusSchema, IncidentStepSchema, NoticeDraftSchema, isoToIstLocal, istLocalToIso, readIncidentActions } from "@/lib/schemas/dpdp";
import { taxYearLabel } from "@/lib/domain/fy";
import { assemblyWords, stageChip, trackerState } from "@/components/audits/audit-ui";
import { systemFacts } from "@/components/audits/facts";
import { qualityAreas } from "@/components/quality/overview";
import type { AuditDetail } from "@/lib/data/audits";
import type { QualityOverview } from "@/lib/data/quality";

/**
 * The forms' shared schemas (client and server parse the same rules, CONVENTIONS §5), and the
 * screens' pure helpers: the stage chip and tracker, the assembly countdown in words, the live fact
 * beside each checklist step, and the quality overview's areas, worst first.
 */

const ID = "5b1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f61";
const errs = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => (r.success ? {} : Object.fromEntries(r.error!.issues.map((i) => [i.path.join("."), i.message])));

describe("audit schemas", () => {
  it("parses materiality in rupees and percentages", () => {
    const r = MaterialitySchema.safeParse({ id: ID, updatedAt: "x", basis: "revenue", baseAmount: "10,00,00,000", percent: "1%", performancePercent: 75, trivialPercent: "5", rationale: "Revenue is what the lenders read." });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ baseAmount: 10_00_00_000_00, percent: 1, performancePercent: 75, trivialPercent: 5 });
    expect(errs(MaterialitySchema.safeParse({ id: ID, updatedAt: "x", basis: "revenue", baseAmount: "0", percent: "1.234", performancePercent: 75, trivialPercent: 5, rationale: "short" }))).toMatchObject({
      baseAmount: expect.any(String),
      percent: "Use at most 2 decimal places.",
      rationale: expect.any(String),
    });
  });

  it("checks the previous auditor's letter makes sense", () => {
    const ok = { clientId: ID, engagementType: "tax_audit", previousAuditorName: "Rao & Associates", previousAuditorFrn: "012345s", letterSentOn: "2026-10-01" };
    const r = PreviousAuditorSchema.safeParse(ok);
    expect(r.success && r.data.previousAuditorFrn).toBe("012345S");
    expect(errs(PreviousAuditorSchema.safeParse({ ...ok, replyReceivedOn: "2026-09-30" }))).toHaveProperty("replyReceivedOn");
    expect(errs(PreviousAuditorSchema.safeParse({ ...ok, outcome: "objection_unresolved" }))).toHaveProperty("objections");
    expect(errs(PreviousAuditorSchema.safeParse({ ...ok, previousAuditorFrn: "01-2345" }))).toHaveProperty("previousAuditorFrn");
  });

  it("takes the company's yes/no facts as one set of ticks, and catches contradictions", () => {
    const base = { id: ID, updatedAt: "x", isPublic: "private" };
    expect(CompanyFactsSchema.safeParse({ ...base, flags: ["isSection8"], paidUpCapital: "1,00,000" }).success).toBe(true);
    expect(errs(CompanyFactsSchema.safeParse({ ...base, isPublic: "public", flags: ["isOnePersonCompany"] }))).toHaveProperty("flags");
    expect(errs(CompanyFactsSchema.safeParse({ ...base, flags: ["isHoldingOrSubsidiaryOfPublic"] }))).toHaveProperty("flags");
    expect(errs(CompanyFactsSchema.safeParse({ ...base, flags: ["isPartnership"] }))).toHaveProperty("flags.0");
    expect(errs(CompanyFactsSchema.safeParse({ ...base, paidUpCapital: "-5" }))).toHaveProperty("paidUpCapital");
  });

  it("needs a reason for N/A, and accepts only real stages and step keys", () => {
    expect(errs(SignoffSchema.safeParse({ id: ID, step: "exec.sampling", action: "not_applicable", note: "no" }))).toHaveProperty("note");
    expect(SignoffSchema.safeParse({ id: ID, step: "exec.sampling", action: "prepare" }).success).toBe(true);
    expect(SignoffSchema.safeParse({ id: ID, step: "Exec;drop", action: "prepare" }).success).toBe(false);
    expect(AdvanceStageSchema.safeParse({ id: ID, updatedAt: "x", to: "closing" }).success).toBe(false);
  });

  it("starts a new engagement on the last completed year unless an earlier one is chosen", () => {
    const years = ["2026-27", "2025-26", "2024-25"];
    expect(defaultAuditFy(years, "2026-27")).toBe("2025-26");
    expect(defaultAuditFy(years, "2024-25")).toBe("2024-25");
    expect(defaultAuditFy(years, "2019-20")).toBe("2025-26");
  });

  it("labels a tax audit by its assessment or tax year, others by FY", () => {
    expect(auditYearLabel("tax_audit", "2025-26", taxYearLabel)).toBe("AY 2026-27");
    expect(auditYearLabel("tax_audit", "2026-27", taxYearLabel)).toBe("Tax year 2026-27");
    expect(auditYearLabel("statutory_companies_act", "2025-26", taxYearLabel)).toBe("FY 2025-26");
  });
});

describe("quality schemas", () => {
  it("needs details for any yes on the independence questionnaire", () => {
    const answers = Object.fromEntries(INDEPENDENCE_QUESTIONS.map((q) => [q.key, "no"]));
    expect(IndependenceSchema.safeParse({ financialYear: "2026-27", answers }).success).toBe(true);
    expect(errs(IndependenceSchema.safeParse({ financialYear: "2026-27", answers: { ...answers, financial_interest: "yes" } }))).toHaveProperty("details");
    expect(errs(IndependenceSchema.safeParse({ financialYear: "2026-27", answers: { ...answers, financial_interest: undefined } }))).toHaveProperty("answers.financial_interest");
    expect(storedAnswers({ ...(answers as Record<string, "yes" | "no">), fee_dependence: "yes" } as never).fee_dependence).toBe(true);
    expect(formAnswers({ financial_interest: true, other: false, employment: "x" })).toEqual({ financial_interest: "yes" });
  });

  it("needs the certificate on a completed peer review", () => {
    const base = { periodFrom: "2023-04-01", periodTo: "2026-03-31", reviewerName: "CA Meera Iyer", status: "completed" };
    expect(Object.keys(errs(PeerReviewSchema.safeParse(base)))).toEqual(expect.arrayContaining(["certificateNo", "reviewedOn", "validUntil"]));
    expect(errs(PeerReviewSchema.safeParse({ ...base, periodTo: "2022-03-31", status: "scheduled" }))).toHaveProperty("periodTo");
    expect(PeerReviewSchema.safeParse({ ...base, certificateNo: "PRB/2026/1234", reviewedOn: "2026-06-01", validUntil: "2029-06-01" }).success).toBe(true);
  });

  it("needs the issues when a restore drill didn't simply pass", () => {
    expect(errs(RestoreDrillSchema.safeParse({ performedOn: "2026-10-05", outcome: "failed" }))).toHaveProperty("issues");
    expect(RestoreDrillSchema.safeParse({ performedOn: "2026-10-05", outcome: "passed", durationMinutes: "35" }).success).toBe(true);
    expect(errs(RestoreDrillSchema.safeParse({ performedOn: "2026-10-05", outcome: "passed", durationMinutes: "0" }))).toHaveProperty("durationMinutes");
  });

  it("groups the manual by SQC 1 element, or by SQM 1 component once switched", () => {
    expect(qualityGroupOf({ element: "human_resources", sqm1Component: null }, "sqc1")).toBe("human_resources");
    expect(qualityGroupOf({ element: "human_resources", sqm1Component: null }, "sqm1")).toBe("resources");
    expect(qualityGroupOf({ element: "monitoring", sqm1Component: "information_communication" }, "sqm1")).toBe("information_communication");
    expect(qualityGroupOf({ element: "risk_assessment_process", sqm1Component: null }, "sqc1")).toBe("monitoring");
    expect(qualityItemReviewDue(null, 12, "2026-10-24", addMonths)).toBe(true);
    expect(qualityItemReviewDue("2025-10-01", 12, "2026-10-24", addMonths)).toBe(true);
    expect(qualityItemReviewDue("2026-01-01", 12, "2026-10-24", addMonths)).toBe(false);
    expect(calendarQuarter("2026-10-24")).toBe("2026-Q4");
  });
});

describe("data protection schemas", () => {
  it("converts the IST datetime inputs", () => {
    expect(istLocalToIso("2026-10-22T14:05")).toBe("2026-10-22T08:35:00.000Z");
    expect(isoToIstLocal("2026-10-22T08:35:00.000Z")).toBe("2026-10-22T14:05");
    expect(istLocalToIso("22/10/2026")).toBeNull();
    expect(isoToIstLocal(null)).toBe("");
  });

  it("needs the response to close and, for erasure, what is retained", () => {
    const base = { id: ID, updatedAt: "x", type: "erasure", status: "completed" };
    expect(Object.keys(errs(DataRequestStatusSchema.safeParse(base)))).toEqual(expect.arrayContaining(["response", "retainedExplanation"]));
    expect(DataRequestStatusSchema.safeParse({ ...base, response: "Erased on 22 Oct 2026.", retainedExplanation: "Nothing is retained." }).success).toBe(true);
    expect(DataRequestStatusSchema.safeParse({ ...base, type: "access", status: "in_progress" }).success).toBe(true);
  });

  it("needs a time for each breach step and the words for the assessment and root cause", () => {
    expect(errs(IncidentStepSchema.safeParse({ id: ID, updatedAt: "x", step: "contain" }))).toHaveProperty("at");
    expect(errs(IncidentStepSchema.safeParse({ id: ID, updatedAt: "x", step: "assess", at: "2026-10-22T14:05" }))).toHaveProperty("text");
    expect(IncidentStepSchema.safeParse({ id: ID, updatedAt: "x", step: "root_cause", text: "A shared password." }).success).toBe(true);
    expect(IncidentStepSchema.safeParse({ id: ID, updatedAt: "x", step: "contain", undo: true }).success).toBe(true);
    expect(readIncidentActions([{ at: "2026-10-22T08:35:00Z", text: "Contained", by: "u1", by_name: "Anita" }, { text: 3 }, null])).toEqual([{ at: "2026-10-22T08:35:00Z", text: "Contained", by: "u1", by_name: "Anita" }]);
  });

  it("needs a real notice body", () => {
    expect(errs(NoticeDraftSchema.safeParse({ body: "Too short" }))).toHaveProperty("body");
  });
});

describe("presentation helpers", () => {
  it("chips each stage, and marks the tracker", () => {
    expect(stageChip("acceptance").label).toBe("Acceptance");
    expect(stageChip("bogus").tone).toBe("muted");
    const order: readonly AuditStage[] = ["acceptance", "planning", "risk_assessment", "execution", "completion", "reporting", "archived"];
    expect(trackerState("acceptance", "planning", order)).toBe("done");
    expect(trackerState("planning", "planning", order)).toBe("current");
    expect(trackerState("execution", "planning", order)).toBe("ahead");
    expect(trackerState("archived", "archived", order)).toBe("done");
  });

  it("words the assembly countdown", () => {
    expect(assemblyWords({ state: "due_soon", due: "2026-10-31", daysLeft: 0, daysLate: null }).label).toBe("Due today");
    expect(assemblyWords({ state: "overdue", due: "2026-10-31", daysLeft: null, daysLate: 1 })).toMatchObject({ label: "1 day overdue", tone: "danger" });
    expect(assemblyWords({ state: "assembled_late", due: "2026-10-31", daysLeft: null, daysLate: 3 }).label).toBe("Assembled 3 days late");
  });
});

function detail(over: { engagement?: Partial<AuditDetail["engagement"]> } & Partial<Omit<AuditDetail, "engagement">> = {}): AuditDetail {
  const { engagement, ...rest } = over;
  return {
    engagement: {
      id: ID,
      client_id: "c1",
      audit_type: "tax_audit",
      financial_year: "2025-26",
      stage: "acceptance",
      engagement_partner_id: "e1",
      review_manager_id: null,
      had_previous_auditor: true,
      requires_peer_reviewed_auditor: false,
      report_date: null,
      report_type: null,
      udin_record_id: null,
      caro_applicable: null,
      archived_at: null,
      file_assembly_due: null,
      ...engagement,
    } as AuditDetail["engagement"],
    stage: "acceptance",
    auditType: "tax_audit",
    client: { id: "c1", display_name: "Sharma Traders", legal_name: null, client_code: "TW-C-0042", entity_type: "partnership", pan: null, address: null, city: null, state_code: null, pincode: null },
    partner: { id: "e1", name: "Vinay Karlagere", profileId: "p1" },
    reviewManager: null,
    checklist: {},
    materiality: null,
    company: EMPTY_COMPANY_FACTS,
    evidence: [],
    log: [],
    gate: null,
    limit: { kind: "tax_audit", level: "confirm", counted: true, position: 61, limit: 60, overridden: false, message: "This would be tax audit 61." },
    kyc: { missing: ["PAN"], complete: false, review_due: true, current: false },
    acceptance: null,
    peerReview: null,
    communications: [],
    letters: [],
    udins: [],
    linkedUdin: null,
    tasks: [],
    names: {},
    params: AUDIT_DEFAULTS,
    ceiling: CEILING_DEFAULTS,
    limitOverrideByName: null,
    ...rest,
  };
}

describe("the live fact beside each step (§18.3 Partner 3)", () => {
  it("says what holds the engagement at Acceptance, with the way to fix it", () => {
    const f = systemFacts(detail(), "2026-10-24", { isPartner: true });
    expect(f.kyc).toMatchObject({ tone: "danger", text: "KYC incomplete: PAN." });
    expect(f.previous_auditor).toMatchObject({ tone: "danger", action: { kind: "record_letter" } });
    expect(f.acceptance?.tone).toBe("danger");
    expect(f.engagement_letter?.tone).toBe("danger");
    expect(f.limits).toMatchObject({ tone: "danger", action: { kind: "confirm_limit" } });
    expect(systemFacts(detail(), "2026-10-24", { isPartner: false }).limits?.action).toBeUndefined();
    expect(f.peer_review?.tone).toBe("success");
  });

  it("passes the previous-auditor step only with proof of delivery for this audit", () => {
    const letter = { id: "l1", client_id: "c1", audit_engagement_id: null, engagement_type: "tax_audit", previous_auditor_name: "Rao & Associates", previous_auditor_frn: null, letter_sent_on: "2026-10-01", sent_via: "email", delivery_proof_document_id: null, delivery_proof_title: null, reply_received_on: null, objections: null, outcome: null, notes: null, updated_at: "x" };
    expect(systemFacts(detail({ communications: [letter] }), "2026-10-24", { isPartner: true }).previous_auditor).toMatchObject({ tone: "danger", action: { label: "Add the proof" } });
    expect(systemFacts(detail({ communications: [{ ...letter, delivery_proof_document_id: "d1" }] }), "2026-10-24", { isPartner: true }).previous_auditor?.tone).toBe("success");
    expect(systemFacts(detail({ communications: [{ ...letter, engagement_type: "gst_audit", delivery_proof_document_id: "d1" }] }), "2026-10-24", { isPartner: true }).previous_auditor?.tone).toBe("danger");
    expect(systemFacts(detail({ engagement: { had_previous_auditor: false } }), "2026-10-24", { isPartner: true }).previous_auditor?.tone).toBe("success");
    expect(systemFacts(detail({ engagement: { had_previous_auditor: null } }), "2026-10-24", { isPartner: true }).previous_auditor?.action?.kind).toBe("edit");
  });

  it("counts the UDIN's 60 days from the report date", () => {
    const signed = detail({ engagement: { report_date: "2026-08-01", report_type: "unmodified" } })
    expect(systemFacts(signed, "2026-09-01", { isPartner: true }).udin).toMatchObject({ tone: "warning", text: "No UDIN linked yet; generate it by 30 Sep 2026." });
    expect(systemFacts(signed, "2026-10-24", { isPartner: true }).udin?.tone).toBe("danger");
    expect(systemFacts(signed, "2026-10-24", { isPartner: true }).opinion?.tone).toBe("success");
  });
});

describe("the quality overview", () => {
  const o: QualityOverview = {
    framework: "sqc1",
    frameworkUpdatedAt: null,
    manual: { total: 12, reviewDue: 0 },
    peerReview: { state: "expiring", daysLeft: 45, validUntil: "2026-12-08", certificateNo: "PRB/1" },
    kyc: { missing: 0, incomplete: 1, review_due: 0, current: 9 },
    acceptancePending: 0,
    previousAuditor: { awaitingReply: 0, total: 3 },
    independence: { declared: 10, staff: 10, withExceptions: 0 },
    disposal: 0,
    restoreDrill: { lastOn: "2026-10-03", lastOutcome: "passed", thisQuarter: true },
    dataRequests: { open: 1, overdue: 1 },
    incidents: { open: 0, boardOverdue: 0 },
    notice: { version: "v2", publishedAt: "2026-04-01T04:30:00Z", draftPending: false },
  };
  it("names every area, with the KYC and overdue request as the dangers", () => {
    const areas = qualityAreas(o, "2026-27");
    expect(areas.map((a) => a.tab)).toEqual(["manual", "peer-reviews", "acceptance", "kyc", "previous-auditors", "independence", "retention", "restore-drills", "notices", "data-requests", "incidents"]);
    expect(areas.filter((a) => a.tone === "danger").map((a) => a.tab)).toEqual(["kyc", "data-requests"]);
    expect(areas.find((a) => a.tab === "peer-reviews")).toMatchObject({ tone: "warning", state: "The certificate expires on 08 Dec 2026, in 45 days." });
    expect(areas.find((a) => a.tab === "notices")?.state).toBe("v2 in force since 01 Apr 2026.");
  });
});
