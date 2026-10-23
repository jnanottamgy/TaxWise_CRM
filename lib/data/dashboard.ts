import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import type { Enums } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { TableParams } from "@/components/app/data-table/params";
import { fetchAll } from "@/server/compliance/engine";
import { addDays, endOfMonth, fyEnd, fyStart, isWorkingDay, istDayBounds, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { presenceStatus } from "@/lib/domain/presence";
import { COVER_DEFAULTS } from "@/lib/domain/cover";
import { toPaise, sumPaise, type Paise } from "@/lib/domain/money";
import { CAPACITY_BANDS, type CapacityAssessment } from "@/lib/domain/capacity";
import { ceilingWarning, peerReviewStatus, resolveCeilingParams, udinStatus, CEILING_PARAM_KEYS, type CeilingWarning, type PeerReviewState } from "@/lib/domain/ceiling";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import type { ComplianceStatus, ComplianceType, ComplianceWorkflow } from "@/lib/domain/enums";
import type { StaffRole } from "@/lib/schemas/people";
import {
  ASSEMBLY_NEAR_DAYS,
  EXPIRY_WINDOW_DAYS,
  attendanceSoFar,
  conversionRate,
  countMissing,
  invoicedVsCollected,
  latestEntryInto,
  latestSendBacks,
  weekHours,
  type AttendanceSoFar,
  type MonthFigures,
  type SetupFacts,
  type StatusChange,
  type WeekHours,
} from "@/lib/domain/dashboard";
import { OPEN_TASK_STATUSES } from "@/lib/schemas/tasks";
import { weekStartOf } from "@/lib/schemas/timesheet";
import { listReviewQueue, type TaskListRow, type WorkViewer } from "@/lib/data/tasks";
import type { WorkFilter, WorkSort } from "@/lib/schemas/tasks";
import { getWeek } from "@/lib/data/timesheet";
import { getLeaveSummary, listLeave, listPendingForApprover, type LeaveRow, type LeaveSummary } from "@/lib/data/leave";
import { getNamesByProfile, getTeamCounts, listActiveStaff } from "@/lib/data/people";
import { getCapacityFor, getWorkingCalendar } from "@/lib/data/capacity";
import { getPrimaryContacts } from "@/lib/data/clients";

/**
 * Reads for the home pages (§7.2): My day (every staff member's own day; the Employee's landing
 * page), Team today (Managers) and Firm today (Partners). Everything runs under the caller's RLS;
 * the pages wrap each call on its own so one failed block never blanks the page (§0.1 rule 3).
 *
 * Money (§4.1): only the Team today and Firm today loaders touch invoices, receipts, quotations or
 * leads, and both pages are Partner/Manager only (the payments figures Partner only, §4.1 table).
 * Nothing in the My day loaders selects a fee, an invoice or a quotation.
 *
 * Totals are summed from the rows (in paise) with every page read (PostgREST answers at most 1,000
 * rows a request), never from a capped list.
 */

const LIST_COLUMNS =
  "id, task_number, client_id, client_name, client_code, client_owner_employee_id, title, service_type, financial_year, period_label, status, priority, due_date, completion_date, assigned_employee_id, assignee_name, reviewer_employee_id, reviewer_name, acceptance_status, decline_reason, declined_by_employee_id, declined_by_name, estimated_minutes, escalation_level, compliance_event_id, is_overdue, days_overdue, checklist_total, checklist_done, open_blockers, logged_minutes, created_by, updated_at";

export type Counted<T> = { rows: T[]; total: number };

/** Matches no employee: a viewer without an employee record. */
const NOBODY = "00000000-0000-0000-0000-000000000000";
const OPEN = OPEN_TASK_STATUSES as Array<Enums<"task_status">>;

type TaskRowDb = { [K in keyof TaskListRow]: TaskListRow[K] | null };

function toTaskRow(r: TaskRowDb): TaskListRow {
  return {
    ...(r as TaskListRow),
    id: r.id ?? "",
    task_number: r.task_number ?? "",
    client_id: r.client_id ?? "",
    title: r.title ?? "",
    status: (r.status ?? "not_started") as TaskListRow["status"],
    priority: (r.priority ?? "medium") as TaskListRow["priority"],
    acceptance_status: (r.acceptance_status ?? "pending") as TaskListRow["acceptance_status"],
    escalation_level: r.escalation_level ?? 0,
    is_overdue: Boolean(r.is_overdue),
    days_overdue: r.days_overdue ?? 0,
    checklist_total: r.checklist_total ?? 0,
    checklist_done: r.checklist_done ?? 0,
    open_blockers: r.open_blockers ?? 0,
    logged_minutes: r.logged_minutes ?? 0,
    updated_at: r.updated_at ?? "",
  };
}

function tasks(supabase: ServerSupabase, opts: { count?: boolean } = {}) {
  return supabase.from("tasks_list").select(LIST_COLUMNS, opts.count === false ? undefined : { count: "exact" }).is("deleted_at", null);
}

async function counted(query: PromiseLike<{ data: unknown; error: unknown; count: number | null }>): Promise<Counted<TaskListRow>> {
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: ((data ?? []) as TaskRowDb[]).map(toTaskRow), total: count ?? 0 };
}

