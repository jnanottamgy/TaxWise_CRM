import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { LeaveStatus, LeaveType } from "@/lib/domain/enums";
import { leaveWorkingDays, tasksDueDuringLeave } from "@/lib/domain/leave";
import { addDays, fyEnd, fyStart, type DateString, type FinancialYear } from "@/lib/domain/fy";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import { getEmployeeNames } from "@/lib/data/people";
import { getWorkingCalendar } from "@/lib/data/capacity";
import type { StaffRole } from "@/lib/schemas/people";

/**
 * Reads for Leave (§7.11.3) under the caller's RLS: Partners and Managers see everyone's leave,
 * an Employee their own (0032). Never money.
 */

export interface LeaveRow {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_role: StaffRole | null;
  start_date: string;
  end_date: string;
  half_day: boolean;
  type: LeaveType;
  status: LeaveStatus;
  reason: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  no_cover_needed: boolean;
  working_days: number;
  created_at: string;
  updated_at: string;
}

export const LEAVE_SORTABLE = ["start_date", "created_at", "status"] as const;
export type LeaveSort = (typeof LEAVE_SORTABLE)[number];
export const LEAVE_FILTERS = {
  status: ["requested", "approved", "declined", "cancelled"] as readonly string[],
  type: ["annual", "sick", "casual", "unpaid", "sabbatical", "other"] as readonly string[],
  person: null,
  when: ["upcoming", "past"] as readonly string[],
};

type RawLeave = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  type: LeaveType;
  status: LeaveStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  no_cover_needed: boolean;
  created_at: string;
  updated_at: string;
};

const LEAVE_COLS = "id, employee_id, start_date, end_date, half_day, type, status, reason, decided_by, decided_at, decision_note, no_cover_needed, created_at, updated_at";

async function decorate(supabase: ServerSupabase, rows: RawLeave[]): Promise<LeaveRow[]> {
  if (rows.length === 0) return [];
  const minStart = rows.reduce((m, r) => (r.start_date < m ? r.start_date : m), rows[0].start_date);
  const maxEnd = rows.reduce((m, r) => (r.end_date > m ? r.end_date : m), rows[0].end_date);
  const [names, deciders, calendar, roles] = await Promise.all([
    getEmployeeNames(supabase, rows.map((r) => r.employee_id)),
    supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", Array.from(new Set(rows.map((r) => r.decided_by).filter((d): d is string => !!d)))),
    getWorkingCalendar(supabase, minStart, maxEnd),
    supabase.from("people_overview").select("id, role").in("id", Array.from(new Set(rows.map((r) => r.employee_id)))),
  ]);
  if (deciders.error) throw deciders.error;
  if (roles.error) throw roles.error;
  const deciderNames = new Map((deciders.data ?? []).map((d) => [d.profile_id as string, d.full_name ?? ""]));
  const roleById = new Map((roles.data ?? []).map((r) => [r.id as string, (r.role ?? null) as StaffRole | null]));
  return rows.map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    employee_name: names.get(r.employee_id) ?? "",
    employee_role: roleById.get(r.employee_id) ?? null,
    start_date: r.start_date,
    end_date: r.end_date,
    half_day: r.half_day,
    type: r.type,
    status: r.status,
    reason: r.reason,
    decided_by_name: r.decided_by ? (deciderNames.get(r.decided_by) ?? null) : null,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    no_cover_needed: r.no_cover_needed,
    working_days: leaveWorkingDays(r.start_date, r.end_date, { weekdays: calendar.weekdays, holidays: calendar.holidays }, r.half_day),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** The leave table (§7.11.3): server-side search, filters, sort and paging. */
export async function listLeave(
  supabase: ServerSupabase,
  t: TableParams<LeaveSort, "status" | "type" | "person" | "when">,
  today: DateString,
  scope: { employeeId?: string | null } = {},
): Promise<{ rows: LeaveRow[]; total: number }> {
  let q = supabase.from("employee_leave").select(LEAVE_COLS, { count: "exact" });
  if (scope.employeeId) q = q.eq("employee_id", scope.employeeId);
  if (t.filters.status) q = q.in("status", t.filters.status as LeaveStatus[]);
  if (t.filters.type) q = q.in("type", t.filters.type as LeaveType[]);
  if (t.filters.person) q = q.in("employee_id", t.filters.person);
  if (t.filters.when?.length === 1) q = t.filters.when[0] === "upcoming" ? q.gte("end_date", today) : q.lt("end_date", today);
  if (t.q) {
    const { data: matches, error } = await supabase.from("employee_directory").select("id").ilike("full_name", `%${escapeLike(t.q)}%`).limit(200);
    if (error) throw error;
    const ids = (matches ?? []).map((m) => m.id as string);
    if (ids.length === 0) return { rows: [], total: 0 };
    q = q.in("employee_id", ids);
  }
  const sort = t.sort ?? "start_date";
  q = q.order(sort, { ascending: t.dir === "asc" }).order("created_at", { ascending: false });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: await decorate(supabase, (data ?? []) as RawLeave[]), total: count ?? 0 };
}

