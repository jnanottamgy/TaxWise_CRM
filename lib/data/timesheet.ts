import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { addDays, istDateOf, istDayBounds, type DateString } from "@/lib/domain/fy";
import { getApprovedLeave, getWorkingCalendar } from "@/lib/data/capacity";
import { listStaffOptions } from "@/lib/data/clients";
import { buildWeekGrid, dayTargets, gridKey, utilisation, weekDates, type GridEntry, type GridRowRef, type WeekGrid } from "@/lib/schemas/timesheet";

/**
 * Reads for the timesheet (§7.10): the running timer, a person's week (entries, grid rows,
 * approval, targets), the team's week with utilisation and budget against actual (Partners and
 * Managers), and unbilled time with its ₹ value (Partners and Managers only: the views return no
 * rows to anyone else, §4.1). Everything runs under the caller's RLS.
 */

export type RunningTimer = {
  id: string;
  started_at: string;
  description: string | null;
  billable: boolean;
  task: { id: string; task_number: string; title: string } | null;
  client: { id: string; name: string; code: string | null } | null;
};

/** The person's running timer, with what it is on, or null. */
export async function getRunningTimer(supabase: ServerSupabase, employeeId: string): Promise<RunningTimer | null> {
  const { data, error } = await supabase
    .from("time_entries")
    .select("id, started_at, description, billable, task_id, client_id")
    .eq("employee_id", employeeId)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const labels = await entryLabels(supabase, data.client_id ? [data.client_id] : [], data.task_id ? [data.task_id] : []);
  const task = data.task_id ? labels.tasks.get(data.task_id) : undefined;
  const clientName = data.client_id ? (labels.clients.get(data.client_id) ?? (task ? { name: task.client_name ?? "", code: null } : undefined)) : undefined;
  return {
    id: data.id,
    started_at: data.started_at,
    description: data.description,
    billable: data.billable,
    task: task ? { id: data.task_id!, task_number: task.task_number, title: task.title } : null,
    client: data.client_id && clientName ? { id: data.client_id, name: clientName.name, code: clientName.code } : null,
  };
}

type TaskLabel = { task_number: string; title: string; client_name: string | null; status: string; estimated_minutes: number | null };