async function headCount(query: PromiseLike<{ error: unknown; count: number | null }>): Promise<number> {
  const { error, count } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** The first rows of the viewer's review queue (the same rule as /work?view=review). */
async function reviewQueue(supabase: ServerSupabase, viewer: WorkViewer, limit: number): Promise<Counted<TaskListRow>> {
  const t: TableParams<WorkSort, WorkFilter> = { page: 1, pageSize: 25, sort: "due_date", dir: "asc", q: "", filters: {}, from: 0, to: limit - 1 };
  return listReviewQueue(supabase, t, viewer);
}

// =================================================================================================
// Deadlines (My day, Team today, Firm today)
// =================================================================================================

export type DeadlineRow = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  client_code: string | null;
  owner_employee_id: string | null;
  type: ComplianceType;
  form_code: string | null;
  rule_code: string | null;
  title: string;
  filing_period: string | null;
  due_date: DateString;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  task_id: string | null;
};

type EventDb = Omit<DeadlineRow, "client_name" | "client_code" | "owner_employee_id"> & {
  clients: { display_name: string; client_code: string; owner_employee_id: string | null; deleted_at: string | null } | null;
};

/**
 * Deadlines due between `from` and `to` (inclusive), filed or not, cancelled ones and deleted
 * clients' left out, soonest first. `ownerEmployeeId` keeps only the clients that person owns
 * (My day for a Partner or Manager); an Employee's RLS already limits them to their own clients.
 */
export async function loadDeadlines(supabase: ServerSupabase, from: DateString, to: DateString, opts: { ownerEmployeeId?: string | null } = {}): Promise<DeadlineRow[]> {
  const columns = "id, client_id, type, form_code, rule_code, title, filing_period, due_date, status, workflow_status, task_id";
  const rows = await fetchAll<EventDb>((a, b) => {
    const q = opts.ownerEmployeeId
      ? supabase
          .from("compliance_events")
          .select(`${columns}, clients!inner(display_name, client_code, owner_employee_id, deleted_at)`)
          .eq("clients.owner_employee_id", opts.ownerEmployeeId)
      : supabase.from("compliance_events").select(`${columns}, clients(display_name, client_code, owner_employee_id, deleted_at)`);
    return q.neq("status", "cancelled").gte("due_date", from).lte("due_date", to).order("due_date").order("id").range(a, b) as unknown as PromiseLike<{ data: EventDb[] | null; error: unknown }>;
  });
  return rows
    .filter((r) => !r.clients?.deleted_at)
    .map(({ clients, ...e }) => ({ ...e, client_name: clients?.display_name ?? null, client_code: clients?.client_code ?? null, owner_employee_id: clients?.owner_employee_id ?? null }));
}

/** Monday to Sunday of the week holding `today` (the work tracker's "This week"). */
export function weekWindow(today: DateString): { from: DateString; to: DateString } {
  const from = weekStartOf(today);
  return { from, to: addDays(from, 6) };
}

// =================================================================================================
// My day (§7.2 Employee)
// =================================================================================================

export type SentBackRow = TaskListRow & { sentBackAt: string; reason: string | null; sentBackBy: string | null };

export type MyTaskQueues = {
  /** Assigned to me and waiting for my Accept / Decline. */
  waiting: Counted<TaskListRow>;
  /** Mine, accepted, due today or overdue. */
  dueNow: Counted<TaskListRow> & { overdue: number; today: number };
  /** Mine, sent back by a reviewer (the latest move was Under review → In progress). */
  sentBack: Counted<SentBackRow>;
  /** Waiting for my review. */
  review: Counted<TaskListRow>;
};

export async function getMyTaskQueues(supabase: ServerSupabase, viewer: WorkViewer, limit = 6): Promise<MyTaskQueues> {
  const me = viewer.employeeId ?? NOBODY;
  const mine = () => tasks(supabase).eq("assigned_employee_id", me).in("status", OPEN);
  const [waiting, dueNow, overdue, today, inProgress, review] = await Promise.all([
    counted(mine().eq("acceptance_status", "pending").order("due_date", { ascending: true, nullsFirst: false }).order("task_number").limit(limit)),
    counted(
      mine()
        .neq("acceptance_status", "pending")
        .or(`is_overdue.eq.true,due_date.eq.${viewer.today}`)
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("priority", { ascending: false })
        .order("task_number")
        .limit(limit),
    ),
    headCount(supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("assigned_employee_id", me).neq("acceptance_status", "pending").eq("is_overdue", true)),
    headCount(
      supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("assigned_employee_id", me).neq("acceptance_status", "pending").in("status", OPEN).eq("due_date", viewer.today),
    ),
    // Sent back = in progress again after a review: read the moves of my in-progress tasks.
    fetchAll<TaskRowDb>((a, b) => tasks(supabase, { count: false }).eq("assigned_employee_id", me).eq("status", "in_progress").order("id").range(a, b) as unknown as PromiseLike<{ data: TaskRowDb[] | null; error: unknown }>, 2000),
    reviewQueue(supabase, viewer, limit),
  ]);

  const candidates = inProgress.map(toTaskRow);
  const history = await loadHistory(supabase, candidates.map((t) => t.id));
  const sends = latestSendBacks(history);
  const reviewers = await getNamesByProfile(supabase, [...sends.values()].map((s) => s.by));
  const sentBackAll: SentBackRow[] = candidates
    .filter((t) => sends.has(t.id))
    .map((t) => {
      const s = sends.get(t.id)!;
      return { ...t, sentBackAt: s.at, reason: s.reason, sentBackBy: s.by ? (reviewers.get(s.by) ?? null) : null };
    })
    .sort((a, b) => (a.sentBackAt < b.sentBackAt ? 1 : a.sentBackAt > b.sentBackAt ? -1 : 0));

  return {
    waiting,
    dueNow: { ...dueNow, overdue, today },
    sentBack: { rows: sentBackAll.slice(0, limit), total: sentBackAll.length },
    review,
  };
}

