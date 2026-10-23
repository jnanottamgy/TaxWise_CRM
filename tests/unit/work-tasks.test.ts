import { describe, expect, it } from "vitest";
import {
  BUILT_IN_VIEWS,
  BulkTaskSchema,
  CreateTaskSchema,
  FileTaskSchema,
  RespondSchema,
  bulkChanges,
  checklistItemDue,
  checklistProgress,
  dueWindowRange,
  estimateMinutes,
  filingDefaults,
  guessFormCode,
  mentionQueryAt,
  mentionsInBody,
  monthGrid,
  monthParam,
  monthTitle,
  needsFilingCapture,
  periodOptionsForFy,
  readMonthParam,
  readWorkView,
  splitEstimate,
} from "@/lib/schemas/tasks";

const CLIENT = "6f1c2b4e-1d2a-4c3b-8a9e-0f1e2d3c4b5a";
const E1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const E2 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

describe("task form (§7.6.2)", () => {
  it("needs a client and a title; blanks become nulls; priority defaults to Medium", () => {
    const bad = CreateTaskSchema.safeParse({ client_id: "", title: " " });
    expect(bad.success).toBe(false);
    const ok = CreateTaskSchema.parse({ client_id: CLIENT, title: " GSTR-3B: Oct 2026 ", service_type: "", due_date: "", assigned_employee_id: "" });
    expect(ok).toMatchObject({ title: "GSTR-3B: Oct 2026", service_type: null, due_date: null, assigned_employee_id: null, priority: "medium", checklist: [], blocker_ids: [] });
  });

  it("refuses a reviewer who is the assignee, on the reviewer field", () => {
    const r = CreateTaskSchema.safeParse({ client_id: CLIENT, title: "x", assigned_employee_id: E1, reviewer_employee_id: E1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["reviewer_employee_id"]);
  });

  it("checks the financial year label", () => {
    expect(CreateTaskSchema.safeParse({ client_id: CLIENT, title: "x", financial_year: "2026-28" }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ client_id: CLIENT, title: "x", financial_year: "2026-27" }).success).toBe(true);
  });

  it("turns hours and minutes into an estimate and back", () => {
    expect(estimateMinutes("2", "30")).toBe(150);
    expect(estimateMinutes("1.5", "")).toBe(90);
    expect(estimateMinutes("", "")).toBeNull();
    expect(splitEstimate(150)).toEqual({ hours: "2", minutes: "30" });
    expect(splitEstimate(null)).toEqual({ hours: "", minutes: "" });
  });
});

describe("acceptance (§7.6.3)", () => {
  it("declining needs a reason code, and 'Something else' needs a note", () => {
    expect(RespondSchema.safeParse({ id: CLIENT, accept: true }).success).toBe(true);
    expect(RespondSchema.safeParse({ id: CLIENT, accept: false }).success).toBe(false);
    expect(RespondSchema.safeParse({ id: CLIENT, accept: false, reason: "no_capacity" }).success).toBe(true);
    const other = RespondSchema.safeParse({ id: CLIENT, accept: false, reason: "other", note: " " });
    expect(other.success).toBe(false);
    if (!other.success) expect(other.error.issues[0].path).toEqual(["note"]);
  });
});

describe("filing capture (§7.6.5)", () => {
  it("needs the return, period, FY and filed-on date, unless skipped with a reason or using a recorded filing", () => {
    const base = { id: CLIENT, mode: "record" as const };
    const missing = FileTaskSchema.safeParse(base);
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.issues.map((i) => i.path[0]).sort()).toEqual(["filed_on", "filing_type", "financial_year", "period"]);
    expect(FileTaskSchema.safeParse({ ...base, filing_type: "GSTR-3B", period: "Sep 2026", financial_year: "2026-27", filed_on: "2026-10-20" }).success).toBe(true);
    expect(FileTaskSchema.safeParse({ id: CLIENT, mode: "skip" }).success).toBe(false);
    expect(FileTaskSchema.safeParse({ id: CLIENT, mode: "skip", skip_reason: "Nothing to file" }).success).toBe(true);
    expect(FileTaskSchema.safeParse({ id: CLIENT, mode: "existing", filing_record_id: E1 }).success).toBe(true);
  });

  it("asks for filing details for filing services and for tasks linked to a deadline", () => {
    expect(needsFilingCapture({ service_type: "gst", compliance_event_id: null })).toBe(true);
    expect(needsFilingCapture({ service_type: "bookkeeping", compliance_event_id: null })).toBe(false);
    expect(needsFilingCapture({ service_type: null, compliance_event_id: E1 })).toBe(true);
    expect(needsFilingCapture({ service_type: null, compliance_event_id: null })).toBe(false);
  });

  it("prefills from the deadline, else from the task", () => {
    expect(
      filingDefaults(
        { title: "x", period_label: null, financial_year: null },
        { form_code: "GSTR-3B", filing_period: "Sep 2026", financial_year: "2026-27", title: "GSTR-3B Sep 2026" },
        "2026-10-20",
      ),
    ).toEqual({ filing_type: "GSTR-3B", period: "Sep 2026", financial_year: "2026-27", filed_on: "2026-10-20" });
    expect(filingDefaults({ title: "File ITR 4 for Sharma", period_label: "2025-26", financial_year: null }, null, "2026-07-20")).toEqual({
      filing_type: "ITR-4",
      period: "2025-26",
      financial_year: "2025-26",
      filed_on: "2026-07-20",
    });
  });

  it("reads form codes from titles", () => {
    expect(guessFormCode("GSTR3B: Sep 2026")).toBe("GSTR-3B");
    expect(guessFormCode("TDS 24Q Q2")).toBe("24Q");
    expect(guessFormCode("aoc 4 filing")).toBe("AOC-4");
    expect(guessFormCode("Bookkeeping for October")).toBeNull();
  });
});

