import { describe, expect, it } from "vitest";
import {
  approvedLeaveOn,
  canCancelLeave,
  canDecideLeaveFor,
  canDecideLeaveStatus,
  findOverlappingLeave,
  formatDayMonth,
  formatLeaveRange,
  isOnApprovedLeave,
  leaveCalendarDays,
  leavesOverlap,
  leaveWorkingDays,
  overlapMessage,
  reassignPrompt,
  tasksDueDuringLeave,
  validateLeaveRequest,
  type LeaveRecord,
} from "@/lib/domain/leave";

const MON_SAT = { weekdays: [1, 2, 3, 4, 5, 6] };

describe("validateLeaveRequest (§7.11.3)", () => {
  it("accepts a valid request, including a one-day and a half-day leave", () => {
    expect(validateLeaveRequest({ type: "annual", startDate: "2026-07-01", endDate: "2026-07-10" })).toEqual({ ok: true });
    expect(validateLeaveRequest({ type: "sick", startDate: "2026-07-01", endDate: "2026-07-01" })).toEqual({ ok: true });
    expect(validateLeaveRequest({ type: "casual", startDate: "2026-07-01", endDate: "2026-07-01", halfDay: true })).toEqual({ ok: true });
  });

  it("refuses an end before the start (inclusive dates: the same day is fine)", () => {
    const r = validateLeaveRequest({ type: "annual", startDate: "2026-07-10", endDate: "2026-07-01" });
    expect(r).toEqual({ ok: false, error: "The leave can't end before it starts.", fieldErrors: { end_date: ["The leave can't end before it starts."] } });
  });

  it("allows a half day only on a single date", () => {
    expect(validateLeaveRequest({ type: "annual", startDate: "2026-07-01", endDate: "2026-07-02", halfDay: true })).toMatchObject({
      ok: false,
      fieldErrors: { half_day: [expect.stringContaining("single date")] },
    });
  });

  it("needs a known type and real dates", () => {
    expect(validateLeaveRequest({ type: null, startDate: "2026-07-01", endDate: "2026-07-01" })).toMatchObject({ ok: false, fieldErrors: { type: ["Choose the type of leave."] } });
    expect(validateLeaveRequest({ type: "vacation", startDate: "2026-07-01", endDate: "2026-07-01" })).toMatchObject({ ok: false, fieldErrors: { type: [expect.any(String)] } });
    expect(validateLeaveRequest({ type: "annual", startDate: "2026-02-30", endDate: null })).toMatchObject({
      ok: false,
      fieldErrors: { start_date: [expect.any(String)], end_date: [expect.any(String)] },
    });
    for (const type of ["annual", "sick", "casual", "unpaid", "sabbatical", "other"]) {
      expect(validateLeaveRequest({ type, startDate: "2026-07-01", endDate: "2026-07-01" }).ok).toBe(true);
    }
  });
});

describe("day counts", () => {
  it("counts calendar days inclusively; a half day is 0.5", () => {
    expect(leaveCalendarDays("2026-07-01", "2026-07-10")).toBe(10);
    expect(leaveCalendarDays("2026-07-01", "2026-07-01")).toBe(1);
    expect(leaveCalendarDays("2026-07-01", "2026-07-01", true)).toBe(0.5);
    expect(leaveCalendarDays("2026-07-10", "2026-07-01")).toBe(0);
  });

  it("counts working days only: Sundays and holidays aren't leave", () => {
    // Wed 01 Jul to Fri 10 Jul 2026: one Sunday (05 Jul) → 9 working days on a Mon–Sat week.
    expect(leaveWorkingDays("2026-07-01", "2026-07-10", MON_SAT)).toBe(9);
    expect(leaveWorkingDays("2026-07-01", "2026-07-10", { ...MON_SAT, holidays: ["2026-07-03"] })).toBe(8);
    expect(leaveWorkingDays("2026-07-01", "2026-07-10", { weekdays: [1, 2, 3, 4, 5] })).toBe(8);
    expect(leaveWorkingDays("2026-07-01", "2026-07-01", MON_SAT, true)).toBe(0.5);
    expect(leaveWorkingDays("2026-07-05", "2026-07-05", MON_SAT, true)).toBe(0);
    expect(leaveWorkingDays("2026-07-10", "2026-07-01", MON_SAT)).toBe(0);
  });
});

describe("overlaps (§7.11.3)", () => {
  const existing: LeaveRecord[] = [
    { id: "l1", startDate: "2026-07-01", endDate: "2026-07-10", status: "approved" },
    { id: "l2", startDate: "2026-07-20", endDate: "2026-07-22", status: "requested" },
    { id: "l3", startDate: "2026-07-12", endDate: "2026-07-14", status: "declined" },
    { id: "l4", startDate: "2026-07-15", endDate: "2026-07-16", status: "cancelled" },
  ];

  it("treats both ends as inclusive", () => {
    expect(leavesOverlap({ startDate: "2026-07-10", endDate: "2026-07-11" }, existing[0])).toBe(true);
    expect(leavesOverlap({ startDate: "2026-06-25", endDate: "2026-07-01" }, existing[0])).toBe(true);
    expect(leavesOverlap({ startDate: "2026-07-11", endDate: "2026-07-11" }, existing[0])).toBe(false);
  });

  it("finds requested and approved leave, not declined or cancelled, nor the request itself", () => {
    expect(findOverlappingLeave({ startDate: "2026-07-05", endDate: "2026-07-21" }, existing)?.id).toBe("l1");
    expect(findOverlappingLeave({ startDate: "2026-07-21", endDate: "2026-07-25" }, existing)?.id).toBe("l2");
    expect(findOverlappingLeave({ startDate: "2026-07-12", endDate: "2026-07-16" }, existing)).toBeNull();
    expect(findOverlappingLeave({ id: "l1", startDate: "2026-07-02", endDate: "2026-07-09" }, existing)).toBeNull();
  });

  it("says what it overlaps", () => {
    expect(overlapMessage(existing[0])).toBe("This overlaps your approved leave from 01 Jul to 10 Jul.");
    expect(overlapMessage(existing[1])).toBe("This overlaps your leave request from 20 Jul to 22 Jul.");
    expect(overlapMessage({ startDate: "2026-07-03", endDate: "2026-07-03", status: "approved", halfDay: true })).toBe("This overlaps your approved leave on 03 Jul (half day).");
  });
});

