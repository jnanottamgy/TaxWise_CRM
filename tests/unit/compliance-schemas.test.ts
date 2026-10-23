import { describe, expect, it } from "vitest";
import {
  CancelEventSchema,
  EventFormSchema,
  FilingSchema,
  GRID_RETURN_TYPES,
  GenerateManySchema,
  ReportRangeSchema,
  WorkflowChangeSchema,
  matchesReturnType,
  returnTypeByKey,
} from "@/lib/schemas/compliance";

const CLIENT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const EVENT = "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d";

describe("EventFormSchema", () => {
  const base = { clientId: CLIENT, type: "gstr_3b", title: " GSTR-3B for Sep 2026 ", dueDate: "2026-10-20", reminderDays: "7", createTask: false };

  it("trims, coerces and blanks optional fields to null", () => {
    const r = EventFormSchema.parse({ ...base, formCode: "", financialYear: "2026-27", filingPeriod: " Sep 2026 ", agmDate: "" });
    expect(r).toMatchObject({ title: "GSTR-3B for Sep 2026", formCode: null, filingPeriod: "Sep 2026", reminderDays: 7, agmDate: null, id: null, expectedUpdatedAt: null });
  });

  it("asks for a title, a real due date and an FY in YYYY-YY", () => {
    const r = EventFormSchema.safeParse({ ...base, title: " ", dueDate: "2026-02-30", financialYear: "2026" });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["title", "dueDate", "financialYear"]));
  });

  it("a task needs a client", () => {
    const r = EventFormSchema.safeParse({ ...base, clientId: null, createTask: true });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0].path.join(".")).toBe("createTask");
    expect(EventFormSchema.safeParse({ ...base, clientId: null }).success).toBe(true);
  });
});

describe("FilingSchema", () => {
  const base = { eventId: EVENT, filingType: "GSTR-3B", period: "Sep 2026", financialYear: "2026-27", filedOn: "2026-10-18", acknowledgementNo: " aa29 1026 123 ", today: "2026-10-23" };

  it("normalises the acknowledgement number and defaults sharing on", () => {
    const r = FilingSchema.parse(base);
    expect(r).toMatchObject({ acknowledgementNo: "AA291026123", shareableWithClient: true, complete: false, documentId: null, udinRecordId: null });
  });

  it("needs the §7.6.5 details unless an existing record is linked", () => {
    const r = FilingSchema.safeParse({ eventId: EVENT });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path[0])).toEqual(["filingType", "period", "financialYear", "filedOn"]);
    expect(FilingSchema.safeParse({ eventId: EVENT, filingRecordId: CLIENT }).success).toBe(true);
  });

  it("refuses a filed-on date after today", () => {
    const r = FilingSchema.safeParse({ ...base, filedOn: "2026-10-24" });
    expect(r.success ? "" : r.error.issues[0].message).toBe("The filed-on date can't be in the future.");
  });
});

describe("other schemas", () => {
  it("workflow, cancel, generate and report range", () => {
    expect(WorkflowChangeSchema.safeParse({ eventId: EVENT, to: "filed" }).success).toBe(true);
    expect(WorkflowChangeSchema.safeParse({ eventId: EVENT, to: "done" }).success).toBe(false);
    expect(CancelEventSchema.safeParse({ eventId: EVENT }).success).toBe(false);
    expect(CancelEventSchema.safeParse({ eventId: EVENT, restore: true }).success).toBe(true);
    expect(GenerateManySchema.parse({ clientIds: [CLIENT, CLIENT] }).clientIds).toEqual([CLIENT]);
    expect(ReportRangeSchema.safeParse({ from: "2026-04-01", to: "2027-03-31" }).success).toBe(true);
    expect(ReportRangeSchema.safeParse({ from: "2026-04-01", to: "2026-03-31" }).success).toBe(false);
    expect(ReportRangeSchema.safeParse({ from: "2020-04-01", to: "2027-03-31" }).success).toBe(false);
  });
});

describe("grid return types", () => {
  it("each key is unique and falls back to GSTR-3B", () => {
    expect(new Set(GRID_RETURN_TYPES.map((t) => t.key)).size).toBe(GRID_RETURN_TYPES.length);
    expect(returnTypeByKey("nope").key).toBe("gstr_3b");
    expect(returnTypeByKey("roc").layout).toBe("form");
  });

  it("matches the seeded form codes (§6.7)", () => {
    const m = (key: string, type: string, form: string | null, rule: string | null = null) => matchesReturnType({ type, form_code: form, rule_code: rule }, returnTypeByKey(key));
    expect(m("gstr_3b", "gstr_3b", "GSTR-3B")).toBe(true);
    expect(m("gstr_3b", "gstr_3b", "PMT-06")).toBe(false);
    expect(m("gstr_3b", "gstr_3b", null)).toBe(false); // ops prep steps carry no form code
    expect(m("tds_return", "tds", "24Q/26Q/27Q")).toBe(true);
    expect(m("tds_return", "tds", "Form 138/140/144")).toBe(true);
    expect(m("tds_return", "tds", "24Q", "TDS_RETURN_Q1")).toBe(true);
    expect(m("tds_return", "tds", "TDS deposit")).toBe(false);
    expect(m("itr", "itr", "ITR (belated)")).toBe(true);
    expect(m("pt", "pt", "PT (Karnataka)")).toBe(true);
    expect(m("pt", "pt", "PT enrolment (Karnataka)")).toBe(false);
    expect(m("roc", "roc", "AOC-4")).toBe(true);
    expect(m("gst_annual", "custom", "GSTR-9C")).toBe(true);
  });
});
