import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Enums } from "@/lib/database.types";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { LEAD_STATUSES, type LeadSource, type LeadStatus, type QuotationStatus, type ServiceType } from "@/lib/domain/enums";
import { toPaiseOrNull, type Paise } from "@/lib/domain/money";
import { BOARD_COLUMN_LIMIT, type LeadFilter, type LeadSort } from "@/lib/schemas/leads";

/**
 * Reads for leads (§7.5.1): the table, the pipeline board, one lead with its timeline, quotations
 * and conflict checks, and the analytics. Partners and Managers only: leads are money-side, so RLS
 * (0034) gives an Employee no row anywhere (§4.1).
 */

export type LeadListRow = {
  id: string;
  lead_number: string | null;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  services_required: ServiceType[];
  source: LeadSource;
  source_detail: string | null;
  status: LeadStatus;
  estimated_value: number | null;
  assigned_to: string | null;
  assigned_name: string | null;
  next_follow_up_at: string | null;
  lost_reason: string | null;
  lost_category: string | null;
  converted_client_id: string | null;
  converted_client_name: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  status_changed_at: string;
  is_stale: boolean;
  follow_up_overdue: boolean;
  open_quotations: number;
  open_quotation_value: number;
  latest_quotation_id: string | null;
  latest_quotation_number: string | null;
  latest_quotation_status: QuotationStatus | null;
};

const LIST_COLUMNS =
  "id, lead_number, name, company, email, phone, whatsapp, services_required, source, source_detail, status, estimated_value, assigned_to, assigned_name, next_follow_up_at, lost_reason, lost_category, converted_client_id, converted_client_name, created_at, updated_at, last_activity_at, status_changed_at, is_stale, follow_up_overdue, open_quotations, open_quotation_value, latest_quotation_id, latest_quotation_number, latest_quotation_status, deleted_at";

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

function mapRow(r: Record<string, unknown>): LeadListRow {
  return {
    id: r.id as string,
    lead_number: (r.lead_number as string | null) ?? null,
    name: (r.name as string) ?? "",
    company: (r.company as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    whatsapp: (r.whatsapp as string | null) ?? null,
    services_required: ((r.services_required as ServiceType[] | null) ?? []) as ServiceType[],
    source: r.source as LeadSource,
    source_detail: (r.source_detail as string | null) ?? null,
    status: r.status as LeadStatus,
    estimated_value: r.estimated_value === null || r.estimated_value === undefined ? null : Number(r.estimated_value),
    assigned_to: (r.assigned_to as string | null) ?? null,
    assigned_name: (r.assigned_name as string | null) ?? null,
    next_follow_up_at: (r.next_follow_up_at as string | null) ?? null,
    lost_reason: (r.lost_reason as string | null) ?? null,
    lost_category: (r.lost_category as string | null) ?? null,
    converted_client_id: (r.converted_client_id as string | null) ?? null,
    converted_client_name: (r.converted_client_name as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    last_activity_at: r.last_activity_at as string,
    status_changed_at: r.status_changed_at as string,
    is_stale: Boolean(r.is_stale),
    follow_up_overdue: Boolean(r.follow_up_overdue),
    open_quotations: Number(r.open_quotations ?? 0),
    open_quotation_value: Number(r.open_quotation_value ?? 0),
    latest_quotation_id: (r.latest_quotation_id as string | null) ?? null,
    latest_quotation_number: (r.latest_quotation_number as string | null) ?? null,
    latest_quotation_status: (r.latest_quotation_status as QuotationStatus | null) ?? null,
  };
}

const SORT_COLUMN: Record<LeadSort, string> = {
  name: "name",
  lead_number: "lead_number",
  status: "status",
  source: "source",
  estimated_value: "estimated_value",
  next_follow_up_at: "next_follow_up_at",
  last_activity_at: "last_activity_at",
  created_at: "created_at",
  assigned_name: "assigned_name",
};

type Filterable = {
  or(filters: string): Filterable;
  in(column: string, values: readonly string[]): Filterable;
  eq(column: string, value: unknown): Filterable;
  gt(column: string, value: unknown): Filterable;
  is(column: string, value: null | boolean): Filterable;
  overlaps(column: string, value: readonly string[]): Filterable;
};

function applyFilters<Q extends Filterable>(query: Q, t: Pick<TableParams<LeadSort, LeadFilter>, "q" | "filters">, opts: { exceptStatus?: boolean } = {}): Q {
  let q = query.is("deleted_at", null) as Q;
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(["name", "company", "email", "phone", "whatsapp", "lead_number", "source_detail"].map((c) => `${c}.ilike.${like}`).join(",")) as Q;
  }
  const f = t.filters;
  if (f.status && !opts.exceptStatus) q = q.in("status", f.status) as Q;
  if (f.source) q = q.in("source", f.source) as Q;
  if (f.service) q = q.overlaps("services_required", f.service) as Q;
  if (f.assigned) {
    const ids = f.assigned.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    if (f.assigned.includes("none")) q = q.or(ids.length ? `assigned_to.is.null,assigned_to.in.(${ids.join(",")})` : "assigned_to.is.null") as Q;
    else if (ids.length) q = q.in("assigned_to", ids) as Q;
  }
  for (const flag of f.flag ?? []) {
    if (flag === "stale") q = q.eq("is_stale", true) as Q;
    else if (flag === "follow_up_due") q = q.eq("follow_up_overdue", true) as Q;
    else if (flag === "unassigned") q = q.is("assigned_to", null) as Q;
    else if (flag === "with_quotation") q = q.gt("open_quotations", 0) as Q;
  }
  return q;
}

/** One page of the leads table (§2.3). */
export async function listLeads(supabase: ServerSupabase, t: TableParams<LeadSort, LeadFilter>): Promise<{ rows: LeadListRow[]; total: number }> {
  let q = supabase.from("leads_list").select(LIST_COLUMNS, { count: "exact" });
  q = applyFilters(q as unknown as Filterable, t) as unknown as typeof q;
  const sort = t.sort ?? "last_activity_at";
  q = q.order(SORT_COLUMN[sort], { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "created_at") q = q.order("created_at", { ascending: false });
  q = q.order("id");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []).map((r) => mapRow(r as Record<string, unknown>)), total: count ?? 0 };
}

