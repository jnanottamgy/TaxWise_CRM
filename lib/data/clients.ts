import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Enums } from "@/lib/database.types";
import type { AppRole } from "@/lib/auth/roles";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import type { ClientPriority, ClientStatus, EntityType, GstRegistration, ServiceType } from "@/lib/domain/enums";
import { SERVICE_TYPES } from "@/lib/domain/enums";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { resolveScaleParams, type TaxAuditParams } from "@/lib/domain/scale";
import { formatSeriesNumber } from "@/lib/domain/numbering";
import {
  EXPORT_MAX_ROWS,
  type ClientExportRow,
  type ClientListFilter,
  type ClientListSort,
} from "@/lib/schemas/clients";
import {
  NOTIFY_CHANNELS,
  turnoverFyStarts,
  type LeadForOnboarding,
  type NotifyChannel,
  type QuotationForOnboarding,
  type ScaleContext,
} from "@/lib/schemas/onboarding";
import { readWhatsAppSignaturePreference } from "@/lib/schemas/profile";
import { todayIST, type DateString } from "@/lib/domain/fy";

/**
 * Reads for the client list (§7.3.1), the onboarding wizard (§7.3.2) and the import/export
 * (§7.3.4). Everything runs under the caller's session, so RLS decides the rows: an Employee sees
 * only clients they own, are on the team of, or cover (§4.1); `clients_list.outstanding` is null for
 * them (0110), and fee columns are never selected for them.
 */

// =================================================================================================
// The list
// =================================================================================================

export type ClientListRow = {
  id: string;
  client_code: string;
  display_name: string;
  legal_name: string | null;
  entity_type: EntityType | null;
  entity_type_other: string | null;
  pan: string | null;
  gstin: string | null;
  tan: string | null;
  gst_registration: GstRegistration;
  effective_gst_scheme: string | null;
  state_code: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  status: ClientStatus;
  priority: ClientPriority;
  owner_employee_id: string | null;
  owner_name: string | null;
  group_id: string | null;
  group_name: string | null;
  service_types: ServiceType[];
  next_due_date: string | null;
  next_due_title: string | null;
  open_tasks: number;
  overdue_tasks: number;
  /** Partner/Manager only; null for Employees (§4.1). */
  outstanding: number | string | null;
  has_overdue_invoices: boolean | null;
  last_contact_at: string | null;
  has_portal: boolean;
  whatsapp_group_status: string;
  unreachable: boolean;
  covered_now: boolean;
  onboarded_at: string | null;
  updated_at: string;
};

const LIST_COLUMNS =
  "id, client_code, display_name, legal_name, entity_type, entity_type_other, pan, gstin, tan, gst_registration, effective_gst_scheme, state_code, email, phone, whatsapp, city, status, priority, owner_employee_id, owner_name, group_id, group_name, service_types, next_due_date, next_due_title, open_tasks, overdue_tasks, outstanding, has_overdue_invoices, last_contact_at, has_portal, whatsapp_group_status, unreachable, covered_now, onboarded_at, updated_at";

/** The same columns without money, for Employees (the view returns null for them anyway). */
const LIST_COLUMNS_NO_MONEY = LIST_COLUMNS.replace(", outstanding, has_overdue_invoices", "");

type ListRowDb = Record<string, unknown>;

