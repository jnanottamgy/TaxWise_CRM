/**
 * Leave: requests, who approves whom, overlaps and day counts (§7.11.3, §5.2, §4.1).
 *
 * - **Request:** Type (Annual · Sick · Casual · Unpaid · Sabbatical · Other) · From · To (inclusive;
 *   `end ≥ start`) · half-day option (a half day is a single date) · Reason.
 * - **Approval:** Managers approve Employees; Partners approve Managers and Partners (and, holding
 *   every Manager power, Employees too, §4.1). Nobody decides their own leave. Only a request that
 *   is still Requested can be approved or declined.
 * - **Effect of approved leave:** attendance On leave, assignment warnings and capacity (see
 *   `capacity.ts`), the out-of-office badge, and the Manager's "Reassign before 01 Jul?" prompt for
 *   tasks due during the leave. Days are counted on working days (weekdays and holidays from firm
 *   settings).
 *
 * Pure and client-safe. Dates are `'YYYY-MM-DD'` strings; "today" is passed in.
 */

import { LEAVE_TYPES, type AppRole, type LeaveStatus, type LeaveType, type TaskStatus } from "@/lib/domain/enums";
import { diffDays, isDateString, isWorkingDay, MONTH_ABBR, parseDateString, workingDaysBetween, type DateString, type WorkingDayOptions } from "@/lib/domain/fy";
import type { FieldErrors } from "@/lib/result";

// -------------------------------------------------------------------------------------------------
// Wording for dates ("from 01 Jul to 10 Jul", §7.6.2)
// -------------------------------------------------------------------------------------------------

/** `01 Jul` (two-digit day, §3.4). Add the year with `withYear`: `01 Jul 2026`. */
export function formatDayMonth(date: DateString, withYear = false): string {
  const { year, month, day } = parseDateString(date);
  const text = `${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]}`;
  return withYear ? `${text} ${year}` : text;
}

/**
 * A leave's dates as sentences use them: `"from 01 Jul to 10 Jul"`, `"on 01 Jul"` for one day,
 * `"on 01 Jul (half day)"`, and with years when the leave crosses a year: `"from 28 Dec 2026 to
 * 05 Jan 2027"`.
 */
export function formatLeaveRange(start: DateString, end: DateString, halfDay = false): string {
  if (start === end) return `on ${formatDayMonth(start)}${halfDay ? " (half day)" : ""}`;
  const crossesYear = start.slice(0, 4) !== end.slice(0, 4);
  return `from ${formatDayMonth(start, crossesYear)} to ${formatDayMonth(end, crossesYear)}`;
}

// -------------------------------------------------------------------------------------------------
// Request validation and day counts
// -------------------------------------------------------------------------------------------------

export type LeaveRequestInput = {
  type: LeaveType | string | null | undefined;
  startDate: DateString | null | undefined;
  endDate: DateString | null | undefined;
  halfDay?: boolean;
  reason?: string | null;
};

export type LeaveValidation = { ok: true } | { ok: false; error: string; fieldErrors: FieldErrors };

/**
 * Checks a leave request (§7.11.3, §5.2): a known type, real From and To dates, To on or after From
 * (inclusive), and a half day only on a single date.
 */
export function validateLeaveRequest(input: LeaveRequestInput): LeaveValidation {
  const fieldErrors: FieldErrors = {};
  const add = (field: string, message: string) => {
    (fieldErrors[field] ??= []).push(message);
  };
  if (!input.type || !(LEAVE_TYPES as readonly string[]).includes(input.type)) add("type", "Choose the type of leave.");
  const startOk = isDateString(input.startDate);
  const endOk = isDateString(input.endDate);
  if (!startOk) add("start_date", "Enter the first day of leave.");
  if (!endOk) add("end_date", "Enter the last day of leave.");
  if (startOk && endOk) {
    const start = input.startDate as DateString;
    const end = input.endDate as DateString;
    if (diffDays(end, start) < 0) add("end_date", "The leave can't end before it starts.");
    else if (input.halfDay && start !== end) add("half_day", "A half day is a single date: make From and To the same day.");
  }
  const fields = Object.keys(fieldErrors);
  if (fields.length === 0) return { ok: true };
  return { ok: false, error: fieldErrors[fields[0]][0], fieldErrors };
}

/** Calendar days of leave, both ends inclusive; a half day is 0.5. 0 when the dates are reversed. */
export function leaveCalendarDays(start: DateString, end: DateString, halfDay = false): number {
  const days = diffDays(end, start) + 1;
  if (days <= 0) return 0;
  return halfDay && days === 1 ? 0.5 : days;
}

/**
 * Days of leave counted on working days (§7.11.3: holidays and non-working weekdays are not leave):
 * inclusive, half a day for a half-day leave on a working day, 0 on a non-working day.
 */
export function leaveWorkingDays(start: DateString, end: DateString, opts: WorkingDayOptions, halfDay = false): number {
  if (diffDays(end, start) < 0) return 0;
  if (halfDay && start === end) return isWorkingDay(start, opts) ? 0.5 : 0;
  return workingDaysBetween(start, end, opts);
}

// -------------------------------------------------------------------------------------------------
// Overlaps
// -------------------------------------------------------------------------------------------------

