import "server-only";

import type { Json } from "@/lib/database.types";
import { isEnumValue, type ComplianceType, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { addDays, isFinancialYear, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { deriveFromGstin, isValidStateCode } from "@/lib/domain/india-validators";
import { toPaiseOrNull } from "@/lib/domain/money";
import {
  generateEvents,
  generateOpsEvents,
  planEventSync,
  serviceTypesOfEvent,
  toComplianceEventInsert,
  type CalendarClientProfile,
  type CalendarEvent,
  type DinKyc,
  type StoredEvent,
} from "@/lib/domain/statutory-calendar";
import { fetchAll, loadComplianceEngine, loadServices, type ComplianceEngine, type Db } from "@/server/compliance/engine";
import { isPresumptiveNature } from "@/lib/schemas/onboarding";

/**
 * Deadline generation for one client (§7.7 "Generation", §6.7): the client's profile, its active
 * services, its AGM dates and DINs, run through the statutory engine (due_date_rules +
 * due_date_overrides) and the ops templates, then written by upsert_compliance_events (0125),
 * idempotent by dedupe_key:
 *   - new keys are inserted;
 *   - an unfiled engine event is rewritten only when the facts behind it changed (an AGM date was
 *     entered, a different rule now applies), as planEventSync decides; a date a person changed by
 *     hand is never overwritten;
 *   - filed, completed and cancelled events are never touched.
 * Used by "Generate deadlines" (Client 360), service changes and onboarding after-effects
 * (server/actions/compliance.ts), the coverage-gaps fix and the monthly top-up job (with the
 * service role). The engine's explanation of each date goes in `description`; `notes` is for people.
 */

export interface ClientCalendarFacts {
  id: string;
  displayName: string;
  status: string;
  ownerEmployeeId: string | null;
  profile: CalendarClientProfile;
  /** Active services, for coverage gaps. */
  services: Array<{ serviceType: ServiceType; frequency: ServiceFrequency }>;
  /** GST is an active service but the client isn't recorded as registered with a GSTIN. */
  gstBlocked: boolean;
}

export interface GenerateResult {
  created: number;
  updated: number;
  /** Filed, completed or cancelled: left alone. */
  locked: number;
  unchanged: number;
  skipped: number;
  /** Deadlines the engine produced for the window (statutory + ops). */
  generated: number;
  /** Law & rules rows that couldn't be read. */
  skippedRules: number;
  /** Untouched future deadlines of services that ended, cancelled (§3.6 "Cancelled … because the service ended"). */
  retired: number;
}

/** The client's state: from the GSTIN, else the recorded state code (§6.6). */
function stateCodeOf(gstin: string | null, stateCode: string | null): string | null {
  const parts = gstin ? deriveFromGstin(gstin) : null;
  if (parts) return parts.stateCode;
  return stateCode && isValidStateCode(stateCode) ? stateCode : null;
}

function taxAudit(value: string | null): CalendarClientProfile["taxAuditApplicable"] {
  return value === "yes" || value === "no" || value === "review" ? value : null;
}

/**
 * Loads what the engine needs to know about a client, under the caller's RLS. Null when it isn't
 * visible. Staff read services through client_services_public (no fee columns, §4.6); the scheduled
 * job (`system`, service role) reads the same three columns from client_services, because the view
 * only answers staff sessions.
 */
export async function loadClientCalendarFacts(db: Db, clientId: string, opts: { system?: boolean } = {}): Promise<ClientCalendarFacts | null> {
  const [client, services, agm, dins] = await Promise.all([
    db
      .from("clients")
      .select("id, display_name, status, deleted_at, owner_employee_id, entity_type, gst_registration, gstin, state_code, gst_scheme, annual_turnover, tax_audit_applicable, income_nature")
      .eq("id", clientId)
      .maybeSingle(),
    loadServices(db, { clientId, system: opts.system }),
    db.from("compliance_events").select("financial_year, agm_date").eq("client_id", clientId).eq("rule_code", "AGM").not("agm_date", "is", null).limit(200),
    db.from("statutory_registrations").select("registration_number, last_dir3_kyc_fy, status").eq("client_id", clientId).eq("registration_type", "DIN").limit(200),
  ]);
  if (client.error) throw client.error;
  if (agm.error) throw agm.error;
  if (dins.error) throw dins.error;
  const c = client.data;
  if (!c || c.deleted_at) return null;

  const active: Array<{ service_type: ServiceType; frequency: ServiceFrequency }> = [];
  for (const s of services) {
    if (s.is_active === true && isEnumValue("service_type", s.service_type) && isEnumValue("service_frequency", s.frequency)) {
      active.push({ service_type: s.service_type, frequency: s.frequency });
    }
  }
  const gstReady = c.gst_registration === "registered" && !!c.gstin && deriveFromGstin(c.gstin) !== null;
  const serviceTypes = [...new Set(active.map((s) => s.service_type))];

  const agmDates: Partial<Record<FinancialYear, DateString>> = {};
  for (const r of agm.data ?? []) if (r.financial_year && isFinancialYear(r.financial_year) && r.agm_date) agmDates[r.financial_year] = r.agm_date;

  const dinList: DinKyc[] = (dins.data ?? [])
    .filter((d) => d.status === "active" && d.registration_number.trim())
    .map((d) => ({ din: d.registration_number.trim(), lastKycFiledFy: d.last_dir3_kyc_fy && isFinancialYear(d.last_dir3_kyc_fy) ? d.last_dir3_kyc_fy : null }));

  return {
    id: c.id,
    displayName: c.display_name,
    status: c.status,
    ownerEmployeeId: c.owner_employee_id,
    services: active.map((s) => ({ serviceType: s.service_type, frequency: s.frequency })),
    gstBlocked: serviceTypes.includes("gst") && !gstReady,
    profile: {
      id: c.id,
      serviceTypes: serviceTypes.filter((s) => s !== "gst" || gstReady),
      entityType: c.entity_type,
      gstScheme: c.gst_scheme,
      stateCode: stateCodeOf(c.gstin, c.state_code),
      turnover: toPaiseOrNull(c.annual_turnover),
      taxAuditApplicable: taxAudit(c.tax_audit_applicable),
      // The onboarding wizard's "Income is earned from" (clients.income_nature, 0141): presumptive
      // cases pay advance tax in one instalment, as the onboarding preview planned (§6.7).
      isPresumptive: isPresumptiveNature(c.income_nature),
      agmDates,
      dins: dinList,
    },
  };
}

/** The statutory and ops deadlines for a client's window (statutory first, then the prep steps). */
export function generateClientEvents(engine: ComplianceEngine, profile: CalendarClientProfile, today: DateString): CalendarEvent[] {
  const statutory = generateEvents(profile, engine.rules, engine.overrides, { today, params: engine.params });
  const ops = generateOpsEvents(profile, engine.templates, { today, params: engine.params });
  return [...statutory, ...ops];
}

/** The upsert row for an event: the engine's explanation in `description`, `notes` left to people. */
export function toUpsertRow(e: CalendarEvent, updateReason: string | null = null): Record<string, unknown> {
  return { ...toComplianceEventInsert(e), description: e.notes, notes: null, update_reason: updateReason };
}

async function storedEvents(db: Db, clientId: string, from: DateString): Promise<StoredEvent[]> {
  const rows = await fetchAll((a, b) =>
    db
      .from("compliance_events")
      .select("id, dedupe_key, rule_code, due_date, status, workflow_status, source, is_provisional, agm_date")
      .eq("client_id", clientId)
      .not("dedupe_key", "is", null)
      .gte("due_date", from)
      .order("due_date")
      .range(a, b),
  );
  return rows.map((r) => ({
    id: r.id,
    dedupeKey: r.dedupe_key,
    ruleCode: r.rule_code,
    dueDate: r.due_date,
    status: r.status,
    workflowStatus: r.workflow_status,
    source: r.source,
    provisional: r.is_provisional,
    agmDate: r.agm_date,
  }));
}

/** The rows to send: new keys, plus the stored events whose facts changed (with the reason). */
export async function planClientDeadlines(db: Db, engine: ComplianceEngine, facts: ClientCalendarFacts, today: DateString) {
  const generated = generateClientEvents(engine, facts.profile, today);
  // Stored events a little before the window too, so a provisional date that moves earlier is found.
  const existing = await storedEvents(db, facts.id, addDays(today, -120));
  const plan = planEventSync(existing, generated);
  const rows = [...plan.insert.map((e) => toUpsertRow(e)), ...plan.update.map((u) => toUpsertRow(u.event, u.reason))];
  return { generated, plan, rows };
}

const BATCH = 1000;

/** The services a stored deadline belongs to: its rule's services, or the service in an ops step's key. */
function servicesOfStored(e: { type: string; form_code: string | null; rule_code: string | null; dedupe_key: string | null; due_date: string }, engine: ComplianceEngine): ServiceType[] {
  const ops = e.dedupe_key ? /\|ops:([a-z_]+):/.exec(e.dedupe_key) : null;
  if (ops && isEnumValue("service_type", ops[1])) return [ops[1]];
  return serviceTypesOfEvent({ type: e.type as ComplianceType, formCode: e.form_code, ruleCode: e.rule_code, dueDate: e.due_date }, engine.rulesByCode);
}

/**
 * On a service change (§7.7 "Generation: on service changes"): future deadlines the engine planned
 * for services that are no longer active, and that nobody has started, are cancelled with a history
 * line. Started, filed, hand-made and past deadlines are left alone, as is anything whose service
 * can't be told. Writes need a Partner or Manager (or the job); returns how many were cancelled.
 */
export async function retireEndedServiceEvents(db: Db, engine: ComplianceEngine, facts: ClientCalendarFacts, today: DateString): Promise<number> {
  const active = new Set(facts.services.map((s) => s.serviceType));
  const rows = await fetchAll((a, b) =>
    db
      .from("compliance_events")
      .select("id, type, form_code, rule_code, dedupe_key, due_date, title")
      .eq("client_id", facts.id)
      .eq("status", "pending")
      .eq("workflow_status", "not_started")
      .in("source", ["statutory_engine", "ops_template"])
      .gte("due_date", today)
      .order("due_date")
      .range(a, b),
  );
  const ended = rows.filter((e) => {
    const services = servicesOfStored(e, engine);
    return services.length > 0 && services.every((s) => !active.has(s));
  });
  if (ended.length === 0) return 0;
  let retired = 0;
  for (let i = 0; i < ended.length; i += 100) {
    const batch = ended.slice(i, i + 100);
    const { data, error } = await db
      .from("compliance_events")
      .update({ status: "cancelled" })
      .in("id", batch.map((e) => e.id))
      .eq("status", "pending")
      .eq("workflow_status", "not_started")
      .select("id");
    if (error) throw error;
    const done = new Set((data ?? []).map((r) => r.id));
    retired += done.size;
    const logs = batch
      .filter((e) => done.has(e.id))
      .map((e) => ({
        entity_type: "compliance_event",
        entity_id: e.id,
        action: "cancelled",
        description: "Cancelled: the service it belongs to has ended.",
        metadata: { reason: "service_ended" } as Json,
      }));
    if (logs.length) {
      const { error: le } = await db.from("activity_logs").insert(logs);
      if (le) throw le;
    }
  }
  return retired;
}

/** Plans and writes one client's deadlines. Throws on a database error; the caller reports it. */
export async function generateForClient(
  db: Db,
  clientId: string,
  opts: {
    today: DateString;
    engine?: ComplianceEngine;
    facts?: ClientCalendarFacts | null;
    system?: boolean;
    /** Also cancel untouched future deadlines of services that ended (Partners, Managers, the job). */
    retire?: boolean;
  },
): Promise<GenerateResult | null> {
  const engine = opts.engine ?? (await loadComplianceEngine(db, opts.today));
  const facts = opts.facts === undefined ? await loadClientCalendarFacts(db, clientId, { system: opts.system }) : opts.facts;
  if (!facts) return null;
  const { generated, rows } = await planClientDeadlines(db, engine, facts, opts.today);
  const total: GenerateResult = { created: 0, updated: 0, locked: 0, unchanged: generated.length - rows.length, skipped: 0, generated: generated.length, skippedRules: engine.skipped.length, retired: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await db.rpc("upsert_compliance_events", { p_rows: rows.slice(i, i + BATCH) as unknown as Json });
    if (error) throw error;
    const r = (data ?? {}) as Partial<Record<"inserted" | "updated" | "locked" | "unchanged" | "skipped", number>>;
    total.created += r.inserted ?? 0;
    total.updated += r.updated ?? 0;
    total.locked += r.locked ?? 0;
    total.unchanged += r.unchanged ?? 0;
    total.skipped += r.skipped ?? 0;
  }
  if (opts.retire) total.retired = await retireEndedServiceEvents(db, engine, facts, opts.today);
  return total;
}
