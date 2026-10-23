import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Enums, Tables } from "@/lib/database.types";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import type { AppRole, QuotationStatus, ServiceFrequency, ServiceType } from "@/lib/domain/enums";
import { todayIST, type DateString } from "@/lib/domain/fy";
import { toPaiseOrNull, type Paise } from "@/lib/domain/money";
import { isAppRole } from "@/lib/auth/roles";
import { renderTemplate, type TemplateValues } from "@/lib/domain/templates";
import type { DocumentFirm, QuotationDocument, QuotationFilter, QuotationSort } from "@/lib/schemas/quotations";
import { formatFirmAddress, type FirmProfile } from "@/server/firm";
import { quotationDisplayStatus } from "@/lib/schemas/quotations";

/**
 * Reads for quotations (§7.5.2–§7.5.3): the list, one quotation with its lines, sends, follow-ups
 * and history, the builder's context, and the shape the PDF and the pages render. Everything runs
 * under the caller's session: quotations are Partner/Manager only (RLS 0034), so an Employee gets
 * nothing here at all (§4.1).
 */

export type QuotationListRow = {
  id: string;
  quotation_number: string;
  status: QuotationStatus;
  display_status: QuotationStatus;
  client_name: string;
  client_company: string | null;
  client_email: string;
  lead_id: string | null;
  lead_number: string | null;
  client_id: string | null;
  client_code: string | null;
  client_display_name: string | null;
  issue_date: string;
  valid_until: string;
  total: number;
  created_by: string;
  created_by_name: string | null;
  sent_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  responded_at: string | null;
  revision_number: number;
  superseded_by_number: string | null;
  converted_client_id: string | null;
  next_follow_up_at: string | null;
  follow_ups_to_hand_off: number;
  is_lapsed: boolean;
  updated_at: string;
};

const LIST_COLUMNS =
  "id, quotation_number, status, client_name, client_company, client_email, lead_id, lead_number, client_id, client_code, client_display_name, issue_date, valid_until, total, created_by, created_by_name, sent_at, last_viewed_at, view_count, responded_at, revision_number, superseded_by_number, converted_client_id, next_follow_up_at, follow_ups_to_hand_off, is_lapsed, updated_at, deleted_at";

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

const SORT_COLUMN: Record<QuotationSort, string> = {
  quotation_number: "quotation_number",
  client_name: "client_name",
  issue_date: "issue_date",
  valid_until: "valid_until",
  total: "total",
  status: "status",
  sent_at: "sent_at",
  created_at: "created_at",
  last_viewed_at: "last_viewed_at",
};

type Filterable = {
  or(filters: string): Filterable;
  in(column: string, values: readonly string[]): Filterable;
  eq(column: string, value: unknown): Filterable;
  gt(column: string, value: unknown): Filterable;
  is(column: string, value: null | boolean): Filterable;
  not(column: string, op: string, value: unknown): Filterable;
};

function applyFilters<Q extends Filterable>(query: Q, t: Pick<TableParams<QuotationSort, QuotationFilter>, "q" | "filters">, userId: string): Q {
  let q = query.is("deleted_at", null) as Q;
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(["quotation_number", "client_name", "client_company", "client_email", "lead_number", "client_code"].map((c) => `${c}.ilike.${like}`).join(",")) as Q;
  }
  const f = t.filters;
  if (f.status) {
    // "Expired" also finds Sent / Viewed quotations past valid_until that the nightly job hasn't reached.
    if (f.status.includes("expired")) {
      const rest = f.status.filter((s) => s !== "expired");
      q = q.or([`status.eq.expired`, `is_lapsed.eq.true`, ...(rest.length ? [`status.in.(${rest.join(",")})`] : [])].join(",")) as Q;
    } else {
      q = q.in("status", f.status) as Q;
      if (f.status.every((s) => s === "sent" || s === "viewed")) q = q.eq("is_lapsed", false) as Q;
    }
  }
  if (f.author) {
    const ids = f.author.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    if (ids.length) q = q.in("created_by", ids) as Q;
  }
  for (const flag of f.flag ?? []) {
    if (flag === "mine") q = q.eq("created_by", userId) as Q;
    else if (flag === "needs_handoff") q = q.gt("follow_ups_to_hand_off", 0) as Q;
    else if (flag === "lapsed") q = q.eq("is_lapsed", true) as Q;
    else if (flag === "converted") q = q.not("converted_client_id", "is", null) as Q;
    else if (flag === "not_converted") q = q.eq("status", "accepted").is("converted_client_id", null).is("client_id", null) as Q;
  }
  return q;
}