/** Status changes of these tasks (RLS: the tasks the viewer can see), read in chunks of 100 ids. */
async function loadHistory(supabase: ServerSupabase, taskIds: readonly string[], toStatus?: Enums<"task_status">): Promise<StatusChange[]> {
  const out: StatusChange[] = [];
  for (let i = 0; i < taskIds.length; i += 100) {
    const ids = taskIds.slice(i, i + 100);
    const rows = await fetchAll<{ task_id: string; from_status: string | null; to_status: string; reason: string | null; changed_at: string; changed_by: string | null }>((a, b) => {
      let q = supabase.from("task_status_history").select("task_id, from_status, to_status, reason, changed_at, changed_by").in("task_id", ids);
      if (toStatus) q = q.eq("to_status", toStatus);
      return q.order("changed_at", { ascending: false }).order("id").range(a, b);
    }, 20_000);
    for (const r of rows) out.push({ taskId: r.task_id, from: r.from_status, to: r.to_status, reason: r.reason, at: r.changed_at, by: r.changed_by });
  }
  return out;
}

export type MyWeek = WeekHours & { monday: DateString };

/** This week's logged time against the target, from the same figures the timesheet shows (§7.10). */
export async function getMyWeekHours(supabase: ServerSupabase, employeeId: string, today: DateString): Promise<MyWeek> {
  const monday = weekStartOf(today);
  const week = await getWeek(supabase, employeeId, monday);
  return { monday, ...weekHours(week.dates, week.targets, week.grid.dayTotals, today) };
}

export type MyLeave = { summary: LeaveSummary; upcoming: Counted<LeaveRow> };

/** The person's leave this FY and what is coming up (requested or approved). */
export async function getMyLeave(supabase: ServerSupabase, employeeId: string, today: DateString, fy: FinancialYear, limit = 3): Promise<MyLeave> {
  const t: TableParams<"start_date" | "created_at" | "status", "status" | "type" | "person" | "when"> = {
    page: 1,
    pageSize: 25,
    sort: "start_date",
    dir: "asc",
    q: "",
    filters: { when: ["upcoming"], status: ["requested", "approved"] },
    from: 0,
    to: limit - 1,
  };
  const [summary, upcoming] = await Promise.all([getLeaveSummary(supabase, employeeId, fy, today), listLeave(supabase, t, today, { employeeId })]);
  return { summary, upcoming };
}

export type UnreadMessageRow = { id: string; client_id: string; client_name: string; channel: Enums<"message_channel">; subject: string | null; snippet: string; created_at: string };

type MessageDb = { id: string; client_id: string; channel: Enums<"message_channel">; subject: string | null; body: string; created_at: string; clients: { display_name: string } | null };

/**
 * Unread messages from clients (portal and email, inbound, not yet read) for the clients the person
 * handles: an Employee's own clients (RLS: owner, team or cover; never money-side messages, 0043);
 * for a Partner or Manager, the clients they own.
 */
export async function getUnreadClientMessages(supabase: ServerSupabase, user: Pick<CurrentUser, "role" | "employeeId">, limit = 5): Promise<Counted<UnreadMessageRow>> {
  let q = supabase
    .from("messages")
    .select("id, client_id, channel, subject, body, created_at, clients!inner(display_name, owner_employee_id, deleted_at)", { count: "exact" })
    .eq("direction", "inbound")
    .is("read_at", null)
    .in("channel", ["portal", "email"])
    .is("clients.deleted_at", null);
  if (user.role !== "employee") q = q.eq("clients.owner_employee_id", user.employeeId ?? NOBODY);
  const { data, error, count } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as unknown as MessageDb[];
  return {
    total: count ?? 0,
    rows: rows.map((m) => ({
      id: m.id,
      client_id: m.client_id,
      client_name: m.clients?.display_name ?? "",
      channel: m.channel,
      subject: m.subject,
      snippet: snippet(m.body),
      created_at: m.created_at,
    })),
  };
}

function snippet(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// =================================================================================================
// Team today (§7.2 Manager)
// =================================================================================================

export type TeamQueues = {
  unassigned: Counted<TaskListRow>;
  waiting: Counted<TaskListRow>;
  declined: Counted<TaskListRow>;
  review: Counted<TaskListRow>;
  dataAwaited: number;
  overdue: number;
};

/** The work queues a Manager clears first; each count matches the /work list it links to. */
export async function getTeamQueues(supabase: ServerSupabase, viewer: WorkViewer, limit = 5): Promise<TeamQueues> {
  const open = () => tasks(supabase).in("status", OPEN);
  const byDue = <Q extends { order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => Q }>(q: Q) => q.order("due_date", { ascending: true, nullsFirst: false }).order("task_number");
  const head = () => supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null);
  const [unassigned, waiting, declined, review, dataAwaited, overdue] = await Promise.all([
    counted(byDue(open().is("assigned_employee_id", null)).limit(limit)),
    counted(byDue(open().eq("acceptance_status", "pending").not("assigned_employee_id", "is", null)).limit(limit)),
    counted(byDue(open().eq("acceptance_status", "declined").is("assigned_employee_id", null)).limit(limit)),
    reviewQueue(supabase, viewer, limit),
    headCount(head().eq("status", "data_awaited")),
    headCount(head().eq("is_overdue", true)),
  ]);
  return { unassigned, waiting, declined, review, dataAwaited, overdue };
}

