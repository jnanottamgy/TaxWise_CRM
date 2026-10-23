import "server-only";

import type { Enums, Tables } from "@/lib/database.types";
import type { AppRole } from "@/lib/auth/roles";
import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { checkAssignment, type AssignmentFinding } from "@/lib/domain/assignment";
import { workingDaysLeft } from "@/lib/domain/capacity";
import { TASK_STATUSES, type TaskStatus } from "@/lib/domain/enums";
import { addDays, type DateString } from "@/lib/domain/fy";
import { nextStatusOptions, type NextStatusOption } from "@/lib/domain/transitions";
import { getApprovedLeave, getWorkingCalendar } from "@/lib/data/capacity";
import { listStaffOptions, type StaffOption } from "@/lib/data/clients";
import { BUILT_IN_VIEWS, ME, NONE, OPEN_TASK_STATUSES, dueWindowRange, type DueWindow, type WorkFilter, type WorkSort } from "@/lib/schemas/tasks";

/**
 * Reads for the work tracker (§7.6): the list behind /work (table, board, calendar, review queue),
 * the task detail page, the form's options and the assignment check's facts. Everything runs under
 * the caller's RLS through `tasks_list` (0130), so an Employee only ever reads tasks assigned to
 * them, that they review, or of clients they can see (§4.1). No money is selected anywhere here.
 */

export type TaskStatusValue = Enums<"task_status">;

export type TaskListRow = {
  id: string;
  task_number: string;
  client_id: string;
  client_name: string | null;
  client_code: string | null;
  client_owner_employee_id: string | null;
  title: string;
  service_type: Enums<"service_type"> | null;
  financial_year: string | null;
  period_label: string | null;
  status: TaskStatusValue;
  priority: Enums<"task_priority">;
  due_date: string | null;
  completion_date: string | null;
  assigned_employee_id: string | null;
  assignee_name: string | null;
  reviewer_employee_id: string | null;
  reviewer_name: string | null;
  acceptance_status: Enums<"task_acceptance">;
  decline_reason: Enums<"decline_reason"> | null;
  declined_by_employee_id: string | null;
  declined_by_name: string | null;
  estimated_minutes: number | null;
  escalation_level: number;
  compliance_event_id: string | null;
  is_overdue: boolean;
  days_overdue: number;
  checklist_total: number;
  checklist_done: number;
  open_blockers: number;
  logged_minutes: number;
  created_by: string | null;
  updated_at: string;
};

const LIST_COLUMNS =
  "id, task_number, client_id, client_name, client_code, client_owner_employee_id, title, service_type, financial_year, period_label, status, priority, due_date, completion_date, assigned_employee_id, assignee_name, reviewer_employee_id, reviewer_name, acceptance_status, decline_reason, declined_by_employee_id, declined_by_name, estimated_minutes, escalation_level, compliance_event_id, is_overdue, days_overdue, checklist_total, checklist_done, open_blockers, logged_minutes, created_by, updated_at";

/** Who is looking: resolves "me" in the filters and scopes the review queue. */
export type WorkViewer = { employeeId: string | null; role: AppRole; today: DateString };

type ListRowDb = { [K in keyof TaskListRow]: TaskListRow[K] | null };

function mapRow(r: ListRowDb): TaskListRow {
  return {
    id: r.id ?? "",
    task_number: r.task_number ?? "",
    client_id: r.client_id ?? "",
    client_name: r.client_name,
    client_code: r.client_code,
    client_owner_employee_id: r.client_owner_employee_id,
    title: r.title ?? "",
    service_type: r.service_type,
    financial_year: r.financial_year,
    period_label: r.period_label,
    status: (r.status ?? "not_started") as TaskStatusValue,
    priority: (r.priority ?? "medium") as Enums<"task_priority">,
    due_date: r.due_date,
    completion_date: r.completion_date,
    assigned_employee_id: r.assigned_employee_id,
    assignee_name: r.assignee_name,
    reviewer_employee_id: r.reviewer_employee_id,
    reviewer_name: r.reviewer_name,
    acceptance_status: (r.acceptance_status ?? "pending") as Enums<"task_acceptance">,
    decline_reason: r.decline_reason,
    declined_by_employee_id: r.declined_by_employee_id,
    declined_by_name: r.declined_by_name,
    estimated_minutes: r.estimated_minutes,
    escalation_level: r.escalation_level ?? 0,
    compliance_event_id: r.compliance_event_id,
    is_overdue: Boolean(r.is_overdue),
    days_overdue: r.days_overdue ?? 0,
    checklist_total: r.checklist_total ?? 0,
    checklist_done: r.checklist_done ?? 0,
    open_blockers: r.open_blockers ?? 0,
    logged_minutes: r.logged_minutes ?? 0,
    created_by: r.created_by,
    updated_at: r.updated_at ?? "",
  };
}

// =================================================================================================
// Filters (§7.6.1)
// =================================================================================================