/** One page of quotations, searched, filtered and sorted in SQL (§2.3). */
export async function listQuotations(
  supabase: ServerSupabase,
  t: TableParams<QuotationSort, QuotationFilter>,
  opts: { userId: string; today?: DateString },
): Promise<{ rows: QuotationListRow[]; total: number }> {
  const today = opts.today ?? todayIST();
  let q = supabase.from("quotations_list").select(LIST_COLUMNS, { count: "exact" });
  q = applyFilters(q as unknown as Filterable, t, opts.userId) as unknown as typeof q;
  const sort = t.sort ?? "created_at";
  q = q.order(SORT_COLUMN[sort], { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "created_at") q = q.order("created_at", { ascending: false });
  q = q.order("id", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  const rows = (data ?? []).map((r) => {
    const status = r.status as QuotationStatus;
    return {
      id: r.id as string,
      quotation_number: r.quotation_number ?? "",
      status,
      display_status: quotationDisplayStatus(status, r.valid_until as string, today),
      client_name: r.client_name ?? "",
      client_company: r.client_company,
      client_email: (r.client_email as string) ?? "",
      lead_id: r.lead_id,
      lead_number: r.lead_number,
      client_id: r.client_id,
      client_code: r.client_code,
      client_display_name: r.client_display_name,
      issue_date: r.issue_date as string,
      valid_until: r.valid_until as string,
      total: Number(r.total ?? 0),
      created_by: r.created_by as string,
      created_by_name: r.created_by_name,
      sent_at: r.sent_at,
      last_viewed_at: r.last_viewed_at,
      view_count: Number(r.view_count ?? 0),
      responded_at: r.responded_at,
      revision_number: Number(r.revision_number ?? 0),
      superseded_by_number: r.superseded_by_number,
      converted_client_id: r.converted_client_id,
      next_follow_up_at: r.next_follow_up_at,
      follow_ups_to_hand_off: Number(r.follow_ups_to_hand_off ?? 0),
      is_lapsed: Boolean(r.is_lapsed),
      updated_at: r.updated_at as string,
    } satisfies QuotationListRow;
  });
  return { rows, total: count ?? 0 };
}

export type QuotationSummary = {
  draft: number;
  pendingApproval: number;
  awaitingResponse: number;
  awaitingValuePaise: Paise;
  acceptedNotConverted: number;
  followUpsToHandOff: number;
};

/** Counts for the header and the "needs you" strip. */
export async function getQuotationSummary(supabase: ServerSupabase): Promise<QuotationSummary> {
  const base = () => supabase.from("quotations_list").select("id", { count: "exact", head: true }).is("deleted_at", null);
  const [draft, pending, awaiting, accepted, handoff, values] = await Promise.all([
    base().eq("status", "draft"),
    base().eq("status", "pending_approval"),
    base().in("status", ["sent", "viewed"]).eq("is_lapsed", false),
    base().eq("status", "accepted").is("converted_client_id", null).is("client_id", null),
    base().gt("follow_ups_to_hand_off", 0).in("status", ["sent", "viewed"]),
    supabase.from("quotations_list").select("total").is("deleted_at", null).in("status", ["sent", "viewed"]).eq("is_lapsed", false).limit(5000),
  ]);
  for (const r of [draft, pending, awaiting, accepted, handoff, values]) if (r.error) throw r.error;
  let value = 0;
  for (const row of values.data ?? []) value += toPaiseOrNull(row.total as number | null) ?? 0;
  return {
    draft: draft.count ?? 0,
    pendingApproval: pending.count ?? 0,
    awaitingResponse: awaiting.count ?? 0,
    awaitingValuePaise: value,
    acceptedNotConverted: accepted.count ?? 0,
    followUpsToHandOff: handoff.count ?? 0,
  };
}

/** Authors to filter by: everyone who has prepared a quotation (Partners and Managers). */
export async function listQuotationAuthors(supabase: ServerSupabase): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from("profiles").select("id, full_name, role, is_active").in("role", ["partner", "manager"]).order("full_name").limit(200);
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, name: p.full_name }));
}

