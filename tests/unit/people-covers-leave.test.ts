import { describe, expect, it } from "vitest";
import {
  COVER_REASON_OPTIONS,
  EndCoverSchema,
  ExtendCoverSchema,
  GrantCoverSchema,
  ReturnNoteSchema,
  coverEndDayText,
  coverWindowText,
  istDateTimeParts,
  istInstant,
} from "@/lib/schemas/covers";
import {
  AttendanceCorrectionSchema,
  LEAVE_TYPE_OPTIONS,
  LeaveDecisionSchema,
  LeaveRequestSchema,
  ReassignLeaveTasksSchema,
  isMonth,
  monthBounds,
  monthLabel,
  monthOf,
  shiftMonth,
} from "@/lib/schemas/leave";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("cover dates in IST (§0.1 rule 13, §4.7)", () => {
  it("an IST date and time become the instant", () => {
    expect(istInstant("2026-10-25", "23:59")?.toISOString()).toBe("2026-10-25T18:29:00.000Z");
    expect(istInstant("2026-10-23", "00:00")?.toISOString()).toBe("2026-10-22T18:30:00.000Z");
    expect(istInstant("2026-02-30", "10:00")).toBeNull();
    expect(istInstant("2026-10-25", "25:00")).toBeNull();
    expect(istInstant("", "10:00")).toBeNull();
  });

  it("and back again", () => {
    expect(istDateTimeParts("2026-10-25T18:29:00.000Z")).toEqual({ date: "2026-10-25", time: "23:59" });
    expect(istDateTimeParts(new Date("2026-10-22T18:30:00.000Z"))).toEqual({ date: "2026-10-23", time: "00:00" });
  });

  it("windows read like '23–25 Oct'", () => {
    expect(coverWindowText("2026-10-23T03:30:00Z", "2026-10-25T18:29:00Z")).toBe("23–25 Oct");
    expect(coverWindowText("2026-10-23T03:30:00Z", "2026-10-23T12:00:00Z")).toBe("23 Oct");
    expect(coverWindowText("2026-10-30T03:30:00Z", "2026-11-02T18:29:00Z")).toBe("30 Oct – 2 Nov");
    // Ending exactly at midnight IST reaches the day before.
    expect(coverWindowText("2026-10-23T03:30:00Z", "2026-10-25T18:30:00Z")).toBe("23–25 Oct");
  });

  it("'until 25 Oct' is the last day the cover reaches", () => {
    expect(coverEndDayText("2026-10-25T18:29:00Z")).toBe("25 Oct");
    expect(coverEndDayText("2026-10-25T18:30:00Z")).toBe("25 Oct"); // 26 Oct 00:00 IST
    expect(coverEndDayText(new Date("2026-10-25T06:00:00Z"))).toBe("25 Oct");
  });

  it("reasons are the §4.7 list", () => {
    expect(COVER_REASON_OPTIONS.map((o) => o.label)).toEqual(["On leave", "Absent today", "Workload", "Other"]);
  });
});

