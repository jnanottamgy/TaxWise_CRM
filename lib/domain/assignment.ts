/**
 * The assignment check run when a task is created or edited (`checkAssignment`, §7.6.2), shown
 * inline before saving:
 *
 * - **Blocks** when the assignee's account is disabled ("the work would be lost").
 * - **Blocks** when the assignee is the named reviewer ("nobody reviews their own work").
 * - **Warns** when they're on approved leave on the due date ("from 01 Jul to 10 Jul"), since
 *   assigning ahead to cover leave is normal.
 * - **Warns** when they'd be over capacity, showing the arithmetic ("20 open tasks over 5 working
 *   days = 4.0 a day"); the band thresholds are passed in (§7.11.4).
 * - **Calls out** "no working days left before the due date" rather than dividing by zero.
 * - **Warns** when the assignee is not on the client's team — unless they hold a cover in force for
 *   it (§4.7: the cover person is assigned "without the 'not on this client's team' warning").
 *
 * Pure and client-safe. The caller counts the open tasks and working days (see `capacity.ts`).
 */

import { capacityArithmetic, capacityBand, isApprovedLeave, type CapacityThresholds, type LeaveSpan } from "@/lib/domain/capacity";
import { diffDays, type DateString } from "@/lib/domain/fy";
import { formatLeaveRange } from "@/lib/domain/leave";

export type AssignmentLevel = "block" | "warn" | "info";

export type AssignmentFindingCode = "assignee_disabled" | "reviewer_is_assignee" | "on_leave_on_due_date" | "over_capacity" | "no_working_days_left" | "not_on_client_team";

export type AssignmentFinding = { level: AssignmentLevel; code: AssignmentFindingCode; message: string };

export type AssigneeFacts = {
  /** Shown in the messages ("Ravi is on approved leave …"); optional. */
  name?: string | null;
  isActive: boolean;
  /** The assignee's leave; only approved leave counts. */
  leaves: readonly LeaveSpan[];
};

export type AssignmentInput = {
  assigneeId: string | null;
  /** Facts about the assignee; null when there is no assignee. */
  assignee: AssigneeFacts | null;
  reviewerId: string | null;
  dueDate: DateString | null;
  /** Open tasks due between today and the due date, **including this one**. */
  openTasksInWindow: number;
  /** Working days from today to the due date, inclusive (`workingDaysLeft`). */
  workingDaysLeft: number;
  capacityBands: CapacityThresholds;
  today: DateString;
  /**
   * Whether the assignee owns the client, is on its team, or holds a cover in force for it (§4.7).
   * False adds the "not on this client's team" warning; leave it out to skip that check.
   */
  onClientTeam?: boolean | null;
};

const LEVEL_ORDER: Record<AssignmentLevel, number> = { block: 0, warn: 1, info: 2 };

/** The approved leave covering `date`, if any. */
function leaveOn(leaves: readonly LeaveSpan[], date: DateString): LeaveSpan | null {
  return leaves.find((l) => isApprovedLeave(l) && diffDays(date, l.start) >= 0 && diffDays(l.end, date) >= 0) ?? null;
}

/**
 * The assignment check (§7.6.2): blocks first, then warnings, then call-outs. An empty list means
 * nothing to say. No assignee means nothing to check.
 */
export function checkAssignment(input: AssignmentInput): AssignmentFinding[] {
  const out: AssignmentFinding[] = [];
  if (input.assigneeId === null || input.assignee === null) return out;
  const name = input.assignee.name?.trim() || null;

  if (!input.assignee.isActive) {
    out.push({
      level: "block",
      code: "assignee_disabled",
      message: `${name ? `${name}'s` : "This person's"} account is disabled, so the work would be lost. Choose someone active.`,
    });
  }
  if (input.reviewerId !== null && input.reviewerId === input.assigneeId) {
    out.push({
      level: "block",
      code: "reviewer_is_assignee",
      message: "The reviewer can't also be the assignee: nobody reviews their own work.",
    });
  }
  if (input.onClientTeam === false) {
    out.push({
      level: "warn",
      code: "not_on_client_team",
      message: `${name ? `${name} isn't` : "They aren't"} on this client's team, so they won't see the client's other work.`,
    });
  }

  if (input.dueDate !== null) {
    const leave = leaveOn(input.assignee.leaves, input.dueDate);
    if (leave) {
      out.push({
        level: "warn",
        code: "on_leave_on_due_date",
        message: `${name ? `${name} is` : "They are"} on approved leave on the due date, ${formatLeaveRange(leave.start, leave.end, leave.halfDay)}.`,
      });
    }

    if (input.workingDaysLeft <= 0) {
      out.push({ level: "info", code: "no_working_days_left", message: "No working days left before the due date." });
    } else if (capacityBand(input.openTasksInWindow, input.workingDaysLeft, input.capacityBands) === "over") {
      out.push({
        level: "warn",
        code: "over_capacity",
        message: `${name ?? "They"} would be over capacity: ${capacityArithmetic(input.openTasksInWindow, input.workingDaysLeft)}.`,
      });
    }
  }

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** True when any finding blocks the save. */
export function assignmentBlocked(findings: readonly AssignmentFinding[]): boolean {
  return findings.some((f) => f.level === "block");
}
