import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { assessCapacity, readCapacityThresholds, workingDaysLeft, type CapacityAssessment, type CapacityThresholds, type LeaveSpan } from "@/lib/domain/capacity";
import { ATTENDANCE_DEFAULTS, type AttendanceParams } from "@/lib/domain/attendance";
import type { DateString } from "@/lib/domain/fy";
import { capacityWindow } from "@/lib/schemas/people";

/**
 * The firm's working calendar and per-person capacity (§7.11.4), under the caller's RLS.
 * firm_settings and holidays are readable by every staff member; open tasks and leave by
 * Partners and Managers for everyone, by an Employee for themselves.
 */

export interface WorkingCalendarSettings {
  weekdays: number[];
  holidays: DateString[];
  thresholds: CapacityThresholds;
  attendance: AttendanceParams;
  weeklyHoursTarget: number;
}

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5, 6];

/** Working weekdays, holidays between `from` and `to`, capacity bands and the working day. */
export async function getWorkingCalendar(supabase: ServerSupabase, from: DateString, to: DateString): Promise<WorkingCalendarSettings> {
  const [settings, holidays] = await Promise.all([
    supabase
      .from("firm_settings")
      .select("working_weekdays, capacity_thresholds, work_day_start, late_grace_minutes, half_day_minutes, weekly_hours_target")
      .eq("id", 1)
      .maybeSingle(),
    supabase.from("holidays").select("date").gte("date", from).lte("date", to).order("date"),
  ]);
  if (settings.error) throw settings.error;
  if (holidays.error) throw holidays.error;
  const s = settings.data;
  return {
    weekdays: s?.working_weekdays?.length ? s.working_weekdays.map(Number) : DEFAULT_WEEKDAYS,
    holidays: (holidays.data ?? []).map((h) => h.date),
    thresholds: readCapacityThresholds(s?.capacity_thresholds),
    attendance: {
      workDayStart: s?.work_day_start ?? ATTENDANCE_DEFAULTS.workDayStart,
      lateGraceMinutes: s?.late_grace_minutes ?? ATTENDANCE_DEFAULTS.lateGraceMinutes,
      halfDayMinutes: s?.half_day_minutes ?? ATTENDANCE_DEFAULTS.halfDayMinutes,
    },
    weeklyHoursTarget: s?.weekly_hours_target ?? 48,
  };
}

/** Approved leave of these people overlapping [from, to], as capacity's LeaveSpan, per person. */
export async function getApprovedLeave(supabase: ServerSupabase, employeeIds: readonly string[], from: DateString, to: DateString): Promise<Map<string, LeaveSpan[]>> {
  const out = new Map<string, LeaveSpan[]>();
  if (employeeIds.length === 0) return out;
  const { data, error } = await supabase
    .from("employee_leave")
    .select("employee_id, start_date, end_date, half_day")
    .in("employee_id", employeeIds as string[])
    .eq("status", "approved")
    .lte("start_date", to)
    .gte("end_date", from);
  if (error) throw error;
  for (const l of data ?? []) {
    const list = out.get(l.employee_id) ?? [];
    list.push({ start: l.start_date, end: l.end_date, status: "approved", halfDay: l.half_day });
    out.set(l.employee_id, list);
  }
  return out;
}

/**
 * Capacity per person over the team window (today and the next 13 days): open tasks due in it
 * (overdue ones too: they still have to be done) over the working days left, excluding weekends,
 * holidays and approved leave, banded CLEAR / BUSY / TIGHT / OVER with the firm's thresholds.
 */
export async function getCapacityFor(
  supabase: ServerSupabase,
  employeeIds: readonly string[],
  today: DateString,
  calendar?: WorkingCalendarSettings,
): Promise<Map<string, CapacityAssessment>> {
  const out = new Map<string, CapacityAssessment>();
  if (employeeIds.length === 0) return out;
  const window = capacityWindow(today);
  const [cal, leave, tasks] = await Promise.all([
    calendar ? Promise.resolve(calendar) : getWorkingCalendar(supabase, window.from, window.to),
    getApprovedLeave(supabase, employeeIds, window.from, window.to),
    supabase
      .from("tasks")
      .select("assigned_employee_id")
      .in("assigned_employee_id", employeeIds as string[])
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .lte("due_date", window.to)
      .limit(20000),
  ]);
  if (tasks.error) throw tasks.error;
  const counts = new Map<string, number>();
  for (const t of tasks.data ?? []) {
    if (t.assigned_employee_id) counts.set(t.assigned_employee_id, (counts.get(t.assigned_employee_id) ?? 0) + 1);
  }
  for (const id of employeeIds) {
    const days = workingDaysLeft(window.from, window.to, { weekdays: cal.weekdays, holidays: cal.holidays, leaves: leave.get(id) ?? [] });
    out.set(id, assessCapacity(counts.get(id) ?? 0, days, cal.thresholds));
  }
  return out;
}
