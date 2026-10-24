import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import { PRESENCE_DEFAULTS, presenceStatus, type PresenceStatus } from "@/lib/domain/presence";
import type { CapacityAssessment } from "@/lib/domain/capacity";
import { addDays, fyEnd, fyStart, isoWeekday, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { getCapacityFor } from "@/lib/data/capacity";
import type { LoginStatus, StaffRole } from "@/lib/schemas/people";
import { STAFF_ROLE_VALUES, summarisePerformance, targetMinutesFor, type PerformanceFigures } from "@/lib/schemas/people";

/**
 * Reads for People (§7.11). Every function runs under the caller's session, so RLS decides what
 * comes back (§4.6: Partners and Managers see every staff record; an Employee their own row and a
 * minimal directory of colleagues). Money never: billing and cost rates are read only for
 * Partners (cost rate, through employee_cost_rates) and Managers (billing rate), never for
 * Employees, not even their own (§4.1). They throw on a database error; pages catch and show the
 * failed block with its Ref.
 */

// -------------------------------------------------------------------------------------------------
// Team list (§7.11.1)
// -------------------------------------------------------------------------------------------------

export const PEOPLE_SORTABLE = ["full_name", "role", "designation", "department", "open_tasks", "last_seen_at"] as const;
export type PeopleSort = (typeof PEOPLE_SORTABLE)[number];
export const PEOPLE_FILTERS = {
  role: STAFF_ROLE_VALUES as readonly string[],
  status: ["active", "disabled", "no_login"] as readonly string[],
  department: null,
  /** "Online now" (the dashboard's Team online now): active within the presence idle window, login not disabled. */
  presence: ["online"] as readonly string[],
};

export interface PersonListRow {
  id: string;
  profile_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  department: string | null;
  designation: string | null;
  role: StaffRole;
  login_status: LoginStatus;
  open_tasks: number;
  review_tasks: number;
  last_seen_at: string | null;
  presence: PresenceStatus;
  on_leave_today: boolean;
  capacity: CapacityAssessment | null;
  updated_at: string;
}

/** Characters PostgREST's `or=(…)` syntax reserves; dropped from the search text. */
function orSafe(q: string): string {
  return q.replace(/[,()]/g, " ").trim();
}

export async function listPeople(
  supabase: ServerSupabase,
  t: TableParams<PeopleSort, "role" | "status" | "department" | "presence">,
  today: DateString,
  now: Date = new Date(),
): Promise<{ rows: PersonListRow[]; total: number }> {
  let q = supabase
    .from("people_overview")
    .select(
      "id, profile_id, full_name, email, phone, department, designation, role, login_status, open_tasks, review_tasks, last_seen_at, open_session_active_at, on_leave_today, updated_at",
      { count: "exact" },
    );
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(`full_name.ilike.${like},email.ilike.${like},designation.ilike.${like},department.ilike.${like}`);
  }
  if (t.filters.role) q = q.in("role", t.filters.role as StaffRole[]);
  if (t.filters.status) q = q.in("login_status", t.filters.status);
  if (t.filters.department) q = q.in("department", t.filters.department);
  if (t.filters.presence?.includes("online")) {
    // presenceStatus(): online while the last activity is under idleAfterMinutes old.
    const since = new Date(now.getTime() - PRESENCE_DEFAULTS.idleAfterMinutes * 60_000).toISOString();
    q = q.gt("open_session_active_at", since).neq("login_status", "disabled");
  }
  const sort = t.sort ?? "full_name";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "full_name") q = q.order("full_name", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;

  const rows = data ?? [];
  const capacity = await getCapacityFor(
    supabase,
    rows.filter((r) => r.login_status !== "disabled").map((r) => r.id as string),
    today,
  );
  return {
    total: count ?? 0,
    rows: rows.map((r) => ({
      id: r.id as string,
      profile_id: r.profile_id,
      full_name: r.full_name ?? "",
      email: r.email ?? "",
      phone: r.phone,
      department: r.department,
      designation: r.designation,
      role: (r.role ?? "employee") as StaffRole,
      login_status: (r.login_status ?? "no_login") as LoginStatus,
      open_tasks: r.open_tasks ?? 0,
      review_tasks: r.review_tasks ?? 0,
      last_seen_at: r.last_seen_at,
      presence: presenceStatus(r.open_session_active_at, now, PRESENCE_DEFAULTS),
      on_leave_today: Boolean(r.on_leave_today),
      capacity: capacity.get(r.id as string) ?? null,
      updated_at: r.updated_at ?? "",
    })),
  };
}