type FilterBuilder = {
  or(filters: string): FilterBuilder;
  in(column: string, values: readonly string[]): FilterBuilder;
  eq(column: string, value: unknown): FilterBuilder;
  neq(column: string, value: unknown): FilterBuilder;
  gt(column: string, value: unknown): FilterBuilder;
  gte(column: string, value: unknown): FilterBuilder;
  lt(column: string, value: unknown): FilterBuilder;
  lte(column: string, value: unknown): FilterBuilder;
  is(column: string, value: null | boolean): FilterBuilder;
  not(column: string, operator: string, value: unknown): FilterBuilder;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches no employee: "me" for someone without an employee record. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** An employee filter ("me", "none" and ids) as a PostgREST condition, or null for none. */
function peopleCondition(column: string, values: readonly string[], me: string | null): string | null {
  const ids = values.filter((v) => UUID.test(v));
  if (values.includes(ME)) ids.push(me ?? NOBODY);
  const parts: string[] = [];
  if (ids.length) parts.push(`${column}.in.(${[...new Set(ids)].join(",")})`);
  if (values.includes(NONE)) parts.push(`${column}.is.null`);
  return parts.length ? parts.join(",") : null;
}

export type WorkFilters = Partial<Record<WorkFilter, string[]>>;

function applyWorkFilters<Q extends FilterBuilder>(query: Q, q: string, f: WorkFilters, viewer: WorkViewer): Q {
  let out = query.is("deleted_at", null) as Q;
  const search = orSafe(q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    out = out.or(["title", "task_number", "client_name", "client_code", "period_label"].map((c) => `${c}.ilike.${like}`).join(",")) as Q;
  }
  if (f.status) out = out.in("status", f.status) as Q;
  if (f.assignee) {
    const cond = peopleCondition("assigned_employee_id", f.assignee, viewer.employeeId);
    if (cond) out = out.or(cond) as Q;
  }
  if (f.reviewer) {
    const cond = peopleCondition("reviewer_employee_id", f.reviewer, viewer.employeeId);
    if (cond) out = out.or(cond) as Q;
  }
  if (f.client) {
    const ids = f.client.filter((v) => UUID.test(v));
    if (ids.length) out = out.in("client_id", ids) as Q;
  }
  if (f.service) out = out.in("service_type", f.service) as Q;
  if (f.priority) out = out.in("priority", f.priority) as Q;
  if (f.due?.[0]) {
    const range = dueWindowRange(f.due[0] as DueWindow, viewer.today);
    if (range.kind === "overdue") out = out.eq("is_overdue", true) as Q;
    else if (range.kind === "none") out = out.is("due_date", null) as Q;
    else out = out.gte("due_date", range.from).lte("due_date", range.to) as Q;
  }
  if (f.acceptance) {
    // "Waiting for acceptance" means an assignee hasn't answered yet; an unassigned task is "Unassigned".
    const parts = f.acceptance.map((a) => (a === "pending" ? "and(acceptance_status.eq.pending,assigned_employee_id.not.is.null)" : `acceptance_status.eq.${a}`));
    out = out.or(parts.join(",")) as Q;
  }
  if (f.year?.[0]) out = out.eq("financial_year", f.year[0]) as Q;
  if (f.period?.[0]) out = out.eq("period_label", f.period[0]) as Q;
  if (f.blockers?.[0] === "yes") out = out.gt("open_blockers", 0) as Q;
  else if (f.blockers?.[0] === "no") out = out.eq("open_blockers", 0) as Q;
  return out;
}

const SORT_COLUMN: Record<WorkSort, string> = {
  task_number: "task_number",
  title: "title",
  client_name: "client_name",
  status: "status",
  priority: "priority",
  due_date: "due_date",
  assignee_name: "assignee_name",
  updated_at: "updated_at",
  created_at: "created_at",
};

// =================================================================================================
// Lists
// =================================================================================================

/** One page of the work tracker (§7.6.1 Table), searched, filtered, sorted and paged in SQL. */
export async function listTasks(
  supabase: ServerSupabase,
  t: TableParams<WorkSort, WorkFilter>,
  viewer: WorkViewer,
): Promise<{ rows: TaskListRow[]; total: number }> {
  let q = supabase.from("tasks_list").select(LIST_COLUMNS, { count: "exact" });
  q = applyWorkFilters(q as unknown as FilterBuilder, t.q, t.filters, viewer) as unknown as typeof q;
  const sort = t.sort ?? "due_date";
  q = q.order(SORT_COLUMN[sort], { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "due_date") q = q.order("due_date", { ascending: true, nullsFirst: false });
  q = q.order("task_number", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as unknown as ListRowDb[]).map(mapRow), total: count ?? 0 };
}

/** Tasks for a CSV export of the current view (§3.4), at most `max`. */
export async function listTasksForExport(
  supabase: ServerSupabase,
  t: Pick<TableParams<WorkSort, WorkFilter>, "q" | "filters" | "sort" | "dir">,
  viewer: WorkViewer,
  max = 5000,
): Promise<{ rows: TaskListRow[]; truncated: boolean }> {
  let q = supabase.from("tasks_list").select(LIST_COLUMNS);
  q = applyWorkFilters(q as unknown as FilterBuilder, t.q, t.filters, viewer) as unknown as typeof q;
  q = q.order(SORT_COLUMN[t.sort ?? "due_date"], { ascending: t.dir === "asc", nullsFirst: false }).order("task_number");
  const { data, error } = await q.range(0, max);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as ListRowDb[]).map(mapRow);
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

export const BOARD_COLUMN_LIMIT = 40;

/**
 * The board (§7.6.1): a column per status with the true count and the first BOARD_COLUMN_LIMIT
 * cards by due date. Filters apply except the status filter, which picks the columns shown.
 */
export async function listBoard(
  supabase: ServerSupabase,
  q: string,
  filters: WorkFilters,
  viewer: WorkViewer,
): Promise<{ columns: Array<{ status: TaskStatus; total: number; rows: TaskListRow[] }> }> {
  const { status, ...rest } = filters;
  const statuses = (status?.length ? TASK_STATUSES.filter((s) => status.includes(s)) : [...TASK_STATUSES]) as TaskStatus[];
  const columns = await Promise.all(
    statuses.map(async (s) => {
      let query = supabase.from("tasks_list").select(LIST_COLUMNS, { count: "exact" }).eq("status", s);
      query = applyWorkFilters(query as unknown as FilterBuilder, q, rest, viewer) as unknown as typeof query;
      // Filed work is shown newest first; open work by due date.
      if (s === "filed_done") query = query.order("completion_date", { ascending: false, nullsFirst: false });
      else query = query.order("due_date", { ascending: true, nullsFirst: false });
      const { data, error, count } = await query.order("task_number").range(0, BOARD_COLUMN_LIMIT - 1);
      if (error) throw error;
      return { status: s, total: count ?? 0, rows: ((data ?? []) as unknown as ListRowDb[]).map(mapRow) };
    }),
  );
  return { columns };
}

export const CALENDAR_LIMIT = 800;

/** Tasks due between two dates for the calendar (§7.6.1), filters applied, at most CALENDAR_LIMIT. */
export async function listCalendar(
  supabase: ServerSupabase,
  q: string,
  filters: WorkFilters,
  viewer: WorkViewer,
  from: DateString,
  to: DateString,
): Promise<{ rows: TaskListRow[]; truncated: boolean; undated: number }> {
  const { due, ...rest } = filters;
  void due; // the month decides the dates
  let query = supabase.from("tasks_list").select(LIST_COLUMNS).gte("due_date", from).lte("due_date", to);
  query = applyWorkFilters(query as unknown as FilterBuilder, q, rest, viewer) as unknown as typeof query;
  const undatedQuery = applyWorkFilters(
    supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("due_date", null).neq("status", "filed_done") as unknown as FilterBuilder,
    q,
    rest,
    viewer,
  ) as unknown as PromiseLike<{ count: number | null; error: unknown }>;
  const [{ data, error }, undated] = await Promise.all([query.order("due_date").order("priority", { ascending: false }).range(0, CALENDAR_LIMIT), undatedQuery]);
  if (error) throw error;
  if (undated.error) throw undated.error;
  const rows = ((data ?? []) as unknown as ListRowDb[]).map(mapRow);
  return { rows: rows.slice(0, CALENDAR_LIMIT), truncated: rows.length > CALENDAR_LIMIT, undated: undated.count ?? 0 };
}

/**
 * My review queue (§7.6.1): work submitted for review (Under review) that the viewer reviews: named
 * as its reviewer, or — for Partners and Managers — with no named reviewer (it goes to all
 * Managers, §7.6.4). Never the viewer's own work (nobody reviews their own).
 */
export async function listReviewQueue(
  supabase: ServerSupabase,
  t: TableParams<WorkSort, WorkFilter>,
  viewer: WorkViewer,
): Promise<{ rows: TaskListRow[]; total: number }> {
  const me = viewer.employeeId ?? NOBODY;
  let q = supabase.from("tasks_list").select(LIST_COLUMNS, { count: "exact" }).eq("status", "under_review");
  q = q.or(viewer.role === "partner" || viewer.role === "manager" ? `reviewer_employee_id.eq.${me},reviewer_employee_id.is.null` : `reviewer_employee_id.eq.${me}`);
  q = q.or(`assigned_employee_id.is.null,assigned_employee_id.neq.${me}`);
  q = applyWorkFilters(q as unknown as FilterBuilder, t.q, { ...t.filters, status: undefined }, viewer) as unknown as typeof q;
  q = q.order(SORT_COLUMN[t.sort ?? "due_date"], { ascending: t.dir === "asc", nullsFirst: false }).order("task_number");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as unknown as ListRowDb[]).map(mapRow), total: count ?? 0 };
}

