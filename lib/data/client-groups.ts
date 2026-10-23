import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import type { ClientPriority, ClientStatus, TaskPriority, TaskStatus } from "@/lib/domain/enums";
import type { GroupSort } from "@/lib/schemas/client-groups";

/**
 * Client groups (§7.4): the list and one group's page, with combined open tasks, deadlines and
 * (Partner/Manager only) outstanding across its members. Runs under the caller's RLS; the
 * `client_groups_overview` view (0113) returns null outstanding for anyone else.
 */

export type GroupListRow = {
  id: string;
  name: string;
  notes: string | null;
  members: number;
  active_members: number;
  open_tasks: number;
  overdue_tasks: number;
  next_due_date: string | null;
  outstanding: number | string | null;
  updated_at: string;
};

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

function mapGroup(r: Record<string, unknown>, seesMoney: boolean): GroupListRow {
  return {
    id: r.id as string,
    name: (r.name as string) ?? "",
    notes: (r.notes as string | null) ?? null,
    members: Number(r.members ?? 0),
    active_members: Number(r.active_members ?? 0),
    open_tasks: Number(r.open_tasks ?? 0),
    overdue_tasks: Number(r.overdue_tasks ?? 0),
    next_due_date: (r.next_due_date as string | null) ?? null,
    outstanding: seesMoney ? ((r.outstanding as number | string | null) ?? 0) : null,
    updated_at: (r.updated_at as string) ?? "",
  };
}

export async function listGroups(
  supabase: ServerSupabase,
  t: TableParams<GroupSort, never>,
  seesMoney: boolean,
): Promise<{ rows: GroupListRow[]; total: number }> {
  const cols = `id, name, notes, members, active_members, open_tasks, overdue_tasks, next_due_date, updated_at${seesMoney ? ", outstanding" : ""}`;
  let q = supabase.from("client_groups_overview").select(cols, { count: "exact" });
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(`name.ilike.${like},notes.ilike.${like}`);
  }
  const sort = t.sort && (t.sort !== "outstanding" || seesMoney) ? t.sort : "name";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "name") q = q.order("name", { ascending: true });
  const { data, error, count } = await q.order("id").range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => mapGroup(r, seesMoney)), total: count ?? 0 };
}

export type GroupMemberRow = {
  id: string;
  client_code: string;
  display_name: string;
  status: ClientStatus;
  priority: ClientPriority;
  owner_name: string | null;
  open_tasks: number;
  overdue_tasks: number;
  next_due_date: string | null;
  next_due_title: string | null;
  outstanding: number | string | null;
};

export type GroupTaskRow = {
  id: string;
  task_number: string;
  title: string;
  client_id: string;
  client_name: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  is_overdue: boolean;
};

export type GroupDeadlineRow = {
  id: string;
  client_id: string;
  client_name: string;
  title: string;
  form_code: string | null;
  filing_period: string | null;
  due_date: string;
  is_overdue: boolean;
};

export type GroupDetail = {
  group: GroupListRow;
  members: GroupMemberRow[];
  tasks: GroupTaskRow[];
  tasksTotal: number;
  deadlines: GroupDeadlineRow[];
  deadlinesTotal: number;
};