// =================================================================================================
// One quotation
// =================================================================================================

export type QuotationItemRow = {
  id: string;
  description: string;
  service_type: ServiceType | null;
  frequency: ServiceFrequency | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  sort_order: number;
};

export type QuotationEmailLogRow = Pick<
  Tables<"quotation_email_logs">,
  "id" | "channel" | "email_type" | "to" | "subject" | "status" | "error" | "sent_at" | "delivered_at" | "opened_at" | "created_at"
>;

export type QuotationFollowUp = Pick<Tables<"quotation_follow_ups">, "id" | "follow_up_day" | "scheduled_at" | "sent_at" | "status" | "notified_at" | "channel" | "note">;

export type QuotationHistoryRow = { id: string; action: string; description: string; user_name: string | null; at: string };

export type QuotationDetail = {
  q: Tables<"quotations"> & {
    created_by_name: string | null;
    created_by_role: AppRole | null;
    approved_by_name: string | null;
    approval_requested_by_name: string | null;
  };
  items: QuotationItemRow[];
  emails: QuotationEmailLogRow[];
  followUps: QuotationFollowUp[];
  history: QuotationHistoryRow[];
  lead: { id: string; lead_number: string | null; name: string; company: string | null; status: Enums<"lead_status">; assigned_to: string | null; whatsapp: string | null; phone: string | null } | null;
  client: { id: string; client_code: string; display_name: string; whatsapp: string | null; phone: string | null } | null;
  convertedClient: { id: string; client_code: string; display_name: string } | null;
  revisedFrom: { id: string; quotation_number: string; status: QuotationStatus } | null;
  supersededBy: { id: string; quotation_number: string; status: QuotationStatus } | null;
};

function itemFrom(r: Record<string, unknown>): QuotationItemRow {
  return {
    id: r.id as string,
    description: (r.description as string) ?? "",
    service_type: (r.service_type as ServiceType | null) ?? null,
    frequency: (r.frequency as ServiceFrequency | null) ?? null,
    quantity: Number(r.quantity ?? 1),
    unit_price: Number(r.unit_price ?? 0),
    tax_rate: Number(r.tax_rate ?? 0),
    tax_amount: Number(r.tax_amount ?? 0),
    total: Number(r.total ?? 0),
    sort_order: Number(r.sort_order ?? 0),
  };
}

async function names(supabase: ServerSupabase, ids: Array<string | null | undefined>): Promise<Map<string, { name: string; role: AppRole | null }>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from("profiles").select("id, full_name, role").in("id", unique);
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.id, { name: p.full_name, role: isAppRole(p.role) ? p.role : null }]));
}

