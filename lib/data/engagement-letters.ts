import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { addDays, type DateString, type FinancialYear } from "@/lib/domain/fy";
import type { EngagementStatus, EntityType, ServiceFrequency, ServiceType } from "@/lib/domain/enums";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { LETTER_EXPIRY_WINDOW_DAYS, parseSchedule, type ScheduleRow } from "@/lib/schemas/engagement-letters";

/**
 * Reads for engagement letters (§7.15.3), under the caller's RLS: Partners and Managers only
 * (engagement_letters, 0034; an Employee gets no row anywhere, §4.1). The list (searched, filtered,
 * sorted and paged in SQL), the letter, the clients with active services and no letter Issued or
 * Signed for the FY (engagement_letter_gaps, 0193), the letters expiring in 30 days, the summary,
 * and what the PDF prints.
 */

export type Page<T> = { rows: T[]; total: number };

export type LetterRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  client_status: string;
  owner_employee_id: string | null;
  owner_name: string | null;
  financial_year: string;
  service_types: ServiceType[];
  is_audit: boolean;
  scope: string | null;
  exclusions: string | null;
  fee_agreed: number | null;
  services_schedule: ScheduleRow[];
  audit_type: string | null;
  reporting_framework: string | null;
  report_form: string | null;
  audit_engagement_id: string | null;
  signatory_id: string | null;
  signatory_name: string | null;
  status: EngagementStatus;
  display_status: EngagementStatus;
  issued_at: string | null;
  signed_at: string | null;
  expires_at: string | null;
  days_to_expiry: number | null;
  document_id: string | null;
  signed_copy_title: string | null;
  declined_reason: string | null;
  sent_at: string | null;
  sent_to: string | null;
  renewed_from_id: string | null;
  renewed_from_fy: string | null;
  renewal_id: string | null;
  renewal_fy: string | null;
  renewal_status: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

const LETTER_COLUMNS =
  "id, client_id, client_name, client_code, client_status, owner_employee_id, owner_name, financial_year, service_types, is_audit, scope, exclusions, fee_agreed, services_schedule, audit_type, reporting_framework, report_form, audit_engagement_id, signatory_id, signatory_name, status, display_status, issued_at, signed_at, expires_at, days_to_expiry, document_id, signed_copy_title, declined_reason, sent_at, sent_to, renewed_from_id, renewed_from_fy, renewal_id, renewal_fy, renewal_status, notes, created_by_name, created_at, updated_at";

function toRow(r: Record<string, unknown>): LetterRow {
  return { ...(r as unknown as LetterRow), services_schedule: parseSchedule(r.services_schedule), service_types: (r.service_types ?? []) as ServiceType[] };
}

function like(q: string): string {
  return `%${escapeLike(q.trim()).replace(/[,()]/g, " ")}%`;
}

export async function listLetters(
  supabase: ServerSupabase,
  t: TableParams<string, string>,
  opts: { fy: FinancialYear | null; clientId?: string | null; limit?: number },
): Promise<Page<LetterRow>> {
  let query = supabase.from("engagement_letters_register").select(LETTER_COLUMNS, { count: "exact" });
  if (opts.fy) query = query.eq("financial_year", opts.fy);
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.status?.length) query = query.in("display_status", t.filters.status);
  if (t.filters.service?.length) query = query.overlaps("service_types", t.filters.service as ServiceType[]);
  if (t.filters.kind?.length === 1) query = query.eq("is_audit", t.filters.kind[0] === "audit");
  if (t.q.trim()) {
    const l = like(t.q);
    query = query.or(`client_name.ilike.${l},client_code.ilike.${l},scope.ilike.${l},notes.ilike.${l}`);
  }
  const sort = t.sort ?? "updated_at";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("client_name").order("id");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []).map((r) => toRow(r as Record<string, unknown>)), total: count ?? 0 };
}