export type LeaveRecord = {
  id?: string;
  startDate: DateString;
  endDate: DateString;
  status: LeaveStatus;
  halfDay?: boolean;
  type?: LeaveType;
};

/** True when two inclusive date ranges share at least one day. */
export function leavesOverlap(a: { startDate: DateString; endDate: DateString }, b: { startDate: DateString; endDate: DateString }): boolean {
  return diffDays(a.startDate, b.endDate) <= 0 && diffDays(b.startDate, a.endDate) <= 0;
}

/** Requested and approved leave block a new overlapping request; declined and cancelled don't. */
export function isLiveLeave(status: LeaveStatus): boolean {
  return status === "requested" || status === "approved";
}

/**
 * The person's existing requested or approved leave that overlaps the request (itself excluded by
 * id when editing), earliest first, or null.
 */
export function findOverlappingLeave<L extends LeaveRecord>(
  request: { id?: string; startDate: DateString; endDate: DateString },
  existing: readonly L[],
): L | null {
  const hits = existing
    .filter((l) => isLiveLeave(l.status) && (request.id === undefined || l.id !== request.id) && leavesOverlap(request, l))
    .sort((a, b) => diffDays(a.startDate, b.startDate));
  return hits[0] ?? null;
}

/** "This overlaps your approved leave from 01 Jul to 10 Jul." (or "your leave request …"). */
export function overlapMessage(leave: LeaveRecord): string {
  const what = leave.status === "approved" ? "your approved leave" : "your leave request";
  return `This overlaps ${what} ${formatLeaveRange(leave.startDate, leave.endDate, leave.halfDay)}.`;
}

// -------------------------------------------------------------------------------------------------
// Who approves whom (§7.11.3)
// -------------------------------------------------------------------------------------------------

export type LeaveDecider = { role: AppRole | null; employeeId: string | null };
export type LeaveRequester = { role: AppRole; employeeId: string };

export type LeaveCheck = { ok: true } | { ok: false; error: string };

/**
 * Who may approve or decline whose leave (§7.11.3): Managers approve Employees; Partners approve
 * Managers and Partners, and Employees too. Nobody decides their own leave, and clients never.
 */
export function canDecideLeaveFor(decider: LeaveDecider, requester: LeaveRequester): LeaveCheck {
  if (decider.employeeId !== null && decider.employeeId === requester.employeeId) {
    return { ok: false, error: "You can't decide your own leave. Another approver decides it." };
  }
  if (decider.role === "partner") return { ok: true };
  if (decider.role === "manager") {
    if (requester.role === "employee") return { ok: true };
    return { ok: false, error: "A Partner decides leave for Managers and Partners." };
  }
  return { ok: false, error: "Only Managers and Partners decide leave requests." };
}

/** Only a request still Requested can be approved or declined. */
export function canDecideLeaveStatus(status: LeaveStatus): LeaveCheck {
  if (status === "requested") return { ok: true };
  return { ok: false, error: `This leave is already ${status}, so it can't be decided again.` };
}

/**
 * Whether the person can cancel their own leave: a request any time before it is decided; approved
 * leave only before it starts (after that a Manager corrects attendance instead).
 */
export function canCancelLeave(leave: LeaveRecord, today: DateString): LeaveCheck {
  if (leave.status === "requested") return { ok: true };
  if (leave.status === "approved") {
    return diffDays(leave.startDate, today) > 0
      ? { ok: true }
      : { ok: false, error: "This leave has already started. Ask a Manager to correct it." };
  }
  return { ok: false, error: `This leave is already ${leave.status}.` };
}

// -------------------------------------------------------------------------------------------------
// Effects of approved leave (§7.11.3)
// -------------------------------------------------------------------------------------------------

/** The approved leave that covers `date`, or null (attendance On leave, the out-of-office badge). */
export function approvedLeaveOn<L extends LeaveRecord>(leaves: readonly L[], date: DateString): L | null {
  return leaves.find((l) => l.status === "approved" && diffDays(date, l.startDate) >= 0 && diffDays(l.endDate, date) >= 0) ?? null;
}

/** True when the person is on approved leave on `date`. */
export function isOnApprovedLeave(leaves: readonly LeaveRecord[], date: DateString): boolean {
  return approvedLeaveOn(leaves, date) !== null;
}

export type LeaveTask = { id: string; dueDate: DateString | null; status: TaskStatus };

/**
 * Open tasks due during the leave (inclusive), earliest first: surfaced to the Manager with
 * "Reassign before 01 Jul?" (§7.11.3).
 */
export function tasksDueDuringLeave<T extends LeaveTask>(tasks: readonly T[], leave: { startDate: DateString; endDate: DateString }): T[] {
  return tasks
    .filter((t) => t.status !== "filed_done" && t.dueDate !== null && diffDays(t.dueDate, leave.startDate) >= 0 && diffDays(leave.endDate, t.dueDate) >= 0)
    .sort((a, b) => diffDays(a.dueDate as DateString, b.dueDate as DateString));
}

/** The Manager's prompt for tasks due during an approved leave: `"Reassign before 01 Jul?"`. */
export function reassignPrompt(leave: { startDate: DateString }): string {
  return `Reassign before ${formatDayMonth(leave.startDate)}?`;
}