function mapRow(r: ListRowDb, seesMoney: boolean): ClientListRow {
  const s = (k: string) => (r[k] as string | null | undefined) ?? null;
  return {
    id: r.id as string,
    client_code: (r.client_code as string) ?? "",
    display_name: (r.display_name as string) ?? "",
    legal_name: s("legal_name"),
    entity_type: (r.entity_type as EntityType | null) ?? null,
    entity_type_other: s("entity_type_other"),
    pan: s("pan"),
    gstin: s("gstin"),
    tan: s("tan"),
    gst_registration: ((r.gst_registration as GstRegistration | null) ?? "unknown"),
    effective_gst_scheme: s("effective_gst_scheme"),
    state_code: s("state_code"),
    email: s("email"),
    phone: s("phone"),
    whatsapp: s("whatsapp"),
    city: s("city"),
    status: (r.status as ClientStatus) ?? "pending",
    priority: (r.priority as ClientPriority) ?? "medium",
    owner_employee_id: s("owner_employee_id"),
    owner_name: s("owner_name"),
    group_id: s("group_id"),
    group_name: s("group_name"),
    service_types: ((r.service_types as ServiceType[] | null) ?? []).filter((x) => (SERVICE_TYPES as readonly string[]).includes(x)),
    next_due_date: s("next_due_date"),
    next_due_title: s("next_due_title"),
    open_tasks: Number(r.open_tasks ?? 0),
    overdue_tasks: Number(r.overdue_tasks ?? 0),
    outstanding: seesMoney ? ((r.outstanding as number | string | null) ?? 0) : null,
    has_overdue_invoices: seesMoney ? Boolean(r.has_overdue_invoices) : null,
    last_contact_at: s("last_contact_at"),
    has_portal: Boolean(r.has_portal),
    whatsapp_group_status: (r.whatsapp_group_status as string) ?? "none",
    unreachable: Boolean(r.unreachable),
    covered_now: Boolean(r.covered_now),
    onboarded_at: s("onboarded_at"),
    updated_at: (r.updated_at as string) ?? "",
  };
}

/** Characters that would break a PostgREST or() filter are replaced by spaces. */
function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

const SORT_COLUMN: Record<ClientListSort, string> = {
  display_name: "display_name",
  client_code: "client_code",
  status: "status",
  priority: "priority",
  owner_name: "owner_name",
  group_name: "group_name",
  next_due_date: "next_due_date",
  open_tasks: "open_tasks",
  outstanding: "outstanding",
  last_contact_at: "last_contact_at",
  onboarded_at: "onboarded_at",
};

export type ClientListOptions = {
  seesMoney: boolean;
  /** Only these clients (a bulk export of a selection). */
  ids?: readonly string[];
  now?: Date;
};

type FilterBuilder = {
  or(filters: string): FilterBuilder;
  in(column: string, values: readonly string[]): FilterBuilder;
  eq(column: string, value: unknown): FilterBuilder;
  gt(column: string, value: unknown): FilterBuilder;
  gte(column: string, value: unknown): FilterBuilder;
  is(column: string, value: null | boolean): FilterBuilder;
  overlaps(column: string, value: readonly string[]): FilterBuilder;
};

