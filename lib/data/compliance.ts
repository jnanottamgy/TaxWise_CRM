import "server-only";

import type { Enums, Tables } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { ComplianceType, ComplianceWorkflow, ComplianceStatus } from "@/lib/domain/enums";
import { fyEnd, fyStart, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { UNASSIGNED, type GridReturnType, type GridStatusFilter } from "@/lib/schemas/compliance";
import type { CalendarState } from "@/components/compliance/logic/calendar";
import { fetchAll } from "@/server/compliance/engine";

/**
 * Compliance reads (§7.7), all under the caller's RLS (CONVENTIONS §3.1). Pagination, filters and
 * sorting happen in SQL (the grid and calendar RPCs of 0127/0128). Nothing here carries money:
 * Employees read these too (§4.1).
 */

// -------------------------------------------------------------------------------------------------
// The filings grid
// -------------------------------------------------------------------------------------------------

export interface GridClient {
  id: string;
  display_name: string;
  client_code: string;
  owner_employee_id: string | null;
  owner_name: string | null;
  state_code: string | null;
  gst_scheme: Enums<"gst_scheme"> | null;
  status: Enums<"client_status">;
}

export interface GridEvent {
  id: string;
  client_id: string;
  type: ComplianceType;
  form_code: string | null;
  title: string;
  filing_period: string | null;
  period_start: DateString | null;
  period_end: DateString | null;
  due_date: DateString;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  is_statutory: boolean;
  rule_code: string | null;
  original_due_date: DateString | null;
  override_id: string | null;
  task_id: string | null;
  updated_at: string;
  has_filing: boolean;
}

export type GridSummaryEvent = Pick<GridEvent, "client_id" | "form_code" | "filing_period" | "period_start" | "period_end" | "due_date" | "status" | "workflow_status">;

export interface FilingsGridData {
  today: DateString;
  total: number;
  clients: GridClient[];
  events: GridEvent[];
  summary: GridSummaryEvent[];
}

export async function getFilingsGrid(
  supabase: ServerSupabase,
  args: { fy: FinancialYear; returnType: GridReturnType; owner: string | null; q: string; status: GridStatusFilter | null; from: number; pageSize: number },
): Promise<FilingsGridData> {
  const unassigned = args.owner === UNASSIGNED;
  const { data, error } = await supabase.rpc("filings_grid", {
    p_financial_year: args.fy,
    p_types: [...args.returnType.types],
    p_form_pattern: args.returnType.formPattern,
    p_rule_pattern: args.returnType.rulePattern,
    p_owner: unassigned ? null : args.owner,
    p_unassigned: unassigned,
    p_q: args.q || null,
    p_status: args.status,
    p_limit: args.pageSize,
    p_offset: args.from,
  });
  if (error) throw error;
  const d = (data ?? {}) as unknown as Partial<FilingsGridData>;
  return { today: d.today ?? "", total: d.total ?? 0, clients: d.clients ?? [], events: d.events ?? [], summary: d.summary ?? [] };
}

/** Staff who can own clients, for the owner filter (Partners and Managers read the directory). */
export async function listOwnerOptions(supabase: ServerSupabase): Promise<Array<{ id: string; name: string; designation: string | null }>> {
  const { data, error } = await supabase.from("employee_directory").select("id, full_name, designation, is_active").order("full_name").limit(1000);
  if (error) throw error;
  return (data ?? []).filter((e) => e.id && e.full_name && e.is_active !== false).map((e) => ({ id: e.id!, name: e.full_name!, designation: e.designation ?? null }));
}

// -------------------------------------------------------------------------------------------------
// The calendar
// -------------------------------------------------------------------------------------------------

export interface CalendarGroupEvent {
  id: string;
  title: string;
  client_id: string | null;
  client_name: string | null;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  original_due_date: DateString | null;
  override_ref: string | null;
}

export interface CalendarGroup {
  date: DateString;
  type: ComplianceType;
  label: string;
  is_statutory: boolean;
  total: number;
  done: number;
  overdue: number;
  extended: number;
  event: CalendarGroupEvent | null;
}

function calendarFilters(state: Pick<CalendarState, "client" | "owner" | "types" | "kind">) {
  return {
    p_client: state.client,
    p_owner: state.owner && state.owner !== UNASSIGNED ? state.owner : null,
    p_types: state.types.length ? [...state.types] : null,
    p_statutory: state.kind === "statutory" ? true : state.kind === "firm" ? false : null,
  };
}

export async function getCalendarGroups(supabase: ServerSupabase, state: CalendarState & { to: DateString }): Promise<{ today: DateString; groups: CalendarGroup[] }> {
  const { data, error } = await supabase.rpc("compliance_calendar_days", { p_from: state.from, p_to: state.to, ...calendarFilters(state) });
  if (error) throw error;
  const d = (data ?? {}) as unknown as { today?: string; groups?: CalendarGroup[] };
  return { today: d.today ?? "", groups: d.groups ?? [] };
}

export interface AgendaRow {
  id: string;
  client_id: string | null;
  client_name: string | null;
  client_code: string | null;
  owner_employee_id: string | null;
  owner_name: string | null;
  type: ComplianceType;
  form_code: string | null;
  title: string;
  financial_year: string | null;
  filing_period: string | null;
  due_date: DateString;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  is_statutory: boolean;
  source: Enums<"compliance_source">;
  rule_code: string | null;
  original_due_date: DateString | null;
  override_id: string | null;
  override_ref: string | null;
  task_id: string | null;
  is_provisional: boolean;
  has_filing: boolean;
  updated_at: string;
}

export async function getAgenda(
  supabase: ServerSupabase,
  state: CalendarState,
  page: { from: number; pageSize: number; overdueOnly?: boolean },
): Promise<{ today: DateString; total: number; rows: AgendaRow[] }> {
  const { data, error } = await supabase.rpc("compliance_agenda", {
    p_from: page.overdueOnly ? null : state.from,
    p_to: page.overdueOnly ? null : state.to,
    ...calendarFilters(state),
    p_label: state.label,
    p_overdue_only: page.overdueOnly ?? false,
    p_limit: page.pageSize,
    p_offset: page.from,
  });
  if (error) throw error;
  const d = (data ?? {}) as unknown as { today?: string; total?: number; rows?: AgendaRow[] };
  return { today: d.today ?? "", total: d.total ?? 0, rows: d.rows ?? [] };
}

/** Clients for the calendar's client filter (the viewer's own, for an Employee). */
export async function listClientOptions(supabase: ServerSupabase): Promise<Array<{ id: string; name: string; code: string }>> {
  const rows = await fetchAll(
    (a, b) => supabase.from("clients").select("id, display_name, client_code").is("deleted_at", null).neq("status", "inactive").order("display_name").range(a, b),
    5000,
  );
  return rows.map((c) => ({ id: c.id, name: c.display_name, code: c.client_code }));
}

// -------------------------------------------------------------------------------------------------
// One client (Client 360 → Compliance)
// -------------------------------------------------------------------------------------------------

export type ClientEventRow = Pick<
  Tables<"compliance_events">,
  | "id" | "client_id" | "type" | "form_code" | "title" | "financial_year" | "filing_period" | "period_start" | "period_end" | "due_date"
  | "status" | "workflow_status" | "is_statutory" | "source" | "rule_code" | "original_due_date" | "override_id" | "task_id"
  | "is_provisional" | "agm_date" | "updated_at" | "reminder_days"
> & { override_ref: string | null; has_filing: boolean; filed_on: string | null };

const CLIENT_EVENT_COLUMNS =
  "id, client_id, type, form_code, title, financial_year, filing_period, period_start, period_end, due_date, status, workflow_status, is_statutory, source, rule_code, original_due_date, override_id, task_id, is_provisional, agm_date, updated_at, reminder_days";

/** Every deadline of a client that falls in the FY (by due date) or is for it (by period). */
export async function getClientComplianceEvents(supabase: ServerSupabase, clientId: string, fy: FinancialYear): Promise<ClientEventRow[]> {
  const start = fyStart(fy);
  const end = fyEnd(fy);
  const rows = await fetchAll((a, b) =>
    supabase
      .from("compliance_events")
      .select(CLIENT_EVENT_COLUMNS)
      .eq("client_id", clientId)
      .or(`and(due_date.gte.${start},due_date.lte.${end}),financial_year.eq.${fy}`)
      .order("due_date")
      .order("title")
      .range(a, b),
    5000,
  );
  return decorate(supabase, rows);
}

async function decorate<T extends { id: string; override_id: string | null }>(supabase: ServerSupabase, rows: T[]): Promise<Array<T & { override_ref: string | null; has_filing: boolean; filed_on: string | null }>> {
  const overrideIds = [...new Set(rows.map((r) => r.override_id).filter((v): v is string => !!v))];
  const ids = rows.map((r) => r.id);
  const overridesQuery = overrideIds.length
    ? supabase.from("due_date_overrides").select("id, source_ref").in("id", overrideIds)
    : Promise.resolve({ data: [] as Array<{ id: string; source_ref: string }>, error: null });
  const filingsQuery = (async () => {
    const out: Array<{ compliance_event_id: string | null; filed_on: string | null }> = [];
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase.from("filing_records").select("compliance_event_id, filed_on").in("compliance_event_id", ids.slice(i, i + 150)).limit(1000);
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out;
  })();
  const [overrides, filings] = await Promise.all([overridesQuery, filingsQuery]);
  if (overrides.error) throw overrides.error;
  const refs = new Map((overrides.data ?? []).map((o) => [o.id, o.source_ref]));
  const filed = new Map<string, string | null>();
  for (const f of filings) if (f.compliance_event_id) filed.set(f.compliance_event_id, f.filed_on ?? filed.get(f.compliance_event_id) ?? null);
  return rows.map((r) => ({ ...r, override_ref: r.override_id ? (refs.get(r.override_id) ?? null) : null, has_filing: filed.has(r.id), filed_on: filed.get(r.id) ?? null }));
}

// -------------------------------------------------------------------------------------------------
// One deadline (the event sheet)
// -------------------------------------------------------------------------------------------------

export interface EventFiling {
  id: string;
  filing_type: string;
  period: string | null;
  financial_year: string;
  filed_on: string | null;
  acknowledgement_no: string | null;
  filed_by_external: string | null;
  shareable_with_client: boolean;
  notes: string | null;
  created_by_name: string | null;
  document: { id: string; title: string; file_name: string } | null;
  udins: Array<{ id: string; udin: string; document_type: string }>;
}

export interface EventDetail {
  event: Tables<"compliance_events"> & { is_overdue: boolean; days_overdue: number; days_until_due: number };
  client: { id: string; display_name: string; client_code: string; owner_employee_id: string | null; owner_name: string | null; entity_type: Enums<"entity_type"> | null } | null;
  task: { id: string; task_number: string; title: string; status: Enums<"task_status">; due_date: string | null; assignee_name: string | null } | null;
  filings: EventFiling[];
  override: { source_ref: string; original_due: string; extended_due: string; scope: string | null } | null;
  rule: { code: string; title: string; source_ref: string | null; verified: boolean } | null;
  history: Array<{ id: string; action: string; description: string; user_name: string | null; at: string }>;
  /** For the filing dialog (Partners and Managers): the client's documents, unlinked UDINs and filing records. */
  documents: Array<{ id: string; title: string; file_name: string; category: Enums<"document_category">; created_at: string }>;
  udins: Array<{ id: string; udin: string; document_type: string; document_date: string }>;
  unlinkedFilings: Array<{ id: string; filing_type: string; period: string | null; financial_year: string; filed_on: string | null; acknowledgement_no: string | null }>;
}

export async function getEventDetail(supabase: ServerSupabase, eventId: string, opts: { manager: boolean }): Promise<EventDetail | null> {
  const { data: event, error } = await supabase.from("compliance_events_view").select("*").eq("id", eventId).maybeSingle();
  if (error) throw error;
  if (!event || !event.id) return null;
  const e = event as unknown as EventDetail["event"];

  const [client, task, filings, override, rule, history] = await Promise.all([
    e.client_id ? supabase.from("clients").select("id, display_name, client_code, owner_employee_id, entity_type, deleted_at").eq("id", e.client_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    e.task_id ? supabase.from("tasks").select("id, task_number, title, status, due_date, assigned_employee_id, deleted_at").eq("id", e.task_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase
      .from("filing_records")
      .select("id, filing_type, period, financial_year, filed_on, acknowledgement_no, filed_by_external, shareable_with_client, notes, created_by, document_id")
      .eq("compliance_event_id", eventId)
      .order("filed_on", { ascending: false, nullsFirst: false })
      .limit(20),
    e.override_id ? supabase.from("due_date_overrides").select("source_ref, original_due, extended_due, scope").eq("id", e.override_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    e.rule_code ? supabase.from("due_date_rules").select("code, title, source_ref, verified").eq("code", e.rule_code).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from("activity_logs").select("id, action, description, user_name, at").eq("entity_type", "compliance_event").eq("entity_id", eventId).order("at", { ascending: false }).limit(50),
  ]);
  for (const r of [client, task, filings, override, rule, history]) if (r.error) throw r.error;

  const c = client.data && !client.data.deleted_at ? client.data : null;
  const t = task.data && !task.data.deleted_at ? task.data : null;
  const filingRows = filings.data ?? [];

  const people = [c?.owner_employee_id, t?.assigned_employee_id].filter((v): v is string => !!v);
  const creators = filingRows.map((f) => f.created_by).filter((v): v is string => !!v);
  const docIds = filingRows.map((f) => f.document_id).filter((v): v is string => !!v);
  const filingIds = filingRows.map((f) => f.id);

  const [directory, profiles, docs, udins] = await Promise.all([
    people.length ? supabase.from("employee_directory").select("id, full_name").in("id", people) : Promise.resolve({ data: [] as Array<{ id: string | null; full_name: string | null }>, error: null }),
    creators.length ? supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", creators) : Promise.resolve({ data: [] as Array<{ profile_id: string | null; full_name: string | null }>, error: null }),
    docIds.length ? supabase.from("documents").select("id, title, file_name").in("id", docIds).is("deleted_at", null) : Promise.resolve({ data: [] as Array<{ id: string; title: string; file_name: string }>, error: null }),
    filingIds.length ? supabase.from("udin_records").select("id, udin, document_type, filing_record_id").in("filing_record_id", filingIds) : Promise.resolve({ data: [] as Array<{ id: string; udin: string; document_type: string; filing_record_id: string | null }>, error: null }),
  ]);
  for (const r of [directory, profiles, docs, udins]) if (r.error) throw r.error;
  const nameOf = new Map((directory.data ?? []).map((d) => [d.id ?? "", d.full_name ?? ""]));
  const creatorName = new Map((profiles.data ?? []).map((d) => [d.profile_id ?? "", d.full_name ?? ""]));
  const docById = new Map((docs.data ?? []).map((d) => [d.id, d]));

  let documents: EventDetail["documents"] = [];
  let openUdins: EventDetail["udins"] = [];
  let unlinked: EventDetail["unlinkedFilings"] = [];
  if (opts.manager && c) {
    const [d, u, f] = await Promise.all([
      supabase.from("documents").select("id, title, file_name, category, created_at").eq("client_id", c.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(30),
      supabase.from("udin_records").select("id, udin, document_type, document_date").eq("client_id", c.id).is("filing_record_id", null).order("document_date", { ascending: false }).limit(30),
      supabase
        .from("filing_records")
        .select("id, filing_type, period, financial_year, filed_on, acknowledgement_no")
        .eq("client_id", c.id)
        .is("compliance_event_id", null)
        .order("filed_on", { ascending: false, nullsFirst: false })
        .limit(30),
    ]);
    for (const r of [d, u, f]) if (r.error) throw r.error;
    documents = d.data ?? [];
    openUdins = (u.data ?? []).map((x) => ({ id: x.id, udin: String(x.udin), document_type: x.document_type, document_date: x.document_date }));
    unlinked = f.data ?? [];
  }

  return {
    event: e,
    client: c ? { id: c.id, display_name: c.display_name, client_code: c.client_code, owner_employee_id: c.owner_employee_id, owner_name: c.owner_employee_id ? (nameOf.get(c.owner_employee_id) ?? null) : null, entity_type: c.entity_type } : null,
    task: t ? { id: t.id, task_number: t.task_number, title: t.title, status: t.status, due_date: t.due_date, assignee_name: t.assigned_employee_id ? (nameOf.get(t.assigned_employee_id) ?? null) : null } : null,
    filings: filingRows.map((f) => ({
      id: f.id,
      filing_type: f.filing_type,
      period: f.period,
      financial_year: f.financial_year,
      filed_on: f.filed_on,
      acknowledgement_no: f.acknowledgement_no,
      filed_by_external: f.filed_by_external,
      shareable_with_client: f.shareable_with_client,
      notes: f.notes,
      created_by_name: f.created_by ? (creatorName.get(f.created_by) ?? null) : null,
      document: f.document_id ? (docById.get(f.document_id) ?? null) : null,
      udins: (udins.data ?? []).filter((u) => u.filing_record_id === f.id).map((u) => ({ id: u.id, udin: String(u.udin), document_type: u.document_type })),
    })),
    override: override.data ?? null,
    rule: rule.data ?? null,
    history: history.data ?? [],
    documents,
    udins: openUdins,
    unlinkedFilings: unlinked,
  };
}

// -------------------------------------------------------------------------------------------------
// The client compliance report (§7.7, §11)
// -------------------------------------------------------------------------------------------------

export interface ReportRow {
  id: string;
  title: string;
  form_code: string | null;
  filing_period: string | null;
  financial_year: string | null;
  due_date: DateString;
  original_due_date: DateString | null;
  override_ref: string | null;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  filed_on: DateString | null;
  acknowledgement_no: string | null;
}

export interface ReportData {
  client: { id: string; display_name: string; legal_name: string | null; client_code: string; pan: string | null; gstin: string | null; tan: string | null; address: string | null; city: string | null; pincode: string | null };
  rows: ReportRow[];
}

/** Every statutory deadline of a client due in the range, with its filing (§7.7). Null when the client isn't visible. */
export async function getComplianceReportData(supabase: ServerSupabase, clientId: string, range: { from: DateString; to: DateString }): Promise<ReportData | null> {
  const { data: client, error } = await supabase
    .from("clients")
    .select("id, display_name, legal_name, client_code, pan, gstin, tan, address, city, pincode, deleted_at")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!client || client.deleted_at) return null;

  const events = await fetchAll(
    (a, b) =>
      supabase
        .from("compliance_events")
        .select("id, title, form_code, filing_period, financial_year, due_date, original_due_date, override_id, status, workflow_status")
        .eq("client_id", clientId)
        .eq("is_statutory", true)
        .neq("status", "cancelled")
        .gte("due_date", range.from)
        .lte("due_date", range.to)
        .order("due_date")
        .order("title")
        .range(a, b),
    5000,
  );
  const ids = events.map((e) => e.id);
  const filings: Array<{ compliance_event_id: string | null; filed_on: string | null; acknowledgement_no: string | null }> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: fe } = await supabase.from("filing_records").select("compliance_event_id, filed_on, acknowledgement_no").in("compliance_event_id", ids.slice(i, i + 200)).limit(1000);
    if (fe) throw fe;
    filings.push(...(data ?? []));
  }
  const byEvent = new Map<string, { filed_on: string | null; acknowledgement_no: string | null }>();
  for (const f of filings) {
    if (!f.compliance_event_id) continue;
    const cur = byEvent.get(f.compliance_event_id);
    if (!cur || (f.filed_on && (!cur.filed_on || f.filed_on > cur.filed_on))) byEvent.set(f.compliance_event_id, { filed_on: f.filed_on, acknowledgement_no: f.acknowledgement_no });
  }
  const overrideIds = [...new Set(events.map((e) => e.override_id).filter((v): v is string => !!v))];
  const refs = new Map<string, string>();
  if (overrideIds.length) {
    const { data, error: oe } = await supabase.from("due_date_overrides").select("id, source_ref").in("id", overrideIds);
    if (oe) throw oe;
    for (const o of data ?? []) refs.set(o.id, o.source_ref);
  }
  const { deleted_at: _deleted, ...c } = client;
  void _deleted;
  return {
    client: { ...c, pan: c.pan ? String(c.pan) : null, gstin: c.gstin ? String(c.gstin) : null, tan: c.tan ? String(c.tan) : null, client_code: String(c.client_code) },
    rows: events.map((e) => ({
      id: e.id,
      title: e.title,
      form_code: e.form_code,
      filing_period: e.filing_period,
      financial_year: e.financial_year,
      due_date: e.due_date,
      original_due_date: e.original_due_date,
      override_ref: e.override_id ? (refs.get(e.override_id) ?? null) : null,
      status: e.status,
      workflow_status: e.workflow_status,
      filed_on: byEvent.get(e.id)?.filed_on ?? null,
      acknowledgement_no: byEvent.get(e.id)?.acknowledgement_no ?? null,
    })),
  };
}