export type WorkSummary = { open: number; overdue: number; dueThisWeek: number; dataAwaited: number; waiting: number; reviewQueue: number };

/**
 * The strip above the tracker: Partners and Managers see the firm, an Employee their own tasks. Each
 * figure links to the list behind it (§7.2 rule).
 */
export async function getWorkSummary(supabase: ServerSupabase, viewer: WorkViewer): Promise<WorkSummary> {
  const mine = viewer.role === "employee";
  const me = viewer.employeeId ?? NOBODY;
  const base = () => {
    let q = supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null);
    if (mine) q = q.eq("assigned_employee_id", me);
    return q;
  };
  const week = dueWindowRange("this_week", viewer.today);
  const weekFrom = week.kind === "range" ? week.from : viewer.today;
  const weekTo = week.kind === "range" ? week.to : viewer.today;
  const review =
    viewer.role === "partner" || viewer.role === "manager"
      ? supabase
          .from("tasks_list")
          .select("id", { count: "exact", head: true })
          .is("deleted_at", null)
          .eq("status", "under_review")
          .or(`reviewer_employee_id.eq.${me},reviewer_employee_id.is.null`)
          .or(`assigned_employee_id.is.null,assigned_employee_id.neq.${me}`)
      : supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "under_review").eq("reviewer_employee_id", me);
  const results = await Promise.all([
    base().in("status", OPEN_TASK_STATUSES as TaskStatus[]),
    base().eq("is_overdue", true),
    base().in("status", OPEN_TASK_STATUSES as TaskStatus[]).gte("due_date", weekFrom).lte("due_date", weekTo),
    base().eq("status", "data_awaited"),
    base().eq("acceptance_status", "pending").not("assigned_employee_id", "is", null),
    review,
  ]);
  for (const r of results) if (r.error) throw r.error;
  const [open, overdue, dueThisWeek, dataAwaited, waiting, reviewQueue] = results.map((r) => r.count ?? 0);
  return { open, overdue, dueThisWeek, dataAwaited, waiting, reviewQueue };
}