/** Applies search and filters to a clients_list query (shared by the page and the export). */
function applyFilters<Q extends FilterBuilder>(query: Q, t: Pick<TableParams<string, ClientListFilter>, "q" | "filters">, opts: ClientListOptions): Q {
  let q = query.is("deleted_at", null) as Q;
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(
      ["display_name", "legal_name", "client_code", "pan", "gstin", "email", "phone", "whatsapp", "city"].map((c) => `${c}.ilike.${like}`).join(","),
    ) as Q;
  }
  const f = t.filters;
  if (f.status) q = q.in("status", f.status) as Q;
  if (f.priority) q = q.in("priority", f.priority) as Q;
  if (f.owner) {
    const ids = f.owner.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    if (f.owner.includes("none")) q = q.or(ids.length ? `owner_employee_id.is.null,owner_employee_id.in.(${ids.join(",")})` : "owner_employee_id.is.null") as Q;
    else if (ids.length) q = q.in("owner_employee_id", ids) as Q;
  }
  if (f.service) q = q.overlaps("service_types", f.service) as Q;
  if (f.entity) q = q.in("entity_type", f.entity) as Q;
  if (f.gst) {
    const plain = f.gst.filter((v) => v !== "missing_gstin");
    const parts = [
      plain.length ? `gst_registration.in.(${plain.join(",")})` : null,
      f.gst.includes("missing_gstin") ? "and(gst_registration.eq.registered,gstin.is.null)" : null,
    ].filter((p): p is string => p !== null);
    q = q.or(parts.join(",")) as Q;
  }
  if (f.scheme) q = q.in("effective_gst_scheme", f.scheme) as Q;
  if (f.group) {
    const ids = f.group.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    if (f.group.includes("none")) q = q.or(ids.length ? `group_id.is.null,group_id.in.(${ids.join(",")})` : "group_id.is.null") as Q;
    else if (ids.length) q = q.in("group_id", ids) as Q;
  }
  if (f.onboarded) {
    const days = Math.max(...f.onboarded.map(Number));
    const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
    q = q.gte("onboarded_at", since) as Q;
  }
  if (f.whatsapp) q = q.in("whatsapp_group_status", f.whatsapp) as Q;
  for (const flag of f.flag ?? []) {
    if (flag === "overdue_tasks") q = q.gt("overdue_tasks", 0) as Q;
    else if (flag === "overdue_invoices" && opts.seesMoney) q = q.eq("has_overdue_invoices", true) as Q;
    else if (flag === "unreachable") q = q.eq("unreachable", true) as Q;
    else if (flag === "covered_now") q = q.eq("covered_now", true) as Q;
  }
  if (opts.ids) q = q.in("id", opts.ids) as Q;
  return q;
}

/** One page of the client list (§7.3.1), sorted, searched and filtered in SQL (§2.3). */
export async function listClients(
  supabase: ServerSupabase,
  t: TableParams<ClientListSort, ClientListFilter>,
  opts: ClientListOptions,
): Promise<{ rows: ClientListRow[]; total: number }> {
  if (opts.ids && opts.ids.length === 0) return { rows: [], total: 0 };
  let q = supabase.from("clients_list").select(opts.seesMoney ? LIST_COLUMNS : LIST_COLUMNS_NO_MONEY, { count: "exact" });
  q = applyFilters(q as unknown as FilterBuilder, t, opts) as unknown as typeof q;
  const sort = t.sort && (t.sort !== "outstanding" || opts.seesMoney) ? t.sort : "display_name";
  q = q.order(SORT_COLUMN[sort], { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "display_name") q = q.order("display_name", { ascending: true });
  q = q.order("id", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as unknown as ListRowDb[]).map((r) => mapRow(r, opts.seesMoney)), total: count ?? 0 };
}

/** Every client of the current view for an export (§7.3.4), up to EXPORT_MAX_ROWS. */
export async function listClientsForExport(
  supabase: ServerSupabase,
  t: Pick<TableParams<ClientListSort, ClientListFilter>, "q" | "filters" | "sort" | "dir">,
  opts: ClientListOptions,
): Promise<{ rows: ClientExportRow[]; truncated: boolean }> {
  if (opts.ids && opts.ids.length === 0) return { rows: [], truncated: false };
  let q = supabase.from("clients_list").select(opts.seesMoney ? LIST_COLUMNS : LIST_COLUMNS_NO_MONEY);
  q = applyFilters(q as unknown as FilterBuilder, t, opts) as unknown as typeof q;
  const sort = t.sort && (t.sort !== "outstanding" || opts.seesMoney) ? t.sort : "display_name";
  q = q.order(SORT_COLUMN[sort], { ascending: t.dir === "asc", nullsFirst: false }).order("display_name").order("id");
  const { data, error } = await q.range(0, EXPORT_MAX_ROWS);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as ListRowDb[]).map((r) => mapRow(r, opts.seesMoney));
  return { rows: rows.slice(0, EXPORT_MAX_ROWS), truncated: rows.length > EXPORT_MAX_ROWS };
}

