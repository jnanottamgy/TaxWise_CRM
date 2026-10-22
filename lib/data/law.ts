import "server-only";

import { untyped } from "@/lib/supabase/untyped";
import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike } from "@/components/app/data-table/params";
import { getProfileNames } from "@/lib/data/settings";

/**
 * Reads for Settings → Law & rules (§5.12, §7.21): statutory parameters, due-date rules,
 * government extensions, the 1961 ↔ 2025 concordance, the change log and the "last reviewed on"
 * stamp. Filtering, search and paging happen in SQL (§2.3). Every function runs under the caller's
 * session (RLS applies) and throws on a database error.
 */

export interface ListArgs {
  q?: string;
  /** false: only rows awaiting partner confirmation; true: only verified rows; null/absent: both. */
  verified?: boolean | null;
  /** Include rows that are no longer in force (effective_to before today). */
  history?: boolean;
  /** Today (IST): what "in force" is measured against. */
  today: string;
  from: number;
  to: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface VerifiedInfo {
  verified: boolean;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_on: string | null;
}

export interface ParameterRow extends VerifiedInfo {
  id: string;
  key: string;
  value: unknown;
  effective_from: string;
  effective_to: string | null;
  statute: string | null;
  section_ref: string | null;
  source_ref: string | null;
  notes: string | null;
  updated_at: string;
}

export interface DueDateRuleRow extends VerifiedInfo {
  id: string;
  code: string;
  title: string;
  compliance_type: string;
  form_code: string | null;
  applies_to: unknown;
  frequency: string;
  rule: unknown;
  reminder_days: number;
  effective_from: string;
  effective_to: string | null;
  source_ref: string | null;
  is_active: boolean;
  updated_at: string;
}

export interface OverrideRow {
  id: string;
  rule_code: string;
  rule_title: string | null;
  period_label: string;
  original_due: string;
  extended_due: string;
  scope: string | null;
  source_ref: string;
  created_by_name: string | null;
  created_at: string;
  /** Compliance events this extension moved (override_id points at it). */
  moved_count: number;
}

export interface ConcordanceRow extends VerifiedInfo {
  id: string;
  topic: string;
  old_section: string | null;
  new_section: string | null;
  old_form: string | null;
  new_form: string | null;
  source_ref: string | null;
  updated_at: string;
}

export interface LawChangeRow {
  id: string;
  at: string;
  user_email: string | null;
  resource_type: string | null;
  action: string | null;
  details: Record<string, unknown> | null;
  success: boolean;
}

export interface LawSummary {
  awaiting: { parameters: number; rules: number; concordance: number; total: number };
  lastReviewedAt: string | null;
  lastReviewedByName: string | null;
  overrides: number;
}

/** The resource types the law actions write to audit_logs (server/actions/law.ts). */
export const LAW_AUDIT_RESOURCES = ["statutory_parameters", "due_date_rules", "due_date_overrides", "section_concordance", "law_review"] as const;

/**
 * An ILIKE pattern for a PostgREST `or=(…)` filter: commas, parentheses and quotes would end the
 * filter list early, so they become spaces; %, _ and \ are escaped for LIKE.
 */
function likeTerm(q: string): string {
  return `%${escapeLike(q.replace(/[,()"]/g, " ").replace(/\s+/g, " ").trim())}%`;
}

function inForce<Q extends { or: (filter: string) => Q }>(q: Q, today: string): Q {
  return q.or(`effective_to.is.null,effective_to.gte.${today}`);
}

function withVerifierNames<T extends { verified_by?: string | null }>(rows: T[], names: Map<string, string>): Array<T & { verified_by_name: string | null }> {
  return rows.map((r) => ({ ...r, verified_by_name: r.verified_by ? (names.get(r.verified_by) ?? null) : null }));
}

export async function getLawSummary(supabase: ServerSupabase, today: string): Promise<LawSummary> {
  const count = async (table: string, scoped: boolean) => {
    let q = untyped(supabase).from(table).select("id", { count: "exact", head: true }).eq("verified", false);
    if (scoped) q = inForce(q, today);
    const { count: n, error } = await q;
    if (error) throw error;
    return n ?? 0;
  };
  const [parameters, rules, concordance, settings, overrides] = await Promise.all([
    count("statutory_parameters", true),
    count("due_date_rules", true),
    count("section_concordance", false),
    supabase.from("firm_settings").select("law_last_reviewed_at, law_last_reviewed_by").eq("id", 1).maybeSingle(),
    supabase.from("due_date_overrides").select("id", { count: "exact", head: true }),
  ]);
  if (settings.error) throw settings.error;
  if (overrides.error) throw overrides.error;
  const reviewedBy = (settings.data as { law_last_reviewed_by: string | null } | null)?.law_last_reviewed_by ?? null;
  const names = await getProfileNames(supabase, [reviewedBy]);
  return {
    awaiting: { parameters, rules, concordance, total: parameters + rules + concordance },
    lastReviewedAt: (settings.data as { law_last_reviewed_at: string | null } | null)?.law_last_reviewed_at ?? null,
    lastReviewedByName: reviewedBy ? (names.get(reviewedBy) ?? null) : null,
    overrides: overrides.count ?? 0,
  };
}

const PARAMETER_COLUMNS =
  "id, key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified, verified_by, verified_on, updated_at";

export async function listParameters(supabase: ServerSupabase, args: ListArgs): Promise<Page<ParameterRow>> {
  let q = supabase.from("statutory_parameters").select(PARAMETER_COLUMNS, { count: "exact" });
  if (!args.history) q = inForce(q, args.today);
  if (typeof args.verified === "boolean") q = q.eq("verified", args.verified);
  if (args.q) {
    const like = likeTerm(args.q);
    q = q.or(`key.ilike.${like},section_ref.ilike.${like},source_ref.ilike.${like},statute.ilike.${like}`);
  }
  const { data, error, count } = await q
    .order("verified", { ascending: true })
    .order("key", { ascending: true })
    .order("effective_from", { ascending: false })
    .range(args.from, args.to);
  if (error) throw error;
  const rows = (data ?? []) as Array<Omit<ParameterRow, "verified_by_name">>;
  const names = await getProfileNames(supabase, rows.map((r) => r.verified_by));
  return { rows: withVerifierNames(rows, names), total: count ?? 0 };
}

const RULE_COLUMNS =
  "id, code, title, compliance_type, form_code, applies_to, frequency, rule, reminder_days, effective_from, effective_to, source_ref, verified, verified_by, verified_on, is_active, updated_at";

export async function listDueDateRules(supabase: ServerSupabase, args: ListArgs): Promise<Page<DueDateRuleRow>> {
  let q = supabase.from("due_date_rules").select(RULE_COLUMNS, { count: "exact" });
  if (!args.history) q = inForce(q, args.today);
  if (typeof args.verified === "boolean") q = q.eq("verified", args.verified);
  if (args.q) {
    const like = likeTerm(args.q);
    q = q.or(`code.ilike.${like},title.ilike.${like},form_code.ilike.${like},source_ref.ilike.${like}`);
  }
  const { data, error, count } = await q
    .order("verified", { ascending: true })
    .order("compliance_type", { ascending: true })
    .order("code", { ascending: true })
    .range(args.from, args.to);
  if (error) throw error;
  const rows = (data ?? []) as Array<Omit<DueDateRuleRow, "verified_by_name">>;
  const names = await getProfileNames(supabase, rows.map((r) => r.verified_by));
  return { rows: withVerifierNames(rows, names), total: count ?? 0 };
}

/** One rule by code (the override form shows its title and checks it exists). */
export async function listRuleChoices(supabase: ServerSupabase, today: string): Promise<Array<{ code: string; title: string; form_code: string | null }>> {
  const { data, error } = await inForce(supabase.from("due_date_rules").select("code, title, form_code"), today)
    .eq("is_active", true)
    .order("code", { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as Array<{ code: string; title: string; form_code: string | null }>;
}

export async function listOverrides(supabase: ServerSupabase, args: Omit<ListArgs, "verified" | "history">): Promise<Page<OverrideRow>> {
  let q = supabase
    .from("due_date_overrides")
    .select("id, rule_code, period_label, original_due, extended_due, scope, source_ref, created_by, created_at", { count: "exact" });
  if (args.q) {
    const like = likeTerm(args.q);
    q = q.or(`rule_code.ilike.${like},period_label.ilike.${like},source_ref.ilike.${like}`);
  }
  const { data, error, count } = await q.order("extended_due", { ascending: false }).order("created_at", { ascending: false }).range(args.from, args.to);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    rule_code: string;
    period_label: string;
    original_due: string;
    extended_due: string;
    scope: string | null;
    source_ref: string;
    created_by: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return { rows: [], total: count ?? 0 };

  const codes = [...new Set(rows.map((r) => r.rule_code))];
  const ids = rows.map((r) => r.id);
  const [rules, moved, names] = await Promise.all([
    supabase.from("due_date_rules").select("code, title").in("code", codes),
    supabase.from("compliance_events").select("override_id").in("override_id", ids).limit(10000),
    getProfileNames(supabase, rows.map((r) => r.created_by)),
  ]);
  if (rules.error) throw rules.error;
  if (moved.error) throw moved.error;
  const titles = new Map(((rules.data ?? []) as Array<{ code: string; title: string }>).map((r) => [r.code, r.title]));
  const movedCount = new Map<string, number>();
  for (const e of (moved.data ?? []) as Array<{ override_id: string | null }>) {
    if (e.override_id) movedCount.set(e.override_id, (movedCount.get(e.override_id) ?? 0) + 1);
  }
  return {
    total: count ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      rule_code: r.rule_code,
      rule_title: titles.get(r.rule_code) ?? null,
      period_label: r.period_label,
      original_due: r.original_due,
      extended_due: r.extended_due,
      scope: r.scope,
      source_ref: r.source_ref,
      created_by_name: r.created_by ? (names.get(r.created_by) ?? null) : null,
      created_at: r.created_at,
      moved_count: movedCount.get(r.id) ?? 0,
    })),
  };
}

