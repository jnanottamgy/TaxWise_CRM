import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import { escapeLike } from "@/components/app/data-table/params";
import { isFinancialYear, fyStart, taxYearLabel, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { parameterInForce, type StatutoryParameterRow } from "@/lib/domain/gst";
import { ITR_RULESET_PARAM_KEY, parseRuleSet, resolveItrRuleSet, type ItrRuleSet } from "@/lib/domain/itr-rulesets";
import type { AssesseeType, ItrResult } from "@/lib/domain/itr";
import type { EntityType } from "@/lib/domain/enums";
import {
  ITR_LIST_SORTABLE,
  RETURN_KIND_RULE,
  readStoredInputs,
  returnDueDates,
  type ItrListFilter,
  type ItrListSort,
  type ItrStatus,
  type ReturnDueDate,
  type ReturnKind,
  type StoredItrInputs,
} from "@/lib/schemas/itr";

/**
 * Reads for the ITR computation workpaper (§6.11, §7.8.2), under the caller's session: RLS gives
 * Partners and Managers every computation and Employees those of their own clients (§4.1). The
 * register is one query on itr_computations_list (0205: search, filters, sort and page in SQL,
 * §2.3). No fee data is read here (a client's tax is not the firm's fee).
 */

/** An ilike pattern for PostgREST's `or()` (quoted, so commas and brackets in the search are text). */
function orIlike(columns: readonly string[], q: string): string {
  const like = `%${escapeLike(q)}%`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return columns.map((c) => `${c}.ilike."${like}"`).join(",");
}

// =================================================================================================
// Rule sets (statutory_parameters key itr.ruleset, §5.12)
// =================================================================================================

export type ItrRuleSetRow = StatutoryParameterRow & { id: string; updatedAt: string };

export async function getItrRuleSetRows(supabase: ServerSupabase): Promise<ItrRuleSetRow[]> {
  const { data, error } = await supabase
    .from("statutory_parameters")
    .select("id, key, value, effective_from, effective_to, verified, source_ref, updated_at")
    .eq("key", ITR_RULESET_PARAM_KEY)
    .order("effective_from", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    verified: r.verified,
    sourceRef: r.source_ref,
    updatedAt: r.updated_at,
  }));
}

export type LoadedRuleSet =
  | { ok: true; ruleSet: ItrRuleSet; raw: Json; paramId: string; verified: boolean; sourceRef: string | null; updatedAt: string }
  | { ok: false; error: string };

/** The rule set in force on 1 April of the FY, validated (§5.12 "the row in force on that date wins"). */
export function ruleSetFor(rows: readonly ItrRuleSetRow[], fy: FinancialYear): LoadedRuleSet {
  if (!isFinancialYear(fy)) return { ok: false, error: `Not a financial year: ${fy}.` };
  const resolved = resolveItrRuleSet(rows, fy);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const row = parameterInForce(rows, ITR_RULESET_PARAM_KEY, fyStart(fy));
  if (!row) return { ok: false, error: `No income-tax rule set is recorded for FY ${fy}. A Partner adds it under Settings → Law & rules.` };
  return { ok: true, ruleSet: resolved.ruleSet, raw: row.value as Json, paramId: row.id, verified: resolved.verified, sourceRef: resolved.sourceRef, updatedAt: row.updatedAt };
}