/** Open tasks of one client, for Client 360 → Tasks (§7.3.3). */
export async function listClientTasks(
  supabase: ServerSupabase,
  clientId: string,
  opts: { status: "open" | "filed" | "all"; page: number; pageSize: number },
): Promise<{ rows: TaskListRow[]; total: number; counts: { open: number; filed: number; overdue: number } }> {
  let q = supabase.from("tasks_list").select(LIST_COLUMNS, { count: "exact" }).eq("client_id", clientId).is("deleted_at", null);
  if (opts.status === "open") q = q.neq("status", "filed_done");
  else if (opts.status === "filed") q = q.eq("status", "filed_done");
  q = opts.status === "filed" ? q.order("completion_date", { ascending: false, nullsFirst: false }) : q.order("due_date", { ascending: true, nullsFirst: false });
  const from = (opts.page - 1) * opts.pageSize;
  const counts = (filter: (b: ReturnType<typeof base>) => ReturnType<typeof base>) => filter(base());
  const base = () => supabase.from("tasks_list").select("id", { count: "exact", head: true }).eq("client_id", clientId).is("deleted_at", null);
  const [list, open, filed, overdue] = await Promise.all([
    q.order("task_number").range(from, from + opts.pageSize - 1),
    counts((b) => b.neq("status", "filed_done")),
    counts((b) => b.eq("status", "filed_done")),
    counts((b) => b.eq("is_overdue", true)),
  ]);
  for (const r of [list, open, filed, overdue]) if (r.error) throw r.error;
  return {
    rows: ((list.data ?? []) as unknown as ListRowDb[]).map(mapRow),
    total: list.count ?? 0,
    counts: { open: open.count ?? 0, filed: filed.count ?? 0, overdue: overdue.count ?? 0 },
  };
}

// =================================================================================================
// Saved views (§7.6.1, §3.4)
// =================================================================================================

export type WorkViewOption = { id: string; name: string; query: string; shared: boolean; mine: boolean; builtIn: boolean };

/** The shipped views first, then the person's own and those shared firm-wide. */
export async function listWorkViews(supabase: ServerSupabase, userId: string): Promise<WorkViewOption[]> {
  const { data, error } = await supabase.from("saved_views").select("id, name, filters, is_shared, user_id").eq("page", "work").order("name").limit(100);
  if (error) throw error;
  const saved = (data ?? []).map((v) => {
    const f = v.filters as { query?: unknown } | null;
    return { id: v.id, name: v.name, query: typeof f?.query === "string" ? f.query : "", shared: v.is_shared, mine: v.user_id === userId, builtIn: false };
  });
  return [...BUILT_IN_VIEWS.map((v) => ({ ...v, shared: false, mine: false, builtIn: true })), ...saved];
}

// =================================================================================================
// Task detail (§7.6.6)
// =================================================================================================

export type TaskDetail = TaskListRow & {
  description: string | null;
  remarks: string | null;
  on_hold_reason: string | null;
  decline_note: string | null;
  declined_at: string | null;
  accepted_at: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  source_template_id: string | null;
  automation_id: string | null;
  filing_skipped_reason: string | null;
  escalated_at: string | null;
  created_at: string;
  deleted_at: string | null;
};