export type CallListRow = {
  task: TaskListRow;
  /** When the task last moved to Data awaited (null when it was created there). */
  since: string | null;
  contact: { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null } | null;
  client: { phone: string | null; whatsapp: string | null; email: string | null } | null;
  /** Open checklist items: what is still needed from the client. */
  missing: string[];
};

/** Data awaited (§7.2 Manager): the call list, soonest due first, with who to call and what is missing. */
export async function getDataAwaitedCallList(supabase: ServerSupabase, limit = 6): Promise<Counted<CallListRow>> {
  const list = await counted(
    tasks(supabase).eq("status", "data_awaited").order("due_date", { ascending: true, nullsFirst: false }).order("task_number").limit(limit),
  );
  if (list.rows.length === 0) return { rows: [], total: list.total };
  const taskIds = list.rows.map((t) => t.id);
  const clientIds = [...new Set(list.rows.map((t) => t.client_id))];
  const [history, contacts, clients, items] = await Promise.all([
    loadHistory(supabase, taskIds, "data_awaited"),
    getPrimaryContacts(supabase, clientIds),
    supabase.from("clients").select("id, phone, whatsapp, email").in("id", clientIds),
    supabase.from("task_checklist_items").select("task_id, title, sort_order").in("task_id", taskIds).eq("done", false).order("sort_order").limit(500),
  ]);
  if (clients.error) throw clients.error;
  if (items.error) throw items.error;
  const since = latestEntryInto(history, "data_awaited");
  const byClient = new Map((clients.data ?? []).map((c) => [c.id, { phone: c.phone, whatsapp: c.whatsapp, email: c.email }]));
  const missing = new Map<string, string[]>();
  for (const i of items.data ?? []) missing.set(i.task_id, [...(missing.get(i.task_id) ?? []), i.title]);
  return {
    total: list.total,
    rows: list.rows.map((task) => ({
      task,
      since: since.get(task.id)?.at ?? null,
      contact: contacts.get(task.client_id) ?? null,
      client: byClient.get(task.client_id) ?? null,
      missing: missing.get(task.id) ?? [],
    })),
  };
}

export type OverdueTaskRef = { client_id: string; client_name: string | null; assigned_employee_id: string | null; assignee_name: string | null };

/** Every overdue task's client and assignee (for "overdue by person" and "at-risk clients"). */
export async function loadOverdueTasks(supabase: ServerSupabase): Promise<OverdueTaskRef[]> {
  return fetchAll<OverdueTaskRef>((a, b) =>
    supabase
      .from("tasks_list")
      .select("client_id, client_name, assigned_employee_id, assignee_name")
      .is("deleted_at", null)
      .eq("is_overdue", true)
      .order("id")
      .range(a, b) as unknown as PromiseLike<{ data: OverdueTaskRef[] | null; error: unknown }>,
  );
}

export type CapacityRow = { id: string; name: string; designation: string | null; role: StaffRole; capacity: CapacityAssessment };

/** Capacity per active person (§7.11.4), the most loaded first. */
export async function getTeamCapacity(supabase: ServerSupabase, today: DateString): Promise<CapacityRow[]> {
  const people = await listActiveStaff(supabase);
  const capacity = await getCapacityFor(supabase, people.map((p) => p.id), today);
  const rank = (b: CapacityAssessment) => CAPACITY_BANDS.indexOf(b.band);
  return people
    .map((p) => ({ id: p.id, name: p.full_name, designation: p.designation, role: p.role, capacity: capacity.get(p.id)! }))
    .filter((r) => r.capacity)
    .sort((a, b) => rank(b.capacity) - rank(a.capacity) || (b.capacity.perDay ?? 0) - (a.capacity.perDay ?? 0) || a.name.localeCompare(b.name));
}

export type AttendanceSnapshot = AttendanceSoFar & { onlineNow: number };

/**
 * Attendance today (§7.2 Manager): present, late, on leave and absent so far (from today's sign-ins,
 * the same rules as the 11:30 job), and who is online now. People with a login only.
 */
export async function getAttendanceSnapshot(supabase: ServerSupabase, today: DateString, now: Date = new Date()): Promise<AttendanceSnapshot> {
  const { start } = istDayBounds(today);
  const [calendar, people, sessions, leave] = await Promise.all([
    getWorkingCalendar(supabase, today, today),
    supabase.from("people_overview").select("id, open_session_active_at").eq("login_status", "active").limit(2000),
    supabase.from("employee_sessions").select("employee_id, login_at, last_active_at, active_minutes").gte("login_at", start.toISOString()).limit(20000),
    supabase.from("employee_leave").select("employee_id").eq("status", "approved").lte("start_date", today).gte("end_date", today).limit(2000),
  ]);
  for (const r of [people, sessions, leave]) if (r.error) throw r.error;
  const rows = (people.data ?? []).filter((p): p is typeof p & { id: string } => Boolean(p.id));
  const soFar = attendanceSoFar({
    people: rows,
    sessions: (sessions.data ?? []).map((x) => ({ employeeId: x.employee_id, loginAt: x.login_at, lastActiveAt: x.last_active_at, activeMinutes: x.active_minutes })),
    onLeave: new Set((leave.data ?? []).map((l) => l.employee_id)),
    params: calendar.attendance,
    isWorkingDay: isWorkingDay(today, { weekdays: calendar.weekdays, holidays: calendar.holidays }),
    noShowAfterMinutes: COVER_DEFAULTS.noShowAfterMinutes,
    today,
    now,
  });
  const onlineNow = rows.filter((p) => presenceStatus(p.open_session_active_at, now) === "online").length;
  return { ...soFar, onlineNow };
}

