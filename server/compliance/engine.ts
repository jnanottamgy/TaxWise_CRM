import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { DateString } from "@/lib/domain/fy";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { isEnumValue } from "@/lib/domain/enums";
import { resolveScaleParams } from "@/lib/domain/scale";
import {
  CALENDAR_DEFAULTS,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  resolveCalendarParams,
  type CalendarParams,
  type DueDateOverride,
  type DueDateRule,
  type OpsTemplate,
} from "@/lib/domain/statutory-calendar";
import type { HintContext } from "@/components/compliance/logic/event";
import { log } from "@/lib/log";

/**
 * The statutory calendar engine as the database holds it (§5.12: statutory parameters are data, not
 * code): the active due_date_rules, every due_date_overrides row (government extensions), the
 * parameters the engine reads (GST filing bar, ROC late fee, the QRMP turnover limit), and the ops
 * templates (recurring_compliance_templates, §7.7). Works with a user's session (RLS: staff read
 * the law tables) or the service role (the monthly job). Rows that can't be read are skipped and
 * logged, so one bad rule on the Law & rules page never stops generation for everyone.
 */

export type Db = SupabaseClient<Database>;

export interface ComplianceEngine {
  rules: DueDateRule[];
  rulesByCode: Map<string, DueDateRule>;
  overrides: DueDateOverride[];
  params: CalendarParams;
  templates: OpsTemplate[];
  /** Plain sentences naming the rows that couldn't be read. */
  skipped: string[];
}

const RULE_COLUMNS = "code, title, compliance_type, form_code, applies_to, frequency, rule, reminder_days, effective_from, effective_to, source_ref, verified, is_active";

export async function loadParameterRows(db: Db): Promise<StatutoryParameterRow[]> {
  const { data, error } = await db
    .from("statutory_parameters")
    .select("key, value, effective_from, effective_to, verified")
    .or("key.like.gst.%,key.like.roc.%,key.like.itr.%");
  if (error) throw error;
  return (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
}

export async function loadComplianceEngine(db: Db, today: DateString): Promise<ComplianceEngine> {
  const [rules, overrides, templates, paramRows] = await Promise.all([
    db.from("due_date_rules").select(RULE_COLUMNS).eq("is_active", true).limit(1000),
    db.from("due_date_overrides").select("id, rule_code, period_label, original_due, extended_due, scope, source_ref").limit(1000),
    db
      .from("recurring_compliance_templates")
      .select("service_type, compliance_type, title, description, frequency, due_day_of_month, due_month, period_offset, reminder_days, is_active")
      .eq("is_active", true)
      .limit(1000),
    loadParameterRows(db),
  ]);
  if (rules.error) throw rules.error;
  if (overrides.error) throw overrides.error;
  if (templates.error) throw templates.error;

  const skipped: string[] = [];
  const parsedRules: DueDateRule[] = [];
  for (const row of rules.data ?? []) {
    const r = parseDueDateRuleRow(row);
    if (r.ok) parsedRules.push(r.value);
    else skipped.push(r.error);
  }
  const parsedOverrides: DueDateOverride[] = [];
  for (const row of overrides.data ?? []) {
    const r = parseDueDateOverrideRow(row);
    if (r.ok) parsedOverrides.push(r.value);
    else skipped.push(r.error);
  }
  const opsTemplates: OpsTemplate[] = [];
  for (const t of templates.data ?? []) {
    if (!isEnumValue("service_type", t.service_type) || !isEnumValue("compliance_type", t.compliance_type) || !isEnumValue("service_frequency", t.frequency)) {
      skipped.push(`Ops template "${t.title}" has an unknown service, type or frequency.`);
      continue;
    }
    opsTemplates.push({
      serviceType: t.service_type,
      complianceType: t.compliance_type,
      title: t.title,
      description: t.description,
      frequency: t.frequency,
      dueDayOfMonth: t.due_day_of_month,
      dueMonth: t.due_month,
      periodOffset: t.period_offset,
      reminderDays: t.reminder_days,
      isActive: t.is_active,
    });
  }
  if (skipped.length) log("warn", "law rows skipped while planning deadlines", { source: "server:compliance:engine", skipped });

  const scale = resolveScaleParams(paramRows, today);
  const params: CalendarParams = {
    ...resolveCalendarParams(paramRows, today, CALENDAR_DEFAULTS),
    scale: { qrmpMaxTurnoverPaise: scale.qrmpMaxTurnoverPaise },
  };
  return { rules: parsedRules, rulesByCode: new Map(parsedRules.map((r) => [r.code, r])), overrides: parsedOverrides, params, templates: opsTemplates, skipped };
}

/** What the hints need (§6.7): which rules carry the GST filing bar and the ROC late fee, and their numbers. */
export function hintContextFrom(engine: Pick<ComplianceEngine, "rules" | "params">, today: DateString): HintContext {
  return {
    today,
    filingBarRules: new Set(engine.rules.filter((r) => r.rule.filingBar === true).map((r) => r.code)),
    filingBar: engine.params.filingBar,
    lateFeeRules: new Set(engine.rules.filter((r) => r.rule.lateFee === true).map((r) => r.code)),
    lateFeePerDayPaise: engine.params.rocLateFeePerDayPaise,
  };
}

/** The hint context without the ops templates and overrides (pages that only display). */
export async function loadHintContext(db: Db, today: DateString): Promise<HintContext> {
  const [rules, paramRows] = await Promise.all([db.from("due_date_rules").select(RULE_COLUMNS).limit(1000), loadParameterRows(db)]);
  if (rules.error) throw rules.error;
  const parsed = (rules.data ?? []).map(parseDueDateRuleRow).flatMap((r) => (r.ok ? [r.value] : []));
  return hintContextFrom({ rules: parsed, params: resolveCalendarParams(paramRows, today, CALENDAR_DEFAULTS) }, today);
}

export interface ServiceRow {
  client_id: string | null;
  service_type: string | null;
  frequency: string | null;
  is_active: boolean | null;
}

/**
 * Services as the engine needs them (type, frequency, active), never a fee column. Staff sessions
 * read client_services_public (§4.6); the scheduled job (`system`, the service role) reads the
 * same three columns from client_services, because the view only answers staff sessions.
 */
export async function loadServices(db: Db, opts: { clientId?: string; system?: boolean; activeOnly?: boolean } = {}): Promise<ServiceRow[]> {
  const page = (from: number, to: number) => {
    if (opts.system) {
      let q = db.from("client_services").select("client_id, service_type, frequency, is_active");
      if (opts.clientId) q = q.eq("client_id", opts.clientId);
      if (opts.activeOnly) q = q.eq("is_active", true);
      return q.order("client_id").range(from, to);
    }
    let q = db.from("client_services_public").select("client_id, service_type, frequency, is_active");
    if (opts.clientId) q = q.eq("client_id", opts.clientId);
    if (opts.activeOnly) q = q.eq("is_active", true);
    return q.order("client_id").range(from, to);
  };
  return fetchAll<ServiceRow>(page);
}

/** Reads every page of a list query (PostgREST answers at most 1,000 rows a request). */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20_000, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}