export async function getLetter(supabase: ServerSupabase, id: string): Promise<LetterRow | null> {
  const { data, error } = await supabase.from("engagement_letters_register").select(LETTER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toRow(data as Record<string, unknown>) : null;
}

export type GapRow = {
  client_id: string;
  client_name: string;
  client_code: string;
  owner_employee_id: string | null;
  owner_name: string | null;
  service_types: ServiceType[];
  drafts: number;
  last_letter_fy: string | null;
  last_letter_status: string | null;
};

/** Clients with active services and no letter Issued or Signed for the FY (§7.15.3 lists). */
export async function listLetterGaps(supabase: ServerSupabase, fy: FinancialYear, t: TableParams<string, string>, opts: { limit?: number } = {}): Promise<Page<GapRow>> {
  let query = supabase.rpc("engagement_letter_gaps", { p_fy: fy }, { count: "exact" }).select("*");
  if (t.q.trim()) {
    const l = like(t.q);
    query = query.or(`client_name.ilike.${l},client_code.ilike.${l}`);
  }
  const sort = t.sort === "client_code" ? "client_code" : "client_name";
  query = query.order(sort, { ascending: t.dir !== "desc" });
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as GapRow[], total: count ?? 0 };
}

/** Issued or Signed letters expiring from today to 30 days ahead and not yet renewed. */
export async function listExpiringLetters(supabase: ServerSupabase, today: DateString, t: TableParams<string, string>, opts: { limit?: number } = {}): Promise<Page<LetterRow>> {
  let query = supabase
    .from("engagement_letters_register")
    .select(LETTER_COLUMNS, { count: "exact" })
    .in("status", ["issued", "signed"])
    .is("renewal_id", null)
    .gte("expires_at", today)
    .lte("expires_at", addDays(today, LETTER_EXPIRY_WINDOW_DAYS));
  if (t.q.trim()) {
    const l = like(t.q);
    query = query.or(`client_name.ilike.${l},client_code.ilike.${l}`);
  }
  query = query.order("expires_at").order("client_name").order("id");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []).map((r) => toRow(r as Record<string, unknown>)), total: count ?? 0 };
}

export type LetterSummary = { signed: number; issued: number; drafts: number; missing: number; expiring: number };

export async function getLetterSummary(supabase: ServerSupabase, fy: FinancialYear, today: DateString): Promise<LetterSummary> {
  const head = () => supabase.from("engagement_letters_register").select("id", { count: "exact", head: true });
  const [signed, issued, drafts, missing, expiring] = await Promise.all([
    head().eq("financial_year", fy).eq("display_status", "signed"),
    head().eq("financial_year", fy).eq("display_status", "issued"),
    head().eq("financial_year", fy).eq("status", "draft"),
    supabase.rpc("engagement_letter_gaps", { p_fy: fy }, { count: "exact", head: true }),
    head().in("status", ["issued", "signed"]).is("renewal_id", null).gte("expires_at", today).lte("expires_at", addDays(today, LETTER_EXPIRY_WINDOW_DAYS)),
  ]);
  for (const r of [signed, issued, drafts, missing, expiring]) if (r.error) throw r.error;
  return { signed: signed.count ?? 0, issued: issued.count ?? 0, drafts: drafts.count ?? 0, missing: missing.count ?? 0, expiring: expiring.count ?? 0 };
}

// =================================================================================================
// The new-letter form's context
// =================================================================================================

export type LetterClientContext = {
  client: { id: string; name: string; code: string; entityType: EntityType | null; status: string };
  services: Array<{ service_type: ServiceType; custom_name: string | null; frequency: ServiceFrequency; billing_frequency: ServiceFrequency | null; agreed_fee: number | null }>;
  letters: Array<{ id: string; financial_year: string; status: string; service_types: ServiceType[] }>;
  engagements: Array<{ id: string; audit_type: string; financial_year: string }>;
};

