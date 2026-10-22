import { describe, expect, it } from "vitest";
import { assignmentBlocked, checkAssignment, type AssignmentInput } from "@/lib/domain/assignment";
import { CAPACITY_DEFAULTS, workingDaysLeft } from "@/lib/domain/capacity";

function input(over: Partial<AssignmentInput> = {}): AssignmentInput {
  return {
    assigneeId: "emp-3",
    assignee: { name: "Ravi", isActive: true, leaves: [] },
    reviewerId: "mgr-1",
    dueDate: "2026-07-05",
    openTasksInWindow: 5,
    workingDaysLeft: 5,
    capacityBands: CAPACITY_DEFAULTS,
    today: "2026-06-29",
    ...over,
  };
}

describe("checkAssignment (§7.6.2)", () => {
  it("says nothing for a normal assignment", () => {
    expect(checkAssignment(input())).toEqual([]);
  });

  it("checks nothing when there is no assignee", () => {
    expect(checkAssignment(input({ assigneeId: null, assignee: null }))).toEqual([]);
  });

  it("blocks when the assignee's account is disabled (the work would be lost)", () => {
    const f = checkAssignment(input({ assignee: { name: "Ravi", isActive: false, leaves: [] } }));
    expect(f).toEqual([{ level: "block", code: "assignee_disabled", message: "Ravi's account is disabled, so the work would be lost. Choose someone active." }]);
    expect(assignmentBlocked(f)).toBe(true);
    expect(checkAssignment(input({ assignee: { isActive: false, leaves: [] } }))[0].message).toBe(
      "This person's account is disabled, so the work would be lost. Choose someone active.",
    );
  });

  it("blocks when the assignee is the named reviewer (nobody reviews their own work)", () => {
    const f = checkAssignment(input({ reviewerId: "emp-3" }));
    expect(f).toEqual([{ level: "block", code: "reviewer_is_assignee", message: "The reviewer can't also be the assignee: nobody reviews their own work." }]);
    expect(assignmentBlocked(f)).toBe(true);
  });

  it("warns (doesn't block) when they're on approved leave on the due date, with the dates", () => {
    const leaves = [{ start: "2026-07-01", end: "2026-07-10", status: "approved" as const }];
    const f = checkAssignment(input({ assignee: { name: "Ravi", isActive: true, leaves } }));
    expect(f).toEqual([{ level: "warn", code: "on_leave_on_due_date", message: "Ravi is on approved leave on the due date, from 01 Jul to 10 Jul." }]);
    expect(assignmentBlocked(f)).toBe(false);
    expect(f[0].message).toContain("from 01 Jul to 10 Jul");
  });

  it("counts the leave's first and last day, and ignores leave that isn't approved or doesn't cover the due date", () => {
    const at = (due: string, status: "approved" | "requested" | "declined" | "cancelled" = "approved") =>
      checkAssignment(input({ dueDate: due, assignee: { name: "Ravi", isActive: true, leaves: [{ start: "2026-07-01", end: "2026-07-10", status }] } })).map((x) => x.code);
    expect(at("2026-07-01")).toContain("on_leave_on_due_date");
    expect(at("2026-07-10")).toContain("on_leave_on_due_date");
    expect(at("2026-06-30")).not.toContain("on_leave_on_due_date");
    expect(at("2026-07-11")).not.toContain("on_leave_on_due_date");
    expect(at("2026-07-05", "requested")).not.toContain("on_leave_on_due_date");
    expect(at("2026-07-05", "declined")).not.toContain("on_leave_on_due_date");
    expect(at("2026-07-05", "cancelled")).not.toContain("on_leave_on_due_date");
  });

  it("words a one-day or half-day leave, and leave across a year end", () => {
    const one = checkAssignment(input({ dueDate: "2026-07-03", assignee: { isActive: true, leaves: [{ start: "2026-07-03", end: "2026-07-03", halfDay: true }] } }));
    expect(one[0].message).toBe("They are on approved leave on the due date, on 03 Jul (half day).");
    const span = checkAssignment(input({ dueDate: "2027-01-02", assignee: { name: "Ravi", isActive: true, leaves: [{ start: "2026-12-28", end: "2027-01-05" }] } }));
    expect(span[0].message).toBe("Ravi is on approved leave on the due date, from 28 Dec 2026 to 05 Jan 2027.");
  });

  it("warns when they'd be over capacity, showing the arithmetic", () => {
    const f = checkAssignment(input({ openTasksInWindow: 20, workingDaysLeft: 5 }));
    expect(f).toEqual([{ level: "warn", code: "over_capacity", message: "Ravi would be over capacity: 20 open tasks over 5 working days = 4.0 a day." }]);
    expect(f[0].message).toContain("20 open tasks over 5 working days = 4.0 a day");
  });

  it("doesn't warn below the OVER threshold, and follows edited thresholds", () => {
    expect(checkAssignment(input({ openTasksInWindow: 19, workingDaysLeft: 5 }))).toEqual([]);
    expect(checkAssignment(input({ openTasksInWindow: 15, workingDaysLeft: 5, capacityBands: { busy: 1, tight: 2, over: 3 } })).map((f) => f.code)).toEqual(["over_capacity"]);
  });

  it("calls out 'no working days left before the due date' instead of dividing by zero", () => {
    const f = checkAssignment(input({ openTasksInWindow: 3, workingDaysLeft: 0 }));
    expect(f).toEqual([{ level: "info", code: "no_working_days_left", message: "No working days left before the due date." }]);
    expect(assignmentBlocked(f)).toBe(false);
  });

  it("skips the leave and capacity checks when there is no due date", () => {
    const leaves = [{ start: "2026-07-01", end: "2026-07-10" }];
    expect(checkAssignment(input({ dueDate: null, workingDaysLeft: 0, openTasksInWindow: 99, assignee: { name: "Ravi", isActive: true, leaves } }))).toEqual([]);
  });

  it("warns when the assignee isn't on the client's team, but not for a cover person (§4.7)", () => {
    expect(checkAssignment(input({ onClientTeam: false }))).toEqual([
      { level: "warn", code: "not_on_client_team", message: "Ravi isn't on this client's team, so they won't see the client's other work." },
    ]);
    // A cover in force counts as being on the team, so the caller passes true.
    expect(checkAssignment(input({ onClientTeam: true }))).toEqual([]);
    expect(checkAssignment(input({ onClientTeam: null }))).toEqual([]);
  });

  it("lists blocks first, then warnings, then call-outs", () => {
    const f = checkAssignment(
      input({
        assignee: { name: "Ravi", isActive: false, leaves: [{ start: "2026-07-01", end: "2026-07-10" }] },
        reviewerId: "emp-3",
        workingDaysLeft: 0,
      }),
    );
    expect(f.map((x) => [x.level, x.code])).toEqual([
      ["block", "assignee_disabled"],
      ["block", "reviewer_is_assignee"],
      ["warn", "on_leave_on_due_date"],
      ["info", "no_working_days_left"],
    ]);
  });

  it("works end to end with workingDaysLeft from the calendar, leave included", () => {
    // Mon 29 Jun 2026 to Sat 04 Jul 2026, Mon–Sat working, approved leave Wed–Thu: 4 working days.
    const leaves = [{ start: "2026-07-01", end: "2026-07-02", status: "approved" as const }];
    const days = workingDaysLeft("2026-06-29", "2026-07-04", { weekdays: [1, 2, 3, 4, 5, 6], leaves });
    expect(days).toBe(4);
    const f = checkAssignment(input({ dueDate: "2026-07-04", openTasksInWindow: 16, workingDaysLeft: days, assignee: { name: "Ravi", isActive: true, leaves } }));
    expect(f.map((x) => x.message)).toEqual(["Ravi would be over capacity: 16 open tasks over 4 working days = 4.0 a day."]);
  });
});