export type QuotationRef = { id: string; quotation_number: string; client_name: string; total: number; sent_at: string | null; status: Enums<"quotation_status"> };
export type LeadRef = { id: string; name: string; company: string | null; status: Enums<"lead_status">; last_activity_at: string | null; created_at: string };

export type SalesSnapshot = {
  invoicesThisMonth: { count: number; totalPaise: Paise };
  quotationsAwaiting: Counted<QuotationRef> & { valuePaise: Paise };
  staleLeads: Counted<LeadRef>;
};

/** Days without activity before an open lead surfaces on the Manager dashboard (§7.4). */
export const STALE_LEAD_DAYS = 14;

/**
 * Invoices raised this month, quotations awaiting the client's response, and open leads untouched
 * for 14 days (§7.2 Manager, §7.4). Partners and Managers only (RLS refuses everyone else).
 */
export async function getSalesSnapshot(supabase: ServerSupabase, today: DateString, now: Date = new Date(), limit = 4): Promise<SalesSnapshot> {
  const monthStart = `${today.slice(0, 7)}-01`;
  const staleBefore = new Date(now.getTime() - STALE_LEAD_DAYS * 86_400_000).toISOString();
  const [invoices, quotations, quotationTotals, leads] = await Promise.all([
    fetchAll<{ total_amount: number | null }>((a, b) =>
      supabase
        .from("invoices")
        .select("total_amount")
        .is("deleted_at", null)
        .is("cancelled_at", null)
        .neq("status", "draft")
        .gte("issue_date", monthStart)
        .lte("issue_date", endOfMonth(monthStart))
        .order("id")
        .range(a, b),
    ),
    supabase
      .from("quotations")
      .select("id, quotation_number, client_name, client_company, total, sent_at, status", { count: "exact" })
      .is("deleted_at", null)
      .in("status", ["sent", "viewed"])
      .order("sent_at", { ascending: true, nullsFirst: false })
      .limit(limit),
    fetchAll<{ total: number }>((a, b) => supabase.from("quotations").select("total").is("deleted_at", null).in("status", ["sent", "viewed"]).order("id").range(a, b)),
    supabase
      .from("leads")
      .select("id, name, company, status, last_activity_at, created_at", { count: "exact" })
      .is("deleted_at", null)
      .not("status", "in", "(won,lost)")
      .or(`last_activity_at.lt.${staleBefore},and(last_activity_at.is.null,created_at.lt.${staleBefore})`)
      .order("last_activity_at", { ascending: true, nullsFirst: true })
      .limit(limit),
  ]);
  if (quotations.error) throw quotations.error;
  if (leads.error) throw leads.error;
  return {
    invoicesThisMonth: { count: invoices.length, totalPaise: sumPaise(invoices.map((i) => toPaise(i.total_amount ?? 0))) },
    quotationsAwaiting: {
      total: quotations.count ?? 0,
      valuePaise: sumPaise(quotationTotals.map((q) => toPaise(q.total))),
      rows: (quotations.data ?? []).map((q) => ({
        id: q.id,
        quotation_number: q.quotation_number,
        client_name: q.client_company || q.client_name,
        total: q.total,
        sent_at: q.sent_at,
        status: q.status,
      })),
    },
    staleLeads: {
      total: leads.count ?? 0,
      rows: (leads.data ?? []).map((l) => ({ id: l.id, name: l.name, company: l.company, status: l.status, last_activity_at: l.last_activity_at, created_at: l.created_at })),
    },
  };
}

// =================================================================================================
// Firm today (§7.2 Partner)
// =================================================================================================

/** The facts behind the Partner's setup checklist (§7.2), all read under the Partner's RLS. */
export async function getSetupFacts(supabase: ServerSupabase): Promise<SetupFacts> {
  const [settings, partners, numbers, staff, clients, invoices] = await Promise.all([
    supabase.from("firm_settings").select("logo_path, bank_account_number, bank_ifsc, upi_id, icai_frn, domain_status, law_last_reviewed_at").eq("id", 1).maybeSingle(),
    supabase.from("profiles").select("icai_membership_no").eq("role", "partner").eq("is_active", true).limit(100),
    headCount(supabase.from("firm_whatsapp_numbers").select("id", { count: "exact", head: true }).eq("is_active", true)),
    headCount(supabase.from("employees").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("is_active", true)),
    // Onboarded through the wizard or brought in by import: either way the firm has its first client.
    headCount(supabase.from("clients").select("id", { count: "exact", head: true }).is("deleted_at", null)),
    headCount(supabase.from("invoices").select("id", { count: "exact", head: true }).is("deleted_at", null).not("invoice_number", "is", null)),
  ]);
  if (settings.error) throw settings.error;
  if (partners.error) throw partners.error;
  const s = settings.data;
  const partnerRows = partners.data ?? [];
  return {
    hasLogo: Boolean(s?.logo_path),
    hasBankAndUpi: Boolean(s?.bank_account_number && s?.bank_ifsc && s?.upi_id),
    hasFrnAndMembership: Boolean(s?.icai_frn) && partnerRows.length > 0 && partnerRows.every((p) => Boolean(p.icai_membership_no?.trim())),
    emailDomainVerified: s?.domain_status === "verified",
    hasWhatsAppNumbers: numbers > 0,
    // The first Partner is on the team from setup; the checklist wants someone else added.
    teamAdded: staff > 1,
    firstClientOnboarded: clients > 0,
    firstInvoiceIssued: invoices > 0,
    lawReviewed: Boolean(s?.law_last_reviewed_at),
  };
}