/** Departments in use, for the filter. */
export async function listDepartments(supabase: ServerSupabase): Promise<string[]> {
  const { data, error } = await supabase.from("people_overview").select("department").not("department", "is", null).limit(1000);
  if (error) throw error;
  return Array.from(new Set((data ?? []).map((d) => d.department).filter((d): d is string => !!d))).sort((a, b) => a.localeCompare(b));
}

/** Counts for the page description: active, no login yet, disabled, online now. */
export async function getTeamCounts(supabase: ServerSupabase, now: Date = new Date()): Promise<{ active: number; noLogin: number; disabled: number; onlineNow: number; onLeaveToday: number }> {
  const { data, error } = await supabase.from("people_overview").select("login_status, open_session_active_at, on_leave_today").limit(2000);
  if (error) throw error;
  const out = { active: 0, noLogin: 0, disabled: 0, onlineNow: 0, onLeaveToday: 0 };
  for (const r of data ?? []) {
    if (r.login_status === "active") out.active++;
    else if (r.login_status === "no_login") out.noLogin++;
    else out.disabled++;
    if (r.login_status !== "disabled" && presenceStatus(r.open_session_active_at, now) === "online") out.onlineNow++;
    if (r.on_leave_today && r.login_status !== "disabled") out.onLeaveToday++;
  }
  return out;
}

/** Emails already on the team (employees and logins), lower-cased, for the import check. */
export async function existingTeamEmails(supabase: ServerSupabase): Promise<Set<string>> {
  const { data, error } = await supabase.from("employees").select("email").limit(5000);
  if (error) throw error;
  return new Set((data ?? []).map((e) => String(e.email).toLowerCase()));
}

// -------------------------------------------------------------------------------------------------
// Pickers
// -------------------------------------------------------------------------------------------------

export interface PersonOption {
  id: string;
  full_name: string;
  designation: string | null;
  role: StaffRole;
  is_active: boolean;
}

/** Active staff for pickers (cover person, reassign to, task assignee). Partners and Managers only. */
export async function listActiveStaff(supabase: ServerSupabase): Promise<PersonOption[]> {
  const { data, error } = await supabase
    .from("people_overview")
    .select("id, full_name, designation, role, login_status")
    .neq("login_status", "disabled")
    .order("full_name")
    .limit(1000);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    full_name: r.full_name ?? "",
    designation: r.designation,
    role: (r.role ?? "employee") as StaffRole,
    is_active: true,
  }));
}

/** Names for employee ids, from the staff directory every staff member may read (§4.6). */
export async function getEmployeeNames(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((i): i is string => !!i)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase.from("employee_directory").select("id, full_name").in("id", unique);
  if (error) throw error;
  for (const r of data ?? []) if (r.id) out.set(r.id, r.full_name ?? "");
  return out;
}

/** Names for profile (auth user) ids, from the staff directory. */
export async function getNamesByProfile(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((i): i is string => !!i)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", unique);
  if (error) throw error;
  for (const r of data ?? []) if (r.profile_id) out.set(r.profile_id, r.full_name ?? "");
  return out;
}

// -------------------------------------------------------------------------------------------------
// Person detail (§7.11.2)
// -------------------------------------------------------------------------------------------------