/** The FYs that have a valid rule set, newest first (the FY picker). */
export function ruleSetYears(rows: readonly ItrRuleSetRow[]): FinancialYear[] {
  const years = new Set<FinancialYear>();
  for (const r of rows) {
    const parsed = parseRuleSet(r.value);
    if (parsed.ok && ruleSetFor(rows, parsed.ruleSet.financialYear).ok) years.add(parsed.ruleSet.financialYear);
  }
  return [...years].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// =================================================================================================
// The due date of the return (due_date_rules + due_date_overrides, §6.7)
// =================================================================================================

export type DueDateSources = {
  rules: Array<{ code: string; title: string; rule: unknown; sourceRef: string | null }>;
  overrides: Array<{ ruleCode: string; periodLabel: string; extendedDue: DateString; sourceRef: string }>;
};

export async function getReturnDueDateSources(supabase: ServerSupabase): Promise<DueDateSources> {
  const codes = Object.values(RETURN_KIND_RULE);
  const [rules, overrides] = await Promise.all([
    supabase.from("due_date_rules").select("code, title, rule, source_ref, is_active").in("code", codes),
    supabase.from("due_date_overrides").select("rule_code, period_label, extended_due, source_ref").in("rule_code", codes).limit(200),
  ]);
  if (rules.error) throw rules.error;
  if (overrides.error) throw overrides.error;
  return {
    rules: (rules.data ?? []).filter((r) => r.is_active).map((r) => ({ code: r.code, title: r.title, rule: r.rule, sourceRef: r.source_ref })),
    overrides: (overrides.data ?? []).map((o) => ({ ruleCode: o.rule_code, periodLabel: o.period_label, extendedDue: o.extended_due, sourceRef: o.source_ref })),
  };
}

export function dueDatesFor(fy: FinancialYear, sources: DueDateSources): Partial<Record<ReturnKind, ReturnDueDate>> {
  return returnDueDates({ fy, yearLabel: taxYearLabel(fy), rules: sources.rules, overrides: sources.overrides });
}

// =================================================================================================
// Clients
// =================================================================================================

export type ItrClientFacts = {
  id: string;
  display_name: string;
  client_code: string;
  legal_name: string | null;
  entity_type: EntityType | null;
  pan: string | null;
  date_of_birth: string | null;
  tax_audit_applicable: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  assesseeType: AssesseeType;
  /** An individual, a HUF or a proprietor (§7.8.2). */
  eligible: boolean;
};

const ELIGIBLE_ENTITIES: readonly string[] = ["individual", "huf", "proprietorship"];

export function isItrEligible(entity: string | null, pan: string | null): boolean {
  if (entity && ELIGIBLE_ENTITIES.includes(entity)) return true;
  if (entity === null || entity === "other") return /^[A-Z]{3}[PH]/i.test(pan ?? "");
  return false;
}

export function assesseeTypeOf(entity: string | null, pan: string | null): AssesseeType {
  if (entity === "huf") return "huf";
  if ((entity === null || entity === "other") && /^[A-Z]{3}H/i.test(pan ?? "")) return "huf";
  return "individual";
}

export async function getItrClientFacts(supabase: ServerSupabase, clientId: string): Promise<ItrClientFacts | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, display_name, client_code, legal_name, entity_type, pan, date_of_birth_or_incorporation, tax_audit_applicable, address, city, pincode")
    .eq("id", clientId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    display_name: data.display_name,
    client_code: String(data.client_code),
    legal_name: data.legal_name,
    entity_type: data.entity_type,
    pan: data.pan,
    date_of_birth: data.date_of_birth_or_incorporation,
    tax_audit_applicable: data.tax_audit_applicable,
    address: data.address,
    city: data.city,
    pincode: data.pincode,
    assesseeType: assesseeTypeOf(data.entity_type, data.pan),
    eligible: isItrEligible(data.entity_type, data.pan),
  };
}

/** Individuals, HUFs and proprietors the caller can see, for the client picker (§7.8.2). */
export async function searchItrClients(supabase: ServerSupabase, q: string): Promise<ComboOption[]> {
  let query = supabase
    .from("clients")
    .select("id, client_code, display_name, entity_type, pan")
    .is("deleted_at", null)
    .neq("status", "inactive")
    .or("entity_type.in.(individual,huf,proprietorship),entity_type.is.null,entity_type.eq.other")
    .order("display_name", { ascending: true })
    .limit(30);
  const text = q.trim();
  if (text) query = query.or(orIlike(["display_name", "client_code", "pan", "legal_name"], text));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? [])
    .filter((c) => isItrEligible(c.entity_type, c.pan))
    .slice(0, 20)
    .map((c) => ({
      value: c.id,
      label: `${c.client_code} · ${c.display_name}`,
      description: [assesseeTypeOf(c.entity_type, c.pan) === "huf" ? "HUF" : "Individual", c.pan ? `PAN ${c.pan}` : null].filter(Boolean).join(" · "),
    }));
}

// =================================================================================================
// The register (§7.8.2)
// =================================================================================================

export type ItrListRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  entity_type: string | null;
  client_pan: string | null;
  financial_year: string;
  year_label: string | null;
  label: string | null;
  status: ItrStatus;
  regime_chosen: "old" | "new" | null;
  recommended_regime: "old" | "new" | null;
  saving_paise: number | null;
  new_regime_total_paise: number | null;
  old_regime_total_paise: number | null;
  effective_regime: "old" | "new" | null;
  balance_paise: number | null;
  total_income_paise: number | null;
  interest_paise: number | null;
  filing_date: string | null;
  due_date: string | null;
  rule_set_verified: boolean | null;
  prepared_by: string | null;
  prepared_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  finalised_by_name: string | null;
  finalised_at: string | null;
  updated_by_name: string | null;
  updated_at: string;
  created_at: string;
};

const LIST_COLUMNS =
  "id, client_id, client_name, client_code, entity_type, client_pan, financial_year, year_label, label, status, regime_chosen, recommended_regime, saving_paise, new_regime_total_paise, old_regime_total_paise, effective_regime, balance_paise, total_income_paise, interest_paise, filing_date, due_date, rule_set_verified, prepared_by, prepared_by_name, reviewed_by_name, reviewed_at, finalised_by_name, finalised_at, updated_by_name, updated_at, created_at";