/** The quotation page's data, or null when it doesn't exist (or the caller can't see it). */
export async function getQuotationDetail(supabase: ServerSupabase, id: string): Promise<QuotationDetail | null> {
  const { data: q, error } = await supabase.from("quotations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!q) return null;

  const [items, emails, followUps, history, lead, client, converted, revisedFrom, supersededBy, people] = await Promise.all([
    supabase.from("quotation_items").select("id, description, service_type, frequency, quantity, unit_price, tax_rate, tax_amount, total, sort_order").eq("quotation_id", id).order("sort_order"),
    supabase
      .from("quotation_email_logs")
      .select('id, channel, email_type, "to", subject, status, error, sent_at, delivered_at, opened_at, created_at')
      .eq("quotation_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("quotation_follow_ups").select("id, follow_up_day, scheduled_at, sent_at, status, notified_at, channel, note").eq("quotation_id", id).order("follow_up_day"),
    supabase.from("activity_logs").select("id, action, description, user_name, at").eq("entity_type", "quotation").eq("entity_id", id).order("at", { ascending: false }).limit(50),
    q.lead_id ? supabase.from("leads").select("id, lead_number, name, company, status, assigned_to, whatsapp, phone").eq("id", q.lead_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    q.client_id ? supabase.from("clients").select("id, client_code, display_name, whatsapp, phone").eq("id", q.client_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    q.converted_client_id ? supabase.from("clients").select("id, client_code, display_name").eq("id", q.converted_client_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    q.revised_from_id ? supabase.from("quotations").select("id, quotation_number, status").eq("id", q.revised_from_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from("quotations").select("id, quotation_number, status").eq("revised_from_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    names(supabase, [q.created_by, q.approved_by, q.approval_requested_by]),
  ]);
  for (const r of [items, emails, followUps, history, lead, client, converted, revisedFrom, supersededBy]) if (r.error) throw r.error;

  const who = (pid: string | null) => (pid ? (people.get(pid) ?? null) : null);
  return {
    q: {
      ...q,
      created_by_name: who(q.created_by)?.name ?? null,
      created_by_role: who(q.created_by)?.role ?? null,
      approved_by_name: who(q.approved_by)?.name ?? null,
      approval_requested_by_name: who(q.approval_requested_by)?.name ?? null,
    },
    items: (items.data ?? []).map((r) => itemFrom(r as Record<string, unknown>)),
    emails: (emails.data ?? []) as QuotationEmailLogRow[],
    followUps: (followUps.data ?? []) as QuotationFollowUp[],
    history: (history.data ?? []).map((h) => ({ id: h.id, action: h.action, description: h.description, user_name: h.user_name, at: h.at })),
    lead: lead.data
      ? {
          id: lead.data.id,
          lead_number: lead.data.lead_number,
          name: lead.data.name,
          company: lead.data.company,
          status: lead.data.status,
          assigned_to: lead.data.assigned_to,
          whatsapp: lead.data.whatsapp,
          phone: lead.data.phone,
        }
      : null,
    client: client.data ? { id: client.data.id, client_code: String(client.data.client_code), display_name: client.data.display_name, whatsapp: client.data.whatsapp, phone: client.data.phone } : null,
    convertedClient: converted.data ? { id: converted.data.id, client_code: String(converted.data.client_code), display_name: converted.data.display_name } : null,
    revisedFrom: revisedFrom.data ? { id: revisedFrom.data.id, quotation_number: revisedFrom.data.quotation_number, status: revisedFrom.data.status } : null,
    supersededBy: supersededBy.data ? { id: supersededBy.data.id, quotation_number: supersededBy.data.quotation_number, status: supersededBy.data.status } : null,
  };
}

/** The document every surface renders (§7.5.3 layout; §7.23 "same layout as the PDF"). */
export function toQuotationDocument(
  q: Pick<
    Tables<"quotations">,
    | "id"
    | "quotation_number"
    | "status"
    | "issue_date"
    | "valid_until"
    | "revision_number"
    | "client_name"
    | "client_company"
    | "client_email"
    | "client_phone"
    | "client_gstin"
    | "place_of_supply_code"
    | "notes"
    | "terms"
    | "accepted_by_name"
    | "responded_at"
  >,
  items: ReadonlyArray<Pick<QuotationItemRow, "description" | "service_type" | "frequency" | "quantity" | "unit_price" | "tax_rate">>,
  extra: { preparedBy: string | null; revisesNumber: string | null; firmStateCode: string },
): QuotationDocument {
  return {
    id: q.id,
    number: q.quotation_number,
    status: q.status,
    issueDate: q.issue_date,
    validUntil: q.valid_until,
    revisionNumber: q.revision_number,
    revisesNumber: extra.revisesNumber,
    preparedBy: extra.preparedBy,
    recipient: {
      name: q.client_name,
      company: q.client_company,
      email: q.client_email,
      phone: q.client_phone,
      gstin: q.client_gstin,
      placeOfSupplyCode: q.place_of_supply_code ?? extra.firmStateCode,
    },
    lines: items.map((i) => ({
      description: i.description,
      serviceType: i.service_type,
      frequency: i.frequency,
      quantity: String(i.quantity),
      unitPrice: Number(i.unit_price).toFixed(2),
      taxRate: String(Number(i.tax_rate)),
    })),
    notes: q.notes,
    terms: q.terms,
    acceptance: q.status === "accepted" && q.accepted_by_name ? { name: q.accepted_by_name, at: q.responded_at } : null,
  };
}

/** The quotation as a document, read under the caller's session (the staff PDF route). */
export async function getQuotationDocument(supabase: ServerSupabase, id: string, firmStateCode: string): Promise<QuotationDocument | null> {
  const detail = await getQuotationDetail(supabase, id);
  if (!detail || detail.q.deleted_at) return null;
  return toQuotationDocument(detail.q, detail.items, {
    preparedBy: detail.q.created_by_name,
    revisesNumber: detail.revisedFrom?.quotation_number ?? null,
    firmStateCode,
  });
}

// =================================================================================================
// The builder's context (§7.5.2)
// =================================================================================================

export type BuilderSettings = {
  today: DateString;
  validityDays: number;
  terms: string | null;
  firmStateCode: string;
  approvalLimitPaise: Paise | null;
};

export async function getBuilderSettings(supabase: ServerSupabase): Promise<BuilderSettings> {
  const { data, error } = await supabase
    .from("firm_settings")
    .select("quotation_validity_days, quotation_terms, state_code, quotation_approval_limit")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return {
    today: todayIST(),
    validityDays: data?.quotation_validity_days ?? 30,
    terms: data?.quotation_terms ?? null,
    firmStateCode: data?.state_code ?? "29",
    approvalLimitPaise: toPaiseOrNull(data?.quotation_approval_limit ?? null),
  };
}

export type BuilderPrefill = {
  party: "lead" | "client" | "other";
  lead_id: string | null;
  client_id: string | null;
  label: string | null;
  client_name: string;
  client_email: string;
  client_phone: string;
  client_company: string;
  client_gstin: string;
  state_code: string | null;
  services: ServiceType[];
};

/** Pre-fill from a lead (§7.5.1 "Create quotation"). */
export async function prefillFromLead(supabase: ServerSupabase, leadId: string): Promise<BuilderPrefill | null> {
  const { data, error } = await supabase.from("leads").select("id, lead_number, name, company, email, phone, whatsapp, services_required, deleted_at").eq("id", leadId).maybeSingle();
  if (error) throw error;
  if (!data || data.deleted_at) return null;
  return {
    party: "lead",
    lead_id: data.id,
    client_id: null,
    label: `${data.lead_number ? `${data.lead_number} · ` : ""}${data.company ? `${data.company} · ` : ""}${data.name}`,
    client_name: data.name,
    client_email: data.email ? String(data.email) : "",
    client_phone: data.phone ?? data.whatsapp ?? "",
    client_company: data.company ?? "",
    client_gstin: "",
    state_code: null,
    services: (data.services_required ?? []) as ServiceType[],
  };
}

/** Pre-fill from an existing client (quoting extra work, §5.4): the primary contact receives it. */
export async function prefillFromClient(supabase: ServerSupabase, clientId: string): Promise<BuilderPrefill | null> {
  const [{ data: c, error }, { data: contacts, error: cErr }] = await Promise.all([
    supabase.from("clients").select("id, client_code, display_name, legal_name, email, phone, gstin, state_code, deleted_at").eq("id", clientId).maybeSingle(),
    supabase.from("client_contacts").select("name, email, phone, is_primary").eq("client_id", clientId).order("is_primary", { ascending: false }).order("created_at").limit(5),
  ]);
  if (error) throw error;
  if (cErr) throw cErr;
  if (!c || c.deleted_at) return null;
  const contact = (contacts ?? []).find((x) => x.email) ?? (contacts ?? [])[0] ?? null;
  return {
    party: "client",
    lead_id: null,
    client_id: c.id,
    label: `${c.client_code} · ${c.display_name}`,
    client_name: contact?.name ?? c.display_name,
    client_email: contact?.email ? String(contact.email) : c.email ? String(c.email) : "",
    client_phone: contact?.phone ?? c.phone ?? "",
    client_company: c.legal_name ?? c.display_name,
    client_gstin: c.gstin ? String(c.gstin) : "",
    state_code: c.state_code,
    services: [],
  };
}

export type PartyOption = { value: string; label: string; description?: string };

/** Leads to quote for (open, not converted): name, company, email, phone or number. */
export async function searchLeadsForQuotation(supabase: ServerSupabase, q: string): Promise<PartyOption[]> {
  let query = supabase.from("leads").select("id, lead_number, name, company, email, status").is("deleted_at", null).is("converted_client_id", null).neq("status", "lost").order("updated_at", { ascending: false }).limit(20);
  const s = orSafe(q);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    query = query.or(["name", "company", "email", "phone", "lead_number"].map((c) => `${c}.ilike.${like}`).join(","));
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((l) => ({ value: l.id, label: l.company ? `${l.company} · ${l.name}` : l.name, description: [l.lead_number, l.email].filter(Boolean).join(" · ") || undefined }));
}

/** Clients to quote extra work for: name, code, PAN or GSTIN. */
export async function searchClientsForQuotation(supabase: ServerSupabase, q: string): Promise<PartyOption[]> {
  let query = supabase.from("clients").select("id, client_code, display_name, gstin").is("deleted_at", null).order("display_name").limit(20);
  const s = orSafe(q);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    query = query.or(["display_name", "legal_name", "client_code", "pan", "gstin", "email"].map((c) => `${c}.ilike.${like}`).join(","));
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((c) => ({ value: c.id, label: c.display_name, description: [String(c.client_code), c.gstin ? String(c.gstin) : null].filter(Boolean).join(" · ") }));
}

// =================================================================================================
// Hand-off drafts (§7.13.2 "Quotation: the public link"; §7.13.3)
// =================================================================================================

export type QuotationTemplates = {
  whatsapp: { id: string; body: string } | null;
  email: { id: string; subject: string | null; body: string } | null;
};

/** The active "Quotation" templates (WhatsApp and email), or null where the firm has none. */
export async function getQuotationTemplates(supabase: ServerSupabase): Promise<QuotationTemplates> {
  const { data, error } = await supabase.from("message_templates").select("id, channel, subject, body").eq("type", "quotation").eq("is_active", true).order("name").limit(20);
  if (error) throw error;
  const rows = data ?? [];
  const wa = rows.find((t) => t.channel === "whatsapp") ?? rows.find((t) => t.channel === "any") ?? null;
  const em = rows.find((t) => t.channel === "email") ?? rows.find((t) => t.channel === "any") ?? null;
  return {
    whatsapp: wa ? { id: wa.id, body: wa.body } : null,
    email: em ? { id: em.id, subject: em.subject, body: em.body } : null,
  };
}

/** Fills a quotation template, falling back to the built-in wording when the firm has none. */
export function quotationDraft(
  templates: QuotationTemplates,
  values: TemplateValues,
): { whatsapp: string; emailSubject: string; emailBody: string } {
  const whatsapp = templates.whatsapp
    ? renderTemplate(templates.whatsapp.body, values)
    : renderTemplate(
        "Hi {{contact_name}}, thank you for your time. Our quotation for {{client_name}} ({{amount}}) is here: {{quotation_link}}\n\nYou can view, download, accept or decline it on that page. Happy to answer any questions.",
        values,
      );
  const emailSubject = templates.email?.subject ? renderTemplate(templates.email.subject, values) : renderTemplate("{{firm_name}} | Our quotation for {{client_name}}", values);
  const emailBody = templates.email
    ? renderTemplate(templates.email.body, values)
    : renderTemplate(
        "Dear {{contact_name}},\n\nThank you for considering {{firm_name}}. Our quotation for {{client_name}} is ready. The quoted total is {{amount}}, and you can view, download, accept or decline it online:\n\n{{quotation_link}}\n\nIf you would like to change anything, just reply to this email or call us on {{firm_phone}}.\n\nWarm regards,\n{{sender_name}}\n{{firm_name}}",
        values,
      );
  return { whatsapp, emailSubject, emailBody };
}

/** The letterhead's firm block from the public profile (§4.6). */
export function toDocumentFirm(f: FirmProfile): DocumentFirm {
  return {
    firmName: f.firmName,
    legalName: f.legalName,
    tagline: f.tagline,
    addressLine: formatFirmAddress(f),
    phone: f.phone,
    email: f.email,
    website: f.website,
    gstin: f.gstin,
    logoUrl: f.logoUrl,
    stateCode: f.stateCode,
  };
}
