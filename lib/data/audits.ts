import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Json, Tables } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import { addDays, fyStart, istDateOf, type DateString } from "@/lib/domain/fy";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { CEILING_PARAM_KEYS, resolveCeilingParams, type CeilingParams } from "@/lib/domain/ceiling";
import {
  AUDIT_PARAM_KEYS,
  AUDIT_STAGES,
  isAuditStage,
  isAuditType,
  nextStage,
  readChecklist,
  readCompanyFacts,
  readGate,
  readMateriality,
  resolveAuditParams,
  type AuditParams,
  type AuditStage,
  type AuditType,
  type CompanyFacts,
  type GateResult,
  type StepSignoff,
  type StoredMateriality,
} from "@/lib/domain/audit-stages";
import { AUDIT_LIST_SORTABLE, type AuditAttention, type AuditListFilter, type AuditListSort } from "@/lib/schemas/audits";

/**
 * Reads for audit engagements (§6.9, §7.15.5), under the caller's session. RLS gives Partners and
 * Managers every engagement and nobody else any (0033), so an Employee or a portal user reaching
 * these gets nothing. Lists page, sort and filter in SQL (§2.3) through `audit_engagements_list`
 * (0198); the engagement page reads the gate (`audit_stage_gate`) and the ceiling check
 * (`audit_limit_check`) from the database, which is where they are enforced.
 */

export type AuditListRow = Tables<"audit_engagements_list">;

export type AuditListResult = { rows: AuditListRow[]; total: number };