export async function listConcordance(supabase: ServerSupabase, args: Omit<ListArgs, "history">): Promise<Page<ConcordanceRow>> {
  // select("*"): verified_by / verified_on may not exist on this table yet; read whatever is there.
  let q = supabase.from("section_concordance").select("*", { count: "exact" });
  if (typeof args.verified === "boolean") q = q.eq("verified", args.verified);
  if (args.q) {
    const like = likeTerm(args.q);
    q = q.or(`topic.ilike.${like},old_section.ilike.${like},new_section.ilike.${like},old_form.ilike.${like},new_form.ilike.${like}`);
  }
  const { data, error, count } = await q.order("verified", { ascending: true }).order("topic", { ascending: true }).range(args.from, args.to);
  if (error) throw error;
  const raw = (data ?? []) as Array<Record<string, unknown>>;
  const rows = raw.map((r) => ({
    id: String(r.id),
    topic: String(r.topic ?? ""),
    old_section: (r.old_section as string | null) ?? null,
    new_section: (r.new_section as string | null) ?? null,
    old_form: (r.old_form as string | null) ?? null,
    new_form: (r.new_form as string | null) ?? null,
    source_ref: (r.source_ref as string | null) ?? null,
    verified: Boolean(r.verified),
    verified_by: (r.verified_by as string | null | undefined) ?? null,
    verified_on: (r.verified_on as string | null | undefined) ?? null,
    updated_at: String(r.updated_at ?? ""),
  }));
  const names = await getProfileNames(supabase, rows.map((r) => r.verified_by));
  return { rows: withVerifierNames(rows, names), total: count ?? 0 };
}

export async function listLawChanges(supabase: ServerSupabase, args: { from: number; to: number }): Promise<Page<LawChangeRow>> {
  const { data, error, count } = await supabase
    .from("audit_logs")
    .select("id, at, user_email, resource_type, action, details, success", { count: "exact" })
    .in("resource_type", [...LAW_AUDIT_RESOURCES])
    .order("at", { ascending: false })
    .range(args.from, args.to);
  if (error) throw error;
  return { rows: (data ?? []) as LawChangeRow[], total: count ?? 0 };
}