export type PracticeCounts = { activeClients: number; filingsDueIn7: number; overdueTasks: number; onlineNow: number };

/** The work half of the Partner's KPI strip. */
export async function getPracticeCounts(supabase: ServerSupabase, today: DateString): Promise<PracticeCounts> {
  const [activeClients, due, overdueTasks, team] = await Promise.all([
    headCount(supabase.from("clients").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "active")),
    loadDeadlines(supabase, today, addDays(today, 7)),
    headCount(supabase.from("tasks_list").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("is_overdue", true)),
    getTeamCounts(supabase),
  ]);
  return { activeClients, filingsDueIn7: due.filter((d) => d.status === "pending").length, overdueTasks, onlineNow: team.onlineNow };
}

export type ReceivableRow = { id: string; client_id: string; client_name: string; issue_date: DateString; due_date: DateString | null; outstandingPaise: Paise; isOverdue: boolean };

export type MoneyPicture = {
  /** Every invoice with a balance (Sent, Partially paid or Disputed; not cancelled or deleted). Overdue is the view's derived flag. */
  receivables: ReceivableRow[];
  /** Invoiced (by invoice date, incl. GST) and collected (received + TDS, by payment date) per FY month. */
  byMonth: MonthFigures[];
  invoicedFyPaise: Paise;
  collectedMonthPaise: Paise;
  /** The TDS part of this month's collections. */
  tdsMonthPaise: Paise;
  unbilledPaise: Paise;
  unbilledMinutes: number;
};

/**
 * The money half of Firm today (§7.2; §4.1: the payments dashboard is the Partner's): receivables,
 * the FY's invoiced and collected by month, and unbilled time. Every figure is summed in paise.
 */
export async function getMoneyPicture(supabase: ServerSupabase, today: DateString, fy: FinancialYear): Promise<MoneyPicture> {
  const from = fyStart(fy);
  const to = fyEnd(fy);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [open, issued, receipts, unbilled] = await Promise.all([
    fetchAll<{ id: string | null; client_id: string | null; client_name_snapshot: string | null; issue_date: string | null; due_date: string | null; outstanding_amount: number | null; is_overdue: boolean | null }>((a, b) =>
      supabase
        .from("invoices_view")
        .select("id, client_id, client_name_snapshot, issue_date, due_date, outstanding_amount, is_overdue")
        .is("deleted_at", null)
        .is("cancelled_at", null)
        .in("status", ["sent", "partially_paid", "disputed"])
        .gt("outstanding_amount", 0)
        .order("id")
        .range(a, b),
    ),
    fetchAll<{ issue_date: string; total_amount: number }>((a, b) =>
      supabase
        .from("invoices")
        .select("issue_date, total_amount")
        .is("deleted_at", null)
        .is("cancelled_at", null)
        .not("status", "in", "(draft,awaiting_approval)")
        .gte("issue_date", from)
        .lte("issue_date", to)
        .order("id")
        .range(a, b),
    ),
    fetchAll<{ payment_date: string; amount_received: number; tds_amount: number }>((a, b) =>
      supabase.from("payment_receipts").select("payment_date, amount_received, tds_amount").is("reversed_at", null).gte("payment_date", from).lte("payment_date", to).order("id").range(a, b),
    ),
    fetchAll<{ amount: number | null; minutes: number | null }>((a, b) => supabase.from("unbilled_time_by_client").select("amount, minutes").order("client_id").range(a, b)),
  ]);

  const receivables: ReceivableRow[] = open
    .filter((r) => r.id && r.client_id && r.issue_date)
    .map((r) => ({
      id: r.id!,
      client_id: r.client_id!,
      client_name: r.client_name_snapshot ?? "",
      issue_date: r.issue_date!,
      due_date: r.due_date,
      outstandingPaise: toPaise(r.outstanding_amount ?? 0),
      isOverdue: Boolean(r.is_overdue),
    }));
  const collected = receipts.map((r) => ({ paymentDate: r.payment_date, amountPaise: toPaise(r.amount_received) + toPaise(r.tds_amount), tdsPaise: toPaise(r.tds_amount) }));
  const byMonth = invoicedVsCollected(
    fy,
    issued.map((i) => ({ issueDate: i.issue_date, totalPaise: toPaise(i.total_amount) })),
    collected,
  );
  const thisMonth = collected.filter((c) => c.paymentDate >= monthStart && c.paymentDate <= today);
  return {
    receivables,
    byMonth,
    invoicedFyPaise: sumPaise(byMonth.map((m) => m.invoicedPaise)),
    collectedMonthPaise: sumPaise(thisMonth.map((c) => c.amountPaise)),
    tdsMonthPaise: sumPaise(thisMonth.map((c) => c.tdsPaise)),
    unbilledPaise: sumPaise(unbilled.map((u) => toPaise(u.amount ?? 0))),
    unbilledMinutes: unbilled.reduce((m, u) => m + (u.minutes ?? 0), 0),
  };
}