export async function listAudits(
  supabase: ServerSupabase,
  t: TableParams<AuditListSort, AuditListFilter>,
  opts: { today: DateString; clientId?: string | null; limit?: number } = { today: "" },
): Promise<AuditListResult> {
  const sort: AuditListSort = t.sort && (AUDIT_LIST_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "updated_at";
  let q = supabase.from("audit_engagements_list").select("*", { count: "exact" });
  const clientId = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (clientId) q = q.eq("client_id", clientId);
  if (t.q) {
    const like = `%${escapeLike(t.q)}%`;
    q = q.or(`client_name.ilike.${like},client_code.ilike.${like},udin.ilike.${like},engagement_partner_name.ilike.${like}`);
  }
  if (t.filters.stage?.length) q = q.in("stage", t.filters.stage);
  if (t.filters.type?.length) q = q.in("audit_type", t.filters.type);
  if (t.filters.partner?.[0]) q = q.eq("engagement_partner_id", t.filters.partner[0]);
  if (t.filters.year?.[0]) q = q.eq("financial_year", t.filters.year[0]);
  for (const a of (t.filters.attention ?? []) as AuditAttention[]) {
    if (a === "open") q = q.is("archived_at", null);
    if (a === "assembly_due") q = q.is("archived_at", null).gte("file_assembly_due", opts.today).lte("file_assembly_due", addDays(opts.today, 14));
    if (a === "assembly_overdue") q = q.is("archived_at", null).lt("file_assembly_due", opts.today);
    if (a === "no_udin") q = q.is("archived_at", null).not("report_date", "is", null).is("udin_record_id", null);
  }
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("id", { ascending: true });
  const limit = opts.limit ?? t.pageSize;
  const { data, error, count } = await q.range(t.from, t.from + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

export type AuditSummary = { open: number; atAcceptance: number; assemblyDue: number; assemblyOverdue: number; noUdin: number };

/** The figures above the list, each the count behind a filter (§7.2 every tile links to its list). */
export async function getAuditSummary(supabase: ServerSupabase, today: DateString): Promise<AuditSummary> {
  const head = () => supabase.from("audit_engagements_list").select("id", { count: "exact", head: true });
  const [open, acceptance, due, overdue, noUdin] = await Promise.all([
    head().is("archived_at", null),
    head().eq("stage", "acceptance"),
    head().is("archived_at", null).gte("file_assembly_due", today).lte("file_assembly_due", addDays(today, 14)),
    head().is("archived_at", null).lt("file_assembly_due", today),
    head().is("archived_at", null).not("report_date", "is", null).is("udin_record_id", null),
  ]);
  for (const r of [open, acceptance, due, overdue, noUdin]) if (r.error) throw r.error;
  return { open: open.count ?? 0, atAcceptance: acceptance.count ?? 0, assemblyDue: due.count ?? 0, assemblyOverdue: overdue.count ?? 0, noUdin: noUdin.count ?? 0 };
}

export type StaffOption = { value: string; label: string; description?: string };

/** Active Partners (engagement partners) and Partners/Managers (review managers), by employees.id. */
export async function listAuditTeamOptions(supabase: ServerSupabase): Promise<{ partners: StaffOption[]; reviewers: StaffOption[] }> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, full_name, designation, profiles!inner(role, is_active)")
    .eq("is_active", true)
    .is("deleted_at", null)
    .in("profiles.role", ["partner", "manager"])
    .eq("profiles.is_active", true)
    .order("full_name")
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{ id: string; full_name: string; designation: string | null; profiles: { role: string } }>;
  const opt = (r: (typeof rows)[number]): StaffOption => ({ value: r.id, label: r.full_name, description: r.profiles.role === "partner" ? "Partner" : "Manager" });
  return { partners: rows.filter((r) => r.profiles.role === "partner").map(opt), reviewers: rows.map(opt) };
}

// =================================================================================================
// The engagement page
// =================================================================================================

export type EvidenceRow = {
  id: string;
  step_key: string;
  document_id: string;
  is_amendment: boolean;
  amendment_note: string | null;
  added_at: string;
  added_by_name: string | null;
  title: string;
  file_name: string;
  category: string;
  deleted: boolean;
};

export type StageLogRow = { id: string; from_stage: string; to_stage: string; note: string | null; at: string; approved_by_name: string | null; warnings: Json };

export type PreviousAuditorRow = {
  id: string;
  client_id: string;
  audit_engagement_id: string | null;
  engagement_type: string;
  previous_auditor_name: string;
  previous_auditor_frn: string | null;
  letter_sent_on: string;
  sent_via: string | null;
  delivery_proof_document_id: string | null;
  delivery_proof_title: string | null;
  reply_received_on: string | null;
  objections: string | null;
  outcome: string | null;
  notes: string | null;
  updated_at: string;
};

export type LetterRow = { id: string; financial_year: string; status: string; audit_type: string | null; audit_engagement_id: string | null; issued_at: string | null; signed_at: string | null; service_types: string[] };

export type UdinOption = { id: string; udin: string; document_type: string; signed_on: string; generated_on: string; audit_engagement_id: string | null };

export type KycStatus = { missing: string[]; complete: boolean; review_due: boolean; current: boolean };

export type LimitCheck = {
  kind: "company" | "tax_audit" | null;
  level: "ok" | "warn" | "block" | "confirm" | "unknown";
  counted: boolean | null;
  current?: number;
  position?: number;
  limit?: number;
  financial_year?: string;
  overridden?: boolean;
  message: string | null;
};

export type TaskLink = { id: string; task_number: string; title: string; status: string; due_date: string | null };

export type AuditDetail = {
  engagement: Tables<"audit_engagements">;
  stage: AuditStage;
  auditType: AuditType;
  client: { id: string; display_name: string; legal_name: string | null; client_code: string; entity_type: string; pan: string | null; address: string | null; city: string | null; state_code: string | null; pincode: string | null };
  partner: { id: string; name: string; profileId: string | null } | null;
  reviewManager: { id: string; name: string } | null;
  checklist: Record<string, StepSignoff>;
  materiality: StoredMateriality | null;
  company: CompanyFacts;
  evidence: EvidenceRow[];
  log: StageLogRow[];
  gate: GateResult | null;
  limit: LimitCheck | null;
  kyc: KycStatus;
  acceptance: { id: string; outcome: string; decided_at: string | null } | null;
  peerReview: { valid_until: string; certificate_no: string | null } | null;
  communications: PreviousAuditorRow[];
  letters: LetterRow[];
  udins: UdinOption[];
  linkedUdin: UdinOption | null;
  tasks: TaskLink[];
  names: Record<string, string>;
  params: AuditParams;
  ceiling: CeilingParams;
  limitOverrideByName: string | null;
};

const PAC_COLUMNS =
  "id, client_id, audit_engagement_id, engagement_type, previous_auditor_name, previous_auditor_frn, letter_sent_on, sent_via, delivery_proof_document_id, reply_received_on, objections, outcome, notes, updated_at, documents:delivery_proof_document_id(title)";

function toPac(r: Record<string, unknown>): PreviousAuditorRow {
  const doc = r.documents as { title: string } | null;
  return { ...(r as unknown as PreviousAuditorRow), delivery_proof_title: doc?.title ?? null };
}

/** Parameter rows the audit and ceiling rules read, in force on a date. */
async function paramRows(supabase: ServerSupabase): Promise<StatutoryParameterRow[]> {
  const keys = [...Object.values(AUDIT_PARAM_KEYS), ...Object.values(CEILING_PARAM_KEYS)];
  const { data, error } = await supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", keys);
  if (error) throw error;
  return (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
}

export async function getAuditParams(supabase: ServerSupabase, on: DateString): Promise<{ audit: AuditParams; ceiling: CeilingParams }> {
  const rows = await paramRows(supabase);
  return { audit: resolveAuditParams(rows, on).params, ceiling: resolveCeilingParams(rows, on).params };
}

/** One engagement with everything its page shows, or null when it doesn't exist or isn't visible. */
export async function getAuditDetail(supabase: ServerSupabase, id: string, today: DateString): Promise<AuditDetail | null> {
  const { data: e, error } = await supabase.from("audit_engagements").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!e) return null;
  const stage: AuditStage = isAuditStage(e.stage) ? e.stage : "acceptance";
  const auditType: AuditType = isAuditType(e.audit_type) ? e.audit_type : "other";
  const to = nextStage(stage);

  const [client, team, evidence, log, gate, limit, kyc, acceptance, peer, pac, letters, udins, tasks, params] = await Promise.all([
    supabase.from("clients").select("id, display_name, legal_name, client_code, entity_type, pan, address, city, state_code, pincode").eq("id", e.client_id).maybeSingle(),
    supabase.from("employees").select("id, full_name, profile_id").in("id", [e.engagement_partner_id, e.review_manager_id].filter((x): x is string => !!x)),
    supabase
      .from("audit_engagement_documents")
      .select("id, step_key, document_id, is_amendment, amendment_note, added_at, added_by, documents!inner(title, file_name, category, deleted_at)")
      .eq("engagement_id", id)
      .order("added_at"),
    supabase.from("audit_engagement_stage_log").select("id, from_stage, to_stage, note, at, approved_by, warnings").eq("engagement_id", id).order("at", { ascending: false }).limit(50),
    to && stage !== "archived" ? supabase.rpc("audit_stage_gate", { p_id: id, p_to: to }) : Promise.resolve({ data: null, error: null }),
    stage === "acceptance" ? supabase.rpc("audit_limit_check", { p_id: id }) : Promise.resolve({ data: null, error: null }),
    supabase.rpc("kyc_status", { p_client_id: e.client_id }),
    supabase.from("client_acceptances").select("id, outcome, decided_at").eq("client_id", e.client_id).order("decided_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from("peer_reviews").select("valid_until, certificate_no").eq("status", "completed").not("valid_until", "is", null).gte("valid_until", today).order("valid_until", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("previous_auditor_communications").select(PAC_COLUMNS).eq("client_id", e.client_id).order("letter_sent_on", { ascending: false }).limit(20),
    supabase
      .from("engagement_letters")
      .select("id, financial_year, status, audit_type, audit_engagement_id, issued_at, signed_at, service_types")
      .eq("client_id", e.client_id)
      .in("financial_year", [e.financial_year])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("udin_records").select("id, udin, document_type, signed_on, generated_on, audit_engagement_id").eq("client_id", e.client_id).order("signed_on", { ascending: false }).limit(50),
    supabase
      .from("tasks")
      .select("id, task_number, title, status, due_date")
      .eq("client_id", e.client_id)
      .eq("financial_year", e.financial_year)
      .is("deleted_at", null)
      .or("service_type.eq.audit,title.ilike.%audit%")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(20),
    getAuditParams(supabase, today),
  ]);
  for (const r of [client, team, evidence, log, gate, limit, kyc, acceptance, peer, pac, letters, udins, tasks]) if (r.error) throw r.error;
  if (!client.data) return null;

  const teamRows = team.data ?? [];
  const partnerRow = teamRows.find((t) => t.id === e.engagement_partner_id) ?? null;
  const managerRow = e.review_manager_id ? (teamRows.find((t) => t.id === e.review_manager_id) ?? null) : null;
  const checklist = readChecklist(e.checklist);

  const evidenceRows = ((evidence.data ?? []) as unknown as Array<{
    id: string;
    step_key: string;
    document_id: string;
    is_amendment: boolean;
    amendment_note: string | null;
    added_at: string;
    added_by: string;
    documents: { title: string; file_name: string; category: string; deleted_at: string | null };
  }>);
  const logRows = (log.data ?? []) as Array<{ id: string; from_stage: string; to_stage: string; note: string | null; at: string; approved_by: string; warnings: Json }>;

  // Everyone named on the page: preparers, reviewers, evidence and log authors, the override.
  const ids = new Set<string>();
  for (const s of Object.values(checklist)) {
    if (s.preparedBy) ids.add(s.preparedBy);
    if (s.reviewedBy) ids.add(s.reviewedBy);
  }
  for (const r of evidenceRows) ids.add(r.added_by);
  for (const r of logRows) ids.add(r.approved_by);
  if (e.limit_override_by) ids.add(e.limit_override_by);
  const names: Record<string, string> = {};
  if (ids.size) {
    const { data: people, error: peopleError } = await supabase.from("profiles").select("id, full_name").in("id", [...ids]);
    if (peopleError) throw peopleError;
    for (const p of people ?? []) names[p.id] = p.full_name;
  }

  const udinRows = (udins.data ?? []).map((u) => ({ ...u, udin: String(u.udin) })) as UdinOption[];
  return {
    engagement: e,
    stage,
    auditType,
    client: { ...client.data, client_code: String(client.data.client_code), entity_type: String(client.data.entity_type), pan: client.data.pan ? String(client.data.pan) : null, state_code: client.data.state_code ? String(client.data.state_code) : null, pincode: client.data.pincode ? String(client.data.pincode) : null },
    partner: partnerRow ? { id: partnerRow.id, name: partnerRow.full_name, profileId: partnerRow.profile_id } : null,
    reviewManager: managerRow ? { id: managerRow.id, name: managerRow.full_name } : null,
    checklist,
    materiality: readMateriality(e.materiality),
    company: readCompanyFacts(e.company_profile),
    evidence: evidenceRows.map((r) => ({
      id: r.id,
      step_key: r.step_key,
      document_id: r.document_id,
      is_amendment: r.is_amendment,
      amendment_note: r.amendment_note,
      added_at: r.added_at,
      added_by_name: names[r.added_by] ?? null,
      title: r.documents.title,
      file_name: r.documents.file_name,
      category: r.documents.category,
      deleted: Boolean(r.documents.deleted_at),
    })),
    log: logRows.map((r) => ({ id: r.id, from_stage: r.from_stage, to_stage: r.to_stage, note: r.note, at: r.at, approved_by_name: names[r.approved_by] ?? null, warnings: r.warnings })),
    gate: gate.data && to ? readGate(gate.data, { from: stage, to }) : null,
    limit: (limit.data as LimitCheck | null) ?? null,
    kyc: (kyc.data as KycStatus | null) ?? { missing: ["the KYC record"], complete: false, review_due: true, current: false },
    acceptance: acceptance.data ? { id: acceptance.data.id, outcome: String(acceptance.data.outcome), decided_at: acceptance.data.decided_at } : null,
    peerReview: peer.data?.valid_until ? { valid_until: peer.data.valid_until, certificate_no: peer.data.certificate_no } : null,
    communications: ((pac.data ?? []) as unknown as Array<Record<string, unknown>>).map(toPac),
    letters: ((letters.data ?? []) as unknown as LetterRow[]).map((l) => ({ ...l, service_types: (l.service_types ?? []).map(String) })),
    udins: udinRows,
    linkedUdin: e.udin_record_id ? (udinRows.find((u) => u.id === e.udin_record_id) ?? null) : null,
    tasks: (tasks.data ?? []) as TaskLink[],
    names,
    params: params.audit,
    ceiling: params.ceiling,
    limitOverrideByName: e.limit_override_by ? (names[e.limit_override_by] ?? null) : null,
  };
}

/** The current stage's gate for an engagement (refreshed after a sign-off). */
export async function getStageGate(supabase: ServerSupabase, id: string, from: AuditStage): Promise<GateResult | null> {
  const to = nextStage(from);
  if (!to) return null;
  const { data, error } = await supabase.rpc("audit_stage_gate", { p_id: id, p_to: to });
  if (error) throw error;
  return readGate(data, { from, to });
}

/** The client's documents to pick evidence from (newest first; audit and KYC categories first). */
export async function searchEvidenceDocuments(supabase: ServerSupabase, clientId: string, q: string): Promise<Array<{ value: string; label: string; description: string }>> {
  let query = supabase.from("documents").select("id, title, file_name, category, financial_year, created_at").eq("client_id", clientId).is("deleted_at", null);
  if (q.trim()) {
    const like = `%${escapeLike(q.trim())}%`;
    query = query.or(`title.ilike.${like},file_name.ilike.${like}`);
  }
  const { data, error } = await query.order("created_at", { ascending: false }).limit(40);
  if (error) throw error;
  const weight = (c: string) => (c === "audit" ? 0 : c === "kyc" ? 1 : 2);
  return (data ?? [])
    .sort((a, b) => weight(String(a.category)) - weight(String(b.category)))
    .map((d) => ({ value: d.id, label: d.title, description: [d.file_name, d.financial_year ? `FY ${d.financial_year}` : null].filter(Boolean).join(" · ") }));
}

/** An engagement's audit-year FY start, for parameters "in force for the year". */
export function engagementParamDate(financialYear: string): DateString {
  return fyStart(financialYear);
}

/** For Client 360's Engagement tab: the client's engagements, newest year first. */
export async function listClientAudits(supabase: ServerSupabase, clientId: string): Promise<AuditListRow[]> {
  const { data, error } = await supabase.from("audit_engagements_list").select("*").eq("client_id", clientId).order("financial_year", { ascending: false }).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
}

/** For Client 360: the client's letters to previous auditors. */
export async function listClientPreviousAuditorComms(supabase: ServerSupabase, clientId: string): Promise<PreviousAuditorRow[]> {
  const { data, error } = await supabase.from("previous_auditor_communications").select(PAC_COLUMNS).eq("client_id", clientId).order("letter_sent_on", { ascending: false }).limit(50);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(toPac);
}

/** For Client 360: the client's acceptance and conflict-check records (§7.5.4). */
export async function listClientAcceptances(
  supabase: ServerSupabase,
  clientId: string,
): Promise<Array<{ id: string; prospect_name: string; outcome: string; rationale: string | null; decided_at: string | null; created_at: string; conflict_count: number; independence_threat: boolean }>> {
  const { data, error } = await supabase
    .from("client_acceptances_list")
    .select("id, prospect_name, outcome, rationale, decided_at, created_at, conflict_count, independence_threat")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    prospect_name: r.prospect_name as string,
    outcome: String(r.outcome),
    rationale: (r.rationale as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    created_at: r.created_at as string,
    conflict_count: Number(r.conflict_count ?? 0),
    independence_threat: Boolean(r.independence_threat),
  }));
}

/** Stages, in order, for a stage filter. */
export const STAGE_FILTER_VALUES: readonly AuditStage[] = AUDIT_STAGES;

// =================================================================================================
// Generated documents: the SA 580 representation letter and the checklist export (§11)
// =================================================================================================

export type RepresentationLetterData = {
  engagementId: string;
  auditType: AuditType;
  financialYear: string;
  stage: AuditStage;
  reportDate: string | null;
  caroApplicable: boolean | null;
  trivialRupees: number | null;
  client: { name: string; code: string; entityType: string | null; address: string | null; pan: string | null; cin: string | null };
  engagementLetterDate: string | null;
  /** The framework the SA 210 letter names, when it names one. */
  framework: string | null;
  partnerName: string | null;
  firmFrn: string | null;
};

/** What the management representation letter template prints, or null when the engagement isn't visible. */
export async function getRepresentationLetterData(supabase: ServerSupabase, id: string): Promise<RepresentationLetterData | null> {
  const { data: e, error } = await supabase
    .from("audit_engagements")
    .select("id, client_id, audit_type, financial_year, stage, report_date, caro_applicable, materiality, engagement_partner_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!e) return null;
  const [client, kyc, letters, partner, settings] = await Promise.all([
    supabase.from("clients").select("display_name, legal_name, client_code, entity_type, pan, address, city, state_code, pincode").eq("id", e.client_id).maybeSingle(),
    supabase.from("client_kyc").select("cin_llpin, registered_address, pan").eq("client_id", e.client_id).maybeSingle(),
    supabase
      .from("engagement_letters")
      .select("id, status, issued_at, signed_at, audit_engagement_id, audit_type, financial_year, reporting_framework")
      .eq("client_id", e.client_id)
      .eq("financial_year", e.financial_year)
      .in("status", ["issued", "signed"])
      .order("signed_at", { ascending: false, nullsFirst: false })
      .limit(10),
    supabase.from("employees").select("full_name").eq("id", e.engagement_partner_id).maybeSingle(),
    supabase.from("firm_settings").select("icai_frn").eq("id", 1).maybeSingle(),
  ]);
  for (const r of [client, kyc, letters, partner, settings]) if (r.error) throw r.error;
  if (!client.data) return null;
  const c = client.data;
  const rows = (letters.data ?? []) as Array<{ issued_at: string | null; signed_at: string | null; audit_engagement_id: string | null; audit_type: string | null; reporting_framework: string | null }>;
  const letter = rows.find((l) => l.audit_engagement_id === e.id) ?? rows.find((l) => l.audit_type === e.audit_type) ?? rows[0] ?? null;
  const letterDate = letter ? (letter.signed_at ?? letter.issued_at) : null;
  const cityLine = [c.city, c.pincode ? String(c.pincode) : null].filter(Boolean).join(" ");
  const address = kyc.data?.registered_address?.trim() || [c.address, cityLine].filter((x) => x && String(x).trim()).join(", ") || null;
  const m = readMateriality(e.materiality);
  return {
    engagementId: e.id,
    auditType: isAuditType(e.audit_type) ? e.audit_type : "other",
    financialYear: e.financial_year,
    stage: isAuditStage(e.stage) ? e.stage : "acceptance",
    reportDate: e.report_date,
    caroApplicable: e.caro_applicable,
    trivialRupees: m ? m.trivial : null,
    client: {
      name: c.legal_name?.trim() || c.display_name,
      code: String(c.client_code),
      entityType: c.entity_type ? String(c.entity_type) : null,
      address,
      pan: (kyc.data?.pan ?? c.pan) ? String(kyc.data?.pan ?? c.pan) : null,
      cin: kyc.data?.cin_llpin ?? null,
    },
    engagementLetterDate: letterDate ? istDateOf(letterDate) : null,
    framework: letter?.reporting_framework?.trim() || null,
    partnerName: partner.data?.full_name ?? null,
    firmFrn: settings.data?.icai_frn ?? null,
  };
}

/** The checklist export (§11 "Audit engagement checklist export"): the page's detail, as data. */
export async function getAuditChecklistExport(supabase: ServerSupabase, id: string, today: DateString): Promise<AuditDetail | null> {
  return getAuditDetail(supabase, id, today);
}