const DETAIL_COLUMNS = `${LIST_COLUMNS}, description, remarks, on_hold_reason, decline_note, declined_at, accepted_at, assigned_by, assigned_at, source_template_id, automation_id, filing_skipped_reason, escalated_at, created_at, deleted_at`;

export type ChecklistItem = Pick<Tables<"task_checklist_items">, "id" | "title" | "done" | "done_at" | "done_by" | "due_offset_days" | "sort_order" | "updated_at">;
export type TaskComment = { id: string; author_id: string; author_name: string | null; body: string; mentions: string[]; edited_at: string | null; created_at: string };
export type TaskAttachment = {
  id: string;
  document_id: string | null;
  title: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: string;
};
export type TaskDependency = {
  dependency_id: string;
  direction: "blocked_by" | "blocking";
  task_id: string;
  task_number: string;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  client_name: string | null;
  visible: boolean;
};
export type StatusHistoryRow = { id: string; from_status: TaskStatus | null; to_status: TaskStatus; reason: string | null; changed_by: string; changed_by_name: string | null; changed_at: string };
export type ActivityRow = { id: string; action: string; description: string; user_name: string | null; at: string };
export type TimeByPerson = { employee_id: string; name: string | null; minutes: number };
export type LinkedEvent = { id: string; title: string; form_code: string | null; filing_period: string | null; financial_year: string | null; due_date: string; workflow_status: Enums<"compliance_workflow">; status: Enums<"compliance_status"> };
export type FilingRecordRef = { id: string; filing_type: string; period: string | null; financial_year: string; filed_on: string | null; acknowledgement_no: string | null; document_id: string | null };

export type TaskDetailBundle = {
  task: TaskDetail;
  checklist: ChecklistItem[];
  comments: TaskComment[];
  attachments: TaskAttachment[];
  dependencies: TaskDependency[];
  history: StatusHistoryRow[];
  activity: ActivityRow[];
  timeByPerson: TimeByPerson[];
  event: LinkedEvent | null;
  filings: FilingRecordRef[];
  nextMoves: NextStatusOption[];
  templateName: string | null;
};

async function profileNames(supabase: ServerSupabase, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const { data, error } = await supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", unique);
  if (error) throw error;
  for (const r of data ?? []) if (r.profile_id && r.full_name) out.set(r.profile_id, r.full_name);
  return out;
}