export type Approvals = {
  invoices: number;
  quotations: number;
  leave: Counted<LeaveRow>;
  dataRequests: { total: number; nextDue: DateString | null };
};

/** Statuses that close a DPDP data request; anything else is still open (§6.10). */
const CLOSED_DATA_REQUEST = "(closed,completed,resolved,rejected,withdrawn)";

/** What waits for the Partner's decision (§7.2 Approvals). */
export async function getApprovals(supabase: ServerSupabase, user: CurrentUser, limit = 4): Promise<Approvals> {
  const [invoices, quotations, leave, requests, nextRequest] = await Promise.all([
    headCount(supabase.from("invoices").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "awaiting_approval")),
    headCount(supabase.from("quotations").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "pending_approval")),
    listPendingForApprover(supabase, user, 200),
    headCount(supabase.from("data_requests").select("id", { count: "exact", head: true }).not("status", "in", CLOSED_DATA_REQUEST)),
    supabase.from("data_requests").select("due_by").not("status", "in", CLOSED_DATA_REQUEST).not("due_by", "is", null).order("due_by").limit(1).maybeSingle(),
  ]);
  if (nextRequest.error) throw nextRequest.error;
  return {
    invoices,
    quotations,
    leave: { rows: leave.slice(0, limit), total: leave.length },
    dataRequests: { total: requests, nextDue: nextRequest.data?.due_by ?? null },
  };
}

export type PracticeHealth = {
  udin: Counted<{ id: string; client_name: string; report_date: DateString; daysLeft: number | null; daysLate: number | null }>;
  taxAudits: Array<{ memberId: string; name: string; total: number; ceiling: number; warning: CeilingWarning | null }>;
  engagementLetters: { expiring: number; missing: number };
  dscExpiring: { count: number; next: DateString | null };
  registrationsExpiring: { count: number; next: DateString | null };
  peerReview: { state: PeerReviewState; validUntil: DateString | null; daysLeft: number | null };
  assembly: Counted<{ id: string; client_name: string; due: DateString }>;
  whatsapp: { activeClients: number; withoutGroup: number; numbers: Array<{ id: string; label: string; links: number; limit: number | null; atLimit: boolean; overLimit: boolean }> };
};

type AuditDb = { id: string; report_date: string | null; file_assembly_due: string | null; clients: { display_name: string } | null };

/**
 * Practice health (§7.2 Partner; §6.8, §6.9, §7.15, §7.25.7): signed reports without a UDIN, each
 * Partner's tax audits against the ceiling, engagement letters expiring or missing, DSCs and
 * registrations expiring in 30 days, peer review validity, audit files near their SA 230 assembly
 * date, and WhatsApp coverage. The rules come from lib/domain/ceiling.ts with the parameters in force.
 */
