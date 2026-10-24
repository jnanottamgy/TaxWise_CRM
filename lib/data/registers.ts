import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { addDays, endOfMonth, financialYearOf, fyStart, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { CEILING_PARAM_KEYS, ceilingWarning, resolveCeilingParams, udinStatus, type CeilingWarning } from "@/lib/domain/ceiling";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import type { CredentialSort, FilingOrigin } from "@/lib/schemas/registers";

/**
 * Reads for the registers (§7.15.1, §7.15.2), under the caller's RLS: the vault list
 * (client_credentials_register: never the ciphertext), the access trail (Partners/Managers), the
 * registrations, DSC and UDIN registers, the per-partner tax-audit ceiling with "audits signed
 * elsewhere" and company audits, signed reports still without a UDIN, and the filing history.
 * Lists page, sort, filter and search in SQL (§2.3). Employees see their own clients only, and no
 * engagement or fee data (§4.1).
 */

export type Page<T> = { rows: T[]; total: number };

type Query = {
  or: (filter: string) => Query;
  in: (col: string, values: readonly string[]) => Query;
  eq: (col: string, value: unknown) => Query;
};

function search<Q>(query: Q, q: string, columns: readonly string[]): Q {
  const text = q.trim();
  if (!text) return query;
  const like = `%${escapeLike(text).replace(/[,()]/g, " ")}%`;
  return (query as unknown as Query).or(columns.map((c) => `${c}.ilike.${like}`).join(",")) as unknown as Q;
}

// =================================================================================================
// The vault
// =================================================================================================

export type CredentialRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  portal: string;
  portal_label: string | null;
  username: string;
  login_url: string | null;
  notes: string | null;
  updated_by_name: string | null;
  updated_at: string;
  can_reveal: boolean;
  last_viewed_at: string | null;
  view_count: number | null;
};

const CREDENTIAL_COLUMNS = "id, client_id, client_name, client_code, portal, portal_label, username, login_url, notes, updated_by_name, updated_at, can_reveal, last_viewed_at, view_count";

export async function listCredentials(supabase: ServerSupabase, t: TableParams<CredentialSort, string>, opts: { clientId?: string | null } = {}): Promise<Page<CredentialRow>> {
  let query = supabase.from("client_credentials_register").select(CREDENTIAL_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.portal?.length) query = query.in("portal", t.filters.portal);
  if (t.filters.reveal?.length === 1) query = query.eq("can_reveal", t.filters.reveal[0] === "yes");
  query = search(query, t.q, ["client_name", "client_code", "username", "portal_label", "notes"]);
  const sort = t.sort ?? "client_name";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "client_name") query = query.order("client_name", { ascending: true });
  const { data, error, count } = await query.order("id").range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as CredentialRow[], total: count ?? 0 };
}

export type TrailRow = { id: string; user_name: string | null; user_role: string | null; action: string; ip: string | null; created_at: string };

/** Who viewed, copied or changed a stored login (Partners and Managers; RLS returns nothing to others). */
export async function getCredentialTrail(supabase: ServerSupabase, credentialId: string, limit = 100): Promise<TrailRow[]> {
  const { data, error } = await supabase
    .from("credential_access_trail")
    .select("id, user_name, user_role, action, ip, created_at")
    .eq("credential_id", credentialId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as TrailRow[];
}

// =================================================================================================
// Registrations
// =================================================================================================

export type RegistrationRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  registration_type: string;
  registration_number: string;
  jurisdiction: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  reminder_days: number;
  status: string;
  display_status: string;
  days_to_expiry: number | null;
  in_reminder_window: boolean;
  last_dir3_kyc_fy: string | null;
  next_dir3_kyc_fy: string | null;
  next_dir3_kyc_due: string | null;
  notes: string | null;
  updated_at: string;
};

const REGISTRATION_COLUMNS =
  "id, client_id, client_name, client_code, registration_type, registration_number, jurisdiction, issue_date, expiry_date, reminder_days, status, display_status, days_to_expiry, in_reminder_window, last_dir3_kyc_fy, next_dir3_kyc_fy, next_dir3_kyc_due, notes, updated_at";

