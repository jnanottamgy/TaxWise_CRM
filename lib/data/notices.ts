import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { TableParams } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import { escapeLike } from "@/components/app/data-table/params";
import { addDays, diffDays, recentFinancialYears, todayIST, type DateString } from "@/lib/domain/fy";
import type { NoticeStatus } from "@/lib/domain/enums";
import { ESCALATION_PARAM_KEYS, resolveEscalationParams, type AppealForum, type LimitationPeriod } from "@/lib/domain/escalation";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import {
  CLOSED_STATUSES,
  NOTICE_LIST_SORTABLE,
  OPEN_STATUSES,
  type NoticeAppealForum,
  type NoticeAttention,
  type NoticeDocumentKind,
  type NoticeListFilter,
  type NoticeListSort,
  type TaxArea,
} from "@/lib/schemas/notices";

/**
 * Reads for the notices and litigation register (§7.8.4), under the caller's session: RLS gives
 * Partners and Managers every notice and Employees those of their own clients (§4.1). The register
 * is one query on tax_notices_list (0207), which works out the derived states (reply overdue, days
 * to reply, next action date, appeal open) in SQL. A tax demand is the client's, not the firm's fee.
 */

function orIlike(columns: readonly string[], q: string): string {
  const like = `%${escapeLike(q)}%`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return columns.map((c) => `${c}.ilike."${like}"`).join(",");
}

export type NoticeListRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  client_pan: string | null;
  client_gstin: string | null;
  client_owner_employee_id: string | null;
  notice_type: string;
  tax_area: TaxArea | null;
  section: string | null;
  authority: string | null;
  reference_no: string | null;
  financial_year: string | null;
  notice_date: string | null;
  received_date: string | null;
  reply_due_date: string | null;
  hearing_date: string | null;
  hearing_on: string | null;
  status: NoticeStatus;
  demand_amount: number | null;
  description: string | null;
  assigned_employee_id: string | null;
  assigned_name: string | null;
  assigned_profile_id: string | null;
  replied_on: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  order_date: string | null;
  appeal_decision: "appeal" | "no_appeal" | null;
  appeal_note: string | null;
  appeal_forum: NoticeAppealForum | null;
  limitation_date: string | null;
  limitation_manual: boolean;
  appeal_task_id: string | null;
  appeal_task_number: string | null;
  appeal_task_status: string | null;
  created_by: string;
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
  is_closed: boolean;
  reply_pending: boolean;
  reply_overdue: boolean;
  days_to_reply: number | null;
  hearing_upcoming: boolean;
  appeal_open: boolean;
  days_to_limitation: number | null;
  next_action_date: string | null;
  notes_count: number;
  last_noted_on: string | null;
  documents_count: number;
};

const COLUMNS =
  "id, client_id, client_name, client_code, client_pan, client_gstin, client_owner_employee_id, notice_type, tax_area, section, authority, reference_no, financial_year, notice_date, received_date, reply_due_date, hearing_date, hearing_on, status, demand_amount, description, assigned_employee_id, assigned_name, assigned_profile_id, replied_on, closed_at, closed_by_name, order_date, appeal_decision, appeal_note, appeal_forum, limitation_date, limitation_manual, appeal_task_id, appeal_task_number, appeal_task_status, created_by, created_by_name, updated_by_name, created_at, updated_at, is_closed, reply_pending, reply_overdue, days_to_reply, hearing_upcoming, appeal_open, days_to_limitation, next_action_date, notes_count, last_noted_on, documents_count";

/** `?status=` values: one status, or every open / closed one. */
function statusValues(values: readonly string[] | undefined): NoticeStatus[] {
  const out = new Set<NoticeStatus>();
  for (const v of values ?? []) {
    if (v === "all_open") OPEN_STATUSES.forEach((s) => out.add(s));
    else if (v === "all_closed") CLOSED_STATUSES.forEach((s) => out.add(s));
    else out.add(v as NoticeStatus);
  }
  return [...out];
}

/** The PostgREST `or` expression for the chosen attention flags (any of them), or null. */
export function attentionFilter(flags: readonly NoticeAttention[], today: DateString): string | null {
  const week = addDays(today, 7);
  const parts = [...new Set(flags)].map((a) => {
    switch (a) {
      case "reply_overdue":
        return "reply_overdue.eq.true";
      case "reply_week":
        return `and(reply_pending.eq.true,reply_due_date.gte.${today},reply_due_date.lte.${week})`;
      case "hearing_week":
        return `and(hearing_upcoming.eq.true,hearing_on.lte.${week})`;
      case "appeal_open":
        return "appeal_open.eq.true";
    }
  });
  return parts.length ? parts.join(",") : null;
}