export async function listItrComputations(
  supabase: ServerSupabase,
  t: TableParams<ItrListSort, ItrListFilter>,
  opts: { fy: FinancialYear | null; clientId?: string | null; viewerId?: string; limit?: number },
): Promise<{ rows: ItrListRow[]; total: number }> {
  let q = supabase.from("itr_computations_list").select(LIST_COLUMNS, { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) q = q.eq("client_id", clientId);
  if (opts.fy) q = q.eq("financial_year", opts.fy);
  if (t.filters.status?.length) q = q.in("status", t.filters.status);
  if (t.filters.regime?.length) q = q.in("effective_regime", t.filters.regime);
  if (t.filters.mine?.[0] === "1" && opts.viewerId) q = q.eq("prepared_by", opts.viewerId);
  if (t.q) q = q.or(orIlike(["client_name", "client_code", "client_pan", "label"], t.q));
  const sort: ItrListSort = t.sort && (ITR_LIST_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "updated_at";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("id", { ascending: true });
  const limit = opts.limit ?? t.pageSize;
  const { data, error, count } = await q.range(t.from, t.from + limit - 1);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as ItrListRow[], total: count ?? 0 };
}

/** How many computations of the FY are at each status (the register's figures). */
export async function getItrStatusCounts(supabase: ServerSupabase, fy: FinancialYear | null): Promise<Record<ItrStatus, number>> {
  const out: Record<ItrStatus, number> = { draft: 0, reviewed: 0, final: 0 };
  await Promise.all(
    (Object.keys(out) as ItrStatus[]).map(async (status) => {
      let q = supabase.from("itr_computations_list").select("id", { count: "exact", head: true }).eq("status", status);
      if (fy) q = q.eq("financial_year", fy);
      const { count, error } = await q;
      if (error) throw error;
      out[status] = count ?? 0;
    }),
  );
  return out;
}

/** A client's computations, newest first (Client 360 → Workpapers). */
export async function listClientItrComputations(supabase: ServerSupabase, clientId: string, limit = 6): Promise<{ rows: ItrListRow[]; total: number }> {
  const { data, error, count } = await supabase
    .from("itr_computations_list")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("client_id", clientId)
    .order("financial_year", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as ItrListRow[], total: count ?? 0 };
}

// =================================================================================================
// One computation
// =================================================================================================

export type ItrDetail = {
  row: ItrListRow;
  inputs: StoredItrInputs | null;
  /** As stored (the server computed it on the last save). */
  results: ItrResult | null;
  /** The rule set the results were computed with, as statutory_parameters held it then. */
  ruleSetRaw: Json | null;
  ruleSetParamId: string | null;
  computedAt: string | null;
  reviewNote: string | null;
  regimeChosenBy: string | null;
  regimeChosenByName: string | null;
  createdBy: string;
};

export async function getItrComputation(supabase: ServerSupabase, id: string): Promise<ItrDetail | null> {
  const [base, list] = await Promise.all([
    supabase
      .from("itr_computations")
      .select("id, inputs, results, rule_set, rule_set_param_id, computed_at, review_note, regime_chosen_by, created_by")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("itr_computations_list").select(LIST_COLUMNS).eq("id", id).maybeSingle(),
  ]);
  if (base.error) throw base.error;
  if (list.error) throw list.error;
  if (!base.data || !list.data) return null;
  const b = base.data;
  let regimeChosenByName: string | null = null;
  if (b.regime_chosen_by) {
    const { data } = await supabase.from("employee_directory").select("full_name").eq("profile_id", b.regime_chosen_by).maybeSingle();
    regimeChosenByName = data?.full_name ?? null;
  }
  const results = b.results && typeof b.results === "object" && !Array.isArray(b.results) && "regimes" in b.results ? (b.results as unknown as ItrResult) : null;
  return {
    row: list.data as unknown as ItrListRow,
    inputs: readStoredInputs(b.inputs),
    results,
    ruleSetRaw: b.rule_set,
    ruleSetParamId: b.rule_set_param_id,
    computedAt: b.computed_at,
    reviewNote: b.review_note,
    regimeChosenBy: b.regime_chosen_by,
    regimeChosenByName,
    createdBy: b.created_by,
  };
}

// =================================================================================================
// What the editor needs (the years with a rule set, each year's rule set and due dates)
// =================================================================================================

export type ItrEditorContext = {
  rows: ItrRuleSetRow[];
  years: FinancialYear[];
  ruleSets: Record<string, ItrRuleSet>;
  dueDates: Record<string, Partial<Record<ReturnKind, ReturnDueDate>>>;
};

export async function getItrEditorContext(supabase: ServerSupabase): Promise<ItrEditorContext> {
  const [rows, sources] = await Promise.all([getItrRuleSetRows(supabase), getReturnDueDateSources(supabase)]);
  const years = ruleSetYears(rows);
  const ruleSets: Record<string, ItrRuleSet> = {};
  const dueDates: Record<string, Partial<Record<ReturnKind, ReturnDueDate>>> = {};
  for (const fy of years) {
    const r = ruleSetFor(rows, fy);
    if (r.ok) ruleSets[fy] = r.ruleSet;
    dueDates[fy] = dueDatesFor(fy, sources);
  }
  return { rows, years, ruleSets, dueDates };
}
