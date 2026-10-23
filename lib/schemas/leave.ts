/**
 * Leave forms (§7.11.3): request, decide, cancel, and reassigning the tasks due during an approved
 * leave ("Reassign before 01 Jul?"). The rules themselves live in lib/domain/leave.ts
 * (validateLeaveRequest, canDecideLeaveFor, canCancelLeave…); these schemas apply them to the form.
 * Client-safe.
 */

import { z } from "zod";
import { LEAVE_TYPE_LABELS, LEAVE_TYPES } from "@/lib/domain/enums";
import { validateLeaveRequest } from "@/lib/domain/leave";
import { isDateString } from "@/lib/domain/fy";

export const LEAVE_TYPE_OPTIONS = LEAVE_TYPES.map((t) => ({ value: t, label: LEAVE_TYPE_LABELS[t] }));

const idField = z.uuid({ error: "Reload the page and try again." });
const tokenField = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });

/** §7.11.3 Request: Type* · From* · To* (inclusive; half-day option) · Reason. */
export const LeaveRequestSchema = z
  .object({
    /** Whose leave: yourself, or (Partners/Managers) someone you manage, recorded as a request. */
    employee_id: z.uuid().nullish(),
    type: z.enum(LEAVE_TYPES, { error: "Choose the type of leave." }),
    start_date: z.string({ error: "Enter the first day of leave." }).trim(),
    end_date: z.string({ error: "Enter the last day of leave." }).trim(),
    half_day: z.boolean().default(false),
    reason: z
      .string()
      .trim()
      .max(500, { error: "Keep the reason under 500 characters." })
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((d, ctx) => {
    const check = validateLeaveRequest({ type: d.type, startDate: d.start_date, endDate: d.end_date, halfDay: d.half_day, reason: d.reason });
    if (check.ok) return;
    for (const [field, messages] of Object.entries(check.fieldErrors)) {
      for (const message of messages) ctx.addIssue({ code: "custom", path: [field], message });
    }
  });
export type LeaveRequestInput = z.input<typeof LeaveRequestSchema>;
export type LeaveRequestValues = z.output<typeof LeaveRequestSchema>;

/** Editing a request that hasn't been decided yet. */
export const LeaveUpdateSchema = z
  .object({
    id: idField,
    updated_at: tokenField,
    type: z.enum(LEAVE_TYPES, { error: "Choose the type of leave." }),
    start_date: z.string().trim(),
    end_date: z.string().trim(),
    half_day: z.boolean().default(false),
    reason: z
      .string()
      .trim()
      .max(500, { error: "Keep the reason under 500 characters." })
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((d, ctx) => {
    const check = validateLeaveRequest({ type: d.type, startDate: d.start_date, endDate: d.end_date, halfDay: d.half_day, reason: d.reason });
    if (check.ok) return;
    for (const [field, messages] of Object.entries(check.fieldErrors)) {
      for (const message of messages) ctx.addIssue({ code: "custom", path: [field], message });
    }
  });
export type LeaveUpdateInput = z.input<typeof LeaveUpdateSchema>;

/** Approve or decline, with an optional note (§7.11.3 "Decision note optional"). */
export const LeaveDecisionSchema = z.object({
  id: idField,
  updated_at: tokenField,
  decision: z.enum(["approved", "declined"], { error: "Choose Approve or Decline." }),
  note: z
    .string()
    .trim()
    .max(1000, { error: "Keep the decision note under 1,000 characters." })
    .nullish()
    .transform((v) => (v ? v : null)),
});
export type LeaveDecisionInput = z.input<typeof LeaveDecisionSchema>;

export const LeaveCancelSchema = z.object({ id: idField, updated_at: tokenField });
export type LeaveCancelInput = z.input<typeof LeaveCancelSchema>;

/** The approver's "No cover needed" (§4.7, §7.11.3), recorded on the leave. */
export const NoCoverNeededSchema = z.object({ id: idField });
export type NoCoverNeededInput = z.input<typeof NoCoverNeededSchema>;

/** "Reassign before 01 Jul?": move chosen tasks due during the leave to someone else. */
export const ReassignLeaveTasksSchema = z.object({
  leave_id: idField,
  moves: z
    .array(z.object({ task_id: idField, to_employee_id: z.uuid({ error: "Choose who takes the task." }) }))
    .min(1, { error: "Choose at least one task to reassign." })
    .max(100, { error: "Reassign at most 100 tasks at a time." }),
});
export type ReassignLeaveTasksInput = z.input<typeof ReassignLeaveTasksSchema>;

/** A month for the attendance calendar and export: `YYYY-MM`. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH_PATTERN.test(v);
}

/** First and last date of a `YYYY-MM` month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/** The month before or after `YYYY-MM`. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `Oct 2026` from `2026-10`. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

/** The `YYYY-MM` of a date string. */
export function monthOf(date: string): string {
  return isDateString(date) ? date.slice(0, 7) : "";
}

/** §7.12 corrections: a status and a reason. */
export const AttendanceCorrectionSchema = z.object({
  employee_id: idField,
  date: z.string().refine((v) => isDateString(v), { error: "Choose the day." }),
  status: z.enum(["present", "absent", "late_login", "half_day", "on_leave"], { error: "Choose the corrected status." }),
  reason: z
    .string({ error: "Give a reason for the correction." })
    .trim()
    .min(3, { error: "Give a reason for the correction." })
    .max(500, { error: "Keep the reason under 500 characters." }),
  /** The record's updated_at when it was loaded, or null when the day has no record yet. */
  updated_at: z.string().nullish(),
});
export type AttendanceCorrectionInput = z.input<typeof AttendanceCorrectionSchema>;