export async function listNotices(
  supabase: ServerSupabase,
  t: TableParams<NoticeListSort, NoticeListFilter>,
  opts: { today?: DateString; clientId?: string | null; viewerEmployeeId?: string | null; limit?: number } = {},
): Promise<{ rows: NoticeListRow[]; total: number }> {
  const today = opts.today ?? todayIST();
  let q = supabase.from("tax_notices_list").select(COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) q = q.eq("client_id", clientId);
  const statuses = statusValues(t.filters.status);
  if (statuses.length) q = q.in("status", statuses);
  if (t.filters.area?.length) q = q.in("tax_area", t.filters.area);
  const assigned = t.filters.assigned?.[0] ?? null;
  if (assigned === "me" && opts.viewerEmployeeId) q = q.eq("assigned_employee_id", opts.viewerEmployeeId);
  else if (assigned === "none") q = q.is("assigned_employee_id", null);
  else if (assigned && /^[0-9a-f-]{36}$/i.test(assigned)) q = q.eq("assigned_employee_id", assigned);
  // Several "needs attention" choices widen the list (any of them), and the search narrows it.
  const attention = attentionFilter((t.filters.attention ?? []) as NoticeAttention[], today);
  const search = t.q ? orIlike(["client_name", "client_code", "notice_type", "reference_no", "section", "authority"], t.q) : null;
  if (attention && search) q = q.or(`and(or(${attention}),or(${search}))`);
  else if (attention) q = q.or(attention);
  else if (search) q = q.or(search);
  const sort: NoticeListSort = t.sort && (NOTICE_LIST_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "next_action_date";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("updated_at", { ascending: false }).order("id", { ascending: true });
  const limit = opts.limit ?? t.pageSize;
  const { data, error, count } = await q.range(t.from, t.from + limit - 1);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as NoticeListRow[], total: count ?? 0 };
}

export type NoticeCounts = { open: number; replyOverdue: number; replyWeek: number; hearingWeek: number; appealOpen: number };

/** The register's figures, every year, under the caller's RLS. */
export async function getNoticeCounts(supabase: ServerSupabase, today: DateString = todayIST(), clientId?: string | null): Promise<NoticeCounts> {
  const base = () => {
    const q = supabase.from("tax_notices_list").select("id", { count: "exact", head: true });
    return clientId ? q.eq("client_id", clientId) : q;
  };
  const run = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  };
  const [open, replyOverdue, replyWeek, hearingWeek, appealOpen] = await Promise.all([
    run(base().eq("is_closed", false)),
    run(base().eq("reply_overdue", true)),
    run(base().eq("reply_pending", true).gte("reply_due_date", today).lte("reply_due_date", addDays(today, 7))),
    run(base().eq("hearing_upcoming", true).lte("hearing_on", addDays(today, 7))),
    run(base().eq("appeal_open", true)),
  ]);
  return { open, replyOverdue, replyWeek, hearingWeek, appealOpen };
}

export async function listClientNotices(supabase: ServerSupabase, clientId: string, limit = 6): Promise<{ rows: NoticeListRow[]; total: number }> {
  const { data, error, count } = await supabase
    .from("tax_notices_list")
    .select(COLUMNS, { count: "exact" })
    .eq("client_id", clientId)
    .order("is_closed", { ascending: true })
    .order("next_action_date", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as NoticeListRow[], total: count ?? 0 };
}

// =================================================================================================
// One notice
// =================================================================================================

export type NoticeNote = { id: string; noted_on: string; kind: string; body: string; author_id: string | null; author_name: string | null; created_at: string };

export type NoticeDocument = {
  id: string;
  document_id: string;
  kind: NoticeDocumentKind;
  title: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  created_at: string;
  deleted: boolean;
};

export type NoticeDetail = { row: NoticeListRow; notes: NoticeNote[]; documents: NoticeDocument[] };

