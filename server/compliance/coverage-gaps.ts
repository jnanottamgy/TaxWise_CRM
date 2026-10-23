import "server-only";

import { COMPANY_ENTITY_TYPES, coverageGaps, serviceTypesOfEvent, type CoverageEvent, type CoverageGap } from "@/lib/domain/statutory-calendar";
import { SERVICE_TYPE_LABELS, isEnumValue, type ComplianceType, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { compareDates, monthPeriodLabel, type DateString } from "@/lib/domain/fy";
import { fetchAll, loadServices, type ComplianceEngine, type Db } from "@/server/compliance/engine";
import { generateClientEvents, loadClientCalendarFacts, type ClientCalendarFacts } from "@/server/compliance/generate";

/**
 * Coverage gaps (§7.7): clients whose active services have no upcoming statutory deadlines ("GST
 * service active but no GSTR-3B events after Dec 2026"), each with its one-click fix:
 *   - generate: the engine would plan dates that aren't stored yet, so "Generate deadlines" fixes it;
 *   - edit_profile: the engine can't plan them from what the client record says (GST active but no
 *     GSTIN; ROC for an entity that isn't a company or LLP), so the fix is the profile;
 *   - add_event: no rule on Law & rules covers the service for this client; add the dates by hand.
 * Cancelled deadlines and internal prep steps don't count as cover (lib/domain coverageGaps).
 */

export type GapFix = "generate" | "edit_profile" | "add_event";

export interface ClientGap extends CoverageGap {
  fixKind: GapFix;
  /** Why generating won't help, when it won't. */
  reason: string | null;
  /** Deadlines "Generate deadlines" would add for this service. */
  wouldAdd: number;
}

export interface ClientGapsRow {
  clientId: string;
  clientName: string;
  clientCode: string;
  ownerName: string | null;
  gaps: ClientGap[];
}

type CoverRow = { client_id: string; type: ComplianceType; form_code: string | null; rule_code: string | null; last_due: DateString; next_due: DateString; upcoming: number };

async function coverage(db: Db, clientIds: string[] | null): Promise<CoverRow[]> {
  const { data, error } = await db.rpc("compliance_coverage", { p_client_ids: clientIds });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as unknown as CoverRow[];
}

function toCoverageEvents(rows: readonly CoverRow[]): CoverageEvent[] {
  return rows.map((r) => ({ type: r.type, formCode: r.form_code, ruleCode: r.rule_code, dueDate: r.last_due, status: "pending", source: "statutory_engine", isStatutory: true }));
}

/** Classifies each gap's fix by generating the client's deadlines in memory (nothing is written). */
function classify(engine: ComplianceEngine, facts: ClientCalendarFacts, gaps: readonly CoverageGap[], today: DateString): ClientGap[] {
  if (gaps.length === 0) return [];
  const planned = generateClientEvents(engine, facts.profile, today).filter((e) => e.isStatutory);
  return gaps.map((g) => {
    const forService = planned.filter((e) => serviceTypesOfEvent({ serviceType: e.serviceType, type: e.type, formCode: e.formCode, ruleCode: e.ruleCode, dueDate: e.dueDate }, engine.rulesByCode).includes(g.serviceType));
    const after = g.coveredUntil;
    const wouldAdd = forService.filter((e) => !after || compareDates(e.dueDate, after) > 0).length;
    if (wouldAdd > 0) return { ...g, fixKind: "generate" as const, reason: null, wouldAdd };
    if (g.serviceType === "gst" && facts.gstBlocked) {
      return { ...g, fixKind: "edit_profile" as const, wouldAdd: 0, reason: "The client isn't recorded as GST-registered with a valid GSTIN, so no GST returns can be planned. Update the GST details on the profile." };
    }
    if (g.serviceType === "company_law" && facts.profile.entityType !== "llp" && !(facts.profile.entityType && COMPANY_ENTITY_TYPES.includes(facts.profile.entityType))) {
      return { ...g, fixKind: "edit_profile" as const, wouldAdd: 0, reason: "ROC filings are planned for companies and LLPs. Check the entity type on the profile, or add the dates by hand." };
    }
    const label = SERVICE_TYPE_LABELS[g.serviceType];
    return {
      ...g,
      fixKind: "add_event" as const,
      wouldAdd: 0,
      reason: after
        ? `No rule on Law & rules plans ${label.toLowerCase()} after ${monthPeriodLabel(after)} for this client. Add the deadlines by hand, or ask a Partner to add the rule.`
        : `No rule on Law & rules plans ${label.toLowerCase()} for this client. Add the deadlines by hand, or ask a Partner to add the rule.`,
    };
  });
}

/** One client's gaps (Client 360 → Compliance). Empty when everything active is covered. */
export async function clientCoverageGaps(db: Db, engine: ComplianceEngine, clientId: string, today: DateString, facts?: ClientCalendarFacts | null): Promise<ClientGap[]> {
  const f = facts === undefined ? await loadClientCalendarFacts(db, clientId) : facts;
  if (!f) return [];
  const gaps = coverageGaps(
    f.services.map((s) => ({ serviceType: s.serviceType, frequency: s.frequency })),
    toCoverageEvents(await coverage(db, [clientId])),
    today,
    { params: engine.params, rules: engine.rules },
  );
  return classify(engine, f, gaps, today);
}

/**
 * Every client's gaps (the report on the filings page and the monthly job): clients that aren't
 * inactive or in the recycle bin, with at least one active service the calendar fills. The fix is
 * worked out for at most `classifyMax` clients (each is generated in memory).
 */
export async function firmCoverageGaps(db: Db, engine: ComplianceEngine, today: DateString, opts: { classifyMax?: number; system?: boolean } = {}): Promise<ClientGapsRow[]> {
  const [services, clients, cover] = await Promise.all([
    loadServices(db, { system: opts.system, activeOnly: true }),
    fetchAll((a, b) =>
      db.from("clients").select("id, display_name, client_code, status, owner_employee_id").is("deleted_at", null).neq("status", "inactive").order("display_name").range(a, b),
    ),
    coverage(db, null),
  ]);

  const byClient = new Map<string, Array<{ serviceType: ServiceType; frequency: ServiceFrequency }>>();
  for (const s of services) {
    if (!s.client_id || !isEnumValue("service_type", s.service_type) || !isEnumValue("service_frequency", s.frequency)) continue;
    const list = byClient.get(s.client_id) ?? [];
    list.push({ serviceType: s.service_type, frequency: s.frequency });
    byClient.set(s.client_id, list);
  }
  const coverByClient = new Map<string, CoverRow[]>();
  for (const r of cover) {
    const list = coverByClient.get(r.client_id) ?? [];
    list.push(r);
    coverByClient.set(r.client_id, list);
  }

  const owners = new Map<string, string>();
  const ownerIds = [...new Set(clients.map((c) => c.owner_employee_id).filter((v): v is string => !!v))];
  if (ownerIds.length) {
    // The directory view answers staff sessions; the job reads the employees table (names only).
    const { data, error } = opts.system
      ? await db.from("employees").select("id, full_name").in("id", ownerIds.slice(0, 300))
      : await db.from("employee_directory").select("id, full_name").in("id", ownerIds.slice(0, 300));
    if (error) throw error;
    for (const e of (data ?? []) as Array<{ id: string | null; full_name: string | null }>) if (e.id && e.full_name) owners.set(e.id, e.full_name);
  }

  const rows: ClientGapsRow[] = [];
  let classified = 0;
  const max = opts.classifyMax ?? 200;
  for (const c of clients) {
    const svc = byClient.get(c.id);
    if (!svc?.length) continue;
    const gaps = coverageGaps(svc, toCoverageEvents(coverByClient.get(c.id) ?? []), today, { params: engine.params, rules: engine.rules });
    if (gaps.length === 0) continue;
    let detailed: ClientGap[];
    if (classified < max) {
      classified++;
      const facts = await loadClientCalendarFacts(db, c.id, { system: opts.system });
      detailed = facts ? classify(engine, facts, gaps, today) : gaps.map((g) => ({ ...g, fixKind: "generate" as const, reason: null, wouldAdd: 0 }));
    } else {
      detailed = gaps.map((g) => ({ ...g, fixKind: "generate" as const, reason: null, wouldAdd: 0 }));
    }
    rows.push({ clientId: c.id, clientName: c.display_name, clientCode: c.client_code, ownerName: c.owner_employee_id ? (owners.get(c.owner_employee_id) ?? null) : null, gaps: detailed });
  }
  return rows;
}
