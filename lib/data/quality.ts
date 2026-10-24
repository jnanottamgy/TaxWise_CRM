import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Tables } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import { addMonths, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { peerReviewStatus, type CeilingParams } from "@/lib/domain/ceiling";
import { isClosedRequestStatus } from "@/lib/domain/dpdp";
import { KYC_SORTABLE, DISPOSAL_SORTABLE, calendarQuarter, qualityItemReviewDue, type KycState, type QualityFramework } from "@/lib/schemas/quality";

/**
 * Reads for the quality and risk module (§7.15.4, §6.8, §12), under the caller's session. RLS gives
 * Partners and Managers these records (Managers read-only, 0039/0197); Employees get only their own
 * independence declaration, and nothing here reaches a portal user. Lists page, sort and filter in
 * SQL (§2.3).
 */

// =================================================================================================
// Overview
// =================================================================================================

export type QualityOverview = {
  framework: QualityFramework;
  frameworkUpdatedAt: string | null;
  manual: { total: number; reviewDue: number };
  peerReview: { state: ReturnType<typeof peerReviewStatus>["state"]; daysLeft: number | null; validUntil: string | null; certificateNo: string | null };
  kyc: Record<KycState, number>;
  acceptancePending: number;
  previousAuditor: { awaitingReply: number; total: number };
  independence: { declared: number; staff: number; withExceptions: number };
  disposal: number;
  restoreDrill: { lastOn: string | null; lastOutcome: string | null; thisQuarter: boolean };
  dataRequests: { open: number; overdue: number };
  incidents: { open: number; boardOverdue: number };
  notice: { version: string | null; publishedAt: string | null; draftPending: boolean };
};

export async function getQualityOverview(supabase: ServerSupabase, today: DateString, fy: FinancialYear, ceiling: CeilingParams): Promise<QualityOverview> {
  const [settings, items, peer, kyc, acceptance, pac, independence, disposal, drills, requests, incidents, notices] = await Promise.all([
    supabase.from("firm_settings").select("quality_framework, updated_at").eq("id", 1).maybeSingle(),
    supabase.from("quality_manual_items").select("last_reviewed_on, review_every_months").limit(1000),
    supabase.from("peer_reviews").select("valid_until, certificate_no").eq("status", "completed").not("valid_until", "is", null).order("valid_until", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("kyc_register").select("kyc_state").limit(5000),
    supabase.from("client_acceptances").select("id", { count: "exact", head: true }).eq("outcome", "pending"),
    supabase.from("previous_auditor_communications").select("reply_received_on, outcome").limit(5000),
    supabase.rpc("independence_register", { p_financial_year: fy }),
    supabase.from("documents_for_disposal").select("id", { count: "exact", head: true }),
    supabase.from("restore_drills").select("performed_on, outcome").order("performed_on", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("data_requests_view").select("is_open, is_overdue").limit(5000),
    supabase.from("data_incidents_view").select("is_open, board_overdue").limit(1000),
    supabase.from("privacy_notices").select("version, published_at, is_current").order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [settings, items, peer, kyc, acceptance, pac, independence, disposal, drills, requests, incidents, notices]) if (r.error) throw r.error;

  const kycCounts: Record<KycState, number> = { missing: 0, incomplete: 0, review_due: 0, current: 0 };
  for (const r of kyc.data ?? []) if (r.kyc_state && r.kyc_state in kycCounts) kycCounts[r.kyc_state as KycState]++;
  const pr = peerReviewStatus(peer.data?.valid_until ?? null, today, ceiling);
  const register = independence.data ?? [];
  const current = (notices.data ?? []).find((n) => n.is_current && n.published_at) ?? null;
  const drill = drills.data ?? null;
  return {
    framework: settings.data?.quality_framework === "sqm1" ? "sqm1" : "sqc1",
    frameworkUpdatedAt: settings.data?.updated_at ?? null,
    manual: {
      total: (items.data ?? []).length,
      reviewDue: (items.data ?? []).filter((i) => qualityItemReviewDue(i.last_reviewed_on, i.review_every_months, today, addMonths)).length,
    },
    peerReview: { state: pr.state, daysLeft: pr.daysLeft, validUntil: peer.data?.valid_until ?? null, certificateNo: peer.data?.certificate_no ?? null },
    kyc: kycCounts,
    acceptancePending: acceptance.count ?? 0,
    previousAuditor: { awaitingReply: (pac.data ?? []).filter((p) => !p.reply_received_on && !p.outcome).length, total: (pac.data ?? []).length },
    independence: { declared: register.filter((r) => r.declaration_id).length, staff: register.length, withExceptions: register.filter((r) => r.has_exceptions).length },
    disposal: disposal.count ?? 0,
    restoreDrill: { lastOn: drill?.performed_on ?? null, lastOutcome: drill?.outcome ?? null, thisQuarter: drill ? calendarQuarter(drill.performed_on) === calendarQuarter(today) : false },
    dataRequests: { open: (requests.data ?? []).filter((r) => r.is_open).length, overdue: (requests.data ?? []).filter((r) => r.is_overdue).length },
    incidents: { open: (incidents.data ?? []).filter((r) => r.is_open).length, boardOverdue: (incidents.data ?? []).filter((r) => r.board_overdue).length },
    notice: { version: current?.version ?? null, publishedAt: current?.published_at ?? null, draftPending: (notices.data ?? []).some((n) => !n.published_at) },
  };
}

// =================================================================================================
// Quality manual
// =================================================================================================

export type QualityItemRow = Tables<"quality_manual_items"> & { owner_name: string | null; last_reviewed_by_name: string | null };

export async function listQualityItems(supabase: ServerSupabase): Promise<{ items: QualityItemRow[]; framework: QualityFramework; settingsUpdatedAt: string | null }> {
  const [items, settings] = await Promise.all([
    supabase.from("quality_manual_items").select("*, owner:owner_employee_id(full_name), reviewer:last_reviewed_by(full_name)").order("sort_order").order("created_at").limit(500),
    supabase.from("firm_settings").select("quality_framework, updated_at").eq("id", 1).maybeSingle(),
  ]);
  if (items.error) throw items.error;
  if (settings.error) throw settings.error;
  const rows = (items.data ?? []) as unknown as Array<Tables<"quality_manual_items"> & { owner: { full_name: string } | null; reviewer: { full_name: string } | null }>;
  return {
    items: rows.map(({ owner, reviewer, ...r }) => ({ ...r, owner_name: owner?.full_name ?? null, last_reviewed_by_name: reviewer?.full_name ?? null })),
    framework: settings.data?.quality_framework === "sqm1" ? "sqm1" : "sqc1",
    settingsUpdatedAt: settings.data?.updated_at ?? null,
  };
}

/** Active staff, for owners and declarations. */
export async function listStaffOptions(supabase: ServerSupabase): Promise<Array<{ value: string; label: string; description?: string }>> {
  const { data, error } = await supabase.from("employees").select("id, full_name, designation").eq("is_active", true).is("deleted_at", null).order("full_name").limit(500);
  if (error) throw error;
  return (data ?? []).map((e) => ({ value: e.id, label: e.full_name, description: e.designation ?? undefined }));
}

// =================================================================================================
// Peer reviews
// =================================================================================================

export type PeerReviewRow = Tables<"peer_reviews">;

export async function listPeerReviews(supabase: ServerSupabase): Promise<PeerReviewRow[]> {
  const { data, error } = await supabase.from("peer_reviews").select("*").order("period_to", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

// =================================================================================================
// KYC register
// =================================================================================================

export type KycRegisterRow = Tables<"kyc_register">;

export async function listKycRegister(supabase: ServerSupabase, t: TableParams<(typeof KYC_SORTABLE)[number], "state" | "audits">, opts: { limit?: number } = {}): Promise<{ rows: KycRegisterRow[]; total: number }> {
  const sort = t.sort && (KYC_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "client_name";
  let q = supabase.from("kyc_register").select("*", { count: "exact" });
  if (t.q) {
    const like = `%${escapeLike(t.q)}%`;
    q = q.or(`client_name.ilike.${like},client_code.ilike.${like}`);
  }
  if (t.filters.state?.length) q = q.in("kyc_state", t.filters.state);
  if (t.filters.audits?.includes("open")) q = q.gt("open_audits", 0);
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("client_id");
  const { data, error, count } = await q.range(t.from, t.from + (opts.limit ?? t.pageSize) - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

// =================================================================================================
// Previous-auditor communications (firm-wide)
// =================================================================================================

export type PreviousAuditorListRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  engagement_type: string;
  audit_engagement_id: string | null;
  previous_auditor_name: string;
  previous_auditor_frn: string | null;
  letter_sent_on: string;
  sent_via: string | null;
  delivery_proof_document_id: string | null;
  reply_received_on: string | null;
  outcome: string | null;
  objections: string | null;
  notes: string | null;
  updated_at: string;
};

export async function listPreviousAuditorComms(supabase: ServerSupabase, t: TableParams<string, "state">): Promise<{ rows: PreviousAuditorListRow[]; total: number }> {
  let q = supabase
    .from("previous_auditor_communications")
    .select(
      "id, client_id, engagement_type, audit_engagement_id, previous_auditor_name, previous_auditor_frn, letter_sent_on, sent_via, delivery_proof_document_id, reply_received_on, outcome, objections, notes, updated_at, clients!inner(display_name, client_code, deleted_at)",
      { count: "exact" },
    )
    .is("clients.deleted_at", null);
  if (t.q) {
    const like = `%${escapeLike(t.q)}%`;
    q = q.or(`previous_auditor_name.ilike.${like},previous_auditor_frn.ilike.${like}`);
  }
  const state = t.filters.state?.[0];
  if (state === "no_proof") q = q.is("delivery_proof_document_id", null);
  if (state === "awaiting_reply") q = q.is("reply_received_on", null).is("outcome", null);
  if (state === "objection") q = q.eq("outcome", "objection_unresolved");
  const asc = t.dir === "asc";
  q = q.order(t.sort === "previous_auditor_name" ? "previous_auditor_name" : "letter_sent_on", { ascending: asc }).order("id");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<Omit<PreviousAuditorListRow, "client_name" | "client_code"> & { clients: { display_name: string; client_code: string } }>;
  return { rows: rows.map(({ clients, ...r }) => ({ ...r, client_name: clients.display_name, client_code: String(clients.client_code) })), total: count ?? 0 };
}

// =================================================================================================
// Independence declarations
// =================================================================================================

export type IndependenceRow = { employee_id: string; full_name: string; designation: string | null; role: string; declaration_id: string | null; declared_at: string | null; answers: unknown; details: string | null; has_exceptions: boolean; updated_at: string | null };

export async function getIndependenceRegister(supabase: ServerSupabase, fy: FinancialYear): Promise<IndependenceRow[]> {
  const { data, error } = await supabase.rpc("independence_register", { p_financial_year: fy });
  if (error) throw error;
  return (data ?? []) as IndependenceRow[];
}

/** The signed-in person's own declaration for the year (Employees reach only their own, RLS). */
export async function getOwnDeclaration(supabase: ServerSupabase, employeeId: string, fy: FinancialYear): Promise<Tables<"independence_declarations"> | null> {
  const { data, error } = await supabase.from("independence_declarations").select("*").eq("employee_id", employeeId).eq("financial_year", fy).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// =================================================================================================
// Retention
// =================================================================================================

export type RetentionYear = { year: number; documents: number; past_retention: number };
export type DisposalRow = Tables<"documents_for_disposal">;

export async function getRetentionSummary(supabase: ServerSupabase): Promise<RetentionYear[]> {
  const { data, error } = await supabase.rpc("retention_summary");
  if (error) throw error;
  return (data ?? []) as RetentionYear[];
}

export async function listDisposal(supabase: ServerSupabase, t: TableParams<(typeof DISPOSAL_SORTABLE)[number], "audit">): Promise<{ rows: DisposalRow[]; total: number }> {
  const sort = t.sort && (DISPOSAL_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "retention_until";
  let q = supabase.from("documents_for_disposal").select("*", { count: "exact" });
  if (t.q) {
    const like = `%${escapeLike(t.q)}%`;
    q = q.or(`title.ilike.${like},client_name.ilike.${like},file_name.ilike.${like}`);
  }
  if (t.filters.audit?.[0] === "in_file") q = q.eq("in_audit_file", true);
  if (t.filters.audit?.[0] === "not_in_file") q = q.eq("in_audit_file", false);
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("id");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

// =================================================================================================
// Restore drills
// =================================================================================================

export type RestoreDrillRow = Tables<"restore_drills"> & { performed_by_name: string | null };

export async function listRestoreDrills(supabase: ServerSupabase, limit = 20): Promise<RestoreDrillRow[]> {
  const { data, error } = await supabase.from("restore_drills").select("*, profiles:performed_by(full_name)").order("performed_on", { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Tables<"restore_drills"> & { profiles: { full_name: string } | null }>).map(({ profiles, ...r }) => ({ ...r, performed_by_name: profiles?.full_name ?? null }));
}

/** Data-request counts the overview and the tab use (closed words per §6.10). */
export function countOpen(rows: ReadonlyArray<{ status: string }>): number {
  return rows.filter((r) => !isClosedRequestStatus(r.status)).length;
}

// =================================================================================================
// Client acceptance (the register lives at /acceptance, §7.5.4; this is its summary here)
// =================================================================================================

export type AcceptanceSummary = {
  counts: { pending: number; accepted: number; declined: number };
  recent: Array<Pick<Tables<"client_acceptances_list">, "id" | "prospect_name" | "client_id" | "client_display_name" | "outcome" | "decided_at" | "decided_by_name" | "conflict_count" | "independence_threat" | "created_at">>;
};

export async function getAcceptanceSummary(supabase: ServerSupabase, limit = 8): Promise<AcceptanceSummary> {
  const head = (outcome: "pending" | "accepted" | "declined") => supabase.from("client_acceptances").select("id", { count: "exact", head: true }).eq("outcome", outcome);
  const [pending, accepted, declined, recent] = await Promise.all([
    head("pending"),
    head("accepted"),
    head("declined"),
    supabase
      .from("client_acceptances_list")
      .select("id, prospect_name, client_id, client_display_name, outcome, decided_at, decided_by_name, conflict_count, independence_threat, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  for (const r of [pending, accepted, declined, recent]) if (r.error) throw r.error;
  return { counts: { pending: pending.count ?? 0, accepted: accepted.count ?? 0, declined: declined.count ?? 0 }, recent: recent.data ?? [] };
}
