/**
 * Attendance per working day (§7.12, §5.2 `attendance_records`).
 *
 * - First activity ≤ `work_day_start + late_grace` → **Present**; later → **Late login**.
 * - Total active minutes < `half_day_minutes` → **Half day** (computed at day end).
 * - No activity on a working day → **Absent** (the 11:30 IST job, for the previous day).
 * - Approved leave → **On leave**, which wins over everything.
 * - Non-working days and holidays create no record.
 * - Corrections: a Partner or Manager can correct a day's status, with a reason.
 *
 * `work_day_start`, `late_grace_minutes` and `half_day_minutes` are firm settings (§5.2), passed in;
 * `ATTENDANCE_DEFAULTS` holds the seeded values (09:30, 15, 240). Times are read in IST.
 *
 * Pure and client-safe.
 */

import type { AppRole, AttendanceStatus } from "@/lib/domain/enums";
import { ATTENDANCE_STATUSES } from "@/lib/domain/enums";
import { istDateOf, nowIST, type DateString } from "@/lib/domain/fy";
import { instantMs, type Instant } from "@/lib/domain/presence";

export type AttendanceParams = {
  /** `firm_settings.work_day_start`, `'HH:MM'` or `'HH:MM:SS'` as Postgres returns `time`. */
  workDayStart: string;
  lateGraceMinutes: number;
  halfDayMinutes: number;
};

/** The firm_settings defaults (§5.2): day starts 09:30, 15 minutes' grace, half day under 240 minutes. */
export const ATTENDANCE_DEFAULTS: AttendanceParams = { workDayStart: "09:30", lateGraceMinutes: 15, halfDayMinutes: 240 };

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  late_login: "Late login",
  half_day: "Half day",
  absent: "Absent",
  on_leave: "On leave",
};

/** Minutes since midnight for `'HH:MM'` / `'HH:MM:SS'`; throws a RangeError for anything else. */
export function parseTimeOfDay(value: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) throw new RangeError(`Not a time of day (HH:MM): ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The latest IST minute of the day that still counts as on time (`09:30 + 15 → 585`, i.e. 09:45). */
export function onTimeUntilMinute(params: AttendanceParams): number {
  return parseTimeOfDay(params.workDayStart) + params.lateGraceMinutes;
}

/** True when the first activity (read in IST) is on or before `work_day_start + late_grace`. */
export function isOnTime(firstActivity: Instant, params: AttendanceParams): boolean {
  return nowIST(new Date(instantMs(firstActivity))).minutesOfDay <= onTimeUntilMinute(params);
}

export type AttendanceInput = AttendanceParams & {
  /** The day's first activity (first session login), or null when there was none. */
  firstActivity: Instant | null;
  /** Active minutes accumulated across the day's sessions. */
  totalActiveMinutes: number;
  /** A working weekday that isn't a firm holiday. */
  isWorkingDay: boolean;
  onApprovedLeave: boolean;
  /**
   * False while the day is still running: Half day isn't decided yet and no activity is not yet
   * Absent (the record waits). Defaults to true (the end-of-day and 11:30 jobs).
   */
  dayComplete?: boolean;
};

/**
 * The day's attendance status (§7.12), or null when no record should exist (a non-working day or
 * holiday, or a running day with no activity yet). Precedence: On leave → Absent → Half day →
 * Late login → Present.
 */
export function deriveAttendance(input: AttendanceInput): AttendanceStatus | null {
  if (!input.isWorkingDay) return null;
  if (input.onApprovedLeave) return "on_leave";
  const dayComplete = input.dayComplete ?? true;
  if (input.firstActivity === null) return dayComplete ? "absent" : null;
  if (dayComplete && input.totalActiveMinutes < input.halfDayMinutes) return "half_day";
  return isOnTime(input.firstActivity, input) ? "present" : "late_login";
}

// -------------------------------------------------------------------------------------------------
// From sessions to a day
// -------------------------------------------------------------------------------------------------

export type DaySession = { loginAt: Instant; lastActiveAt: Instant; activeMinutes: number };

export type DaySummary = { firstActivity: Date | null; lastActivity: Date | null; totalActiveMinutes: number };

/**
 * The day's first activity, last activity and active minutes from the sessions that began on that
 * IST date (sessions close by 00:15 IST, so none runs into the next day for long).
 */
export function summariseDay(sessions: readonly DaySession[], date: DateString): DaySummary {
  let first: number | null = null;
  let last: number | null = null;
  let total = 0;
  for (const s of sessions) {
    const login = instantMs(s.loginAt);
    if (istDateOf(new Date(login)) !== date) continue;
    const lastActive = instantMs(s.lastActiveAt);
    first = first === null ? login : Math.min(first, login);
    last = last === null ? lastActive : Math.max(last, lastActive);
    total += s.activeMinutes;
  }
  return { firstActivity: first === null ? null : new Date(first), lastActivity: last === null ? null : new Date(last), totalActiveMinutes: total };
}

// -------------------------------------------------------------------------------------------------
// Corrections and the monthly summary
// -------------------------------------------------------------------------------------------------

export type AttendanceCorrection = { actorRole: AppRole | null; status: string | null | undefined; reason: string | null | undefined };

/**
 * Whether a correction may be saved (§7.12): Partners and Managers only, a real status, and a
 * reason (stored and shown in the audit log). Returns the refusal, or null.
 */
export function attendanceCorrectionError(c: AttendanceCorrection): string | null {
  if (c.actorRole !== "partner" && c.actorRole !== "manager") return "Only Partners and Managers can correct attendance.";
  if (!c.status || !(ATTENDANCE_STATUSES as readonly string[]).includes(c.status)) return "Choose the corrected status.";
  if (!(c.reason ?? "").trim()) return "Give a reason for the correction.";
  return null;
}

export type MonthlyAttendanceSummary = {
  present: number;
  lateLogin: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  /** Sum of `work_minutes` (shown as hours). */
  workMinutes: number;
};

/** The monthly summary row for the attendance export (§7.12): present, late, half days, absent, leave, hours. */
export function summariseMonth(records: readonly { status: AttendanceStatus; workMinutes?: number | null }[]): MonthlyAttendanceSummary {
  const out: MonthlyAttendanceSummary = { present: 0, lateLogin: 0, halfDay: 0, absent: 0, onLeave: 0, workMinutes: 0 };
  for (const r of records) {
    if (r.status === "present") out.present++;
    else if (r.status === "late_login") out.lateLogin++;
    else if (r.status === "half_day") out.halfDay++;
    else if (r.status === "absent") out.absent++;
    else if (r.status === "on_leave") out.onLeave++;
    out.workMinutes += r.workMinutes ?? 0;
  }
  return out;
}