/** Counts for the header and the banner (§7.3.1 "N clients can't be reached"). */
export async function getClientListSummary(supabase: ServerSupabase): Promise<{ total: number; pending: number; unreachable: number }> {
  const base = () => supabase.from("clients_list").select("id", { count: "exact", head: true }).is("deleted_at", null);
  const [all, pending, unreachable] = await Promise.all([base(), base().eq("status", "pending"), base().eq("unreachable", true)]);
  for (const r of [all, pending, unreachable]) if (r.error) throw r.error;
  return { total: all.count ?? 0, pending: pending.count ?? 0, unreachable: unreachable.count ?? 0 };
}

// =================================================================================================
// Options
// =================================================================================================

export type StaffOption = { id: string; name: string; role: AppRole; designation: string | null };

/**
 * Active team members for owner and team pickers. Partners and Managers read employees with their
 * profile's role (the authority, §0.1 rule 9); everyone else gets the directory (no roles).
 */
export async function listStaffOptions(supabase: ServerSupabase, viewerRole: AppRole): Promise<StaffOption[]> {
  if (viewerRole === "partner" || viewerRole === "manager") {
    const { data, error } = await supabase
      .from("employees")
      .select("id, full_name, designation, staff_role, is_active, deleted_at, profiles(role, is_active)")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name");
    if (error) throw error;
    return (data ?? [])
      .filter((e) => {
        const p = e.profiles as { role: AppRole; is_active: boolean } | null;
        return !p || p.is_active;
      })
      .map((e) => {
        const p = e.profiles as { role: AppRole } | null;
        return { id: e.id, name: e.full_name, role: (p?.role ?? e.staff_role) as AppRole, designation: e.designation };
      });
  }
  const { data, error } = await supabase.from("employee_directory").select("id, full_name, designation, is_active").order("full_name");
  if (error) throw error;
  return (data ?? []).filter((e) => e.is_active).map((e) => ({ id: e.id as string, name: e.full_name ?? "", role: "employee" as AppRole, designation: e.designation }));
}

export type GroupOption = { id: string; name: string };

export async function listGroupOptions(supabase: ServerSupabase): Promise<GroupOption[]> {
  const { data, error } = await supabase.from("client_groups").select("id, name").order("name").limit(1000);
  if (error) throw error;
  return (data ?? []).map((g) => ({ id: g.id, name: String(g.name) }));
}

export type SavedClientView = { id: string; name: string; query: string; shared: boolean; mine: boolean };

/** Saved views of the client list (§3.4): the user's own and the ones shared firm-wide. */
export async function listClientViews(supabase: ServerSupabase, userId: string): Promise<SavedClientView[]> {
  const { data, error } = await supabase.from("saved_views").select("id, name, filters, is_shared, user_id").eq("page", "clients").order("name").limit(100);
  if (error) throw error;
  return (data ?? []).map((v) => {
    const f = v.filters as { query?: unknown } | null;
    return { id: v.id, name: v.name, query: typeof f?.query === "string" ? f.query : "", shared: v.is_shared, mine: v.user_id === userId };
  });
}

// =================================================================================================
// Onboarding wizard context (§7.3.2)
// =================================================================================================

/**
 * The client code to suggest (§5.3 "auto-suggested TW-C-0001; editable"): the series' next value,
 * skipping codes already taken. The real number is taken at Complete, from the locked series, when
 * the suggestion is kept (onboard_client, 0111).
 */
export async function suggestClientCode(supabase: ServerSupabase): Promise<string> {
  const [{ data: fs }, { data: series }] = await Promise.all([
    supabase.from("firm_settings").select("client_code_prefix").eq("id", 1).maybeSingle(),
    supabase.from("number_series").select("next_value").eq("key", "client_code").maybeSingle(),
  ]);
  const prefix = fs?.client_code_prefix?.trim() || "TW-C";
  let seq = series?.next_value ?? 1;
  for (let i = 0; i < 20; i++) {
    const code = formatSeriesNumber("client_code", { prefix, seq });
    const { count } = await supabase.from("clients").select("id", { count: "exact", head: true }).eq("client_code", code);
    if (!count) return code;
    seq++;
  }
  return formatSeriesNumber("client_code", { prefix, seq });
}

