import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { SERIES_KEYS, type SeriesKey } from "@/lib/domain/numbering";

/**
 * Reads for Settings (§7.21, §5.2). Every function runs under the caller's session, so RLS applies
 * (firm_settings: SELECT for staff, UPDATE Partner only, §4.6). They throw on a database error; the
 * page catches it and shows the failed block with its Ref.
 *
 * Row types are written out here until lib/database.types.ts is regenerated from the schema.
 */

/** The firm_settings singleton (§5.2), the columns the Settings pages edit or show. */
export interface FirmSettingsRow {
  id: number;
  // Identity
  firm_name: string;
  legal_name: string | null;
  tagline: string | null;
  address: string | null;
  city: string | null;
  state_code: string;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  icai_frn: string | null;
  // Bank and UPI
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  upi_id: string | null;
  upi_payee_name: string | null;
  // Branding
  logo_path: string | null;
  logo_updated_at: string | null;
  // Numbering
  invoice_prefix: string;
  credit_note_prefix: string;
  quotation_prefix: string;
  receipt_prefix: string;
  client_code_prefix: string;
  // Billing
  default_sac: string;
  sac_by_service: Record<string, unknown> | null;
  default_tax_rate: number | string;
  payment_terms_days: number;
  invoice_approval_limit: number | string | null;
  quotation_approval_limit: number | string | null;
  e_invoicing_applies: boolean;
  last_gstr1_reported_month: string | null;
  round_off_enabled: boolean;
  quotation_validity_days: number;
  quotation_terms: string | null;
  invoice_terms: string | null;
  invoice_footer_note: string | null;
  quotation_follow_up_days: number[];
  // Working hours
  work_day_start: string;
  late_grace_minutes: number;
  half_day_minutes: number;
  working_weekdays: number[];
  weekly_hours_target: number;
  capacity_thresholds: { busy?: unknown; tight?: unknown; over?: unknown } | null;
  // Reminders
  compliance_reminder_days: number;
  invoice_reminder_before_days: number;
  invoice_reminder_after_days: number[];
  document_request_reminder_every_days: number;
  digest_enabled: boolean;
  // Email (shown on the invoice preview and in diagnostics)
  email_from_name: string;
  email_from_address: string;
  email_reply_to: string;
  domain_status: string | null;
  // Law & rules
  law_last_reviewed_at: string | null;
  law_last_reviewed_by: string | null;
  // Housekeeping
  updated_by: string | null;
  updated_at: string;
}

export const FIRM_SETTINGS_COLUMNS = [
  "id",
  "firm_name",
  "legal_name",
  "tagline",
  "address",
  "city",
  "state_code",
  "pincode",
  "phone",
  "email",
  "website",
  "gstin",
  "pan",
  "tan",
  "icai_frn",
  "bank_name",
  "bank_account_name",
  "bank_account_number",
  "bank_ifsc",
  "bank_branch",
  "upi_id",
  "upi_payee_name",
  "logo_path",
  "logo_updated_at",
  "invoice_prefix",
  "credit_note_prefix",
  "quotation_prefix",
  "receipt_prefix",
  "client_code_prefix",
  "default_sac",
  "sac_by_service",
  "default_tax_rate",
  "payment_terms_days",
  "invoice_approval_limit",
  "quotation_approval_limit",
  "e_invoicing_applies",
  "last_gstr1_reported_month",
  "round_off_enabled",
  "quotation_validity_days",
  "quotation_terms",
  "invoice_terms",
  "invoice_footer_note",
  "quotation_follow_up_days",
  "work_day_start",
  "late_grace_minutes",
  "half_day_minutes",
  "working_weekdays",
  "weekly_hours_target",
  "capacity_thresholds",
  "compliance_reminder_days",
  "invoice_reminder_before_days",
  "invoice_reminder_after_days",
  "document_request_reminder_every_days",
  "digest_enabled",
  "email_from_name",
  "email_from_address",
  "email_reply_to",
  "domain_status",
  "law_last_reviewed_at",
  "law_last_reviewed_by",
  "updated_by",
  "updated_at",
] as const;