export async function listRegistrations(
  supabase: ServerSupabase,
  t: TableParams<string, string>,
  opts: { today: DateString; clientId?: string | null; limit?: number },
): Promise<Page<RegistrationRow>> {
  let query = supabase.from("statutory_registrations_register").select(REGISTRATION_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.type?.length) query = query.in("registration_type", t.filters.type);
  if (t.filters.status?.length) query = query.in("display_status", t.filters.status);
  const expiring = t.filters.expiring?.[0];
  if (expiring === "30" || expiring === "90") {
    query = query.eq("status", "active").gte("expiry_date", opts.today).lte("expiry_date", addDays(opts.today, Number(expiring)));
  }
  query = search(query, t.q, ["client_name", "client_code", "registration_number", "jurisdiction"]);
  const sort = t.sort ?? "client_name";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "client_name") query = query.order("client_name", { ascending: true });
  query = query.order("registration_type").order("id");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as RegistrationRow[], total: count ?? 0 };
}

export type RegistrationSummary = { active: number; expiring: number; pastExpiry: number; kycDue: number; fy: FinancialYear };

/** The four facts above the list: Active, expiring in 30 days, past their expiry, DIR-3 KYC due this FY. */
export async function getRegistrationSummary(supabase: ServerSupabase, today: DateString): Promise<RegistrationSummary> {
  const fy = financialYearOf(today);
  const head = () => supabase.from("statutory_registrations_register").select("id", { count: "exact", head: true });
  const [active, expiring, past, kyc] = await Promise.all([
    head().eq("display_status", "active"),
    head().eq("status", "active").gte("expiry_date", today).lte("expiry_date", addDays(today, 30)),
    head().eq("status", "active").lt("expiry_date", today),
    head().eq("registration_type", "DIN").eq("status", "active").lte("next_dir3_kyc_fy", fy),
  ]);
  for (const r of [active, expiring, past, kyc]) if (r.error) throw r.error;
  return { active: active.count ?? 0, expiring: expiring.count ?? 0, pastExpiry: past.count ?? 0, kycDue: kyc.count ?? 0, fy };
}

// =================================================================================================
// DSCs
// =================================================================================================

export type DscRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  holder_name: string;
  holder_pan: string | null;
  dsc_class: string;
  serial_number: string | null;
  issued_by: string | null;
  issue_date: string | null;
  expiry_date: string;
  custody: string | null;
  status: string;
  display_status: string;
  days_to_expiry: number;
  notes: string | null;
  updated_at: string;
};

const DSC_COLUMNS = "id, client_id, client_name, client_code, holder_name, holder_pan, dsc_class, serial_number, issued_by, issue_date, expiry_date, custody, status, display_status, days_to_expiry, notes, updated_at";

export async function listDscs(supabase: ServerSupabase, t: TableParams<string, string>, opts: { today: DateString; clientId?: string | null; limit?: number }): Promise<Page<DscRow>> {
  let query = supabase.from("dsc_register").select(DSC_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.status?.length) query = query.in("display_status", t.filters.status);
  const expiring = t.filters.expiring?.[0];
  if (expiring) {
    const end = expiring === "month" ? endOfMonth(opts.today) : addDays(opts.today, Number(expiring) || 30);
    query = query.eq("status", "active").gte("expiry_date", opts.today).lte("expiry_date", end);
  }
  const custody = t.filters.custody ?? [];
  if (custody.length === 1) {
    if (custody[0] === "firm") query = query.ilike("custody", "firm");
    else if (custody[0] === "client") query = query.ilike("custody", "client");
    else query = query.not("custody", "is", null).not("custody", "ilike", "firm").not("custody", "ilike", "client");
  }
  query = search(query, t.q, ["client_name", "client_code", "holder_name", "serial_number", "custody"]);
  const sort = t.sort ?? "expiry_date";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("client_name").order("id");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as DscRow[], total: count ?? 0 };
}

export type DscSummary = { active: number; thisMonth: number; next30: number; expired: number };

