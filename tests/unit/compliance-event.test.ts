import { describe, expect, it } from "vitest";
import {
  GSTR3B_CHECKLIST_ITEM,
  IMS_CHECKLIST_ITEM,
  checklistHints,
  circularUrl,
  displayChip,
  eventDisplayStatus,
  eventFamily,
  eventHints,
  reportOutcome,
  summariseStatuses,
  workflowMoves,
  type HintContext,
  type HintEvent,
} from "@/components/compliance/logic/event";

const TODAY = "2026-10-23";

const ctx: HintContext = {
  today: TODAY,
  filingBarRules: new Set(["GSTR3B_MONTHLY"]),
  filingBar: { years: 3, warnMonths: 6, fromPeriod: "2025-07-01" },
  lateFeeRules: new Set(["AOC4"]),
  lateFeePerDayPaise: 100_00,
};

function ev(over: Partial<HintEvent> = {}): HintEvent {
  return {
    status: "pending",
    workflow_status: "not_started",
    due_date: "2026-11-20",
    form_code: "GSTR-3B",
    rule_code: "GSTR3B_MONTHLY",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    ...over,
  };
}

describe("eventDisplayStatus", () => {
  it("shows the workflow, Overdue past the due date, and Filed/Completed once done", () => {
    expect(eventDisplayStatus(ev(), TODAY)).toBe("not_started");
    expect(eventDisplayStatus(ev({ workflow_status: "under_review" }), TODAY)).toBe("under_review");
    expect(eventDisplayStatus(ev({ due_date: "2026-10-20", workflow_status: "in_progress" }), TODAY)).toBe("overdue");
    expect(eventDisplayStatus(ev({ due_date: TODAY }), TODAY)).toBe("not_started");
    expect(eventDisplayStatus(ev({ due_date: "2026-10-20", workflow_status: "filed", status: "completed" }), TODAY)).toBe("filed");
    expect(eventDisplayStatus(ev({ workflow_status: "completed", status: "completed" }), TODAY)).toBe("completed");
    expect(eventDisplayStatus(ev({ status: "cancelled", due_date: "2026-01-01" }), TODAY)).toBe("cancelled");
  });

  it("maps to the §3.6 vocabularies", () => {
    expect(displayChip("overdue")).toEqual({ kind: "compliance_status", value: "overdue" });
    expect(displayChip("documents_awaited")).toEqual({ kind: "compliance_workflow", value: "documents_awaited" });
  });

  it("summarises several deadlines by the least done, ignoring cancelled ones", () => {
    const s = summariseStatuses(
      [ev({ workflow_status: "filed", status: "completed" }), ev({ workflow_status: "under_review" }), ev({ status: "cancelled" })],
      TODAY,
    );
    expect(s).toEqual({ display: "under_review", total: 2, done: 1 });
    expect(summariseStatuses([], TODAY)).toEqual({ display: "cancelled", total: 0, done: 0 });
  });
});

describe("eventFamily", () => {
  it("colours by type, never by status", () => {
    expect(eventFamily("gstr_3b", "GSTR-3B", true)).toBe("gst");
    expect(eventFamily("custom", "GSTR-9", true)).toBe("gst");
    expect(eventFamily("itr", "ITR", true)).toBe("income_tax");
    expect(eventFamily("audit", "Form 3CEB", true)).toBe("income_tax");
    expect(eventFamily("tds", "24Q/26Q/27Q", true)).toBe("tds");
    expect(eventFamily("roc", "AOC-4", true)).toBe("roc");
    expect(eventFamily("pt", "PT (Karnataka)", true)).toBe("payroll");
    expect(eventFamily("gstr_1", null, false)).toBe("firm");
  });
});

describe("workflowMoves", () => {
  const base = { workflow_status: "in_progress" as const, status: "pending", is_statutory: true, client_id: "c1", has_filing: false };

  it("an Employee moves among the open steps only (§7.6.4: they submit Under review)", () => {
    expect(workflowMoves(base, "employee").map((m) => m.to)).toEqual(["not_started", "documents_awaited", "under_review"]);
    expect(workflowMoves({ ...base, workflow_status: "filed", status: "completed" }, "employee")).toEqual([]);
  });

  it("a Manager files through the filing dialog when no filing record exists", () => {
    const moves = workflowMoves(base, "manager");
    expect(moves.find((m) => m.to === "filed")).toMatchObject({ needsFiling: true, needsReason: false });
    expect(workflowMoves({ ...base, has_filing: true }, "partner").find((m) => m.to === "filed")?.needsFiling).toBe(false);
    expect(workflowMoves({ ...base, is_statutory: false }, "partner").find((m) => m.to === "completed")?.needsFiling).toBe(false);
    expect(workflowMoves({ ...base, client_id: null }, "partner").find((m) => m.to === "filed")?.needsFiling).toBe(false);
  });

  it("reopening asks for a reason; a cancelled deadline has no moves", () => {
    const moves = workflowMoves({ ...base, workflow_status: "filed", status: "completed", has_filing: true }, "partner");
    expect(moves.find((m) => m.to === "in_progress")).toMatchObject({ reopen: true, needsReason: true });
    expect(moves.find((m) => m.to === "completed")).toMatchObject({ reopen: false, needsReason: false, needsFiling: false });
    expect(workflowMoves({ ...base, status: "cancelled" }, "partner")).toEqual([]);
  });
});