describe("bulk changes (§7.6.7)", () => {
  it("a due-date change needs a reason; the change maps to bulk_update_tasks' object", () => {
    expect(BulkTaskSchema.safeParse({ ids: [E1], change: "due_date", due_date: "2026-11-10" }).success).toBe(false);
    const due = BulkTaskSchema.parse({ ids: [E1], change: "due_date", due_date: "2026-11-10", reason: "Client asked" });
    expect(bulkChanges(due)).toEqual({ due_date: "2026-11-10" });
    const assign = BulkTaskSchema.parse({ ids: [E1, E2], change: "assignee", assigned_employee_id: "" });
    expect(bulkChanges(assign)).toEqual({ assigned_employee_id: null });
    expect(BulkTaskSchema.safeParse({ ids: [], change: "priority", priority: "high" }).success).toBe(false);
  });
});

describe("mentions (§7.6.6)", () => {
  it("keeps only the mentions still written in the comment", () => {
    const picked = [
      { id: E1, name: "Ravi Kumar" },
      { id: E2, name: "Anita Rao" },
    ];
    expect(mentionsInBody("@Ravi Kumar please check", picked)).toEqual([E1]);
    expect(mentionsInBody("@Anita Rao and @Ravi Kumar", picked)).toEqual([E1, E2]);
    expect(mentionsInBody("no one", picked)).toEqual([]);
  });

  it("finds the @query at the caret", () => {
    expect(mentionQueryAt("Hi @rav", 7)).toEqual({ query: "rav", start: 3 });
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQueryAt("email@x", 7)).toBeNull();
    expect(mentionQueryAt("Hi @ravi done", 13)).toBeNull();
  });
});

describe("checklist", () => {
  it("dates a step from the task's due date and its offset", () => {
    expect(checklistItemDue("2026-11-11", 9)).toBe("2026-11-02");
    expect(checklistItemDue("2026-11-11", -9)).toBe("2026-11-20");
    expect(checklistItemDue(null, 9)).toBeNull();
    expect(checklistItemDue("2026-11-11", null)).toBeNull();
  });

  it("works out progress without dividing by zero", () => {
    expect(checklistProgress(3, 7)).toEqual({ done: 3, total: 7, percent: 42 });
    expect(checklistProgress(0, 0)).toEqual({ done: 0, total: 0, percent: 0 });
    expect(checklistProgress(9, 7).percent).toBe(100);
  });
});

describe("views and filters (§7.6.1)", () => {
  it("ships the six default views", () => {
    expect(BUILT_IN_VIEWS.map((v) => v.name)).toEqual(["My open tasks", "Due this week", "Data awaited", "Unassigned", "Waiting for acceptance", "Overdue"]);
  });

  it("works out due windows from today in IST, weeks Monday–Sunday", () => {
    // 22 Oct 2026 is a Thursday.
    expect(dueWindowRange("this_week", "2026-10-22")).toEqual({ kind: "range", from: "2026-10-19", to: "2026-10-25" });
    expect(dueWindowRange("next_7_days", "2026-10-22")).toEqual({ kind: "range", from: "2026-10-22", to: "2026-10-29" });
    expect(dueWindowRange("this_month", "2026-02-10")).toEqual({ kind: "range", from: "2026-02-01", to: "2026-02-28" });
    expect(dueWindowRange("today", "2026-10-22")).toEqual({ kind: "range", from: "2026-10-22", to: "2026-10-22" });
    expect(dueWindowRange("overdue", "2026-10-22")).toEqual({ kind: "overdue", before: "2026-10-22" });
    expect(dueWindowRange("no_date", "2026-10-22")).toEqual({ kind: "none" });
  });

  it("offers the FY's months, quarters and the year as periods", () => {
    const p = periodOptionsForFy("2026-27");
    expect(p.slice(0, 2)).toEqual(["Apr 2026", "May 2026"]);
    expect(p[11]).toBe("Mar 2027");
    expect(p.slice(12)).toEqual(["Q1 2026-27", "Q2 2026-27", "Q3 2026-27", "Q4 2026-27", "2026-27"]);
    expect(periodOptionsForFy("bad")).toEqual([]);
  });

  it("reads the view and the calendar month", () => {
    expect(readWorkView("board")).toBe("board");
    expect(readWorkView("nonsense")).toBe("table");
    expect(readMonthParam("2026-02", "2026-10-22")).toBe("2026-02-01");
    expect(readMonthParam("2026-13", "2026-10-22")).toBe("2026-10-01");
    expect(monthParam("2026-12-01", 1)).toBe("2027-01");
    expect(monthTitle("2026-10-01")).toBe("October 2026");
  });

  it("lays a month out in whole Monday–Sunday weeks", () => {
    const g = monthGrid("2026-10-01"); // 1 Oct 2026 is a Thursday
    expect(g[0][0]).toBe("2026-09-28");
    expect(g[g.length - 1][6]).toBe("2026-11-01");
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g).toHaveLength(5);
  });
});