export type WizardContext = {
  today: DateString;
  clientCode: string;
  reminderDays: number;
  notifyChannels: NotifyChannel[];
  staff: StaffOption[];
  groups: GroupOption[];
  scale: ScaleContext;
  /** SAC per service from Settings → Billing (§6.4), for the "SAC override" hint. */
  sacByService: Partial<Record<ServiceType, string>>;
  defaultSac: string;
};

function parseSacMap(value: unknown): Partial<Record<ServiceType, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<ServiceType, string>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((SERVICE_TYPES as readonly string[]).includes(k) && typeof v === "string" && /^\d{4,8}$/.test(v)) out[k as ServiceType] = v;
  }
  return out;
}

/** The statutory parameter rows the §6.6 decisions read (§5.12). */
export async function loadScaleParameterRows(supabase: ServerSupabase): Promise<StatutoryParameterRow[]> {
  const { data, error } = await supabase
    .from("statutory_parameters")
    .select("key, value, effective_from, effective_to, verified")
    .or("key.like.gst.%,key.like.itr.%,key.like.roc.%");
  if (error) throw error;
  return (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
}

export function scaleContextFrom(rows: readonly StatutoryParameterRow[], today: DateString): ScaleContext {
  const now = resolveScaleParams(rows, today);
  const byFy: Record<string, TaxAuditParams> = {};
  for (const [fy, start] of Object.entries(turnoverFyStarts(today))) byFy[fy] = resolveScaleParams(rows, start).taxAudit;
  return { qrmpMaxTurnoverPaise: now.qrmpMaxTurnoverPaise, taxAuditByFy: byFy };
}

export async function getWizardContext(supabase: ServerSupabase, viewerRole: AppRole): Promise<WizardContext> {
  const today = todayIST();
  const [settings, code, staff, groups, params] = await Promise.all([
    supabase.from("firm_settings").select("compliance_reminder_days, client_notify_channels, sac_by_service, default_sac").eq("id", 1).maybeSingle(),
    suggestClientCode(supabase),
    listStaffOptions(supabase, viewerRole),
    listGroupOptions(supabase),
    loadScaleParameterRows(supabase),
  ]);
  if (settings.error) throw settings.error;
  const fs = settings.data;
  const channels = ((fs?.client_notify_channels as string[] | null) ?? ["email", "whatsapp"]).filter((c): c is NotifyChannel =>
    (NOTIFY_CHANNELS as readonly string[]).includes(c),
  );
  return {
    today,
    clientCode: code,
    reminderDays: Math.min(60, Math.max(1, fs?.compliance_reminder_days ?? 7)),
    notifyChannels: channels,
    staff,
    groups,
    scale: scaleContextFrom(params, today),
    sacByService: parseSacMap(fs?.sac_by_service),
    defaultSac: fs?.default_sac ?? "9982",
  };
}

/** A quotation and its lines, for pre-filling the wizard (Partner/Manager; quotations are money, §4.1). */
export async function getQuotationForOnboarding(supabase: ServerSupabase, id: string): Promise<QuotationForOnboarding | null> {
  const { data, error } = await supabase
    .from("quotations")
    .select(
      "id, quotation_number, status, lead_id, client_id, converted_client_id, client_name, client_email, client_phone, client_company, client_gstin, place_of_supply_code, deleted_at, quotation_items(id, description, service_type, frequency, quantity, unit_price, sort_order)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.deleted_at) return null;
  const items = [...((data.quotation_items as QuotationForOnboarding["items"] & Array<{ sort_order: number }>) ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  return {
    id: data.id,
    quotation_number: data.quotation_number,
    status: data.status,
    lead_id: data.lead_id,
    client_id: data.client_id,
    converted_client_id: data.converted_client_id,
    client_name: data.client_name,
    client_email: data.client_email,
    client_phone: data.client_phone,
    client_company: data.client_company,
    client_gstin: data.client_gstin,
    place_of_supply_code: data.place_of_supply_code,
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      service_type: i.service_type,
      frequency: i.frequency,
      quantity: i.quantity,
      unit_price: i.unit_price,
    })),
  };
}

export async function getLeadForOnboarding(supabase: ServerSupabase, id: string): Promise<LeadForOnboarding | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, lead_number, status, name, company, email, phone, whatsapp, services_required, requirement_notes, converted_client_id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.deleted_at) return null;
  return {
    id: data.id,
    lead_number: data.lead_number,
    status: data.status,
    name: data.name,
    company: data.company,
    email: data.email,
    phone: data.phone,
    whatsapp: data.whatsapp,
    services_required: (data.services_required ?? []) as ServiceType[],
    requirement_notes: data.requirement_notes,
    converted_client_id: data.converted_client_id,
  };
}