export async function getPracticeHealth(supabase: ServerSupabase, today: DateString, fy: FinancialYear, limit = 4): Promise<PracticeHealth> {
  const soon = addDays(today, EXPIRY_WINDOW_DAYS);
  const [params, unsigned, ceilings, partners, expiringLetters, services, letters, dsc, registrations, peer, assembly, activeClients, groups, numbers] = await Promise.all([
    supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", Object.values(CEILING_PARAM_KEYS)),
    supabase
      .from("audit_engagements")
      .select("id, report_date, file_assembly_due, clients(display_name)", { count: "exact" })
      .not("report_date", "is", null)
      .is("udin_record_id", null)
      .is("archived_at", null)
      .order("report_date")
      .limit(limit),
    supabase.from("tax_audit_ceiling_view").select("member_profile_id, member_name, total_count, ceiling, warning").eq("financial_year", fy),
    supabase.from("profiles").select("id, full_name").eq("role", "partner").eq("is_active", true).order("full_name").limit(100),
    headCount(supabase.from("engagement_letters").select("id", { count: "exact", head: true }).eq("status", "signed").gte("expires_at", today).lte("expires_at", soon)),
    fetchAll<{ client_id: string; clients: { status: string; deleted_at: string | null } | null }>((a, b) =>
      supabase.from("client_services").select("client_id, clients!inner(status, deleted_at)").eq("is_active", true).eq("clients.status", "active").is("clients.deleted_at", null).order("id").range(a, b) as unknown as PromiseLike<{
        data: Array<{ client_id: string; clients: { status: string; deleted_at: string | null } | null }> | null;
        error: unknown;
      }>,
    ),
    fetchAll<{ client_id: string }>((a, b) => supabase.from("engagement_letters").select("client_id").eq("financial_year", fy).in("status", ["issued", "signed"]).order("id").range(a, b)),
    supabase.from("dsc_records").select("expiry_date", { count: "exact" }).eq("status", "active").gte("expiry_date", today).lte("expiry_date", soon).order("expiry_date").limit(1),
    supabase.from("statutory_registrations").select("expiry_date", { count: "exact" }).eq("status", "active").gte("expiry_date", today).lte("expiry_date", soon).order("expiry_date").limit(1),
    supabase.from("peer_reviews").select("valid_until").eq("status", "completed").not("valid_until", "is", null).order("valid_until", { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from("audit_engagements")
      .select("id, report_date, file_assembly_due, clients(display_name)", { count: "exact" })
      .is("archived_at", null)
      .not("file_assembly_due", "is", null)
      .lte("file_assembly_due", addDays(today, ASSEMBLY_NEAR_DAYS))
      .order("file_assembly_due")
      .limit(limit),
    fetchAll<{ id: string }>((a, b) => supabase.from("clients").select("id").is("deleted_at", null).eq("status", "active").order("id").range(a, b)),
    fetchAll<{ client_id: string }>((a, b) => supabase.from("client_whatsapp_groups_public").select("client_id").eq("status", "active").is("deleted_at", null).order("id").range(a, b) as unknown as PromiseLike<{ data: Array<{ client_id: string }> | null; error: unknown }>),
    supabase.from("whatsapp_links_per_number").select("number_id, label, active_links, device_limit, at_limit, over_limit, is_active").eq("is_active", true).order("label"),
  ]);
  for (const r of [params, unsigned, ceilings, partners, dsc, registrations, peer, assembly, numbers]) if (r.error) throw r.error;

  const paramRows: StatutoryParameterRow[] = (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  const ceiling = resolveCeilingParams(paramRows, fyStart(fy)).params;
  const counts = new Map((ceilings.data ?? []).map((c) => [c.member_profile_id, c]));
  const auditRows = (unsigned.data ?? []) as unknown as AuditDb[];
  const assemblyRows = (assembly.data ?? []) as unknown as AuditDb[];

  return {
    udin: {
      total: unsigned.count ?? 0,
      rows: auditRows.map((a) => {
        const s = udinStatus({ signedOn: a.report_date!, generatedOn: null, today }, ceiling);
        return { id: a.id, client_name: a.clients?.display_name ?? "", report_date: a.report_date!, daysLeft: s.daysLeft, daysLate: s.daysLate };
      }),
    },
    taxAudits: (partners.data ?? []).map((p) => {
      const c = counts.get(p.id);
      const total = c?.total_count ?? 0;
      return { memberId: p.id, name: p.full_name, total, ceiling: c?.ceiling ?? ceiling.taxAuditCeiling, warning: ceilingWarning(total, ceiling) };
    }),
    engagementLetters: { expiring: expiringLetters, missing: countMissing(services.map((s) => s.client_id), letters.map((l) => l.client_id)) },
    dscExpiring: { count: dsc.count ?? 0, next: dsc.data?.[0]?.expiry_date ?? null },
    registrationsExpiring: { count: registrations.count ?? 0, next: registrations.data?.[0]?.expiry_date ?? null },
    peerReview: { ...peerReviewStatus(peer.data?.valid_until ?? null, today, ceiling), validUntil: peer.data?.valid_until ?? null },
    assembly: { total: assembly.count ?? 0, rows: assemblyRows.map((a) => ({ id: a.id, client_name: a.clients?.display_name ?? "", due: a.file_assembly_due! })) },
    whatsapp: {
      activeClients: activeClients.length,
      withoutGroup: countMissing(
        activeClients.map((c) => c.id),
        groups.map((g) => g.client_id),
      ),
      numbers: (numbers.data ?? []).map((n) => ({
        id: n.number_id ?? "",
        label: n.label ?? "",
        links: n.active_links ?? 0,
        limit: n.device_limit,
        atLimit: Boolean(n.at_limit),
        overLimit: Boolean(n.over_limit),
      })),
    },
  };
}

export type Pipeline = { openLeads: number; quotationsSent: { count: number; valuePaise: Paise }; conversion: { accepted: number; decided: number; percent: number | null } };

/** Pipeline (§7.2 Partner): open leads, quotations out with the client and their value, and this FY's conversion rate. */
export async function getPipeline(supabase: ServerSupabase, fy: FinancialYear): Promise<Pipeline> {
  const [openLeads, sent, decided] = await Promise.all([
    headCount(supabase.from("leads").select("id", { count: "exact", head: true }).is("deleted_at", null).not("status", "in", "(won,lost)")),
    fetchAll<{ total: number }>((a, b) => supabase.from("quotations").select("total").is("deleted_at", null).in("status", ["sent", "viewed"]).order("id").range(a, b)),
    fetchAll<{ status: Enums<"quotation_status"> }>((a, b) =>
      supabase.from("quotations").select("status").is("deleted_at", null).in("status", ["accepted", "rejected", "expired"]).gte("issue_date", fyStart(fy)).lte("issue_date", fyEnd(fy)).order("id").range(a, b),
    ),
  ]);
  const tally = { accepted: 0, rejected: 0, expired: 0 };
  for (const q of decided) tally[q.status as keyof typeof tally]++;
  return {
    openLeads,
    quotationsSent: { count: sent.length, valuePaise: sumPaise(sent.map((q) => toPaise(q.total))) },
    conversion: { accepted: tally.accepted, decided: decided.length, percent: conversionRate(tally) },
  };
}

export type ActivityItem = { id: string; description: string; user_name: string | null; at: string; entity_type: string; entity_id: string };

/** The latest entries of the firm's activity log (§7.2 Partner "recent activity"). */
export async function getRecentActivity(supabase: ServerSupabase, limit = 6): Promise<ActivityItem[]> {
  const { data, error } = await supabase.from("activity_logs").select("id, description, user_name, at, entity_type, entity_id").order("at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}