export async function getDscSummary(supabase: ServerSupabase, today: DateString): Promise<DscSummary> {
  const head = () => supabase.from("dsc_register").select("id", { count: "exact", head: true });
  const [active, month, next30, expired] = await Promise.all([
    head().eq("display_status", "active"),
    head().eq("status", "active").gte("expiry_date", today).lte("expiry_date", endOfMonth(today)),
    head().eq("status", "active").gte("expiry_date", today).lte("expiry_date", addDays(today, 30)),
    head().eq("display_status", "expired"),
  ]);
  for (const r of [active, month, next30, expired]) if (r.error) throw r.error;
  return { active: active.count ?? 0, thisMonth: month.count ?? 0, next30: next30.count ?? 0, expired: expired.count ?? 0 };
}

// =================================================================================================
// UDINs and the ceiling
// =================================================================================================

export type UdinRow = {
  id: string;
  udin: string;
  client_id: string | null;
  client_name: string | null;
  client_code: string | null;
  document_type: string;
  report_form: string | null;
  form26_category: string | null;
  financial_year: string | null;
  signed_on: string;
  generated_on: string;
  signed_fy: string;
  days_to_generate: number;
  generation_days: number;
  generated_late: boolean;
  signing_partner_id: string | null;
  signing_partner_name: string | null;
  signing_membership_no: string | null;
  membership_mismatch: boolean | null;
  is_revised: boolean;
  counts_towards_tax_audit_ceiling: boolean | null;
  ceiling_confirmed_at: string | null;
  filing_record_id: string | null;
  filing_form: string | null;
  filing_period: string | null;
  filing_financial_year: string | null;
  audit_engagement_id: string | null;
  engagement_audit_type: string | null;
  engagement_financial_year: string | null;
  remarks: string | null;
  updated_at: string;
};

const UDIN_COLUMNS =
  "id, udin, client_id, client_name, client_code, document_type, report_form, form26_category, financial_year, signed_on, generated_on, signed_fy, days_to_generate, generation_days, generated_late, signing_partner_id, signing_partner_name, signing_membership_no, membership_mismatch, is_revised, counts_towards_tax_audit_ceiling, ceiling_confirmed_at, filing_record_id, filing_form, filing_period, filing_financial_year, audit_engagement_id, engagement_audit_type, engagement_financial_year, remarks, updated_at";

export async function listUdins(supabase: ServerSupabase, t: TableParams<string, string>, opts: { clientId?: string | null; limit?: number } = {}): Promise<Page<UdinRow>> {
  let query = supabase.from("udin_register").select(UDIN_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.partner?.length) query = query.in("signing_partner_id", t.filters.partner);
  if (t.filters.form?.length) query = query.in("report_form", t.filters.form);
  if (t.filters.counted?.length === 1) query = query.eq("counts_towards_tax_audit_ceiling", t.filters.counted[0] === "yes");
  if (t.filters.late?.[0] === "yes") query = query.eq("generated_late", true);
  if (t.filters.year?.[0]) query = query.eq("signed_fy", t.filters.year[0]);
  query = search(query, t.q, ["udin", "client_name", "client_code", "document_type", "remarks"]);
  const sort = t.sort ?? "signed_on";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("udin");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as UdinRow[], total: count ?? 0 };
}

export type CeilingRow = {
  memberId: string;
  name: string;
  membershipNo: string | null;
  signedInFirm: number;
  signedElsewhere: number;
  elsewhereNotes: string | null;
  total: number;
  ceiling: number;
  remaining: number;
  warning: CeilingWarning | null;
  /** The warning counts reached (50, 58). */
  warnAt: readonly number[];
  companyAudits: number;
  companyLimit: number;
  companyLevel: "ok" | "warn" | "block";
};

export type CeilingPanel = { fy: FinancialYear; rows: CeilingRow[]; unverified: string[] };

type ExternalRow = { member_profile_id: string; audits_signed_elsewhere: number; notes: string | null };