/** A client's code and name (for "already converted to …" links). */
export async function getClientLabel(supabase: ServerSupabase, id: string): Promise<{ id: string; client_code: string; display_name: string } | null> {
  const { data, error } = await supabase.from("clients").select("id, client_code, display_name").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, client_code: String(data.client_code), display_name: data.display_name } : null;
}

// =================================================================================================
// Messaging context for the list's WhatsApp and email row actions (§7.13.2)
// =================================================================================================

export type MessageTemplateRow = { id: string; name: string; type: Enums<"template_type">; channel: string; subject: string | null; body: string };

export type MessagingContext = {
  firmName: string;
  firmPhone: string | null;
  countryCode: string;
  signatureFormat: string;
  /** The signed-in person adds their signature to WhatsApp drafts (§7.25.10). */
  addSignature: boolean;
  senderName: string;
  templates: MessageTemplateRow[];
};

const MONEY_TEMPLATE_TYPES: ReadonlyArray<Enums<"template_type">> = ["payment_reminder", "quotation"];

/** Firm details and active templates for hand-off drafts; money templates only for Partners/Managers (§4.1). */
export async function getMessagingContext(
  supabase: ServerSupabase,
  user: { role: AppRole; fullName: string; preferences: Record<string, unknown> },
): Promise<MessagingContext> {
  const [settings, templates] = await Promise.all([
    supabase.from("firm_settings").select("firm_name, phone, whatsapp_country_code, whatsapp_signature").eq("id", 1).maybeSingle(),
    supabase.from("message_templates").select("id, name, type, channel, subject, body").eq("is_active", true).order("name").limit(200),
  ]);
  if (settings.error) throw settings.error;
  if (templates.error) throw templates.error;
  const seesMoney = user.role === "partner" || user.role === "manager";
  return {
    firmName: settings.data?.firm_name ?? "TaxWise Consultants",
    firmPhone: settings.data?.phone ?? null,
    countryCode: settings.data?.whatsapp_country_code ?? "91",
    signatureFormat: settings.data?.whatsapp_signature ?? "– {first_name}",
    addSignature: readWhatsAppSignaturePreference(user.preferences, user.role),
    senderName: user.fullName,
    templates: (templates.data ?? [])
      .filter((t) => seesMoney || !MONEY_TEMPLATE_TYPES.includes(t.type))
      .map((t) => ({ id: t.id, name: String(t.name), type: t.type, channel: t.channel, subject: t.subject, body: t.body })),
  };
}

/** Primary contacts of the clients on a page (one query), for row hand-offs (§7.13.2). */
export async function getPrimaryContacts(
  supabase: ServerSupabase,
  clientIds: readonly string[],
): Promise<Map<string, { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null }>> {
  const out = new Map<string, { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null }>();
  if (clientIds.length === 0) return out;
  const { data, error } = await supabase
    .from("client_contacts")
    .select("id, client_id, name, email, phone, whatsapp, is_primary")
    .in("client_id", clientIds as string[])
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  for (const c of data ?? []) {
    if (!out.has(c.client_id)) out.set(c.client_id, { id: c.id, name: c.name, email: c.email, phone: c.phone, whatsapp: c.whatsapp });
  }
  return out;
}