/** Who last changed the settings and when: shown in each panel's footer. */
export interface LastChange {
  at: string;
  byName: string | null;
}

export interface FirmSettingsView {
  row: FirmSettingsRow;
  lastChange: LastChange;
}

/** The firm settings row (§2.3: id = 1), or null when the seed hasn't run. */
export async function getFirmSettings(supabase: ServerSupabase): Promise<FirmSettingsView | null> {
  const { data, error } = await supabase.from("firm_settings").select(FIRM_SETTINGS_COLUMNS.join(", ")).eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as FirmSettingsRow;
  const names = await getProfileNames(supabase, [row.updated_by]);
  return { row, lastChange: { at: row.updated_at, byName: row.updated_by ? (names.get(row.updated_by) ?? null) : null } };
}

/** Full names for profile ids (missing ids are left out). One query, never N+1. */
export async function getProfileNames(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", unique);
  if (error) throw error;
  for (const p of (data ?? []) as Array<{ id: string; full_name: string }>) out.set(p.id, p.full_name);
  return out;
}

/** A Partner and their ICAI membership number (§1, §7.21). */
export interface PartnerRow {
  id: string;
  full_name: string;
  email: string;
  icai_membership_no: string | null;
}

export async function getPartners(supabase: ServerSupabase): Promise<PartnerRow[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, icai_membership_no")
    .eq("role", "partner")
    .eq("is_active", true)
    .order("full_name", { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as PartnerRow[];
}

/** One number_series row (§5.11). Missing rows are returned as never used. */
export interface NumberSeriesRow {
  key: SeriesKey;
  financial_year: string | null;
  next_value: number;
  updated_at: string | null;
  exists: boolean;
}

export async function getNumberSeries(supabase: ServerSupabase): Promise<NumberSeriesRow[]> {
  const { data, error } = await supabase.from("number_series").select("key, financial_year, next_value, updated_at").in("key", [...SERIES_KEYS]);
  if (error) throw error;
  const byKey = new Map((data ?? []).map((r) => [(r as { key: string }).key, r as { key: SeriesKey; financial_year: string | null; next_value: number; updated_at: string }]));
  return SERIES_KEYS.map((key) => {
    const r = byKey.get(key);
    return r
      ? { key, financial_year: r.financial_year, next_value: r.next_value, updated_at: r.updated_at, exists: true }
      : { key, financial_year: null, next_value: 1, updated_at: null, exists: false };
  });
}

/** A firm holiday (non-working day for capacity and attendance, §7.11). */
export interface HolidayRow {
  date: string;
  name: string;
}

/** Holidays from `fromDate` on (default: everything), in date order. At most 200. */
export async function getHolidays(supabase: ServerSupabase, opts: { fromDate?: string } = {}): Promise<HolidayRow[]> {
  let q = supabase.from("holidays").select("date, name").order("date", { ascending: true }).limit(200);
  if (opts.fromDate) q = q.gte("date", opts.fromDate);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HolidayRow[];
}

/**
 * The logo's public URL (the branding bucket is public-read for the logo only, §2.3), with the
 * upload time as a cache-buster so a changed logo shows at once.
 */
export function logoPublicUrl(supabase: ServerSupabase, row: Pick<FirmSettingsRow, "logo_path" | "logo_updated_at">): string | null {
  const raw = row.logo_path?.trim();
  if (!raw) return null;
  const path = raw.replace(/^\/+/, "").replace(/^branding\//, "");
  const { data } = supabase.storage.from("branding").getPublicUrl(path);
  if (!data?.publicUrl) return null;
  const version = row.logo_updated_at ? Date.parse(row.logo_updated_at) : NaN;
  return Number.isFinite(version) ? `${data.publicUrl}?v=${version}` : data.publicUrl;
}
