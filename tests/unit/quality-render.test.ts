import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; scroll?: boolean }) => {
    const props: Record<string, unknown> = { ...rest };
    delete props.scroll;
    return React.createElement("a", { href, ...props }, children);
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/quality",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));
const { action } = vi.hoisted(() => ({ action: () => vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock("@/server/actions/audits", () => ({
  createAudit: action(), updateAudit: action(), deleteAudit: action(), saveMateriality: action(), saveCompanyFacts: action(), saveReport: action(), advanceStage: action(),
  signoffStep: action(), attachEvidence: action(), detachEvidence: action(), confirmLimitOverride: action(), searchAuditClients: action(), searchEvidenceDocs: action(),
}));
vi.mock("@/server/actions/previous-auditor", () => ({ savePreviousAuditorComm: action(), deletePreviousAuditorComm: action() }));
vi.mock("@/server/actions/quality", () => ({ saveQualityItem: action(), markItemReviewed: action(), deleteQualityItem: action(), setQualityFramework: action(), recordRestoreDrill: action() }));
vi.mock("@/server/actions/peer-reviews", () => ({ savePeerReview: action(), deletePeerReview: action() }));
vi.mock("@/server/actions/independence", () => ({ saveDeclaration: action(), remindIndependence: action() }));
vi.mock("@/server/actions/kyc-register", () => ({ reconfirmKyc: action(), exportKycRegister: action() }));
vi.mock("@/server/actions/privacy-notices", () => ({ saveNoticeDraft: action(), publishNotice: action(), deleteNoticeDraft: action(), withdrawConsent: action() }));
vi.mock("@/server/actions/data-requests", () => ({ saveDataRequest: action(), setDataRequestStatus: action() }));
vi.mock("@/server/actions/data-incidents", () => ({ saveIncident: action(), recordIncidentStep: action(), addIncidentAction: action(), closeIncident: action() }));
vi.mock("@/server/actions/documents", () => ({ confirmUpload: action(), discardUpload: action(), findDuplicates: action(), requestUploadSlots: action() }));

import { AUDIT_DEFAULTS, EMPTY_COMPANY_FACTS, stepsFor } from "@/lib/domain/audit-stages";
import { CEILING_DEFAULTS } from "@/lib/domain/ceiling";
import type { AuditDetail } from "@/lib/data/audits";
import { AuditWorkspace, type WorkspaceData } from "@/components/audits/audit-workspace";
import { GatePanel } from "@/components/audits/gate-panel";
import { StageChecklist } from "@/components/audits/stage-checklist";
import { StageTracker } from "@/components/audits/stage-tracker";
import { AssemblyCard, DetailsCard, LinkedCard, MaterialityCard, ReportCard, StageLogCard } from "@/components/audits/side-cards";
import { systemFacts } from "@/components/audits/facts";
import { QualityOverviewView } from "@/components/quality/overview";
import { QualityManual } from "@/components/quality/manual";
import { PeerReviews } from "@/components/quality/peer-reviews";
import { RestoreDrills } from "@/components/quality/restore-drills";
import { IndependenceRegister, OwnDeclaration } from "@/components/quality/independence";
import { AcceptanceSection } from "@/components/quality/acceptance";
import { QualityNav } from "@/components/quality/quality-nav";
import { RetentionSummary } from "@/components/quality/retention";
import { Incidents } from "@/components/dpdp/incidents";
import { NoticeEditor, NoticeVersions } from "@/components/dpdp/notices";
import { ClientPreviousAuditors } from "@/components/practice/previous-auditor-list";

/**
 * Server render of the quality, audit and data-protection screens' parts with believable records:
 * they render without throwing, show the controls each role may use, and say the right things.
 */

const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const ID = "5b1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f61";
const TODAY = "2026-10-24";

function detail(): AuditDetail {
  return {
    engagement: {
      id: ID, client_id: "c1", audit_type: "tax_audit", financial_year: "2025-26", stage: "planning", engagement_partner_id: "e1", review_manager_id: "e2", had_previous_auditor: false,
      requires_peer_reviewed_auditor: false, report_date: null, report_type: null, udin_record_id: null, caro_applicable: null, archived_at: null, archived_by: null, file_assembly_due: null,
      retain_until: null, accepted_on: "2026-10-10", notes: null, limit_override_at: null, limit_override_by: null, updated_at: "2026-10-20T05:00:00Z", materiality: null,
    } as unknown as AuditDetail["engagement"],
    stage: "planning",
    auditType: "tax_audit",
    client: { id: "c1", display_name: "Sharma Traders", legal_name: "Sharma Traders", client_code: "TW-C-0042", entity_type: "partnership", pan: "AAJFS1234K", address: null, city: "Bengaluru", state_code: "29", pincode: "560058" },
    partner: { id: "e1", name: "Vinay Karlagere", profileId: "p1" },
    reviewManager: { id: "e2", name: "Anita Rao" },
    checklist: {
      "plan.strategy": { preparedBy: "p2", preparedAt: "2026-10-12T05:00:00Z", reviewedBy: null, reviewedAt: null, notApplicable: false, naReason: null, note: null },
    },
    materiality: null,
    company: EMPTY_COMPANY_FACTS,
    evidence: [{ id: "l1", step_key: "plan.strategy", document_id: "d1", is_amendment: false, amendment_note: null, added_at: "2026-10-12T04:00:00Z", added_by_name: "Anita Rao", title: "Audit plan FY 2025-26", file_name: "audit-plan.pdf", category: "audit", deleted: false }],
    log: [{ id: "g1", from_stage: "acceptance", to_stage: "planning", note: null, at: "2026-10-10T06:00:00Z", approved_by_name: "Vinay Karlagere", warnings: [] }],
    gate: { ok: false, missing: [{ code: "materiality", message: "record materiality: the basis, overall, performance and clearly-trivial amounts (SA 320)" }], warnings: [], from: "planning", to: "risk_assessment", isEngagementPartner: false },
    limit: null,
    kyc: { missing: [], complete: true, review_due: false, current: true },
    acceptance: { id: "a1", outcome: "accepted", decided_at: "2026-09-30T05:00:00Z" },
    peerReview: null,
    communications: [],
    letters: [],
    udins: [],
    linkedUdin: null,
    tasks: [{ id: "t1", task_number: "TW-T-0310", title: "Tax audit FY 2025-26", status: "in_progress", due_date: "2026-10-31" }],
    names: { p2: "Anita Rao" },
    params: AUDIT_DEFAULTS,
    ceiling: CEILING_DEFAULTS,
    limitOverrideByName: null,
  };
}

const workspace = (d: AuditDetail): WorkspaceData => ({
  id: ID, updatedAt: "2026-10-20T05:00:00Z", stage: d.stage, auditType: d.auditType, financialYear: "2025-26", client: { id: "c1", label: "Sharma Traders (TW-C-0042)" }, archived: false, today: TODAY,
  team: { engagementPartnerId: "e1", reviewManagerId: "e2", partners: [{ value: "e1", label: "Vinay Karlagere" }], reviewers: [{ value: "e2", label: "Anita Rao" }], fyOptions: ["2026-27", "2025-26"], canChangePartner: false },
  answers: { hadPreviousAuditor: false, requiresPeerReviewedAuditor: false, notes: null }, materiality: null, company: EMPTY_COMPANY_FACTS, params: AUDIT_DEFAULTS, privateExclusionPaise: CEILING_DEFAULTS.privateCompanyPaidUpExclusionPaise,
  report: { reportType: null, reportDate: null, udinRecordId: null, caroApplicable: null, caroHint: null, udins: [] }, limitMessage: null, moveWarnings: [],
});

describe("the audit engagement page", () => {
  it("shows the gate, the checklist with sign-offs and working papers, and who approves", () => {
    const d = detail();
    const steps = stepsFor("tax_audit", "planning").map((s) => ({ key: s.key, title: s.title, sa: s.sa, guidance: s.guidance, evidenceRequired: s.evidenceRequired, allowNa: s.allowNa, system: s.system }));
    const out = html(
      h(AuditWorkspace, {
        data: workspace(d),
        children: h(React.Fragment, null,
        h(GatePanel, { stage: "planning", gate: d.gate, isEngagementPartner: false, partnerName: "Vinay Karlagere", canWork: true }),
        h(StageChecklist, { steps, signoffs: d.checklist, evidence: d.evidence, names: d.names, facts: systemFacts(d, TODAY, { isPartner: false }), actorId: "p2", signable: true, archived: false, emptyText: "None" }),
        h(MaterialityCard, { d, canEdit: true }), h(ReportCard, { d, canEdit: true }), h(AssemblyCard, { d, today: TODAY, params: AUDIT_DEFAULTS }), h(DetailsCard, { d, canEdit: true, isPartner: false }), h(LinkedCard, { d }), h(StageLogCard, { d }),
        ),
      }),
    );
    expect(out).toContain("Before Risk assessment");
    expect(out).toContain("Record materiality: the basis, overall, performance and clearly-trivial amounts (SA 320).");
    expect(out).toContain("Vinay Karlagere is the engagement partner and approves each move.");
    expect(out).toContain("Overall audit strategy and audit plan");
    expect(out).toContain("Prepared by Anita Rao");
    expect(out).toContain("You prepared this step, so someone else reviews it.");
    expect(out).toContain("Audit plan FY 2025-26");
    expect(out).toContain("Materiality isn&#x27;t recorded yet.");
    expect(out).toContain("/api/pdf/management-representation/" + ID);
    expect(out).toContain("/api/exports/audit-checklist/" + ID);
    expect(out).toContain("TW-T-0310");
    expect(out).not.toContain("Delete engagement");
  });

  it("tracks all seven stages with their Standards", () => {
    const out = html(h(StageTracker, { current: "planning", viewing: "planning", progress: { planning: { done: 0, total: 3 } }, hrefFor: (s: string) => `/audits/${ID}?stage=${s}` }));
    for (const label of ["1. Acceptance", "2. Planning", "3. Risk assessment", "4. Execution", "5. Completion", "6. Reporting", "7. Archive"]) expect(out).toContain(label);
    expect(out).toContain("SA 300 · SA 320");
    expect(out).toContain('aria-current="step"');
  });
});

describe("the quality module", () => {
  it("lists every area with what needs attention first", () => {
    const out = html(
      h(QualityOverviewView, {
        fy: "2026-27",
        o: {
          framework: "sqc1", frameworkUpdatedAt: null, manual: { total: 0, reviewDue: 0 }, peerReview: { state: "missing", daysLeft: null, validUntil: null, certificateNo: null }, kyc: { missing: 0, incomplete: 0, review_due: 0, current: 0 },
          acceptancePending: 0, previousAuditor: { awaitingReply: 0, total: 0 }, independence: { declared: 0, staff: 4, withExceptions: 0 }, disposal: 0, restoreDrill: { lastOn: null, lastOutcome: null, thisQuarter: false },
          dataRequests: { open: 0, overdue: 0 }, incidents: { open: 0, boardOverdue: 0 }, notice: { version: null, publishedAt: null, draftPending: false },
        },
      }),
    );
    expect(out).toContain("areas need attention");
    expect(out.indexOf("No peer review certificate is recorded.")).toBeLessThan(out.indexOf("No open personal data breach."));
    expect(out).toContain("SQC 1 (in force)");
  });

  it("shows the manual to a Manager without the Partner's controls", () => {
    const items = [{ id: "q1", element: "ethics_independence", title: "Every engagement partner confirms independence before accepting an audit.", owner_employee_id: "e1", owner_name: "Vinay Karlagere", last_reviewed_on: "2025-06-01", last_reviewed_by_name: null, review_every_months: 12, notes: null, sort_order: 10, sqm1_component: null, quality_objective: null, quality_risk: null, risk_response: null, created_at: "", updated_at: "x", last_reviewed_by: null }];
    const out = html(h(QualityManual, { items: items as never, framework: "sqc1", settingsUpdatedAt: "x", staff: [], canEdit: false, today: TODAY }));
    expect(out).toContain("Ethical requirements and independence");
    expect(out).toContain("Review due");
    expect(out).not.toContain("Add item");
    const partner = html(h(QualityManual, { items: [], framework: "sqm1", settingsUpdatedAt: "x", staff: [], canEdit: true, today: TODAY }));
    expect(partner).toContain("SQM 1 component");
  });

  it("warns about the peer review certificate and the quarter's restore drill", () => {
    const pr = html(h(PeerReviews, { rows: [{ id: "r1", period_from: "2023-04-01", period_to: "2026-03-31", reviewer_name: "CA Meera Iyer", reviewer_frn: null, status: "completed", reviewed_on: "2023-12-10", certificate_no: "PRB/2023/77", valid_until: "2026-12-08", observations: null, notes: null, created_by: null, created_at: "", updated_at: "x" }] as never, today: TODAY, ceiling: CEILING_DEFAULTS, canEdit: true }));
    expect(pr).toContain("The certificate expires on 08 Dec 2026, in 45 days");
    const rd = html(h(RestoreDrills, { rows: [], today: TODAY, canEdit: true }));
    expect(rd).toContain("No restore drill recorded for 2026 Q4");
  });

  it("asks each person for their own declaration and lists who hasn't made it", () => {
    const own = html(h(OwnDeclaration, { fy: "2026-27", existing: null }));
    expect(own).toContain("Your declaration for FY 2026-27");
    expect(own).toContain("Not declared yet");
    const reg = html(h(IndependenceRegister, { fy: "2026-27", years: ["2026-27", "2025-26"], canRemind: true, rows: [{ employee_id: "e3", full_name: "Ravi Kumar", designation: "Article assistant", role: "employee", declaration_id: null, declared_at: null, answers: null, details: null, has_exceptions: false, updated_at: null }] }));
    expect(reg).toContain("0 of 1 declared; 1 to go");
    expect(reg).toContain("Remind 1 to declare");
  });

  it("renders the section list, the acceptance summary and the retention years", () => {
    expect(html(h(QualityNav, { active: "kyc", counts: { kyc: 3 } }))).toContain("3 waiting");
    expect(html(h(AcceptanceSection, { s: { counts: { pending: 1, accepted: 4, declined: 0 }, recent: [] } }))).toContain("Waiting for a decision");
    expect(html(h(RetentionSummary, { years: [{ year: 2025, documents: 12, past_retention: 12 }, { year: 2031, documents: 40, past_retention: 0 }], thisYear: 2026 }))).toContain("2031");
  });
});

describe("data protection", () => {
  it("shows an open breach with its checklist and the Board's deadline", () => {
    const row = { id: "i1", title: "Laptop stolen", detected_at: "2026-10-22T05:00:00Z", description: "A laptop with client files was stolen from a car.", data_categories: ["documents"], people_affected_estimate: 40, severity: "high", contained_at: "2026-10-22T07:00:00Z", assessed_at: null, assessment: null, board_notified_at: null, board_reference: null, principals_notified_at: null, root_cause: null, actions: [{ at: "2026-10-22T05:10:00Z", by: "p1", by_name: "Vinay Karlagere", text: "Incident recorded" }], closed_at: null, board_report_due_at: "2026-10-25T05:00:00Z", board_overdue: false, steps_done: 1, is_open: true, updated_at: "x" };
    const out = html(h(Incidents, { rows: [row] as never, canEdit: true, focusId: null }));
    expect(out).toContain("Laptop stolen");
    expect(out).toContain("Board report due 25 Oct 2026");
    expect(out).toContain("4 of 5 steps left before it can close.");
    expect(out).toContain("Incident recorded");
  });

  it("edits the draft notice and lists the versions", () => {
    const notices = [
      { id: "n2", version: "v2", body: "# Privacy notice\n\n## What personal data we collect ...", published_at: null, is_current: false, change_summary: null, created_at: "", updated_at: "2026-10-23T06:00:00Z", created_by: null, published_by: null, created_by_name: "Vinay Karlagere", published_by_name: null, acknowledgements: 0 },
      { id: "n1", version: "v1", body: "# Privacy notice v1", published_at: "2026-04-01T04:30:00Z", is_current: true, change_summary: "First version", created_at: "", updated_at: "y", created_by: null, published_by: null, created_by_name: null, published_by_name: "Vinay Karlagere", acknowledgements: 31 },
    ];
    const ed = html(h(NoticeEditor, { notices: notices as never, starter: "x" }));
    expect(ed).toContain("Notice text (v2)");
    expect(ed).toContain("Publish v2");
    const v = html(h(NoticeVersions, { notices: notices as never }));
    expect(v).toContain("31 acknowledgements");
    expect(v).toContain(">Current<");
    expect(v).toContain(">Draft<");
    expect(v).toContain("Drafted by Vinay Karlagere");
  });
});

describe("Client 360 → Engagement", () => {
  it("lists the previous auditor letters with the proof and reply", () => {
    const out = html(
      h(ClientPreviousAuditors, {
        client: { id: "c1", label: "Sharma Traders (TW-C-0042)" },
        today: TODAY,
        rows: [{ id: "l1", client_id: "c1", audit_engagement_id: null, engagement_type: "tax_audit", previous_auditor_name: "Rao & Associates", previous_auditor_frn: "004321S", letter_sent_on: "2026-09-20", sent_via: "registered_post", delivery_proof_document_id: null, delivery_proof_title: null, reply_received_on: null, objections: null, outcome: null, notes: null, updated_at: "x" }],
      }),
    );
    expect(out).toContain("Rao &amp; Associates");
    expect(out).toContain("No proof yet");
    expect(out).toContain("Awaiting reply");
    expect(out).toContain("Registered post (AD)");
  });
});