describe("GrantCoverSchema (§4.7 Fields)", () => {
  const window = { starts_at: "2026-10-23T04:00:00.000Z", ends_at: "2026-10-25T18:29:00.000Z", reason: "leave" as const };

  it("a client cover needs the cover person and the client", () => {
    const r = GrantCoverSchema.safeParse({ mode: "client", ...window });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["cover_employee_id", "client_id"]));
    const ok = GrantCoverSchema.safeParse({ mode: "client", cover_employee_id: A, client_id: C, ...window });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.include_vault).toBe(false);
      expect(ok.data.note).toBeNull();
    }
  });

  it("a person cover needs who is away", () => {
    const r = GrantCoverSchema.safeParse({ mode: "person", cover_employee_id: A, ...window });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["absent_employee_id"]);
    expect(GrantCoverSchema.safeParse({ mode: "person", cover_employee_id: A, absent_employee_id: B, ...window }).success).toBe(true);
  });

  it("a split needs at least one cover person, and nobody covers themselves", () => {
    const none = GrantCoverSchema.safeParse({ mode: "split", absent_employee_id: B, splits: [{ client_id: C, cover_employee_id: null }], ...window });
    expect(none.success).toBe(false);
    if (!none.success) expect(none.error.issues[0].message).toBe("Choose who covers at least one client.");
    const self = GrantCoverSchema.safeParse({ mode: "split", absent_employee_id: B, splits: [{ client_id: C, cover_employee_id: B }], ...window });
    expect(self.success).toBe(false);
    if (!self.success) expect(self.error.issues[0].message).toBe("Nobody can cover for themselves.");
    expect(GrantCoverSchema.safeParse({ mode: "split", absent_employee_id: B, splits: [{ client_id: C, cover_employee_id: A }], ...window }).success).toBe(true);
  });

  it("needs a From and an Until that are instants, and a reason", () => {
    const r = GrantCoverSchema.safeParse({ mode: "client", cover_employee_id: A, client_id: C, starts_at: "soon", ends_at: "", reason: "holiday" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["starts_at", "ends_at", "reason"]));
  });

  it("extend, end and the note back", () => {
    expect(ExtendCoverSchema.safeParse({ id: A, updated_at: "x", ends_at: "2026-10-27T18:29:00Z" }).success).toBe(true);
    expect(ExtendCoverSchema.safeParse({ id: A, updated_at: "", ends_at: "2026-10-27T18:29:00Z" }).success).toBe(false);
    const end = EndCoverSchema.safeParse({ id: A, updated_at: "x", reason: "  " });
    expect(end.success && end.data.reason).toBeNull();
    expect(ReturnNoteSchema.safeParse({ id: A, return_note: "   " }).success).toBe(false);
    expect(ReturnNoteSchema.safeParse({ id: A, return_note: "Filed GSTR-1 for XYZ Traders; 3B waits for the purchase register." }).success).toBe(true);
  });
});

describe("LeaveRequestSchema (§7.11.3)", () => {
  it("lists the six leave types", () => {
    expect(LEAVE_TYPE_OPTIONS.map((o) => o.value)).toEqual(["annual", "sick", "casual", "unpaid", "sabbatical", "other"]);
  });

  it("accepts an inclusive range with an optional reason", () => {
    const r = LeaveRequestSchema.safeParse({ type: "annual", start_date: "2026-10-23", end_date: "2026-10-25", reason: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.half_day).toBe(false);
      expect(r.data.reason).toBeNull();
    }
  });

  it("puts the domain rule's errors on the fields", () => {
    const backwards = LeaveRequestSchema.safeParse({ type: "annual", start_date: "2026-10-25", end_date: "2026-10-23" });
    expect(backwards.success).toBe(false);
    if (!backwards.success) expect(backwards.error.issues.some((i) => i.path[0] === "end_date")).toBe(true);
    const halfDayRange = LeaveRequestSchema.safeParse({ type: "casual", start_date: "2026-10-23", end_date: "2026-10-24", half_day: true });
    expect(halfDayRange.success).toBe(false);
    const noType = LeaveRequestSchema.safeParse({ start_date: "2026-10-23", end_date: "2026-10-23" });
    expect(noType.success).toBe(false);
  });

  it("decisions, and the 'Reassign before…' moves", () => {
    expect(LeaveDecisionSchema.safeParse({ id: A, updated_at: "x", decision: "approved", note: "" }).success).toBe(true);
    expect(LeaveDecisionSchema.safeParse({ id: A, updated_at: "x", decision: "maybe" }).success).toBe(false);
    expect(ReassignLeaveTasksSchema.safeParse({ leave_id: A, moves: [] }).success).toBe(false);
    expect(ReassignLeaveTasksSchema.safeParse({ leave_id: A, moves: [{ task_id: B, to_employee_id: C }] }).success).toBe(true);
  });
});

describe("attendance months and corrections (§7.12)", () => {
  it("month helpers", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthBounds("2026-10")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-10")).toBe("Oct 2026");
    expect(monthOf("2026-10-23")).toBe("2026-10");
    expect(monthOf("not a date")).toBe("");
  });

  it("a correction needs a status and a reason", () => {
    expect(AttendanceCorrectionSchema.safeParse({ employee_id: A, date: "2026-10-22", status: "present", reason: "Worked from the client's office" }).success).toBe(true);
    const r = AttendanceCorrectionSchema.safeParse({ employee_id: A, date: "2026-10-22", status: "present", reason: " " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Give a reason for the correction.");
    expect(AttendanceCorrectionSchema.safeParse({ employee_id: A, date: "22 Oct", status: "present", reason: "ok ok" }).success).toBe(false);
    expect(AttendanceCorrectionSchema.safeParse({ employee_id: A, date: "2026-10-22", status: "holiday", reason: "ok ok" }).success).toBe(false);
  });
});