export interface PersonDetail {
  id: string;
  profile_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  department: string | null;
  designation: string | null;
  date_of_joining: string | null;
  role: StaffRole;
  login_status: LoginStatus;
  is_active: boolean;
  vault_access: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  last_seen_at: string | null;
  presence: PresenceStatus;
  on_leave_today: boolean;
  avatar_path: string | null;
  icai_membership_no: string | null;
  /** Partners and Managers only (§4.1: Employees never see rates, not even their own). */
  billing_rate_per_hour: string | number | null;
  /** Partners only (§5.2). */
  cost_rate_per_hour: string | number | null;
  open_tasks: number;
  review_tasks: number;
  updated_at: string;
  created_at: string;
}

/**
 * One person, as the viewer may see them: Partners and Managers anyone (RLS), an Employee only
 * themselves (the page refuses anyone else). Null when not found or not visible.
 */
export async function getPerson(supabase: ServerSupabase, id: string, viewerRole: AppRole, now: Date = new Date()): Promise<PersonDetail | null> {
  const { data: row, error } = await supabase
    .from("people_overview")
    .select(
      "id, profile_id, full_name, email, phone, whatsapp, department, designation, date_of_joining, role, login_status, is_active, vault_access, must_change_password, last_login_at, last_seen_at, open_session_active_at, on_leave_today, avatar_path, open_tasks, review_tasks, updated_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const isManager = viewerRole === "partner" || viewerRole === "manager";
  const [rates, cost, profile] = await Promise.all([
    isManager ? supabase.from("employees").select("billing_rate_per_hour").eq("id", id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    viewerRole === "partner" ? supabase.from("employee_cost_rates").select("cost_rate_per_hour").eq("id", id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    row.profile_id ? supabase.from("profiles").select("icai_membership_no").eq("id", row.profile_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (rates.error) throw rates.error;
  if (cost.error) throw cost.error;
  if (profile.error) throw profile.error;

  return {
    id: row.id as string,
    profile_id: row.profile_id,
    full_name: row.full_name ?? "",
    email: row.email ?? "",
    phone: row.phone,
    whatsapp: row.whatsapp,
    department: row.department,
    designation: row.designation,
    date_of_joining: row.date_of_joining,
    role: (row.role ?? "employee") as StaffRole,
    login_status: (row.login_status ?? "no_login") as LoginStatus,
    is_active: Boolean(row.is_active),
    vault_access: Boolean(row.vault_access),
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at,
    last_seen_at: row.last_seen_at,
    presence: presenceStatus(row.open_session_active_at, now),
    on_leave_today: Boolean(row.on_leave_today),
    avatar_path: row.avatar_path,
    icai_membership_no: (profile.data as { icai_membership_no: string | null } | null)?.icai_membership_no ?? null,
    billing_rate_per_hour: (rates.data as { billing_rate_per_hour: number | null } | null)?.billing_rate_per_hour ?? null,
    cost_rate_per_hour: (cost.data as { cost_rate_per_hour: number | null } | null)?.cost_rate_per_hour ?? null,
    open_tasks: row.open_tasks ?? 0,
    review_tasks: row.review_tasks ?? 0,
    updated_at: row.updated_at ?? "",
    created_at: row.created_at ?? "",
  };
}

export interface OpenWork {
  open_tasks: number;
  review_tasks: number;
  owned_clients: number;
  team_clients: number;
  open_notices: number;
  open_leads: number;
}

export async function getOpenWork(supabase: ServerSupabase, employeeId: string): Promise<OpenWork> {
  const { data, error } = await supabase.rpc("employee_open_work", { p_employee: employeeId });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, number>;
  return {
    open_tasks: d.open_tasks ?? 0,
    review_tasks: d.review_tasks ?? 0,
    owned_clients: d.owned_clients ?? 0,
    team_clients: d.team_clients ?? 0,
    open_notices: d.open_notices ?? 0,
    open_leads: d.open_leads ?? 0,
  };
}

// -------------------------------------------------------------------------------------------------
// Work tab (§7.11.2)
// -------------------------------------------------------------------------------------------------

export interface WorkTask {
  id: string;
  task_number: string;
  title: string;
  status: string;
  due_date: string | null;
  client_id: string;
  client_name: string | null;
  acceptance_status: string;
}

export interface WorkClient {
  id: string;
  client_code: string;
  display_name: string;
  relation: "owner" | "team";
  open_tasks: number;
}

export async function getPersonWork(
  supabase: ServerSupabase,
  employeeId: string,
): Promise<{ assigned: WorkTask[]; reviewing: WorkTask[]; clients: WorkClient[]; clientTotal: number }> {
  const taskCols = "id, task_number, title, status, due_date, client_id, acceptance_status, clients(display_name)";
  const [assigned, reviewing, owned, team] = await Promise.all([
    supabase.from("tasks").select(taskCols).eq("assigned_employee_id", employeeId).is("deleted_at", null).neq("status", "filed_done").order("due_date", { ascending: true, nullsFirst: false }).limit(8),
    supabase.from("tasks").select(taskCols).eq("reviewer_employee_id", employeeId).is("deleted_at", null).neq("status", "filed_done").order("due_date", { ascending: true, nullsFirst: false }).limit(8),
    supabase.from("clients").select("id, client_code, display_name").eq("owner_employee_id", employeeId).is("deleted_at", null).order("display_name").limit(50),
    supabase.from("client_team_members").select("client_id, clients(id, client_code, display_name, deleted_at)").eq("employee_id", employeeId).limit(200),
  ]);
  for (const r of [assigned, reviewing, owned, team]) if (r.error) throw r.error;

  const mapTask = (t: Record<string, unknown>): WorkTask => ({
    id: t.id as string,
    task_number: t.task_number as string,
    title: t.title as string,
    status: t.status as string,
    due_date: (t.due_date as string | null) ?? null,
    client_id: t.client_id as string,
    client_name: ((t.clients as { display_name?: string } | null)?.display_name as string | undefined) ?? null,
    acceptance_status: t.acceptance_status as string,
  });

  const clients = new Map<string, WorkClient>();
  for (const c of owned.data ?? []) clients.set(c.id, { id: c.id, client_code: c.client_code as string, display_name: c.display_name, relation: "owner", open_tasks: 0 });
  for (const m of team.data ?? []) {
    const c = m.clients as { id: string; client_code: string; display_name: string; deleted_at: string | null } | null;
    if (!c || c.deleted_at || clients.has(c.id)) continue;
    clients.set(c.id, { id: c.id, client_code: c.client_code, display_name: c.display_name, relation: "team", open_tasks: 0 });
  }
  const ids = Array.from(clients.keys());
  if (ids.length > 0) {
    const { data: open, error } = await supabase.from("tasks").select("client_id").in("client_id", ids).is("deleted_at", null).neq("status", "filed_done").limit(10000);
    if (error) throw error;
    for (const t of open ?? []) {
      const c = clients.get(t.client_id);
      if (c) c.open_tasks += 1;
    }
  }
  const list = Array.from(clients.values()).sort((a, b) => (a.relation === b.relation ? a.display_name.localeCompare(b.display_name) : a.relation === "owner" ? -1 : 1));
  return {
    assigned: (assigned.data ?? []).map((t) => mapTask(t as unknown as Record<string, unknown>)),
    reviewing: (reviewing.data ?? []).map((t) => mapTask(t as unknown as Record<string, unknown>)),
    clients: list.slice(0, 12),
    clientTotal: list.length,
  };
}

// -------------------------------------------------------------------------------------------------
// Time tab (§7.11.2, §7.10): hours this week and month, billable %, utilisation
// -------------------------------------------------------------------------------------------------

export interface TimeSummary {
  weekMinutes: number;
  weekBillableMinutes: number;
  monthMinutes: number;
  monthBillableMinutes: number;
  weeklyTargetMinutes: number;
  weekStart: DateString;
  monthStart: DateString;
}

export async function getPersonTime(supabase: ServerSupabase, employeeId: string, today: DateString, weeklyHoursTarget: number): Promise<TimeSummary> {
  const weekStart = addDays(today, 1 - isoWeekday(today));
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = weekStart < monthStart ? weekStart : monthStart;
  const { data, error } = await supabase
    .from("time_entries")
    .select("started_at, minutes, billable")
    .eq("employee_id", employeeId)
    .gte("started_at", new Date(`${from}T00:00:00+05:30`).toISOString())
    .not("ended_at", "is", null)
    .limit(5000);
  if (error) throw error;
  const out: TimeSummary = { weekMinutes: 0, weekBillableMinutes: 0, monthMinutes: 0, monthBillableMinutes: 0, weeklyTargetMinutes: weeklyHoursTarget * 60, weekStart, monthStart };
  for (const e of data ?? []) {
    const day = new Date(new Date(e.started_at).getTime() + 330 * 60_000).toISOString().slice(0, 10);
    if (day >= weekStart && day <= today) {
      out.weekMinutes += e.minutes;
      if (e.billable) out.weekBillableMinutes += e.minutes;
    }
    if (day >= monthStart && day <= today) {
      out.monthMinutes += e.minutes;
      if (e.billable) out.monthBillableMinutes += e.minutes;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Performance (§7.11.2): filed on time %, average days late, review send-back rate, hours vs target
// -------------------------------------------------------------------------------------------------

export interface PerformanceSummary extends PerformanceFigures {
  fy: FinancialYear;
  hoursMinutes: number;
  targetMinutes: number;
}

export async function getPersonPerformance(
  supabase: ServerSupabase,
  employeeId: string,
  fy: FinancialYear,
  today: DateString,
  weeklyHoursTarget: number,
): Promise<PerformanceSummary> {
  const start = fyStart(fy);
  const end = fyEnd(fy) < today ? fyEnd(fy) : today;
  const startInstant = new Date(`${start}T00:00:00+05:30`).toISOString();
  const endInstant = new Date(`${addDays(end, 1)}T00:00:00+05:30`).toISOString();

  const [filed, history, time] = await Promise.all([
    supabase
      .from("tasks")
      .select("due_date, completion_date")
      .eq("assigned_employee_id", employeeId)
      .eq("status", "filed_done")
      .is("deleted_at", null)
      .gte("completion_date", startInstant)
      .lt("completion_date", endInstant)
      .limit(10000),
    supabase
      .from("task_status_history")
      .select("from_status, to_status, tasks!inner(assigned_employee_id)")
      .eq("tasks.assigned_employee_id", employeeId)
      .gte("changed_at", startInstant)
      .lt("changed_at", endInstant)
      .or("to_status.eq.under_review,and(from_status.eq.under_review,to_status.eq.in_progress)")
      .limit(20000),
    supabase
      .from("time_entries")
      .select("minutes")
      .eq("employee_id", employeeId)
      .gte("started_at", startInstant)
      .lt("started_at", endInstant)
      .not("ended_at", "is", null)
      .limit(20000),
  ]);
  for (const r of [filed, history, time]) if (r.error) throw r.error;

  const figures = summarisePerformance(filed.data ?? [], (history.data ?? []).map((h) => ({ from_status: h.from_status, to_status: h.to_status })));
  const minutes = (time.data ?? []).reduce((s, e) => s + (e.minutes ?? 0), 0);
  const days = Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1);
  return { ...figures, fy, hoursMinutes: minutes, targetMinutes: targetMinutesFor(weeklyHoursTarget, days) };
}

// -------------------------------------------------------------------------------------------------
// Activity (§7.11.2 "Activity timeline"): the person's own feed (employee_activities)
// -------------------------------------------------------------------------------------------------

export interface ActivityRow {
  id: string;
  activity_type: string;
  description: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  performed_at: string;
}

export async function getPersonActivity(supabase: ServerSupabase, employeeId: string, page: number, pageSize = 25): Promise<{ rows: ActivityRow[]; total: number }> {
  const from = (page - 1) * pageSize;
  const { data, error, count } = await supabase
    .from("employee_activities")
    .select("id, activity_type, description, entity_type, entity_id, entity_name, performed_at", { count: "exact" })
    .eq("employee_id", employeeId)
    .order("performed_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

/** The person's history as Partners and Managers record it (activity_logs on the employee). */
export async function getPersonHistory(supabase: ServerSupabase, employeeId: string, limit = 20): Promise<Array<{ id: string; action: string; description: string; user_name: string | null; at: string }>> {
  const { data, error } = await supabase
    .from("activity_logs")
    .select("id, action, description, user_name, at")
    .eq("entity_type", "employee")
    .eq("entity_id", employeeId)
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** The signed-in staff member's own employees row id and updated_at (for Profile). */
export async function getMyEmployee(supabase: ServerSupabase, userId: string): Promise<{ id: string; updated_at: string } | null> {
  const { data, error } = await supabase.from("employees").select("id, updated_at").eq("profile_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

// -------------------------------------------------------------------------------------------------
// The team's performance in one go (/performance): no query per person
// -------------------------------------------------------------------------------------------------

export interface TeamPerformanceRow extends PerformanceFigures {
  employee_id: string;
  hoursMinutes: number;
  targetMinutes: number;
}

export async function getTeamPerformance(
  supabase: ServerSupabase,
  employeeIds: readonly string[],
  fy: FinancialYear,
  today: DateString,
  weeklyHoursTarget: number,
): Promise<Map<string, TeamPerformanceRow>> {
  const out = new Map<string, TeamPerformanceRow>();
  if (employeeIds.length === 0) return out;
  const start = fyStart(fy);
  const end = fyEnd(fy) < today ? fyEnd(fy) : today;
  const startInstant = new Date(`${start}T00:00:00+05:30`).toISOString();
  const endInstant = new Date(`${addDays(end, 1)}T00:00:00+05:30`).toISOString();
  const ids = employeeIds as string[];
  const [filed, history, time] = await Promise.all([
    supabase
      .from("tasks")
      .select("assigned_employee_id, due_date, completion_date")
      .in("assigned_employee_id", ids)
      .eq("status", "filed_done")
      .is("deleted_at", null)
      .gte("completion_date", startInstant)
      .lt("completion_date", endInstant)
      .limit(50000),
    supabase
      .from("task_status_history")
      .select("from_status, to_status, tasks!inner(assigned_employee_id)")
      .in("tasks.assigned_employee_id", ids)
      .gte("changed_at", startInstant)
      .lt("changed_at", endInstant)
      .or("to_status.eq.under_review,and(from_status.eq.under_review,to_status.eq.in_progress)")
      .limit(50000),
    supabase.from("time_entries").select("employee_id, minutes").in("employee_id", ids).gte("started_at", startInstant).lt("started_at", endInstant).not("ended_at", "is", null).limit(100000),
  ]);
  for (const r of [filed, history, time]) if (r.error) throw r.error;
  const days = Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1);
  const target = targetMinutesFor(weeklyHoursTarget, days);
  for (const id of ids) {
    const f = (filed.data ?? []).filter((t) => t.assigned_employee_id === id);
    const h = (history.data ?? [])
      .filter((x) => (x.tasks as { assigned_employee_id?: string | null } | null)?.assigned_employee_id === id)
      .map((x) => ({ from_status: x.from_status, to_status: x.to_status }));
    const minutes = (time.data ?? []).filter((e) => e.employee_id === id).reduce((s, e) => s + (e.minutes ?? 0), 0);
    out.set(id, { employee_id: id, ...summarisePerformance(f, h), hoursMinutes: minutes, targetMinutes: target });
  }
  return out;
}