/**
 * Each Partner's tax audits for the FY against the ICAI ceiling (§6.8): signed in the firm (by the
 * date signed, head office/branch once, revised never), plus the audits signed elsewhere they
 * entered; the warnings at 50 and 58; and the company audits they are engaging partner on, against
 * the limit of 20 with its warning from the 18th. Partners and Managers (RLS on the view and the
 * engagements).
 */
export async function getCeilingPanel(supabase: ServerSupabase, fy: FinancialYear): Promise<CeilingPanel> {
  const [partners, ceilings, external, params, engagements, staff] = await Promise.all([
    supabase.from("profiles").select("id, full_name, icai_membership_no").eq("role", "partner").eq("is_active", true).order("full_name").limit(100),
    supabase.from("tax_audit_ceiling_view").select("member_profile_id, signed_in_firm, signed_elsewhere, total_count, ceiling").eq("financial_year", fy),
    supabase.from("tax_audit_external_counts").select("member_profile_id, audits_signed_elsewhere, notes").eq("financial_year", fy),
    supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", Object.values(CEILING_PARAM_KEYS)),
    supabase.from("audit_engagements").select("engagement_partner_id, counts_towards_company_audit_limit").eq("audit_type", "statutory_companies_act").eq("financial_year", fy).limit(5000),
    supabase.from("employees").select("id, profile_id").not("profile_id", "is", null).limit(5000),
  ]);
  for (const r of [partners, ceilings, external, params, engagements, staff]) if (r.error) throw r.error;

  const rows: StatutoryParameterRow[] = (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  const resolved = resolveCeilingParams(rows, fyStart(fy));
  const p = resolved.params;
  const counts = new Map((ceilings.data ?? []).map((c) => [c.member_profile_id, c]));
  const ext = new Map(((external.data ?? []) as ExternalRow[]).map((e) => [e.member_profile_id, e]));
  // audit_engagements.engagement_partner_id names the employee row (0195); older rows the profile.
  const profileOfEmployee = new Map((staff.data ?? []).map((e) => [e.id, e.profile_id as string]));
  const company = new Map<string, number>();
  for (const e of engagements.data ?? []) {
    if (e.counts_towards_company_audit_limit === false || !e.engagement_partner_id) continue;
    const profile = profileOfEmployee.get(e.engagement_partner_id) ?? e.engagement_partner_id;
    company.set(profile, (company.get(profile) ?? 0) + 1);
  }

  return {
    fy,
    unverified: resolved.unverified,
    rows: (partners.data ?? []).map((m) => {
      const c = counts.get(m.id);
      const elsewhere = ext.get(m.id);
      const inFirm = c?.signed_in_firm ?? 0;
      const outside = c?.signed_elsewhere ?? elsewhere?.audits_signed_elsewhere ?? 0;
      const total = c?.total_count ?? inFirm + outside;
      const companyAudits = company.get(m.id) ?? 0;
      return {
        memberId: m.id,
        name: m.full_name,
        membershipNo: m.icai_membership_no,
        signedInFirm: inFirm,
        signedElsewhere: outside,
        elsewhereNotes: elsewhere?.notes ?? null,
        total,
        ceiling: c?.ceiling ?? p.taxAuditCeiling,
        remaining: (c?.ceiling ?? p.taxAuditCeiling) - total,
        warning: ceilingWarning(total, p),
        warnAt: p.taxAuditWarnAt,
        companyAudits,
        companyLimit: p.companyAuditLimit,
        // §6.8: warn when a Partner is engaging partner on the 18th or later countable audit.
        companyLevel: companyAudits > p.companyAuditLimit ? "block" : companyAudits >= p.companyAuditWarnFrom ? "warn" : "ok",
      };
    }),
  };
}

export type MissingUdinRow = { id: string; client_id: string; client_name: string; audit_type: string; financial_year: string; report_date: string; signing_partner_id: string | null; daysLeft: number | null; daysLate: number | null };

/**
 * Signed reports with no UDIN yet (§6.8 "the dashboard lists signed documents with no UDIN, with
 * the days left"): audit engagements with a report date and no UDIN, not archived. Partners and
 * Managers (RLS).
 */
export async function listReportsWithoutUdin(supabase: ServerSupabase, today: DateString, limit = 8): Promise<Page<MissingUdinRow>> {
  const [res, params] = await Promise.all([
    supabase
      .from("audit_engagements")
      .select("id, client_id, audit_type, financial_year, report_date, engagement_partner_id, clients!inner(display_name, deleted_at)", { count: "exact" })
      .not("report_date", "is", null)
      .is("udin_record_id", null)
      .is("archived_at", null)
      .is("clients.deleted_at", null)
      .order("report_date")
      .limit(limit),
    supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").eq("key", CEILING_PARAM_KEYS.udinGenerationDays),
  ]);
  if (res.error) throw res.error;
  if (params.error) throw params.error;
  const p = resolveCeilingParams(
    (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified })),
    today,
  ).params;
  const rows = (res.data ?? []) as unknown as Array<{ id: string; client_id: string; audit_type: string; financial_year: string; report_date: string; engagement_partner_id: string | null; clients: { display_name: string } | null }>;
  // The engagement partner is an employees row; the UDIN's signing member is that person's login.
  const partnerIds = [...new Set(rows.map((r) => r.engagement_partner_id).filter((v): v is string => Boolean(v)))];
  const profileOf = new Map<string, string>();
  if (partnerIds.length) {
    const { data: emps, error } = await supabase.from("employees").select("id, profile_id").in("id", partnerIds);
    if (error) throw error;
    for (const e of emps ?? []) if (e.profile_id) profileOf.set(e.id, e.profile_id);
  }
  return {
    total: res.count ?? 0,
    rows: rows.map((r) => {
      const s = udinStatus({ signedOn: r.report_date, generatedOn: null, today }, p);
      return {
        id: r.id,
        client_id: r.client_id,
        client_name: r.clients?.display_name ?? "",
        audit_type: r.audit_type,
        financial_year: r.financial_year,
        report_date: r.report_date,
        signing_partner_id: r.engagement_partner_id ? (profileOf.get(r.engagement_partner_id) ?? null) : null,
        daysLeft: s.daysLeft,
        daysLate: s.daysLate,
      };
    }),
  };
}