/** Names for the clients and tasks entries point at (tasks through tasks_list, so a task's client name shows even outside the viewer's clients). */
export async function entryLabels(
  supabase: ServerSupabase,
  clientIds: readonly string[],
  taskIds: readonly string[],
): Promise<{ clients: Map<string, { name: string; code: string | null }>; tasks: Map<string, TaskLabel> }> {
  const cIds = [...new Set(clientIds.filter(Boolean))];
  const tIds = [...new Set(taskIds.filter(Boolean))];
  const [clients, tasks] = await Promise.all([
    cIds.length ? supabase.from("clients").select("id, display_name, client_code").in("id", cIds) : Promise.resolve({ data: [], error: null }),
    tIds.length
      ? supabase.from("tasks_list").select("id, task_number, title, client_id, client_name, client_code, status, estimated_minutes").in("id", tIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (clients.error) throw clients.error;
  if (tasks.error) throw tasks.error;
  const clientMap = new Map<string, { name: string; code: string | null }>();
  for (const c of (clients.data ?? []) as Array<{ id: string; display_name: string; client_code: string }>) clientMap.set(c.id, { name: c.display_name, code: String(c.client_code) });
  const taskMap = new Map<string, TaskLabel>();
  for (const t of (tasks.data ?? []) as Array<{ id: string; task_number: string; title: string; client_id: string; client_name: string | null; client_code: string | null; status: string; estimated_minutes: number | null }>) {
    taskMap.set(t.id, { task_number: t.task_number, title: t.title, client_name: t.client_name, status: t.status, estimated_minutes: t.estimated_minutes });
    if (t.client_id && !clientMap.has(t.client_id) && t.client_name) clientMap.set(t.client_id, { name: t.client_name, code: t.client_code });
  }
  return { clients: clientMap, tasks: taskMap };
}

export type EntryRow = GridEntry & {
  description: string | null;
  updated_at: string;
  client_name: string | null;
  task_number: string | null;
  task_title: string | null;
};

export type RowLabel = { client_name: string | null; client_code: string | null; task_number: string | null; task_title: string | null };

export type WeekView = {
  monday: DateString;
  dates: DateString[];
  entries: EntryRow[];
  grid: WeekGrid;
  labels: Record<string, RowLabel>;
  targets: number[];
  weeklyTarget: number;
  approval: { approved_at: string; approved_by_name: string | null; note: string | null } | null;
};

function weekBounds(monday: DateString): { from: string; to: string } {
  return { from: istDayBounds(monday).start.toISOString(), to: istDayBounds(addDays(monday, 7)).start.toISOString() };
}

const ENTRY_COLUMNS = "id, started_at, ended_at, minutes, client_id, task_id, billable, entry_source, locked, invoice_id, description, updated_at";

/** One person's week (§7.10 "My timesheet"). */
export async function getWeek(supabase: ServerSupabase, employeeId: string, monday: DateString): Promise<WeekView> {
  const dates = weekDates(monday);
  const { from, to } = weekBounds(monday);
  const [entries, rows, approval, calendar, leave] = await Promise.all([
    supabase.from("time_entries").select(ENTRY_COLUMNS).eq("employee_id", employeeId).gte("started_at", from).lt("started_at", to).order("started_at").limit(2000),
    supabase.from("timesheet_week_rows").select("id, client_id, task_id, billable, sort_order").eq("employee_id", employeeId).eq("week_start", monday).order("sort_order").order("created_at"),
    supabase.from("timesheet_week_approvals").select("approved_at, approved_by, note").eq("employee_id", employeeId).eq("week_start", monday).maybeSingle(),
    getWorkingCalendar(supabase, monday, addDays(monday, 6)),
    getApprovedLeave(supabase, [employeeId], monday, addDays(monday, 6)),
  ]);
  for (const r of [entries, rows, approval]) if (r.error) throw r.error;
  const list = (entries.data ?? []) as Array<GridEntry & { description: string | null; updated_at: string }>;
  const saved = (rows.data ?? []) as Array<GridRowRef & { id: string }>;
  const labels = await entryLabels(
    supabase,
    [...list.map((e) => e.client_id ?? ""), ...saved.map((r) => r.client_id ?? "")],
    [...list.map((e) => e.task_id ?? ""), ...saved.map((r) => r.task_id ?? "")],
  );
  const grid = buildWeekGrid(dates, list, saved);
  const rowLabels: Record<string, RowLabel> = {};
  for (const row of grid.rows) {
    const t = row.task_id ? labels.tasks.get(row.task_id) : undefined;
    const c = row.client_id ? labels.clients.get(row.client_id) : undefined;
    rowLabels[row.key] = { client_name: c?.name ?? t?.client_name ?? null, client_code: c?.code ?? null, task_number: t?.task_number ?? null, task_title: t?.title ?? null };
  }
  const targets = dayTargets(dates, { weeklyHours: calendar.weeklyHoursTarget, weekdays: calendar.weekdays, holidays: calendar.holidays, leaves: leave.get(employeeId) ?? [] });
  let approvedByName: string | null = null;
  if (approval.data?.approved_by) {
    const { data: who } = await supabase.from("employee_directory").select("full_name").eq("profile_id", approval.data.approved_by).maybeSingle();
    approvedByName = who?.full_name ?? null;
  }
  return {
    monday,
    dates,
    entries: list.map((e) => {
      const t = e.task_id ? labels.tasks.get(e.task_id) : undefined;
      const c = e.client_id ? labels.clients.get(e.client_id) : undefined;
      return { ...e, client_name: c?.name ?? t?.client_name ?? null, task_number: t?.task_number ?? null, task_title: t?.title ?? null };
    }),
    grid,
    labels: rowLabels,
    targets,
    weeklyTarget: targets.reduce((a, b) => a + b, 0),
    approval: approval.data ? { approved_at: approval.data.approved_at, approved_by_name: approvedByName, note: approval.data.note } : null,
  };
}

/** Last week's rows (from its entries and its saved rows), for "Copy last week's rows". */
export async function getRowsOfWeek(supabase: ServerSupabase, employeeId: string, monday: DateString): Promise<GridRowRef[]> {
  const { from, to } = weekBounds(monday);
  const [entries, rows] = await Promise.all([
    supabase.from("time_entries").select("client_id, task_id, billable").eq("employee_id", employeeId).gte("started_at", from).lt("started_at", to).not("ended_at", "is", null).limit(2000),
    supabase.from("timesheet_week_rows").select("client_id, task_id, billable").eq("employee_id", employeeId).eq("week_start", monday),
  ]);
  if (entries.error) throw entries.error;
  if (rows.error) throw rows.error;
  const seen = new Set<string>();
  const out: GridRowRef[] = [];
  for (const r of [...(rows.data ?? []), ...(entries.data ?? [])]) {
    const k = gridKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ client_id: r.client_id, task_id: r.task_id, billable: r.billable });
  }
  return out;
}

/** Whether the week is approved (and so locked) for the person. */
export async function isWeekApproved(supabase: ServerSupabase, employeeId: string, monday: DateString): Promise<boolean> {
  const { data, error } = await supabase.from("timesheet_week_approvals").select("id").eq("employee_id", employeeId).eq("week_start", monday).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// =================================================================================================
// Team timesheet (§7.10, Partners and Managers)
// =================================================================================================

export type TeamPerson = {
  employee_id: string;
  name: string;
  role: string;
  designation: string | null;
  days: number[];
  total: number;
  billable: number;
  target: number;
  utilisation: number | null;
  running: boolean;
  approval: { approved_at: string; approved_by_name: string | null } | null;
};

export type BudgetRow = {
  task_id: string;
  task_number: string;
  title: string;
  client_name: string | null;
  status: string;
  estimated_minutes: number;
  logged_minutes: number;
  week_minutes: number;
};

export type TeamWeek = { monday: DateString; dates: DateString[]; people: TeamPerson[]; dayTotals: number[]; total: number; billable: number; budget: BudgetRow[] };

/** Everyone's week: per person per day, utilisation (billable ÷ total) and budget against actual per task. */
export async function getTeamWeek(supabase: ServerSupabase, monday: DateString, viewerRole: "partner" | "manager"): Promise<TeamWeek> {
  const dates = weekDates(monday);
  const { from, to } = weekBounds(monday);
  const [staff, entries, approvals, calendar] = await Promise.all([
    listStaffOptions(supabase, viewerRole),
    supabase.from("time_entries").select("employee_id, started_at, ended_at, minutes, billable, task_id").gte("started_at", from).lt("started_at", to).limit(20000),
    supabase.from("timesheet_week_approvals").select("employee_id, approved_at, approved_by").eq("week_start", monday),
    getWorkingCalendar(supabase, monday, addDays(monday, 6)),
  ]);
  if (entries.error) throw entries.error;
  if (approvals.error) throw approvals.error;
  const leave = await getApprovedLeave(supabase, staff.map((s) => s.id), monday, addDays(monday, 6));
  const approverIds = [...new Set((approvals.data ?? []).map((a) => a.approved_by))];
  const approverNames = new Map<string, string>();
  if (approverIds.length) {
    const { data, error } = await supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", approverIds);
    if (error) throw error;
    for (const p of data ?? []) if (p.profile_id && p.full_name) approverNames.set(p.profile_id, p.full_name);
  }

  const byPerson = new Map<string, { days: number[]; billable: number; running: boolean }>();
  const taskWeek = new Map<string, number>();
  for (const e of entries.data ?? []) {
    const p = byPerson.get(e.employee_id) ?? { days: dates.map(() => 0), billable: 0, running: false };
    if (e.ended_at === null) {
      p.running = true;
    } else {
      const i = dates.indexOf(istDateOf(e.started_at));
      if (i >= 0) p.days[i] += e.minutes;
      if (e.billable) p.billable += e.minutes;
      if (e.task_id) taskWeek.set(e.task_id, (taskWeek.get(e.task_id) ?? 0) + e.minutes);
    }
    byPerson.set(e.employee_id, p);
  }
  const people: TeamPerson[] = staff.map((s) => {
    const p = byPerson.get(s.id) ?? { days: dates.map(() => 0), billable: 0, running: false };
    const total = p.days.reduce((a, b) => a + b, 0);
    const target = dayTargets(dates, { weeklyHours: calendar.weeklyHoursTarget, weekdays: calendar.weekdays, holidays: calendar.holidays, leaves: leave.get(s.id) ?? [] }).reduce((a, b) => a + b, 0);
    const a = (approvals.data ?? []).find((x) => x.employee_id === s.id);
    return {
      employee_id: s.id,
      name: s.name,
      role: s.role,
      designation: s.designation,
      days: p.days,
      total,
      billable: p.billable,
      target,
      utilisation: utilisation(p.billable, total),
      running: p.running,
      approval: a ? { approved_at: a.approved_at, approved_by_name: approverNames.get(a.approved_by) ?? null } : null,
    };
  });

  let budget: BudgetRow[] = [];
  const taskIds = [...taskWeek.keys()];
  if (taskIds.length) {
    const { data, error } = await supabase
      .from("tasks_list")
      .select("id, task_number, title, client_name, status, estimated_minutes, logged_minutes")
      .in("id", taskIds.slice(0, 1000))
      .not("estimated_minutes", "is", null);
    if (error) throw error;
    budget = (data ?? [])
      .filter((t) => (t.estimated_minutes ?? 0) > 0)
      .map((t) => ({
        task_id: t.id ?? "",
        task_number: t.task_number ?? "",
        title: t.title ?? "",
        client_name: t.client_name,
        status: t.status ?? "",
        estimated_minutes: t.estimated_minutes ?? 0,
        logged_minutes: t.logged_minutes ?? 0,
        week_minutes: taskWeek.get(t.id ?? "") ?? 0,
      }))
      .sort((a, b) => b.logged_minutes / b.estimated_minutes - a.logged_minutes / a.estimated_minutes);
  }
  const dayTotals = dates.map((_, i) => people.reduce((n, p) => n + p.days[i], 0));
  return {
    monday,
    dates,
    people,
    dayTotals,
    total: dayTotals.reduce((a, b) => a + b, 0),
    billable: people.reduce((n, p) => n + p.billable, 0),
    budget,
  };
}

// =================================================================================================
// Unbilled time (§7.10, Partners and Managers)
// =================================================================================================

export type UnbilledClientRow = {
  client_id: string;
  client_name: string;
  client_code: string | null;
  entries: number;
  minutes: number;
  amount: string | null;
  unrated_minutes: number;
  people: number;
  oldest_started_at: string | null;
};

export const UNBILLED_SORTABLE = ["client_name", "minutes", "amount", "oldest_started_at"] as const;
export type UnbilledSort = (typeof UNBILLED_SORTABLE)[number];

export async function listUnbilledByClient(
  supabase: ServerSupabase,
  t: TableParams<UnbilledSort, never>,
): Promise<{ rows: UnbilledClientRow[]; total: number; totals: { minutes: number; amount: string; clients: number } }> {
  let q = supabase.from("unbilled_time_by_client").select("client_id, client_name, client_code, entries, minutes, amount, unrated_minutes, people, oldest_started_at", { count: "exact" });
  const s = t.q.replace(/[,()"\\]/g, " ").trim();
  if (s) q = q.or(`client_name.ilike.%${escapeLike(s)}%,client_code.ilike.%${escapeLike(s)}%`);
  q = q.order(t.sort ?? "amount", { ascending: t.dir === "asc", nullsFirst: false }).order("client_name");
  const [page, all] = await Promise.all([q.range(t.from, t.to), supabase.from("unbilled_time_by_client").select("minutes, amount").limit(10000)]);
  if (page.error) throw page.error;
  if (all.error) throw all.error;
  // Sum the ₹ values as integer paise (§0.1 rule 7).
  let paise = 0;
  let minutes = 0;
  for (const r of all.data ?? []) {
    minutes += r.minutes ?? 0;
    if (r.amount !== null && r.amount !== undefined) paise += Math.round(Number(r.amount) * 100);
  }
  return {
    rows: (page.data ?? []).map((r) => ({
      client_id: r.client_id ?? "",
      client_name: r.client_name ?? "",
      client_code: r.client_code,
      entries: r.entries ?? 0,
      minutes: r.minutes ?? 0,
      amount: r.amount === null || r.amount === undefined ? null : String(r.amount),
      unrated_minutes: r.unrated_minutes ?? 0,
      people: r.people ?? 0,
      oldest_started_at: r.oldest_started_at,
    })),
    total: page.count ?? 0,
    totals: { minutes, amount: (paise / 100).toFixed(2), clients: (all.data ?? []).length },
  };
}

export type UnbilledEntryRow = {
  id: string;
  employee_name: string | null;
  task_number: string | null;
  task_title: string | null;
  description: string | null;
  started_at: string;
  minutes: number;
  billing_rate_per_hour: string | null;
  amount: string | null;
};

/** One client's unbilled entries, newest first (the drill-down under a client). */
export async function listUnbilledEntries(supabase: ServerSupabase, clientId: string, limit = 200): Promise<UnbilledEntryRow[]> {
  const { data, error } = await supabase
    .from("unbilled_time_entries")
    .select("id, employee_name, task_number, task_title, description, started_at, minutes, billing_rate_per_hour, amount")
    .eq("client_id", clientId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id ?? "",
    employee_name: r.employee_name,
    task_number: r.task_number,
    task_title: r.task_title,
    description: r.description,
    started_at: r.started_at ?? "",
    minutes: r.minutes ?? 0,
    billing_rate_per_hour: r.billing_rate_per_hour === null || r.billing_rate_per_hour === undefined ? null : String(r.billing_rate_per_hour),
    amount: r.amount === null || r.amount === undefined ? null : String(r.amount),
  }));
}

// =================================================================================================
// Timer shortcuts (the shell's timer panel)
// =================================================================================================

export type TimerShortcut = { id: string; task_number: string; title: string; client_name: string | null; due_date: string | null; is_overdue: boolean };

/** The person's open, accepted tasks, soonest due first: one tap starts the timer on one (§7.10). */
export async function getTimerShortcuts(supabase: ServerSupabase, employeeId: string, limit = 6): Promise<TimerShortcut[]> {
  const { data, error } = await supabase
    .from("tasks_list")
    .select("id, task_number, title, client_name, due_date, is_overdue")
    .eq("assigned_employee_id", employeeId)
    .eq("acceptance_status", "accepted")
    .neq("status", "filed_done")
    .is("deleted_at", null)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("task_number")
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((t) => ({
    id: t.id ?? "",
    task_number: t.task_number ?? "",
    title: t.title ?? "",
    client_name: t.client_name,
    due_date: t.due_date,
    is_overdue: Boolean(t.is_overdue),
  }));
}