/** Requests waiting for this approver (§7.11.3): Managers Employees', Partners everyone's; never their own. */
export async function listPendingForApprover(supabase: ServerSupabase, user: CurrentUser, limit = 50): Promise<LeaveRow[]> {
  if (user.role !== "partner" && user.role !== "manager") return [];
  let q = supabase.from("employee_leave").select(LEAVE_COLS).eq("status", "requested").order("start_date").limit(limit);
  if (user.employeeId) q = q.neq("employee_id", user.employeeId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = await decorate(supabase, (data ?? []) as RawLeave[]);
  return user.role === "partner" ? rows : rows.filter((r) => r.employee_role === "employee");
}

/** Who is away (approved leave) between `from` and `to`. */
export async function listAway(supabase: ServerSupabase, from: DateString, to: DateString, limit = 50): Promise<LeaveRow[]> {
  const { data, error } = await supabase
    .from("employee_leave")
    .select(LEAVE_COLS)
    .eq("status", "approved")
    .lte("start_date", to)
    .gte("end_date", from)
    .order("start_date")
    .limit(limit);
  if (error) throw error;
  return decorate(supabase, (data ?? []) as RawLeave[]);
}

export async function getLeave(supabase: ServerSupabase, id: string): Promise<LeaveRow | null> {
  const { data, error } = await supabase.from("employee_leave").select(LEAVE_COLS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await decorate(supabase, [data as RawLeave]))[0];
}

/** The person's live leave (requested or approved), for the overlap check (lib/domain/leave). */
export async function getLiveLeave(supabase: ServerSupabase, employeeId: string): Promise<RawLeave[]> {
  const { data, error } = await supabase
    .from("employee_leave")
    .select(LEAVE_COLS)
    .eq("employee_id", employeeId)
    .in("status", ["requested", "approved"])
    .limit(500);
  if (error) throw error;
  return (data ?? []) as RawLeave[];
}

export interface LeaveSummary {
  fy: FinancialYear;
  /** Working days of approved leave in the FY, by type. */
  takenByType: Partial<Record<LeaveType, number>>;
  taken: number;
  upcoming: number;
  pending: number;
}

/**
 * The Leave tab's summary (§7.11.2 "Leave: balance and history"): the firm keeps no leave
 * allowance, so the balance is what has been taken in the year (working days, by type), what is
 * approved ahead, and what is waiting for a decision.
 */
export async function getLeaveSummary(supabase: ServerSupabase, employeeId: string, fy: FinancialYear, today: DateString): Promise<LeaveSummary> {
  const start = fyStart(fy);
  const end = fyEnd(fy);
  const { data, error } = await supabase
    .from("employee_leave")
    .select("start_date, end_date, half_day, type, status")
    .eq("employee_id", employeeId)
    .in("status", ["approved", "requested"])
    .lte("start_date", end)
    .gte("end_date", start)
    .limit(500);
  if (error) throw error;
  const calendar = await getWorkingCalendar(supabase, start, end);
  const opts = { weekdays: calendar.weekdays, holidays: calendar.holidays };
  const out: LeaveSummary = { fy, takenByType: {}, taken: 0, upcoming: 0, pending: 0 };
  for (const l of data ?? []) {
    const from = l.start_date < start ? start : l.start_date;
    const to = l.end_date > end ? end : l.end_date;
    if (l.status === "requested") {
      out.pending += leaveWorkingDays(from, to, opts, l.half_day);
      continue;
    }
    const pastEnd = to < today ? to : addDays(today, -1);
    const past = pastEnd >= from ? leaveWorkingDays(from, pastEnd, opts, l.half_day && from === to) : 0;
    const ahead = leaveWorkingDays(from > today ? from : today, to, opts, l.half_day && from === to);
    out.taken += past;
    out.upcoming += to >= today ? ahead : 0;
    out.takenByType[l.type as LeaveType] = (out.takenByType[l.type as LeaveType] ?? 0) + past;
  }
  return out;
}

/** Open tasks of the person due during the leave (§7.11.3 "Reassign before 01 Jul?"). */
export async function getTasksDuringLeave(
  supabase: ServerSupabase,
  employeeId: string,
  start: DateString,
  end: DateString,
): Promise<Array<{ id: string; task_number: string; title: string; due_date: string; status: string; client_id: string; client_name: string | null }>> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, task_number, title, due_date, status, client_id, clients(display_name)")
    .eq("assigned_employee_id", employeeId)
    .is("deleted_at", null)
    .neq("status", "filed_done")
    .gte("due_date", start)
    .lte("due_date", end)
    .order("due_date")
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []).map((t) => ({
    id: t.id,
    task_number: t.task_number,
    title: t.title,
    dueDate: t.due_date,
    due_date: t.due_date as string,
    status: t.status,
    client_id: t.client_id,
    client_name: (t.clients as { display_name?: string } | null)?.display_name ?? null,
  }));
  return tasksDueDuringLeave(rows, { startDate: start, endDate: end }).map((r) => ({
    id: r.id,
    task_number: r.task_number,
    title: r.title,
    due_date: r.due_date,
    status: r.status,
    client_id: r.client_id,
    client_name: r.client_name,
  }));
}