/** One group with its members, their open tasks and their next deadlines (§7.4). Null when it doesn't exist. */
export async function getGroup(supabase: ServerSupabase, id: string, seesMoney: boolean): Promise<GroupDetail | null> {
  const cols = `id, name, notes, members, active_members, open_tasks, overdue_tasks, next_due_date, updated_at${seesMoney ? ", outstanding" : ""}`;
  const { data: g, error } = await supabase.from("client_groups_overview").select(cols).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!g) return null;
  const group = mapGroup(g as unknown as Record<string, unknown>, seesMoney);

  const memberCols = `id, client_code, display_name, status, priority, owner_name, open_tasks, overdue_tasks, next_due_date, next_due_title${seesMoney ? ", outstanding" : ""}`;
  const { data: members, error: mErr } = await supabase
    .from("clients_list")
    .select(memberCols)
    .eq("group_id", id)
    .is("deleted_at", null)
    .order("display_name")
    .limit(500);
  if (mErr) throw mErr;
  const rows = ((members ?? []) as unknown as Array<Record<string, unknown>>).map(
    (m): GroupMemberRow => ({
      id: m.id as string,
      client_code: (m.client_code as string) ?? "",
      display_name: (m.display_name as string) ?? "",
      status: (m.status as ClientStatus) ?? "pending",
      priority: (m.priority as ClientPriority) ?? "medium",
      owner_name: (m.owner_name as string | null) ?? null,
      open_tasks: Number(m.open_tasks ?? 0),
      overdue_tasks: Number(m.overdue_tasks ?? 0),
      next_due_date: (m.next_due_date as string | null) ?? null,
      next_due_title: (m.next_due_title as string | null) ?? null,
      outstanding: seesMoney ? ((m.outstanding as number | string | null) ?? 0) : null,
    }),
  );
  const ids = rows.map((r) => r.id);
  const names = new Map(rows.map((r) => [r.id, r.display_name]));
  if (ids.length === 0) return { group, members: rows, tasks: [], tasksTotal: 0, deadlines: [], deadlinesTotal: 0 };

  const [tasks, deadlines] = await Promise.all([
    supabase
      .from("tasks_view")
      .select("id, task_number, title, client_id, status, priority, due_date, is_overdue", { count: "exact" })
      .in("client_id", ids)
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("task_number")
      .limit(8),
    supabase
      .from("compliance_events_view")
      .select("id, client_id, title, form_code, filing_period, due_date, is_overdue", { count: "exact" })
      .in("client_id", ids)
      .eq("status", "pending")
      .order("due_date")
      .order("title")
      .limit(8),
  ]);
  if (tasks.error) throw tasks.error;
  if (deadlines.error) throw deadlines.error;
  return {
    group,
    members: rows,
    tasks: (tasks.data ?? []).map((t) => ({
      id: t.id as string,
      task_number: (t.task_number as string) ?? "",
      title: (t.title as string) ?? "",
      client_id: t.client_id as string,
      client_name: names.get(t.client_id as string) ?? "",
      status: (t.status as TaskStatus) ?? "not_started",
      priority: (t.priority as TaskPriority) ?? "medium",
      due_date: (t.due_date as string | null) ?? null,
      is_overdue: Boolean(t.is_overdue),
    })),
    tasksTotal: tasks.count ?? 0,
    deadlines: (deadlines.data ?? []).map((d) => ({
      id: d.id as string,
      client_id: d.client_id as string,
      client_name: names.get(d.client_id as string) ?? "",
      title: (d.title as string) ?? "",
      form_code: (d.form_code as string | null) ?? null,
      filing_period: (d.filing_period as string | null) ?? null,
      due_date: d.due_date as string,
      is_overdue: Boolean(d.is_overdue),
    })),
    deadlinesTotal: deadlines.count ?? 0,
  };
}

/** Clients to add to a group: search by name, code, PAN or GSTIN (§7.4 "member clients (add/remove)"). */
export async function searchClientsForGroup(
  supabase: ServerSupabase,
  q: string,
  groupId: string | null,
): Promise<Array<{ id: string; client_code: string; display_name: string; group_name: string | null }>> {
  let query = supabase.from("clients_list").select("id, client_code, display_name, group_id, group_name").is("deleted_at", null);
  const search = orSafe(q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    query = query.or(`display_name.ilike.${like},client_code.ilike.${like},pan.ilike.${like},gstin.ilike.${like}`);
  }
  if (groupId) query = query.or(`group_id.is.null,group_id.neq.${groupId}`);
  const { data, error } = await query.order("display_name").limit(20);
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id as string,
    client_code: (c.client_code as string) ?? "",
    display_name: (c.display_name as string) ?? "",
    group_name: (c.group_name as string | null) ?? null,
  }));
}