/**
 * Who may be named as the signing member (§4.1 "UDIN add if signing staff"): for Partners and
 * Managers, the active Partners; an Employee only themselves, and only when they hold an ICAI
 * membership number (a member who signs). Nobody else can log a UDIN.
 */
export async function listSigningMembers(supabase: ServerSupabase, user: CurrentUser): Promise<Array<{ id: string; name: string; membershipNo: string | null }>> {
  if (!isManagerOrPartner(user.role)) {
    const { data, error } = await supabase.from("profiles").select("id, full_name, icai_membership_no").eq("id", user.id).maybeSingle();
    if (error) throw error;
    return data && data.icai_membership_no?.trim() ? [{ id: data.id, name: data.full_name, membershipNo: data.icai_membership_no }] : [];
  }
  const { data, error } = await supabase.from("profiles").select("id, full_name, icai_membership_no").eq("role", "partner").eq("is_active", true).order("full_name").limit(100);
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, name: p.full_name, membershipNo: p.icai_membership_no }));
}

export type UdinLinkOptions = {
  filings: ComboOption[];
  engagements: ComboOption[];
};

const AUDIT_TYPE_SHORT: Record<string, string> = {
  statutory_companies_act: "Statutory audit",
  tax_audit: "Tax audit",
  gst_audit: "GST audit",
  internal: "Internal audit",
  bank_branch: "Bank branch audit",
  stock: "Stock audit",
  certification: "Certification",
  other: "Audit",
};