describe("who approves whom (§7.11.3)", () => {
  const employee = { role: "employee" as const, employeeId: "e1" };
  const manager = { role: "manager" as const, employeeId: "m1" };
  const partner = { role: "partner" as const, employeeId: "p1" };

  it("Managers approve Employees", () => {
    expect(canDecideLeaveFor({ role: "manager", employeeId: "m2" }, employee)).toEqual({ ok: true });
  });

  it("Partners approve Managers and Partners (and Employees)", () => {
    expect(canDecideLeaveFor({ role: "partner", employeeId: "p2" }, manager)).toEqual({ ok: true });
    expect(canDecideLeaveFor({ role: "partner", employeeId: "p2" }, partner)).toEqual({ ok: true });
    expect(canDecideLeaveFor({ role: "partner", employeeId: "p2" }, employee)).toEqual({ ok: true });
  });

  it("Managers can't decide for Managers or Partners", () => {
    expect(canDecideLeaveFor({ role: "manager", employeeId: "m2" }, manager)).toEqual({ ok: false, error: "A Partner decides leave for Managers and Partners." });
    expect(canDecideLeaveFor({ role: "manager", employeeId: "m2" }, partner)).toMatchObject({ ok: false });
  });

  it("nobody decides their own leave; Employees and clients decide none", () => {
    expect(canDecideLeaveFor({ role: "partner", employeeId: "p1" }, partner)).toEqual({ ok: false, error: "You can't decide your own leave. Another approver decides it." });
    expect(canDecideLeaveFor({ role: "manager", employeeId: "m1" }, manager)).toMatchObject({ ok: false });
    expect(canDecideLeaveFor({ role: "employee", employeeId: "e2" }, employee)).toEqual({ ok: false, error: "Only Managers and Partners decide leave requests." });
    expect(canDecideLeaveFor({ role: "client", employeeId: null }, employee)).toMatchObject({ ok: false });
    expect(canDecideLeaveFor({ role: null, employeeId: null }, employee)).toMatchObject({ ok: false });
  });

  it("decides only requests still Requested", () => {
    expect(canDecideLeaveStatus("requested")).toEqual({ ok: true });
    for (const s of ["approved", "declined", "cancelled"] as const) expect(canDecideLeaveStatus(s)).toMatchObject({ ok: false });
  });

  it("lets the person cancel a request, or approved leave before it starts", () => {
    const leave = (status: LeaveRecord["status"]): LeaveRecord => ({ startDate: "2026-07-01", endDate: "2026-07-10", status });
    expect(canCancelLeave(leave("requested"), "2026-07-05")).toEqual({ ok: true });
    expect(canCancelLeave(leave("approved"), "2026-06-30")).toEqual({ ok: true });
    expect(canCancelLeave(leave("approved"), "2026-07-01")).toMatchObject({ ok: false });
    expect(canCancelLeave(leave("declined"), "2026-06-01")).toMatchObject({ ok: false });
  });
});

describe("effects of approved leave (§7.11.3)", () => {
  const leaves: LeaveRecord[] = [
    { id: "a", startDate: "2026-07-01", endDate: "2026-07-10", status: "approved" },
    { id: "r", startDate: "2026-07-20", endDate: "2026-07-22", status: "requested" },
  ];

  it("finds the approved leave on a date", () => {
    expect(approvedLeaveOn(leaves, "2026-07-01")?.id).toBe("a");
    expect(approvedLeaveOn(leaves, "2026-07-10")?.id).toBe("a");
    expect(approvedLeaveOn(leaves, "2026-07-11")).toBeNull();
    expect(isOnApprovedLeave(leaves, "2026-07-21")).toBe(false);
    expect(isOnApprovedLeave(leaves, "2026-07-05")).toBe(true);
  });

  it("surfaces open tasks due during the leave, earliest first: 'Reassign before 01 Jul?'", () => {
    const tasks = [
      { id: "t3", dueDate: "2026-07-10", status: "in_progress" as const },
      { id: "t1", dueDate: "2026-07-01", status: "not_started" as const },
      { id: "t2", dueDate: "2026-07-05", status: "filed_done" as const },
      { id: "t4", dueDate: "2026-07-11", status: "in_progress" as const },
      { id: "t5", dueDate: null, status: "in_progress" as const },
    ];
    expect(tasksDueDuringLeave(tasks, leaves[0]).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(reassignPrompt(leaves[0])).toBe("Reassign before 01 Jul?");
  });

  it("formats leave dates as the assignment check words them", () => {
    expect(formatDayMonth("2026-07-01")).toBe("01 Jul");
    expect(formatDayMonth("2026-07-01", true)).toBe("01 Jul 2026");
    expect(formatLeaveRange("2026-07-01", "2026-07-10")).toBe("from 01 Jul to 10 Jul");
    expect(formatLeaveRange("2026-07-01", "2026-07-01")).toBe("on 01 Jul");
    expect(formatLeaveRange("2026-12-28", "2027-01-05")).toBe("from 28 Dec 2026 to 05 Jan 2027");
  });
});