/** The task as its detail page shows it, or null when it doesn't exist or isn't the viewer's to see. */
export async function getTaskDetail(supabase: ServerSupabase, id: string, viewer: WorkViewer): Promise<TaskDetailBundle | null> {
  const { data: row, error } = await supabase.from("tasks_list").select(DETAIL_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const task = { ...(mapRow(row as unknown as ListRowDb) as TaskListRow), ...(pickDetail(row as unknown as Record<string, unknown>)) } as TaskDetail;

  const [checklist, comments, attachments, deps, history, activity, time, filings, template] = await Promise.all([
    supabase.from("task_checklist_items").select("id, title, done, done_at, done_by, due_offset_days, sort_order, updated_at").eq("task_id", id).order("sort_order").order("created_at"),
    supabase.from("task_comments").select("id, author_id, body, mentions, edited_at, created_at").eq("task_id", id).is("deleted_at", null).order("created_at").limit(500),
    supabase.from("task_attachments").select("id, document_id, uploaded_by, created_at, documents(title, file_name, mime_type, file_size, deleted_at)").eq("task_id", id).order("created_at", { ascending: false }),
    supabase.rpc("task_dependency_list", { p_task_id: id }),
    supabase.from("task_status_history").select("id, from_status, to_status, reason, changed_by, changed_at").eq("task_id", id).order("changed_at", { ascending: false }).limit(100),
    supabase.from("activity_logs").select("id, action, description, user_name, at").eq("entity_type", "task").eq("entity_id", id).order("at", { ascending: false }).limit(50),
    supabase.from("time_entries").select("employee_id, minutes").eq("task_id", id).not("ended_at", "is", null).limit(5000),
    supabase.from("filing_records").select("id, filing_type, period, financial_year, filed_on, acknowledgement_no, document_id").eq("task_id", id).order("created_at", { ascending: false }),
    task.source_template_id ? supabase.from("job_templates").select("name").eq("id", task.source_template_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [checklist, comments, attachments, deps, history, activity, time, template]) if (r.error) throw r.error;
  // Filing records are client-owned: an Employee who can't see the client simply gets none.
  const filingRows = filings.error ? [] : (filings.data ?? []);

  let event: LinkedEvent | null = null;
  if (task.compliance_event_id) {
    const { data: e, error: eErr } = await supabase
      .from("compliance_events")
      .select("id, title, form_code, filing_period, financial_year, due_date, workflow_status, status")
      .eq("id", task.compliance_event_id)
      .maybeSingle();
    if (eErr) throw eErr;
    event = e ?? null;
  }

  const names = await profileNames(supabase, [
    ...(comments.data ?? []).map((c) => c.author_id),
    ...(history.data ?? []).map((h) => h.changed_by),
    ...(attachments.data ?? []).map((a) => a.uploaded_by ?? ""),
  ]);

  // Time logged by person (the viewer's RLS: Partners/Managers see everyone's, an Employee their own;
  // the total on the task comes from tasks_list and counts everyone).
  const byPerson = new Map<string, number>();
  for (const t of time.data ?? []) byPerson.set(t.employee_id, (byPerson.get(t.employee_id) ?? 0) + t.minutes);
  const people = byPerson.size
    ? await supabase.from("employee_directory").select("id, full_name").in("id", [...byPerson.keys()])
    : { data: [] as Array<{ id: string | null; full_name: string | null }>, error: null };
  if (people.error) throw people.error;
  const personName = new Map((people.data ?? []).map((p) => [p.id ?? "", p.full_name]));

  const blockers = ((deps.data ?? []) as TaskDependency[]).filter((d) => d.direction === "blocked_by");
  const nextMoves = nextStatusOptions({
    from: task.status,
    actorRole: viewer.role,
    actorEmployeeId: viewer.employeeId,
    assigneeEmployeeId: task.assigned_employee_id,
    acceptance: task.acceptance_status,
    declinedByEmployeeId: task.declined_by_employee_id,
    blockers: blockers.map((b) => ({ id: b.task_id, title: b.title, status: b.status })),
  });

  return {
    task,
    checklist: (checklist.data ?? []) as ChecklistItem[],
    comments: (comments.data ?? []).map((c) => ({ ...c, mentions: c.mentions ?? [], author_name: names.get(c.author_id) ?? null })),
    attachments: (attachments.data ?? [])
      .map((a) => {
        const d = a.documents as { title: string; file_name: string; mime_type: string; file_size: number; deleted_at: string | null } | null;
        return {
          id: a.id,
          document_id: d && !d.deleted_at ? a.document_id : null,
          title: d?.title ?? null,
          file_name: d?.file_name ?? null,
          mime_type: d?.mime_type ?? null,
          file_size: d?.file_size ?? null,
          uploaded_by: a.uploaded_by,
          uploaded_by_name: a.uploaded_by ? (names.get(a.uploaded_by) ?? null) : null,
          created_at: a.created_at,
        };
      }),
    dependencies: (deps.data ?? []) as TaskDependency[],
    history: (history.data ?? []).map((h) => ({ ...h, changed_by_name: names.get(h.changed_by) ?? null })) as StatusHistoryRow[],
    activity: (activity.data ?? []) as ActivityRow[],
    timeByPerson: [...byPerson.entries()].map(([employee_id, minutes]) => ({ employee_id, minutes, name: personName.get(employee_id) ?? null })).sort((a, b) => b.minutes - a.minutes),
    event,
    filings: filingRows as FilingRecordRef[],
    nextMoves,
    templateName: (template.data as { name: string } | null)?.name ?? null,
  };
}

function pickDetail(r: Record<string, unknown>) {
  const s = (k: string) => (r[k] as string | null) ?? null;
  return {
    description: s("description"),
    remarks: s("remarks"),
    on_hold_reason: s("on_hold_reason"),
    decline_note: s("decline_note"),
    declined_at: s("declined_at"),
    accepted_at: s("accepted_at"),
    assigned_by: s("assigned_by"),
    assigned_at: s("assigned_at"),
    source_template_id: s("source_template_id"),
    automation_id: s("automation_id"),
    filing_skipped_reason: s("filing_skipped_reason"),
    escalated_at: s("escalated_at"),
    created_at: s("created_at") ?? "",
    deleted_at: s("deleted_at"),
  };
}

/** The row for the edit form (with its updated_at for optimistic concurrency, §13). */
export async function getTaskForEdit(supabase: ServerSupabase, id: string) {
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, client_id, title, description, service_type, financial_year, period_label, due_date, priority, estimated_minutes, assigned_employee_id, reviewer_employee_id, remarks, compliance_event_id, updated_at, deleted_at, status",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data && !data.deleted_at ? data : null;
}

// =================================================================================================
// Form options and pickers
// =================================================================================================

export type TemplateOption = { id: string; name: string; service_type: Enums<"service_type">; default_lead_days: number | null; steps: number };

export async function listTemplateOptions(supabase: ServerSupabase): Promise<TemplateOption[]> {
  const { data, error } = await supabase
    .from("job_templates")
    .select("id, name, service_type, default_lead_days, job_template_items(count)")
    .eq("is_active", true)
    .order("name")
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((t) => ({
    id: t.id,
    name: String(t.name),
    service_type: t.service_type,
    default_lead_days: t.default_lead_days,
    steps: (t.job_template_items as unknown as Array<{ count: number }> | null)?.[0]?.count ?? 0,
  }));
}

export type TaskFormOptions = { staff: StaffOption[]; reviewers: StaffOption[]; templates: TemplateOption[] };

/** Who can be assigned (active staff) and who can review (Partners and Managers: only they file or send back). */
export async function getTaskFormOptions(supabase: ServerSupabase, role: AppRole): Promise<TaskFormOptions> {
  const [staff, templates] = await Promise.all([listStaffOptions(supabase, role), listTemplateOptions(supabase)]);
  return { staff, reviewers: staff.filter((s) => s.role === "partner" || s.role === "manager"), templates };
}

export type ClientOption = { value: string; label: string; description?: string };

/** Clients the viewer can see, for pickers (RLS decides). */
export async function searchClientOptions(supabase: ServerSupabase, q: string, limit = 20): Promise<ClientOption[]> {
  let query = supabase.from("clients").select("id, display_name, client_code").is("deleted_at", null).neq("status", "inactive");
  const s = orSafe(q);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    query = query.or(`display_name.ilike.${like},client_code.ilike.${like},legal_name.ilike.${like}`);
  }
  const { data, error } = await query.order("display_name").limit(limit);
  if (error) throw error;
  return (data ?? []).map((c) => ({ value: c.id, label: c.display_name, description: String(c.client_code) }));
}

export async function getClientOption(supabase: ServerSupabase, id: string): Promise<ClientOption | null> {
  const { data, error } = await supabase.from("clients").select("id, display_name, client_code").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? { value: data.id, label: data.display_name, description: String(data.client_code) } : null;
}

export type TaskOption = { value: string; label: string; description?: string };

/** Tasks for the blocked-by and time-entry pickers: open ones first, the viewer's RLS. */
export async function searchTaskOptions(
  supabase: ServerSupabase,
  q: string,
  opts: { clientId?: string | null; excludeId?: string | null; openOnly?: boolean; limit?: number } = {},
): Promise<TaskOption[]> {
  let query = supabase.from("tasks_list").select("id, task_number, title, client_name, status, due_date").is("deleted_at", null);
  if (opts.clientId) query = query.eq("client_id", opts.clientId);
  if (opts.excludeId) query = query.neq("id", opts.excludeId);
  if (opts.openOnly) query = query.neq("status", "filed_done");
  const s = orSafe(q);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    query = query.or(`title.ilike.${like},task_number.ilike.${like},client_name.ilike.${like}`);
  }
  const { data, error } = await query.order("due_date", { ascending: true, nullsFirst: false }).limit(opts.limit ?? 20);
  if (error) throw error;
  return (data ?? []).map((t) => ({
    value: t.id ?? "",
    label: `${t.task_number} · ${t.title}`,
    description: [t.client_name, t.status === "filed_done" ? "Filed" : null].filter(Boolean).join(" · ") || undefined,
  }));
}

export type DeadlineOption = { value: string; label: string; description?: string; form_code: string | null; filing_period: string | null; financial_year: string | null };

/** The client's open compliance deadlines (§7.6.5: the filing capture marks the linked one Filed). */
export async function listClientDeadlines(supabase: ServerSupabase, clientId: string, today: DateString): Promise<DeadlineOption[]> {
  const { data, error } = await supabase
    .from("compliance_events")
    .select("id, title, form_code, filing_period, financial_year, due_date, task_id")
    .eq("client_id", clientId)
    .eq("status", "pending")
    .gte("due_date", addDays(today, -120))
    .order("due_date")
    .limit(60);
  if (error) throw error;
  return (data ?? []).map((e) => ({
    value: e.id,
    label: e.title,
    description: [e.due_date, e.task_id ? "has a task" : null].filter(Boolean).join(" · "),
    form_code: e.form_code,
    filing_period: e.filing_period,
    financial_year: e.financial_year,
  }));
}

// =================================================================================================
// The assignment check's facts (§7.6.2)
// =================================================================================================

export type AssignmentCheckInput = {
  taskId: string | null;
  clientId: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  dueDate: DateString | null;
};

/**
 * Runs checkAssignment (lib/domain/assignment.ts) with real data: the assignee's account, their
 * approved leave, their open tasks due between today and the due date (this one included), the
 * working days left (working weekdays and holidays from Settings, less their leave), the firm's
 * capacity bands, and whether they own, are on the team of, or cover the client (§4.7).
 */
export async function runAssignmentCheck(supabase: ServerSupabase, input: AssignmentCheckInput, today: DateString): Promise<AssignmentFinding[]> {
  if (!input.assigneeId) return [];
  const until = input.dueDate && input.dueDate >= today ? input.dueDate : today;
  const [emp, calendar, leaveMap, openTasks, team] = await Promise.all([
    supabase.from("employees").select("id, full_name, is_active, deleted_at, profiles(is_active)").eq("id", input.assigneeId).maybeSingle(),
    getWorkingCalendar(supabase, today, until),
    getApprovedLeave(supabase, [input.assigneeId], today, input.dueDate && input.dueDate > until ? input.dueDate : until),
    input.dueDate
      ? (() => {
          let q = supabase
            .from("tasks")
            .select("id", { count: "exact", head: true })
            .eq("assigned_employee_id", input.assigneeId)
            .is("deleted_at", null)
            .neq("status", "filed_done")
            .lte("due_date", input.dueDate);
          if (input.taskId) q = q.neq("id", input.taskId);
          return q;
        })()
      : Promise.resolve({ count: 0, error: null }),
    input.clientId ? onClientTeam(supabase, input.clientId, input.assigneeId) : Promise.resolve(null),
  ]);
  if (emp.error) throw emp.error;
  if (openTasks.error) throw openTasks.error;
  const e = emp.data;
  const profileActive = (e?.profiles as { is_active: boolean } | null)?.is_active ?? true;
  const leaves = leaveMap.get(input.assigneeId) ?? [];
  const days = input.dueDate ? workingDaysLeft(today, input.dueDate, { weekdays: calendar.weekdays, holidays: calendar.holidays, leaves }) : 0;
  return checkAssignment({
    assigneeId: input.assigneeId,
    assignee: { name: e?.full_name ?? null, isActive: Boolean(e && e.is_active && !e.deleted_at && profileActive), leaves },
    reviewerId: input.reviewerId,
    dueDate: input.dueDate,
    openTasksInWindow: (openTasks.count ?? 0) + 1,
    workingDaysLeft: days,
    capacityBands: calendar.thresholds,
    today,
    onClientTeam: team,
  });
}

/** Owner, on the engagement team, or holding a cover in force for the client (§4.7). */
async function onClientTeam(supabase: ServerSupabase, clientId: string, employeeId: string): Promise<boolean> {
  const [client, team, covers] = await Promise.all([
    supabase.from("clients").select("owner_employee_id").eq("id", clientId).maybeSingle(),
    supabase.from("client_team_members").select("employee_id").eq("client_id", clientId),
    supabase.from("covers_in_force").select("kind, client_id, absent_employee_id").eq("cover_employee_id", employeeId),
  ]);
  if (client.error) throw client.error;
  if (team.error) throw team.error;
  if (covers.error) throw covers.error;
  const owner = client.data?.owner_employee_id ?? null;
  const members = (team.data ?? []).map((t) => t.employee_id);
  if (owner === employeeId || members.includes(employeeId)) return true;
  return (covers.data ?? []).some(
    (c) => (c.kind === "client" && c.client_id === clientId) || (c.kind === "person" && c.absent_employee_id !== null && (c.absent_employee_id === owner || members.includes(c.absent_employee_id))),
  );
}

// =================================================================================================
// "Ask client for data" (§7.6.6, §7.6.4 Data awaited)
// =================================================================================================

export type AskClientContext = {
  clientName: string;
  clientCode: string;
  client: { phone: string | null; whatsapp: string | null; email: string | null } | null;
  contact: { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null } | null;
};

/** The client's numbers and primary contact for the hand-off, when the viewer can see the client. */
export async function getAskClientContext(supabase: ServerSupabase, clientId: string): Promise<AskClientContext | null> {
  const [client, contacts] = await Promise.all([
    supabase.from("clients").select("display_name, client_code, phone, whatsapp, email").eq("id", clientId).maybeSingle(),
    supabase.from("client_contacts").select("id, name, email, phone, whatsapp, is_primary").eq("client_id", clientId).order("is_primary", { ascending: false }).order("created_at").limit(1),
  ]);
  if (client.error) throw client.error;
  if (contacts.error) throw contacts.error;
  if (!client.data) return null;
  const c = contacts.data?.[0];
  return {
    clientName: client.data.display_name,
    clientCode: String(client.data.client_code),
    client: { phone: client.data.phone, whatsapp: client.data.whatsapp, email: client.data.email },
    contact: c ? { id: c.id, name: c.name, email: c.email, phone: c.phone, whatsapp: c.whatsapp } : null,
  };
}

/** Unlinked UDINs of the client, for the filing dialog (§7.6.5 "Link a UDIN"). Partners/Managers. */
export async function listUnlinkedUdins(supabase: ServerSupabase, clientId: string): Promise<Array<{ id: string; udin: string; document_type: string; document_date: string }>> {
  const { data, error } = await supabase
    .from("udin_records")
    .select("id, udin, document_type, document_date")
    .eq("client_id", clientId)
    .is("filing_record_id", null)
    .order("document_date", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((u) => ({ id: u.id, udin: String(u.udin), document_type: u.document_type, document_date: u.document_date }));
}

/** Filing records already made for the deadline or the task (§7.6.5: re-filing uses the one recorded). */
export async function listExistingFilings(supabase: ServerSupabase, taskId: string, eventId: string | null): Promise<FilingRecordRef[]> {
  let q = supabase.from("filing_records").select("id, filing_type, period, financial_year, filed_on, acknowledgement_no, document_id");
  q = eventId ? q.or(`task_id.eq.${taskId},compliance_event_id.eq.${eventId}`) : q.eq("task_id", taskId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(10);
  if (error) throw error;
  return (data ?? []) as FilingRecordRef[];
}