/** A client's filings and audit engagements a UDIN can be linked to (engagements: Partners/Managers by RLS). */
export async function getUdinLinkOptions(supabase: ServerSupabase, clientId: string): Promise<UdinLinkOptions> {
  const [filings, engagements] = await Promise.all([
    supabase.from("filing_records").select("id, filing_type, period, financial_year, filed_on, acknowledgement_no").eq("client_id", clientId).order("filed_on", { ascending: false, nullsFirst: false }).limit(60),
    supabase.from("audit_engagements").select("id, audit_type, financial_year, report_date").eq("client_id", clientId).order("financial_year", { ascending: false }).limit(30),
  ]);
  if (filings.error) throw filings.error;
  if (engagements.error) throw engagements.error;
  return {
    filings: (filings.data ?? []).map((f) => ({
      value: f.id,
      label: `${f.filing_type}${f.period ? ` · ${f.period}` : ""} · FY ${f.financial_year}`,
      description: f.acknowledgement_no ? `Ack ${f.acknowledgement_no}` : undefined,
    })),
    engagements: (engagements.data ?? []).map((e) => ({
      value: e.id,
      label: `${AUDIT_TYPE_SHORT[e.audit_type] ?? "Audit"} · FY ${e.financial_year}`,
      description: e.report_date ? `Report dated ${e.report_date}` : "Report not signed yet",
    })),
  };
}

// =================================================================================================
// Filing history
// =================================================================================================

export type FilingRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  financial_year: string;
  filing_type: string;
  service_type: string | null;
  period: string | null;
  filed_on: string | null;
  acknowledgement_no: string | null;
  filed_by_external: string | null;
  origin: FilingOrigin;
  task_id: string | null;
  task_number: string | null;
  compliance_event_id: string | null;
  event_title: string | null;
  event_due_date: string | null;
  on_time: boolean | null;
  document_id: string | null;
  notes: string | null;
  created_by_name: string | null;
  updated_at: string;
};

const FILING_COLUMNS =
  "id, client_id, client_name, client_code, financial_year, filing_type, service_type, period, filed_on, acknowledgement_no, filed_by_external, origin, task_id, task_number, compliance_event_id, event_title, event_due_date, on_time, document_id, notes, created_by_name, updated_at";

export async function listFilings(supabase: ServerSupabase, t: TableParams<string, string>, opts: { clientId?: string | null; limit?: number } = {}): Promise<Page<FilingRow>> {
  let query = supabase.from("filing_history").select(FILING_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) query = query.eq("client_id", clientId);
  if (t.filters.origin?.length === 1) query = query.eq("origin", t.filters.origin[0]);
  if (t.filters.year?.length) query = query.in("financial_year", t.filters.year);
  if (t.filters.form?.length) query = query.in("form_key", t.filters.form);
  query = search(query, t.q, ["client_name", "client_code", "filing_type", "acknowledgement_no", "filed_by_external", "period"]);
  const sort = t.sort ?? "filed_on";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("financial_year", { ascending: false }).order("id");
  const { data, error, count } = opts.limit ? await query.range(0, opts.limit - 1) : await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as FilingRow[], total: count ?? 0 };
}

export async function getFilingFacets(supabase: ServerSupabase, clientId: string | null = null): Promise<{ forms: string[]; years: string[] }> {
  const { data, error } = await supabase.rpc("filing_history_facets", { p_client_id: clientId });
  if (error) throw error;
  const v = (data ?? {}) as { forms?: unknown; years?: unknown };
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { forms: strings(v.forms), years: strings(v.years) };
}

// =================================================================================================
// Clients
// =================================================================================================

/** Clients the caller can see, by name or code, for the register forms' client picker. */
export async function searchRegisterClients(supabase: ServerSupabase, q: string): Promise<ComboOption[]> {
  let query = supabase.from("clients").select("id, client_code, display_name, status").is("deleted_at", null).order("display_name").limit(20);
  const text = q.trim();
  if (text) {
    const like = `%${escapeLike(text).replace(/[,()]/g, " ")}%`;
    query = query.or(`display_name.ilike.${like},client_code.ilike.${like},legal_name.ilike.${like},pan.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((c) => ({ value: c.id, label: c.display_name, description: c.status === "inactive" ? `${c.client_code} · Inactive` : String(c.client_code) }));
}

export async function getClientLabel(supabase: ServerSupabase, clientId: string): Promise<{ id: string; name: string; code: string } | null> {
  const { data, error } = await supabase.from("clients").select("id, display_name, client_code").eq("id", clientId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, name: data.display_name, code: String(data.client_code) } : null;
}