describe("eventHints", () => {
  it("adds the GSTR-1A and IMS lines to GSTR-3B from the July 2025 period (§6.7)", () => {
    expect(checklistHints({ form_code: "GSTR-3B", period_start: "2026-09-01" })).toEqual([GSTR3B_CHECKLIST_ITEM, IMS_CHECKLIST_ITEM]);
    expect(checklistHints({ form_code: "GSTR-3B", period_start: "2025-06-01" })).toEqual([IMS_CHECKLIST_ITEM]);
    expect(checklistHints({ form_code: "GSTR-1", period_start: "2026-09-01" })).toEqual([]);
    const kinds = eventHints(ev(), ctx).map((h) => h.kind);
    expect(kinds).toEqual(["gstr1a", "ims"]);
    expect(eventHints(ev({ workflow_status: "filed", status: "completed" }), ctx)).toEqual([]);
  });

  it("flags an unfiled GST return within six months of the three-year bar in red, and past it", () => {
    const july2025 = { due_date: "2025-08-20", period_start: "2025-07-01", period_end: "2025-07-31" };
    expect(eventHints(ev(july2025), ctx).some((h) => h.kind === "filing_bar" || h.kind === "barred")).toBe(false);
    const near = eventHints(ev(july2025), { ...ctx, today: "2028-05-01" }).find((h) => h.kind === "filing_bar");
    expect(near).toMatchObject({ tone: "danger" });
    expect(near?.text).toMatch(/Can't be filed after 20 Aug 2028/);
    const barred = eventHints(ev(july2025), { ...ctx, today: "2028-09-01" }).find((h) => h.kind === "barred");
    expect(barred?.text).toMatch(/limit passed on 20 Aug 2028/);
    // Periods before the bar's first period (July 2025) aren't flagged.
    expect(eventHints(ev({ due_date: "2023-06-20", period_start: "2023-05-01", period_end: "2023-05-31" }), ctx).some((h) => h.kind === "barred")).toBe(false);
    // Filed returns never are.
    expect(eventHints(ev({ ...july2025, workflow_status: "filed", status: "completed" }), { ...ctx, today: "2028-09-01" })).toEqual([]);
  });

  it("shows the ROC late fee accruing, the Sunday hint, the extension and a provisional date", () => {
    const late = eventHints(ev({ form_code: "AOC-4", rule_code: "AOC4", due_date: "2026-10-20" }), ctx).find((h) => h.kind === "late_fee");
    expect(late?.text).toBe("Late fee accruing: ₹100.00 a day per form, ₹300.00 so far (3 days).");
    expect(eventHints(ev({ form_code: "X", rule_code: null, due_date: "2026-11-22" }), ctx).map((h) => h.kind)).toEqual(["sunday"]);
    const ext = eventHints(ev({ form_code: "ITR", rule_code: "ITR_AUDIT", due_date: "2026-11-21", original_due_date: "2026-10-31", override_ref: "CBDT Circular 07/2026 dated 28 Sep 2026" }), ctx);
    expect(ext.find((h) => h.kind === "extended")?.text).toBe("Extended from 31 Oct 2026 by CBDT Circular 07/2026 dated 28 Sep 2026.");
    expect(eventHints(ev({ form_code: "ADT-1", rule_code: "ADT1", is_provisional: true }), ctx).map((h) => h.kind)).toContain("provisional");
  });

  it("finds a link in a circular reference", () => {
    expect(circularUrl("CBDT Circular 07/2026 (https://incometaxindia.gov.in/circular-7.pdf).")).toBe("https://incometaxindia.gov.in/circular-7.pdf");
    expect(circularUrl("CBDT Circular 07/2026 dated 28 Sep 2026")).toBeNull();
    expect(circularUrl(null)).toBeNull();
  });
});

describe("reportOutcome", () => {
  const filed = { status: "completed", workflow_status: "filed", due_date: "2026-10-20" };
  it("says whether each deadline was met (§7.7)", () => {
    expect(reportOutcome(filed, "2026-10-18", TODAY)).toEqual({ outcome: "on_time", days: 0, text: "On time" });
    expect(reportOutcome(filed, "2026-10-20", TODAY).outcome).toBe("on_time");
    expect(reportOutcome(filed, "2026-10-22", TODAY)).toEqual({ outcome: "late", days: 2, text: "Late by 2 days" });
    expect(reportOutcome(filed, null, TODAY).outcome).toBe("filed");
    expect(reportOutcome({ status: "pending", workflow_status: "in_progress", due_date: "2026-10-22" }, null, TODAY)).toEqual({ outcome: "overdue", days: 1, text: "Not filed, 1 day overdue" });
    expect(reportOutcome({ status: "pending", workflow_status: "not_started", due_date: TODAY }, null, TODAY).text).toBe("Due today");
    expect(reportOutcome({ status: "pending", workflow_status: "not_started", due_date: "2026-11-20" }, null, TODAY).outcome).toBe("due");
  });
});