export type BoardColumn = { status: LeadStatus; total: number; valuePaise: Paise; rows: LeadListRow[] };

/**
 * The pipeline board (§7.5.1): a column per stage with its count, the estimated value of the
 * leads in it, and up to BOARD_COLUMN_LIMIT cards (follow-ups due first, then the most recently
 * active). Won and Lost show the most recently closed. The table filters apply, except the stage.
 */
export async function getLeadBoard(supabase: ServerSupabase, t: Pick<TableParams<LeadSort, LeadFilter>, "q" | "filters">): Promise<BoardColumn[]> {
  const statuses = t.filters.status?.length ? LEAD_STATUSES.filter((s) => t.filters.status!.includes(s)) : [...LEAD_STATUSES];
  return Promise.all(
    statuses.map(async (status) => {
      let q = supabase.from("leads_list").select(LIST_COLUMNS, { count: "exact" });
      q = applyFilters(q as unknown as Filterable, t, { exceptStatus: true }) as unknown as typeof q;
      q = q.eq("status", status);
      q = status === "won" || status === "lost" ? q.order("status_changed_at", { ascending: false }) : q.order("next_follow_up_at", { ascending: true, nullsFirst: false }).order("last_activity_at", { ascending: false });
      const { data, error, count } = await q.order("id").range(0, BOARD_COLUMN_LIMIT - 1);
      if (error) throw error;
      const rows = (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
      // The column's value: the estimated value of every lead in it (not just the cards shown).
      let vq = supabase.from("leads_list").select("estimated_value");
      vq = applyFilters(vq as unknown as Filterable, t, { exceptStatus: true }) as unknown as typeof vq;
      const { data: values, error: vErr } = await vq.eq("status", status).limit(5000);
      if (vErr) throw vErr;
      const valuePaise = (values ?? []).reduce((n, v) => n + (toPaiseOrNull(v.estimated_value as number | null) ?? 0), 0);
      return { status, total: count ?? rows.length, valuePaise, rows };
    }),
  );
}

export type LeadSummary = { open: number; stale: number; followUpsDue: number; unassigned: number };

export async function getLeadSummary(supabase: ServerSupabase): Promise<LeadSummary> {
  const base = () => supabase.from("leads_list").select("id", { count: "exact", head: true }).is("deleted_at", null).not("status", "in", "(won,lost)");
  const [open, stale, due, unassigned] = await Promise.all([base(), base().eq("is_stale", true), base().eq("follow_up_overdue", true), base().is("assigned_to", null)]);
  for (const r of [open, stale, due, unassigned]) if (r.error) throw r.error;
  return { open: open.count ?? 0, stale: stale.count ?? 0, followUpsDue: due.count ?? 0, unassigned: unassigned.count ?? 0 };
}

// =================================================================================================
// One lead
// =================================================================================================

export type LeadTimelineRow = { id: string; event_type: string; title: string; description: string | null; created_at: string; performed_by_name: string | null };

export type LeadQuotationRow = {
  id: string;
  quotation_number: string;
  status: QuotationStatus;
  total: number;
  issue_date: string;
  valid_until: string;
  sent_at: string | null;
  last_viewed_at: string | null;
  is_lapsed: boolean;
  revision_number: number;
};

export type LeadAcceptanceRow = { id: string; outcome: Enums<"acceptance_outcome">; decided_at: string | null; decided_by_name: string | null; conflict_count: number; rationale: string | null; created_at: string; prospect_name: string };

export type LeadDetail = {
  lead: LeadListRow & { requirement_notes: string | null; created_by_name: string | null };
  timeline: LeadTimelineRow[];
  quotations: LeadQuotationRow[];
  acceptances: LeadAcceptanceRow[];
};

export async function getLeadDetail(supabase: ServerSupabase, id: string): Promise<LeadDetail | null> {
  const { data, error } = await supabase.from("leads_list").select(`${LIST_COLUMNS}, requirement_notes, created_by_name`).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || (data as { deleted_at: string | null }).deleted_at) return null;
  const [timeline, quotations, acceptances] = await Promise.all([
    supabase.from("client_timeline_events").select("id, event_type, title, description, created_at, performed_by").eq("lead_id", id).order("created_at", { ascending: false }).limit(100),
    supabase
      .from("quotations_list")
      .select("id, quotation_number, status, total, issue_date, valid_until, sent_at, last_viewed_at, is_lapsed, revision_number")
      .eq("lead_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("client_acceptances_list")
      .select("id, outcome, decided_at, decided_by_name, conflict_count, rationale, created_at, prospect_name")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  for (const r of [timeline, quotations, acceptances]) if (r.error) throw r.error;
  const performers = [...new Set((timeline.data ?? []).map((t) => t.performed_by).filter((v): v is string => Boolean(v)))];
  const people = new Map<string, string>();
  if (performers.length) {
    const { data: p, error: pErr } = await supabase.from("profiles").select("id, full_name").in("id", performers);
    if (pErr) throw pErr;
    for (const x of p ?? []) people.set(x.id, x.full_name);
  }
  const row = data as Record<string, unknown>;
  return {
    lead: { ...mapRow(row), requirement_notes: (row.requirement_notes as string | null) ?? null, created_by_name: (row.created_by_name as string | null) ?? null },
    timeline: (timeline.data ?? []).map((t) => ({
      id: t.id,
      event_type: t.event_type,
      title: t.title,
      description: t.description,
      created_at: t.created_at,
      performed_by_name: t.performed_by ? (people.get(t.performed_by) ?? null) : null,
    })),
    quotations: (quotations.data ?? []).map((q) => ({
      id: q.id as string,
      quotation_number: q.quotation_number ?? "",
      status: q.status as QuotationStatus,
      total: Number(q.total ?? 0),
      issue_date: q.issue_date as string,
      valid_until: q.valid_until as string,
      sent_at: q.sent_at,
      last_viewed_at: q.last_viewed_at,
      is_lapsed: Boolean(q.is_lapsed),
      revision_number: Number(q.revision_number ?? 0),
    })),
    acceptances: (acceptances.data ?? []).map((a) => ({
      id: a.id as string,
      outcome: a.outcome as Enums<"acceptance_outcome">,
      decided_at: a.decided_at,
      decided_by_name: a.decided_by_name,
      conflict_count: Number(a.conflict_count ?? 0),
      rationale: a.rationale,
      created_at: a.created_at as string,
      prospect_name: a.prospect_name ?? "",
    })),
  };
}

/** Templates for lead hand-offs ("Lead follow-up", §7.13.2): by name, falling back to the built-in wording. */
export async function getLeadTemplates(supabase: ServerSupabase): Promise<{ whatsapp: { id: string; body: string } | null; email: { id: string; subject: string | null; body: string } | null }> {
  const { data, error } = await supabase.from("message_templates").select("id, name, channel, subject, body").eq("is_active", true).ilike("name", "Lead follow-up%").limit(10);
  if (error) throw error;
  const rows = data ?? [];
  const wa = rows.find((t) => t.channel === "whatsapp") ?? rows.find((t) => t.channel === "any") ?? null;
  const em = rows.find((t) => t.channel === "email") ?? rows.find((t) => t.channel === "any") ?? null;
  return { whatsapp: wa ? { id: wa.id, body: wa.body } : null, email: em ? { id: em.id, subject: em.subject, body: em.body } : null };
}

// =================================================================================================
// Analytics (§7.5.1)
// =================================================================================================

export type LeadAnalytics = {
  from: string;
  to: string;
  leadsCreated: number;
  bySource: Array<{ source: LeadSource; total: number; won: number; lost: number; open: number; estimatedValuePaise: Paise }>;
  byStage: Array<{ status: LeadStatus; total: number; estimatedValuePaise: Paise }>;
  won: number;
  lost: number;
  avgDaysToWin: number | null;
  pipeline: { openCount: number; openValuePaise: Paise };
  quotations: { sent: number; accepted: number; rejected: number; expired: number };
  lossReasons: Array<{ category: string; total: number; examples: string[] }>;
  declineReasons: Array<{ id: string; quotationNumber: string; client: string; reason: string | null; respondedAt: string }>;
};

type RawAnalytics = {
  from: string;
  to: string;
  leads_created: number;
  by_source: Array<{ source: LeadSource; total: number; won: number; lost: number; open: number; estimated_value: number }>;
  by_stage: Array<{ status: LeadStatus; total: number; estimated_value: number }>;
  won: number;
  lost: number;
  avg_days_to_win: number | null;
  pipeline: { open_count: number; open_value: number } | null;
  quotations: { sent: number; accepted: number; rejected: number; expired: number } | null;
  loss_reasons: Array<{ category: string; total: number; examples: Array<string | null> | null }>;
  decline_reasons: Array<{ id: string; quotation_number: string; client: string; rejection_reason: string | null; responded_at: string }>;
};

export async function getLeadAnalytics(supabase: ServerSupabase, from: string, to: string): Promise<LeadAnalytics> {
  const { data, error } = await supabase.rpc("lead_analytics", { p_from: from, p_to: to });
  if (error) throw error;
  const r = (data ?? {}) as unknown as RawAnalytics;
  const paise = (v: number | null | undefined) => toPaiseOrNull(v ?? 0) ?? 0;
  return {
    from: r.from ?? from,
    to: r.to ?? to,
    leadsCreated: Number(r.leads_created ?? 0),
    bySource: (r.by_source ?? []).map((s) => ({ source: s.source, total: s.total, won: s.won, lost: s.lost, open: s.open, estimatedValuePaise: paise(s.estimated_value) })),
    byStage: (r.by_stage ?? []).map((s) => ({ status: s.status, total: s.total, estimatedValuePaise: paise(s.estimated_value) })),
    won: Number(r.won ?? 0),
    lost: Number(r.lost ?? 0),
    avgDaysToWin: r.avg_days_to_win === null || r.avg_days_to_win === undefined ? null : Number(r.avg_days_to_win),
    pipeline: { openCount: Number(r.pipeline?.open_count ?? 0), openValuePaise: paise(r.pipeline?.open_value) },
    quotations: { sent: r.quotations?.sent ?? 0, accepted: r.quotations?.accepted ?? 0, rejected: r.quotations?.rejected ?? 0, expired: r.quotations?.expired ?? 0 },
    lossReasons: (r.loss_reasons ?? []).map((l) => ({ category: l.category, total: l.total, examples: (l.examples ?? []).filter((x): x is string => Boolean(x)) })),
    declineReasons: (r.decline_reasons ?? []).map((d) => ({ id: d.id, quotationNumber: d.quotation_number, client: d.client, reason: d.rejection_reason, respondedAt: d.responded_at })),
  };
}