export async function getNotice(supabase: ServerSupabase, id: string): Promise<NoticeDetail | null> {
  const [row, notes, docs] = await Promise.all([
    supabase.from("tax_notices_list").select(COLUMNS).eq("id", id).maybeSingle(),
    supabase
      .from("tax_notice_notes_list")
      .select("id, noted_on, kind, body, author_id, author_name, created_at")
      .eq("notice_id", id)
      .order("noted_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("tax_notice_documents")
      .select("id, document_id, kind, created_at, documents(title, file_name, mime_type, file_size, deleted_at)")
      .eq("notice_id", id)
      .order("created_at", { ascending: true })
      .limit(100),
  ]);
  if (row.error) throw row.error;
  if (notes.error) throw notes.error;
  if (docs.error) throw docs.error;
  if (!row.data) return null;
  type DocJoin = { id: string; document_id: string; kind: string; created_at: string; documents: { title: string | null; file_name: string | null; mime_type: string | null; file_size: number | null; deleted_at: string | null } | null };
  return {
    row: row.data as unknown as NoticeListRow,
    notes: (notes.data ?? []) as unknown as NoticeNote[],
    documents: ((docs.data ?? []) as unknown as DocJoin[]).map((d) => ({
      id: d.id,
      document_id: d.document_id,
      kind: d.kind as NoticeDocumentKind,
      title: d.documents?.title ?? null,
      file_name: d.documents?.file_name ?? null,
      mime_type: d.documents?.mime_type ?? null,
      file_size: d.documents?.file_size ?? null,
      created_at: d.created_at,
      deleted: !d.documents || Boolean(d.documents.deleted_at),
    })),
  };
}

// =================================================================================================
// Pickers and parameters
// =================================================================================================

/** Clients the caller can see (Employees: their own, RLS), for the notice's client field. */
export async function searchNoticeClients(supabase: ServerSupabase, q: string): Promise<ComboOption[]> {
  let query = supabase.from("clients").select("id, client_code, display_name, pan, gstin").is("deleted_at", null).order("display_name", { ascending: true }).limit(20);
  const text = q.trim();
  if (text) query = query.or(orIlike(["display_name", "client_code", "pan", "gstin", "legal_name"], text));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((c) => ({ value: c.id, label: `${c.client_code} · ${c.display_name}`, description: c.gstin ? `GSTIN ${c.gstin}` : c.pan ? `PAN ${c.pan}` : undefined }));
}

/** Active staff a notice can be assigned to (the directory every staff member reads, §4.6). */
export async function listAssignableStaff(supabase: ServerSupabase): Promise<Array<{ value: string; label: string }>> {
  const { data, error } = await supabase.from("employee_directory").select("id, full_name, is_active").eq("is_active", true).order("full_name", { ascending: true }).limit(300);
  if (error) throw error;
  return (data ?? []).filter((e) => e.id && e.full_name).map((e) => ({ value: e.id as string, label: e.full_name as string }));
}

/** The appeal limitation periods in force on a date (statutory_parameters appeal.*, §7.8.4). */
export async function getAppealPeriods(supabase: ServerSupabase, on: DateString): Promise<{ periods: Record<AppealForum, LimitationPeriod>; unverified: boolean }> {
  const keys = [ESCALATION_PARAM_KEYS.incomeTaxFirstAppeal, ESCALATION_PARAM_KEYS.incomeTaxTribunal, ESCALATION_PARAM_KEYS.gstFirstAppeal, ESCALATION_PARAM_KEYS.gstTribunal];
  const { data, error } = await supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", keys);
  if (error) throw error;
  const rows: StatutoryParameterRow[] = (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  const resolved = resolveEscalationParams(rows, on);
  return { periods: resolved.appeals, unverified: keys.some((k) => resolved.unverified.includes(k)) };
}

// =================================================================================================
// Alerts for the dashboards (§7.2, §7.8.4 "overdue replies are red on the dashboard")
// =================================================================================================

export type NoticeAlert = {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  noticeType: string;
  referenceNo: string | null;
  /** What is due: the reply, the hearing, or the appeal (limitation date). */
  kind: "reply" | "hearing" | "appeal";
  date: DateString;
  /** Negative when overdue. */
  daysLeft: number;
  overdue: boolean;
  assignedName: string | null;
  href: string;
};

export type NoticeAlerts = {
  /** Replies past their due date (red on the dashboard). */
  overdueReplies: NoticeAlert[];
  /** Replies due within `withinDays` (default 7). */
  repliesDue: NoticeAlert[];
  /** Hearings within `withinDays`. */
  hearings: NoticeAlert[];
  /** Appeals still to be filed: limitation within 14 days, or passed. */
  appeals: NoticeAlert[];
  counts: { overdueReplies: number; repliesDue: number; hearings: number; appeals: number; open: number };
};

/**
 * The notices that need someone today, for the Partner and Manager dashboards and My day (§7.2,
 * §7.8.4), under the caller's RLS (an Employee gets their own clients' notices only). Each list is
 * capped at `limit` rows (overviews show 4–6, DESIGN.md §4), soonest first; `counts` are the full
 * totals behind each list. `assignedTo` narrows to one person's notices (My day).
 *
 *   const alerts = await getNoticeAlerts(supabase, { limit: 5 })
 *   alerts.overdueReplies  // red: "Reply 3 days overdue · GST DRC-01 · Sharma Traders"
 */
export async function getNoticeAlerts(
  supabase: ServerSupabase,
  opts: { today?: DateString; withinDays?: number; limit?: number; assignedTo?: string | null } = {},
): Promise<NoticeAlerts> {
  const today = opts.today ?? todayIST();
  const within = opts.withinDays ?? 7;
  const limit = opts.limit ?? 5;
  const cols = "id, client_id, client_name, client_code, notice_type, reference_no, reply_due_date, hearing_on, limitation_date, assigned_name, assigned_employee_id";
  const scoped = (head = false) => {
    const q = supabase.from("tax_notices_list").select(cols, head ? { count: "exact", head: true } : { count: "exact" });
    return opts.assignedTo ? q.eq("assigned_employee_id", opts.assignedTo) : q;
  };
  type Row = { id: string; client_id: string; client_name: string; client_code: string; notice_type: string; reference_no: string | null; reply_due_date: string | null; hearing_on: string | null; limitation_date: string | null; assigned_name: string | null };
  const toAlert = (r: Row, kind: NoticeAlert["kind"], date: string): NoticeAlert => {
    const daysLeft = diffDays(date, today);
    return {
      id: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      clientCode: r.client_code,
      noticeType: r.notice_type,
      referenceNo: r.reference_no,
      kind,
      date,
      daysLeft,
      overdue: daysLeft < 0,
      assignedName: r.assigned_name,
      href: `/workpapers/notices/${r.id}`,
    };
  };
  const [overdue, due, hearings, appeals, open] = await Promise.all([
    scoped().eq("reply_overdue", true).order("reply_due_date", { ascending: true }).limit(limit),
    scoped().eq("reply_pending", true).gte("reply_due_date", today).lte("reply_due_date", addDays(today, within)).order("reply_due_date", { ascending: true }).limit(limit),
    scoped().eq("hearing_upcoming", true).lte("hearing_on", addDays(today, within)).order("hearing_date", { ascending: true }).limit(limit),
    scoped().eq("appeal_open", true).lte("limitation_date", addDays(today, 14)).order("limitation_date", { ascending: true }).limit(limit),
    scoped(true).eq("is_closed", false),
  ]);
  for (const r of [overdue, due, hearings, appeals, open]) if (r.error) throw r.error;
  const rows = (x: { data: unknown }) => (x.data ?? []) as Row[];
  return {
    overdueReplies: rows(overdue).map((r) => toAlert(r, "reply", r.reply_due_date as string)),
    repliesDue: rows(due).map((r) => toAlert(r, "reply", r.reply_due_date as string)),
    hearings: rows(hearings).map((r) => toAlert(r, "hearing", r.hearing_on as string)),
    appeals: rows(appeals).map((r) => toAlert(r, "appeal", r.limitation_date as string)),
    counts: { overdueReplies: overdue.count ?? 0, repliesDue: due.count ?? 0, hearings: hearings.count ?? 0, appeals: appeals.count ?? 0, open: open.count ?? 0 },
  };
}

// =================================================================================================
// What the notice form needs
// =================================================================================================

export type NoticeFormContextData = {
  staff: Array<{ value: string; label: string }>;
  years: string[];
  canAssignOthers: boolean;
};

/**
 * Assignees and years for the notice form: Partners and Managers assign anyone active; an Employee
 * takes a notice themselves or leaves it unassigned (the guard on tax_notices holds the same rule).
 * Years: the current FY and the eight before it (notices reach back to old assessment years).
 */
export async function getNoticeFormContext(
  supabase: ServerSupabase,
  viewer: { role: string; employeeId: string | null; fullName: string },
  today: DateString = todayIST(),
): Promise<NoticeFormContextData> {
  const mp = viewer.role === "partner" || viewer.role === "manager";
  const staff = mp ? await listAssignableStaff(supabase) : viewer.employeeId ? [{ value: viewer.employeeId, label: `Me (${viewer.fullName})` }] : [];
  return { staff, years: recentFinancialYears(today, 9), canAssignOthers: mp };
}