// =================================================================================================
// Import lookups (§7.3.4)
// =================================================================================================

/** What the database holds for the identifiers in an import file (recycled clients included; Partner/Manager see them all). */
export async function getImportContext(
  supabase: ServerSupabase,
  lookups: { codes: string[]; pans: string[]; gstins: string[] },
): Promise<{
  existingCodes: Set<string>;
  existingPans: Map<string, string>;
  existingGstins: Map<string, string>;
  owners: Map<string, { id: string; name: string }>;
  groups: Map<string, { id: string; name: string }>;
}> {
  const chunks = <T,>(xs: T[], n = 200) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const existingCodes = new Set<string>();
  const existingPans = new Map<string, string>();
  const existingGstins = new Map<string, string>();
  for (const part of chunks(lookups.codes)) {
    const { data, error } = await supabase.from("clients").select("client_code").in("client_code", part);
    if (error) throw error;
    for (const r of data ?? []) existingCodes.add(String(r.client_code).toUpperCase());
  }
  for (const part of chunks(lookups.pans)) {
    const { data, error } = await supabase.from("clients").select("pan, client_code").in("pan", part);
    if (error) throw error;
    for (const r of data ?? []) if (r.pan) existingPans.set(String(r.pan).toUpperCase(), String(r.client_code));
  }
  for (const part of chunks(lookups.gstins)) {
    const { data, error } = await supabase.from("clients").select("gstin, client_code").in("gstin", part);
    if (error) throw error;
    for (const r of data ?? []) if (r.gstin) existingGstins.set(String(r.gstin).toUpperCase(), String(r.client_code));
  }
  const [emps, groups] = await Promise.all([
    supabase.from("employees").select("id, full_name, email, is_active, deleted_at").eq("is_active", true).is("deleted_at", null),
    supabase.from("client_groups").select("id, name"),
  ]);
  if (emps.error) throw emps.error;
  if (groups.error) throw groups.error;
  return {
    existingCodes,
    existingPans,
    existingGstins,
    owners: new Map((emps.data ?? []).map((e) => [String(e.email).toLowerCase(), { id: e.id, name: e.full_name }])),
    groups: new Map((groups.data ?? []).map((g) => [String(g.name).toLowerCase(), { id: g.id, name: String(g.name) }])),
  };
}

// =================================================================================================
// Rows for actions
// =================================================================================================

/** The facts the status, delete and bulk actions need about a few clients. */
export async function getClientsBrief(
  supabase: ServerSupabase,
  ids: readonly string[],
): Promise<Array<{ id: string; client_code: string; display_name: string; status: ClientStatus; owner_employee_id: string | null; group_id: string | null; updated_at: string; deleted_at: string | null }>> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("clients")
    .select("id, client_code, display_name, status, owner_employee_id, group_id, updated_at, deleted_at")
    .in("id", ids as string[]);
  if (error) throw error;
  return (data ?? []).map((c) => ({ ...c, client_code: String(c.client_code) }));
}

/** Unpaid issued invoices of a client (the delete guard's message, §7.3.4). Partner/Manager only. */
export async function getUnpaidInvoices(supabase: ServerSupabase, clientId: string): Promise<{ count: number; outstanding: number }> {
  const { data, error } = await supabase
    .from("invoices")
    .select("outstanding_amount")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .is("cancelled_at", null)
    .in("status", ["sent", "partially_paid", "disputed"])
    .gt("outstanding_amount", 0);
  if (error) throw error;
  const rows = data ?? [];
  return { count: rows.length, outstanding: rows.reduce((s, r) => s + Number(r.outstanding_amount ?? 0), 0) };
}
