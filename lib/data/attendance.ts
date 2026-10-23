import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { AttendanceStatus } from "@/lib/domain/enums";
import { summariseMonth, type MonthlyAttendanceSummary } from "@/lib/domain/attendance";
import { addDays, isWorkingDay, type DateString } from "@/lib/domain/fy";
import { getWorkingCalendar, type WorkingCalendarSettings } from "@/lib/data/capacity";
import { getNamesByProfile } from "@/lib/data/people";
import { monthBounds } from "@/lib/schemas/leave";
import type { StaffRole } from "@/lib/schemas/people";

/**
 * Reads for attendance and presence (§7.12) under the caller's RLS: Partners and Managers see
 * everyone's records and sessions, an Employee their own (0032).
 */

export interface AttendanceDay {
  date: DateString;
  /** null: no record (a non-working day, a holiday, today still running, or a day ahead). */
  status: AttendanceStatus | null;
  working: boolean;
  holiday: string | null;
  first_login_at: string | null;
  last_activity_at: string | null;
  work_minutes: number | null;
  notes: string | null;
  corrected: boolean;
  corrected_by_name: string | null;
  correction_reason: string | null;
  record_updated_at: string | null;
}

export interface AttendanceMonth {
  month: string;
  days: AttendanceDay[];
  summary: MonthlyAttendanceSummary;
  calendar: WorkingCalendarSettings;
}

/** One person's month (§7.11.2 Attendance "calendar with statuses"). */
export async function getAttendanceMonth(supabase: ServerSupabase, employeeId: string, month: string): Promise<AttendanceMonth> {
  const { start, end } = monthBounds(month);
  const [calendar, records, holidays] = await Promise.all([
    getWorkingCalendar(supabase, start, end),
    supabase
      .from("attendance_records")
      .select("date, status, first_login_at, last_activity_at, work_minutes, notes, corrected_by, correction_reason, updated_at")
      .eq("employee_id", employeeId)
      .gte("date", start)
      .lte("date", end),
    supabase.from("holidays").select("date, name").gte("date", start).lte("date", end),
  ]);
  if (records.error) throw records.error;
  if (holidays.error) throw holidays.error;
  const byDate = new Map((records.data ?? []).map((r) => [r.date, r]));
  const holidayName = new Map((holidays.data ?? []).map((h) => [h.date, h.name]));
  const correctors = await getNamesByProfile(supabase, (records.data ?? []).map((r) => r.corrected_by));
  const days: AttendanceDay[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const r = byDate.get(d);
    days.push({
      date: d,
      status: (r?.status as AttendanceStatus | undefined) ?? null,
      working: isWorkingDay(d, { weekdays: calendar.weekdays, holidays: calendar.holidays }),
      holiday: holidayName.get(d) ?? null,
      first_login_at: r?.first_login_at ?? null,
      last_activity_at: r?.last_activity_at ?? null,
      work_minutes: r?.work_minutes ?? null,
      notes: r?.notes ?? null,
      corrected: !!r?.corrected_by,
      corrected_by_name: r?.corrected_by ? (correctors.get(r.corrected_by) ?? null) : null,
      correction_reason: r?.correction_reason ?? null,
      record_updated_at: r?.updated_at ?? null,
    });
  }
  return {
    month,
    days,
    summary: summariseMonth((records.data ?? []).map((r) => ({ status: r.status as AttendanceStatus, workMinutes: r.work_minutes }))),
    calendar,
  };
}

export interface TeamAttendanceRow {
  employee_id: string;
  full_name: string;
  designation: string | null;
  role: StaffRole;
  summary: MonthlyAttendanceSummary;
  /** Status per date of the month (null = no record). */
  byDate: Record<string, AttendanceStatus | null>;
}

/**
 * The team's month (§7.12 exports: "attendance report (person × day)" and "a monthly summary").
 * Partners and Managers; people disabled before the month are left out.
 */
export async function getTeamAttendance(
  supabase: ServerSupabase,
  month: string,
  opts: { employeeIds?: readonly string[] } = {},
): Promise<{ month: string; dates: DateString[]; rows: TeamAttendanceRow[]; calendar: WorkingCalendarSettings }> {
  const { start, end } = monthBounds(month);
  let people = supabase.from("people_overview").select("id, full_name, designation, role, login_status").order("full_name").limit(1000);
  if (opts.employeeIds?.length) people = people.in("id", opts.employeeIds as string[]);
  const [peopleRes, calendar] = await Promise.all([people, getWorkingCalendar(supabase, start, end)]);
  if (peopleRes.error) throw peopleRes.error;
  const ids = (peopleRes.data ?? []).map((p) => p.id as string);
  const records = ids.length
    ? await supabase.from("attendance_records").select("employee_id, date, status, work_minutes").in("employee_id", ids).gte("date", start).lte("date", end).limit(50000)
    : { data: [], error: null };
  if (records.error) throw records.error;

  const dates: DateString[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  const byPerson = new Map<string, Array<{ date: string; status: AttendanceStatus; work_minutes: number | null }>>();
  for (const r of records.data ?? []) {
    const list = byPerson.get(r.employee_id) ?? [];
    list.push({ date: r.date, status: r.status as AttendanceStatus, work_minutes: r.work_minutes });
    byPerson.set(r.employee_id, list);
  }
  const rows: TeamAttendanceRow[] = [];
  for (const p of peopleRes.data ?? []) {
    const list = byPerson.get(p.id as string) ?? [];
    if (p.login_status === "disabled" && list.length === 0) continue;
    const byDate: Record<string, AttendanceStatus | null> = {};
    for (const d of dates) byDate[d] = null;
    for (const r of list) byDate[r.date] = r.status;
    rows.push({
      employee_id: p.id as string,
      full_name: p.full_name ?? "",
      designation: p.designation,
      role: (p.role ?? "employee") as StaffRole,
      summary: summariseMonth(list.map((r) => ({ status: r.status, workMinutes: r.work_minutes }))),
      byDate,
    });
  }
  return { month, dates, rows, calendar };
}

/** Today's attendance at a glance (§7.2 Manager "Attendance today"): counts by status. */
export async function getAttendanceToday(supabase: ServerSupabase, today: DateString): Promise<Record<AttendanceStatus, number>> {
  const { data, error } = await supabase.from("attendance_records").select("status").eq("date", today).limit(5000);
  if (error) throw error;
  const out: Record<AttendanceStatus, number> = { present: 0, late_login: 0, half_day: 0, absent: 0, on_leave: 0 };
  for (const r of data ?? []) out[r.status as AttendanceStatus] += 1;
  return out;
}

export interface SessionRow {
  id: string;
  login_at: string;
  last_active_at: string;
  logout_at: string | null;
  active_minutes: number;
  closed_reason: string | null;
  ip: string | null;
  user_agent: string | null;
  is_active: boolean;
}

/** Recent presence sessions of a person (Profile "Active sessions", person detail). */
export async function getRecentSessions(supabase: ServerSupabase, employeeId: string, limit = 10): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from("employee_sessions")
    .select("id, login_at, last_active_at, logout_at, active_minutes, closed_reason, ip, user_agent, is_active")
    .eq("employee_id", employeeId)
    .order("last_active_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
