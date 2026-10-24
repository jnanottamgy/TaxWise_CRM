import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import type { Enums, Json } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { TableParams } from "@/components/app/data-table/params";
import { fetchAll } from "@/server/compliance/engine";
import { addDays, isWorkingDay, istDayBounds, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { presenceStatus, PRESENCE_DEFAULTS } from "@/lib/domain/presence";
import { COVER_DEFAULTS } from "@/lib/domain/cover";
import { toPaise, type Paise } from "@/lib/domain/money";
import { CAPACITY_BANDS, type CapacityAssessment } from "@/lib/domain/capacity";
import { peerReviewStatus, type CeilingWarning, type PeerReviewState } from "@/lib/domain/ceiling";
import type { ComplianceStatus, ComplianceType, ComplianceWorkflow } from "@/lib/domain/enums";
import type { StaffRole } from "@/lib/schemas/people";
import {
  AT_RISK_OVERDUE_TASKS,
  AT_RISK_RECEIVABLE_DAYS,
  ageingFromBuckets,
  atRiskFromCounts,
  attendanceSoFar,
  conversionRate,
  fyMonthRows,
  latestEntryInto,
  weekHours,
  type AgeingRow,
  type AtRiskClient,
  type AttendanceSoFar,
  type DomainStatus,
  type FyMonthRow,
  type PersonCount,
  type SetupDetail,
  type StatusChange,
  type WeekHours,
} from "@/lib/domain/dashboard";
import { weekStartOf } from "@/lib/schemas/timesheet";
import type { TaskListRow } from "@/lib/data/tasks";
import { getWeek } from "@/lib/data/timesheet";
import { getLeaveSummary, listLeave, listPendingForApprover, type LeaveRow, type LeaveSummary } from "@/lib/data/leave";
import { listActiveStaff } from "@/lib/data/people";
import { getCapacityFor, getWorkingCalendar } from "@/lib/data/capacity";
import { getPrimaryContacts } from "@/lib/data/clients";
import { getCeilingPanel, getDscSummary, getRegistrationSummary, listReportsWithoutUdin } from "@/lib/data/registers";
import { getLetterSummary } from "@/lib/data/engagement-letters";
import { getAuditParams, getAuditSummary } from "@/lib/data/audits";
import { listPeerReviews } from "@/lib/data/quality";
import { getLinksPerNumber, getRegisterSummary } from "@/lib/data/whatsapp";
import { getNoticeAlerts, type NoticeAlerts } from "@/lib/data/notices";

/**
 * Reads for the home pages (§7.2): My day (every staff member's own day; the Employee's landing
 * page), Team today (Managers) and Firm today (Partners). Everything runs under the caller's RLS;
 * the pages wrap each call on its own so one failed block never blanks the page (§0.1 rule 3).
 *
 * The figures and queues come from one database call per page (0216 dashboard_firm_today, 0217
 * dashboard_team_today, 0218 dashboard_my_day): counts and sums are worked out in SQL, amounts
 * arrive as decimal strings and become paise here. Practice health reads each register through its
 * own module's function (registers, engagement letters, audits, quality, WhatsApp, notices), so the
 * dashboard and the register page it links to never disagree.
 *
 * Money (§4.1): only the Firm today and Team today readers touch invoices, receipts, quotations or
 * leads; the database refuses both to anyone but Partners (Firm today) and Partners and Managers
 * (Team today). Nothing in the My day readers selects a fee, an invoice or a quotation.
 */

export type Counted<T> = { rows: T[]; total: number };

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

// -------------------------------------------------------------------------------------------------
// Reading the database's JSON (shapes in 0215–0218)
// -------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const paise = (v: unknown): Paise => (typeof v === "string" || typeof v === "number" ? toPaise(v) : 0);
const paiseOrNull = (v: unknown): Paise | null => (v === null || v === undefined ? null : paise(v));

function taskBlock(v: unknown): Counted<TaskListRow> {
  const o = obj(v);
  return { total: int(o.total), rows: arr(o.rows).map((r) => toTaskRow(r as TaskRowDb)) };
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

export type DeadlineWindow = Counted<DeadlineRow> & { from: DateString; to: DateString };

function deadlineBlock(v: unknown, fallback: { from: DateString; to: DateString }): DeadlineWindow {
  const o = obj(v);
  return { from: str(o.from) ?? fallback.from, to: str(o.to) ?? fallback.to, total: int(o.total), rows: arr(o.rows) as DeadlineRow[] };
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

export type MyDayData =
  | { linked: false }
  | {
      linked: true;
      /** Assigned to me and waiting for my Accept / Decline. */
      waiting: Counted<TaskListRow>;
      /** Mine, accepted, due today or overdue. */
      dueNow: Counted<TaskListRow> & { overdue: number; today: number };
      /** Mine, sent back by a reviewer (the latest move was Under review → In progress). */
      sentBack: Counted<SentBackRow>;
      /** Waiting for my review. */
      review: Counted<TaskListRow>;
      /** My clients' deadlines in the window, not yet filed. */
      deadlines: DeadlineWindow;
    };

/** My day's queues and my clients' deadlines in one call (0218). */
export async function getMyDay(supabase: ServerSupabase, today: DateString, opts: { rows?: number; deadlineDays?: number } = {}): Promise<MyDayData> {
  const deadlineDays = opts.deadlineDays ?? 14;
  const { data, error } = await supabase.rpc("dashboard_my_day", { p_today: today, p_rows: opts.rows ?? 6, p_deadline_days: deadlineDays });
  if (error) throw error;
  const r = obj(data);
  if (r.linked !== true) return { linked: false };
  const due = obj(r.due_now);
  const back = obj(r.sent_back);
  const meta = new Map(arr(back.meta).map((m) => [String(obj(m).task_id), obj(m)]));
  return {
    linked: true,
    waiting: taskBlock(r.waiting),
    dueNow: { ...taskBlock(r.due_now), overdue: int(due.overdue), today: int(due.today) },
    sentBack: {
      total: int(back.total),
      rows: taskBlock(back).rows.map((t) => {
        const m = meta.get(t.id) ?? {};
        return { ...t, sentBackAt: str(m.at) ?? t.updated_at, reason: str(m.reason), sentBackBy: str(m.by_name) };
      }),
    },
    review: taskBlock(r.review),
    deadlines: deadlineBlock(r.deadlines, { from: today, to: addDays(today, deadlineDays) }),
  };
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

/** Matches no employee: a viewer without an employee record. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

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

/** Notices assigned to me with a reply overdue or due within 7 days (§7.8.4 "overdue replies are red on the dashboard"). */
export async function getMyNoticeReplies(supabase: ServerSupabase, employeeId: string, today: DateString): Promise<NoticeAlerts> {
  return getNoticeAlerts(supabase, { today, assignedTo: employeeId, limit: 3 });
}

// =================================================================================================
// Team today (§7.2 Manager)
// =================================================================================================

export type QuotationRef = { id: string; quotation_number: string; client_name: string; totalPaise: Paise; sent_at: string | null; status: Enums<"quotation_status"> };
export type LeadRef = { id: string; name: string; company: string | null; status: Enums<"lead_status">; last_activity_at: string | null; created_at: string };

export type SalesSnapshot = {
  /** Issued (numbered) this month, incl. GST; and those still waiting for a Partner's approval. */
  invoicesThisMonth: { count: number; totalPaise: Paise; awaitingApproval: number };
  quotationsAwaiting: Counted<QuotationRef> & { valuePaise: Paise };
  staleLeads: Counted<LeadRef>;
};

export type TeamToday = {
  monthStart: DateString;
  monthEnd: DateString;
  unassigned: Counted<TaskListRow>;
  waiting: Counted<TaskListRow>;
  declined: Counted<TaskListRow>;
  review: Counted<TaskListRow>;
  dataAwaited: number;
  overdue: number;
  /** Overdue tasks by assignee, most first; unassigned work last (employeeId null). */
  overdueByPerson: PersonCount[];
  week: DeadlineWindow;
  sales: SalesSnapshot;
};

/** Days without activity before an open lead surfaces on the Manager dashboard (§7.4). */
export const STALE_LEAD_DAYS = 14;

/** Team today's queues, overdue work by person, this week's deadlines and the sales strip, in one call (0217). */
export async function getTeamToday(supabase: ServerSupabase, today: DateString, opts: { rows?: number; salesRows?: number } = {}): Promise<TeamToday> {
  const { data, error } = await supabase.rpc("dashboard_team_today", { p_today: today, p_rows: opts.rows ?? 4, p_stale_days: STALE_LEAD_DAYS, p_sales_rows: opts.salesRows ?? 4 });
  if (error) throw error;
  const r = obj(data);
  const sales = obj(r.sales);
  return {
    monthStart: str(r.month_start) ?? `${today.slice(0, 7)}-01`,
    monthEnd: str(r.month_end) ?? today,
    unassigned: taskBlock(r.unassigned),
    waiting: taskBlock(r.waiting),
    declined: taskBlock(r.declined),
    review: taskBlock(r.review),
    dataAwaited: int(r.data_awaited),
    overdue: int(r.overdue),
    overdueByPerson: arr(r.overdue_by_person).map((p) => {
      const o = obj(p);
      return { employeeId: str(o.employee_id), name: str(o.name) ?? "", count: int(o.count) };
    }),
    week: deadlineBlock(r.week, weekWindow(today)),
    sales: {
      invoicesThisMonth: { count: int(sales.invoices_month), totalPaise: paise(sales.invoices_month_total), awaitingApproval: int(sales.invoices_awaiting) },
      quotationsAwaiting: {
        total: int(sales.quotations_awaiting),
        valuePaise: paise(sales.quotations_awaiting_value),
        rows: arr(sales.quotation_rows).map((q) => {
          const o = obj(q);
          return {
            id: String(o.id),
            quotation_number: str(o.quotation_number) ?? "",
            client_name: str(o.client_name) ?? "",
            totalPaise: paise(o.total),
            sent_at: str(o.sent_at),
            status: (str(o.status) ?? "sent") as Enums<"quotation_status">,
          };
        }),
      },
      staleLeads: {
        total: int(sales.stale_leads),
        rows: arr(sales.stale_rows).map((l) => {
          const o = obj(l);
          return {
            id: String(o.id),
            name: str(o.name) ?? "",
            company: str(o.company),
            status: (str(o.status) ?? "new_lead") as Enums<"lead_status">,
            last_activity_at: str(o.last_activity_at),
            created_at: str(o.created_at) ?? "",
          };
        }),
      },
    },
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

const LIST_COLUMNS =
  "id, task_number, client_id, client_name, client_code, client_owner_employee_id, title, service_type, financial_year, period_label, status, priority, due_date, completion_date, assigned_employee_id, assignee_name, reviewer_employee_id, reviewer_name, acceptance_status, decline_reason, declined_by_employee_id, declined_by_name, estimated_minutes, escalation_level, compliance_event_id, is_overdue, days_overdue, checklist_total, checklist_done, open_blockers, logged_minutes, created_by, updated_at";

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
  const { data, error, count } = await supabase
    .from("tasks_list")
    .select(LIST_COLUMNS, { count: "exact" })
    .is("deleted_at", null)
    .eq("status", "data_awaited")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("task_number")
    .limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as TaskRowDb[]).map(toTaskRow);
  if (rows.length === 0) return { rows: [], total: count ?? 0 };
  const taskIds = rows.map((t) => t.id);
  const clientIds = [...new Set(rows.map((t) => t.client_id))];
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
    total: count ?? 0,
    rows: rows.map((task) => ({
      task,
      since: since.get(task.id)?.at ?? null,
      contact: contacts.get(task.client_id) ?? null,
      client: byClient.get(task.client_id) ?? null,
      missing: missing.get(task.id) ?? [],
    })),
  };
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

// =================================================================================================
// Firm today (§7.2 Partner)
// =================================================================================================

export type FirmKpis = {
  activeClients: number;
  invoicedFyPaise: Paise;
  invoicedFyCount: number;
  collectedMonthPaise: Paise;
  /** The TDS part of this month's collections. */
  tdsMonthPaise: Paise;
  outstandingPaise: Paise;
  outstandingCount: number;
  overduePaise: Paise;
  overdueCount: number;
  filingsDueIn7: number;
  overdueTasks: number;
  onlineNow: number;
  withLogin: number;
  unbilledPaise: Paise;
  unbilledMinutes: number;
  unbilledClients: number;
};

export type FirmApprovals = {
  invoices: number;
  invoicesPaise: Paise;
  quotations: number;
  quotationsPaise: Paise;
  /** Leave requests waiting for this Partner (not their own). */
  leave: number;
  dataRequests: { open: number; overdue: number; nextDue: DateString | null };
};

export type FilingGroup = { type: string; form_code: string | null; rule_code: string | null; filed: number; pending: number; overdue: number };

export type Pipeline = { openLeads: number; quotationsSent: { count: number; valuePaise: Paise }; conversion: { accepted: number; decided: number; percent: number | null } };

export type FirmToday = {
  fy: FinancialYear;
  monthStart: DateString;
  monthEnd: DateString;
  setup: SetupDetail;
  kpis: FirmKpis;
  approvals: FirmApprovals;
  /** The FY's months from April; months not yet begun have null figures. */
  months: FyMonthRow[];
  ageing: AgeingRow[];
  /** This month's deadlines by type, form and rule (mapped to return types by the page). */
  filing: FilingGroup[];
  atRisk: Counted<AtRiskClient>;
  pipeline: Pipeline;
  week: DeadlineWindow;
  review: Counted<TaskListRow>;
};

const DOMAIN_STATUSES: readonly DomainStatus[] = ["not_started", "pending", "verified", "failed"];

/**
 * Firm today in one call (0216; Partner only): the setup checklist's facts, the KPIs, approvals, the
 * FY's invoiced and collected by month, receivables ageing, this month's filing status, at-risk
 * clients, the pipeline, this week's deadlines and the review queue. The receivables, ageing,
 * collected and unbilled figures are the payments dashboard's own definitions.
 */
export async function getFirmToday(supabase: ServerSupabase, fy: FinancialYear, today: DateString, opts: { rows?: number } = {}): Promise<FirmToday> {
  const { data, error } = await supabase.rpc("dashboard_firm_today", {
    p_fy: fy,
    p_today: today,
    p_online_minutes: PRESENCE_DEFAULTS.idleAfterMinutes,
    p_rows: opts.rows ?? 6,
    p_at_risk_tasks: AT_RISK_OVERDUE_TASKS,
    p_at_risk_days: AT_RISK_RECEIVABLE_DAYS,
  });
  if (error) throw error;
  return parseFirmToday(data, fy, today);
}

function parseFirmToday(data: Json, fy: FinancialYear, today: DateString): FirmToday {
  const r = obj(data);
  const s = obj(r.setup);
  const k = obj(r.kpis);
  const a = obj(r.approvals);
  const p = obj(r.pipeline);
  const risk = obj(r.at_risk);
  const domain = str(s.domain_status) as DomainStatus | null;
  const decided = { accepted: int(p.accepted), rejected: int(p.rejected), expired: int(p.expired) };
  return {
    fy: (str(r.financial_year) ?? fy) as FinancialYear,
    monthStart: str(r.month_start) ?? `${today.slice(0, 7)}-01`,
    monthEnd: str(r.month_end) ?? today,
    setup: {
      hasLogo: s.has_logo === true,
      hasBank: s.has_bank === true,
      hasUpi: s.has_upi === true,
      hasFrn: s.has_frn === true,
      domainStatus: domain && DOMAIN_STATUSES.includes(domain) ? domain : "not_started",
      lawReviewedAt: str(s.law_reviewed_at),
      partners: int(s.partners),
      partnersMissingMembership: arr(s.partners_missing_membership).map((m) => {
        const o = obj(m);
        return { profileId: String(o.profile_id), employeeId: str(o.employee_id), name: str(o.name) ?? "" };
      }),
      whatsappNumbers: int(s.whatsapp_numbers),
      whatsappSlots: int(s.whatsapp_slots),
      teamMembers: int(s.team_members),
      clientsOnboarded: int(s.clients_onboarded),
      invoicesIssued: int(s.invoices_issued),
    },
    kpis: {
      activeClients: int(k.active_clients),
      invoicedFyPaise: paise(k.invoiced_fy),
      invoicedFyCount: int(k.invoiced_fy_count),
      collectedMonthPaise: paise(k.collected_month),
      tdsMonthPaise: paise(k.tds_month),
      outstandingPaise: paise(k.outstanding),
      outstandingCount: int(k.outstanding_count),
      overduePaise: paise(k.overdue),
      overdueCount: int(k.overdue_count),
      filingsDueIn7: int(k.filings_due_7),
      overdueTasks: int(k.overdue_tasks),
      onlineNow: int(k.online_now),
      withLogin: int(k.with_login),
      unbilledPaise: paise(k.unbilled),
      unbilledMinutes: int(k.unbilled_minutes),
      unbilledClients: int(k.unbilled_clients),
    },
    approvals: {
      invoices: int(a.invoices),
      invoicesPaise: paise(a.invoices_value),
      quotations: int(a.quotations),
      quotationsPaise: paise(a.quotations_value),
      leave: int(a.leave),
      dataRequests: { open: int(a.data_requests), overdue: int(a.data_requests_overdue), nextDue: str(a.data_requests_next_due) },
    },
    months: fyMonthRows(
      arr(r.months).map((m) => {
        const o = obj(m);
        return { month: str(o.month) ?? "", invoicedPaise: paiseOrNull(o.invoiced), collectedPaise: paiseOrNull(o.collected) };
      }),
    ),
    ageing: ageingFromBuckets(
      arr(r.ageing).map((b) => {
        const o = obj(b);
        return { bucket: str(o.bucket) ?? "", count: int(o.count), paise: paise(o.amount) };
      }),
    ),
    filing: arr(r.filing).map((g) => {
      const o = obj(g);
      return { type: str(o.type) ?? "custom", form_code: str(o.form_code), rule_code: str(o.rule_code), filed: int(o.filed), pending: int(o.pending), overdue: int(o.overdue) };
    }),
    atRisk: {
      total: int(risk.total),
      rows: atRiskFromCounts(
        arr(risk.rows).map((x) => {
          const o = obj(x);
          return { clientId: String(o.client_id), clientName: str(o.client_name) ?? "", overdueTasks: int(o.overdue_tasks), receivablesOldPaise: paise(o.receivables_old) };
        }),
      ),
    },
    pipeline: {
      openLeads: int(p.open_leads),
      quotationsSent: { count: int(p.quotations_sent), valuePaise: paise(p.quotations_sent_value) },
      conversion: { accepted: decided.accepted, decided: decided.accepted + decided.rejected + decided.expired, percent: conversionRate(decided) },
    },
    week: deadlineBlock(r.week, weekWindow(today)),
    review: taskBlock(r.review),
  };
}

/** The leave requests waiting for this person's decision, for deciding in place (§7.11.3). */
export async function getPendingLeave(supabase: ServerSupabase, user: CurrentUser, limit = 3): Promise<Counted<LeaveRow>> {
  const rows = await listPendingForApprover(supabase, user, 200);
  return { rows: rows.slice(0, limit), total: rows.length };
}

export type ActivityItem = { id: string; description: string; user_name: string | null; at: string; entity_type: string; entity_id: string };

/** The latest entries of the firm's activity log (§7.2 Partner "recent activity"). */
export async function getRecentActivity(supabase: ServerSupabase, limit = 6): Promise<ActivityItem[]> {
  const { data, error } = await supabase.from("activity_logs").select("id, description, user_name, at, entity_type, entity_id").order("at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

// =================================================================================================
// Practice health (§7.2 Partner; §6.8, §6.9, §6.10, §7.15, §7.25.7, §7.8.4). One reader per item,
// each through the module that owns the register, so each item fails on its own.
// =================================================================================================

export type UdinHealth = Counted<{ id: string; clientId: string; clientName: string; reportDate: DateString; daysLeft: number | null; daysLate: number | null }> & {
  /** Days from signing within which the UDIN must be generated (60, from Law & rules). */
  windowDays: number;
};

/** Signed reports with no UDIN yet, with the days left of the 60 (registers: the same list as the UDIN tab). */
export async function getUdinHealth(supabase: ServerSupabase, today: DateString, limit = 4): Promise<UdinHealth> {
  const [r, params] = await Promise.all([listReportsWithoutUdin(supabase, today, limit), getAuditParams(supabase, today)]);
  return {
    total: r.total,
    windowDays: params.ceiling.udinGenerationDays,
    rows: r.rows.map((u) => ({ id: u.id, clientId: u.client_id, clientName: u.client_name, reportDate: u.report_date, daysLeft: u.daysLeft, daysLate: u.daysLate })),
  };
}

export type CeilingHealth = { fy: FinancialYear; rows: Array<{ memberId: string; name: string; total: number; ceiling: number; warning: CeilingWarning | null }>; unverified: boolean };

/** Each Partner's tax audits for the FY against the ceiling (registers: the UDIN tab's ceiling panel). */
export async function getCeilingHealth(supabase: ServerSupabase, fy: FinancialYear): Promise<CeilingHealth> {
  const p = await getCeilingPanel(supabase, fy);
  return { fy: p.fy, unverified: p.unverified.length > 0, rows: p.rows.map((r) => ({ memberId: r.memberId, name: r.name, total: r.total, ceiling: r.ceiling, warning: r.warning })) };
}

export type LetterHealth = { missing: number; expiring: number };

/** Active clients with no engagement letter for the FY, and letters expiring in 30 days (engagement letters). */
export async function getLetterHealth(supabase: ServerSupabase, fy: FinancialYear, today: DateString): Promise<LetterHealth> {
  const s = await getLetterSummary(supabase, fy, today);
  return { missing: s.missing, expiring: s.expiring };
}

export type ExpiryHealth = { dscNext30: number; dscExpired: number; registrationsNext30: number; registrationsPast: number };

/** DSCs and registrations expiring in the next 30 days, and those already past (registers). */
export async function getExpiryHealth(supabase: ServerSupabase, today: DateString): Promise<ExpiryHealth> {
  const [dsc, reg] = await Promise.all([getDscSummary(supabase, today), getRegistrationSummary(supabase, today)]);
  return { dscNext30: dsc.next30, dscExpired: dsc.expired, registrationsNext30: reg.expiring, registrationsPast: reg.pastExpiry };
}

export type PeerReviewHealth = { state: PeerReviewState; validUntil: DateString | null; daysLeft: number | null };

/** The firm's peer review certificate (quality): the latest completed review's validity. */
export async function getPeerReviewHealth(supabase: ServerSupabase, today: DateString): Promise<PeerReviewHealth> {
  const [reviews, params] = await Promise.all([listPeerReviews(supabase), getAuditParams(supabase, today)]);
  const validUntil =
    reviews
      .filter((r) => r.status === "completed" && r.valid_until)
      .map((r) => r.valid_until as string)
      .sort()
      .at(-1) ?? null;
  const s = peerReviewStatus(validUntil, today, params.ceiling);
  return { state: s.state, daysLeft: s.daysLeft, validUntil };
}

export type AssemblyHealth = { due: number; overdue: number; rows: Array<{ id: string; clientName: string; due: DateString }> };

/** Audit files whose 60-day assembly date (SA 230) is past or within 14 days (audits: the same counts as its filters). */
export async function getAssemblyHealth(supabase: ServerSupabase, today: DateString, limit = 4): Promise<AssemblyHealth> {
  const [summary, rows] = await Promise.all([
    getAuditSummary(supabase, today),
    supabase
      .from("audit_engagements_list")
      .select("id, client_name, file_assembly_due")
      .is("archived_at", null)
      .not("file_assembly_due", "is", null)
      .lte("file_assembly_due", addDays(today, 14))
      .order("file_assembly_due")
      .order("id")
      .limit(limit),
  ]);
  if (rows.error) throw rows.error;
  return {
    due: summary.assemblyDue,
    overdue: summary.assemblyOverdue,
    rows: (rows.data ?? []).map((a) => ({ id: a.id as string, clientName: (a.client_name as string | null) ?? "", due: a.file_assembly_due as string })),
  };
}

export type WhatsAppHealth = { withoutGroup: number; numbers: Array<{ id: string; label: string; links: number; limit: number | null; atLimit: boolean; overLimit: boolean }> };

/** Active clients with no WhatsApp group, and PCs linked per firm number against WhatsApp's limit (§7.25.7). */
export async function getWhatsAppHealth(supabase: ServerSupabase): Promise<WhatsAppHealth> {
  const [register, links] = await Promise.all([getRegisterSummary(supabase), getLinksPerNumber(supabase)]);
  return {
    withoutGroup: register.none,
    numbers: links.map((n) => ({ id: n.number_id, label: n.label, links: n.active_links, limit: n.device_limit, atLimit: n.at_limit, overLimit: n.over_limit })),
  };
}

/** Notice replies overdue and due within 7 days, firm-wide (notices). */
export async function getNoticeHealth(supabase: ServerSupabase, today: DateString): Promise<NoticeAlerts> {
  return getNoticeAlerts(supabase, { today, limit: 3 });
}