/** A client's active services (with fees), letters and audit engagements, to prefill a letter. */
export async function getLetterClientContext(supabase: ServerSupabase, clientId: string): Promise<LetterClientContext | null> {
  const [client, services, letters, engagements] = await Promise.all([
    supabase.from("clients").select("id, display_name, client_code, entity_type, status").eq("id", clientId).is("deleted_at", null).maybeSingle(),
    supabase.from("client_services").select("service_type, custom_name, frequency, billing_frequency, agreed_fee").eq("client_id", clientId).eq("is_active", true).order("service_type"),
    supabase.from("engagement_letters").select("id, financial_year, status, service_types").eq("client_id", clientId).order("financial_year", { ascending: false }).limit(20),
    supabase.from("audit_engagements").select("id, audit_type, financial_year").eq("client_id", clientId).order("financial_year", { ascending: false }).limit(20),
  ]);
  for (const r of [client, services, letters, engagements]) if (r.error) throw r.error;
  if (!client.data) return null;
  return {
    client: { id: client.data.id, name: client.data.display_name, code: String(client.data.client_code), entityType: (client.data.entity_type ?? null) as EntityType | null, status: client.data.status },
    services: (services.data ?? []) as LetterClientContext["services"],
    letters: (letters.data ?? []) as LetterClientContext["letters"],
    engagements: (engagements.data ?? []) as LetterClientContext["engagements"],
  };
}

export async function listSignatories(supabase: ServerSupabase): Promise<Array<{ id: string; name: string; membershipNo: string | null }>> {
  const { data, error } = await supabase.from("profiles").select("id, full_name, icai_membership_no").eq("role", "partner").eq("is_active", true).order("full_name").limit(100);
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, name: p.full_name, membershipNo: p.icai_membership_no }));
}

// =================================================================================================
// The PDF
// =================================================================================================

export type LetterDocument = {
  letter: LetterRow;
  client: {
    name: string;
    legalName: string | null;
    code: string;
    entityType: EntityType | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
    stateCode: string | null;
    pan: string | null;
    gstin: string | null;
  };
  signatory: { name: string; membershipNo: string | null } | null;
  frn: string | null;
  primaryContact: { name: string; role: string | null; email: string | null } | null;
};

export async function getLetterDocument(supabase: ServerSupabase, id: string): Promise<LetterDocument | null> {
  const letter = await getLetter(supabase, id);
  if (!letter) return null;
  const [client, signatory, firm, contact] = await Promise.all([
    supabase.from("clients").select("display_name, legal_name, client_code, entity_type, address, city, pincode, state_code, pan, gstin").eq("id", letter.client_id).maybeSingle(),
    letter.signatory_id ? supabase.from("profiles").select("full_name, icai_membership_no").eq("id", letter.signatory_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from("firm_settings").select("icai_frn").eq("id", 1).maybeSingle(),
    supabase.from("client_contacts").select("name, role, email").eq("client_id", letter.client_id).order("is_primary", { ascending: false }).order("created_at").limit(1).maybeSingle(),
  ]);
  for (const r of [client, signatory, firm, contact]) if (r.error) throw r.error;
  if (!client.data) return null;
  const c = client.data;
  return {
    letter,
    client: {
      name: c.display_name,
      legalName: c.legal_name,
      code: String(c.client_code),
      entityType: (c.entity_type ?? null) as EntityType | null,
      address: c.address,
      city: c.city,
      pincode: c.pincode,
      stateCode: c.state_code,
      pan: c.pan ? String(c.pan) : null,
      gstin: c.gstin ? String(c.gstin) : null,
    },
    signatory: signatory.data ? { name: signatory.data.full_name, membershipNo: signatory.data.icai_membership_no } : null,
    frn: firm.data?.icai_frn ?? null,
    primaryContact: contact.data ? { name: contact.data.name, role: contact.data.role, email: contact.data.email ? String(contact.data.email) : null } : null,
  };
}

/** The contacts a letter can be emailed to (the primary first, then whoever handles audit or the services). */
export async function listLetterRecipients(supabase: ServerSupabase, clientId: string, services: readonly ServiceType[]): Promise<Array<{ id: string; name: string; role: string | null; email: string; primary: boolean; handles: boolean }>> {
  const { data, error } = await supabase
    .from("client_contacts")
    .select("id, name, role, email, is_primary, handles, email_bounced")
    .eq("client_id", clientId)
    .not("email", "is", null)
    .order("is_primary", { ascending: false })
    .order("name")
    .limit(30);
  if (error) throw error;
  return (data ?? [])
    .filter((c) => c.email && !c.email_bounced)
    .map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      email: String(c.email),
      primary: c.is_primary,
      handles: (c.handles ?? []).some((h: string) => services.includes(h as ServiceType)),
    }));
}
