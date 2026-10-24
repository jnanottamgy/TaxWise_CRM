import "server-only";

import ExcelJS from "exceljs";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import { CLIENT_DOCUMENTS_BUCKET, objectNameOf } from "@/lib/domain/files";
import { pickContactForService } from "@/lib/domain/messaging";
import type { FieldSpec } from "@/lib/domain/gstr2b";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import { getMessagingContext, type MessagingContext } from "@/lib/data/clients";
import {
  csvToMatrix,
  decodeText,
  detectHeaderRow,
  matrixToRecords,
  plainCell,
  MAX_SHEET_ROWS,
  HEADER_SCAN_ROWS,
  type CellMatrix,
  type SheetRecords,
} from "@/components/workpapers/shared/sheet";
import { isPeriod, periodSortKey, readRunSummary, type FollowUpLine, type StoredRunSummary } from "@/lib/schemas/gst-recon";

/**
 * Reads for the GST reconciliation workpapers (§6.12, §7.8.1), under the caller's RLS: Employees see
 * their own clients' runs only (§4.1). Lists are searched, sorted and paged in SQL (§2.3) on the
 * read models of 0203–0204. Also the stored source files (the GSTR-2B JSON in task-files, the
 * purchase register in the client's vault), read back as the caller, and the sheet reader the
 * financial statements workpaper shares.
 */

export type Page<T> = { rows: T[]; total: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrQuery = { or: (filter: string) => unknown };

function search<Q>(query: Q, q: string, columns: readonly string[]): Q {
  const text = q.trim();
  if (!text) return query;
  const like = `%${escapeLike(text).replace(/[,()]/g, " ")}%`;
  return (query as unknown as OrQuery).or(columns.map((c) => `${c}.ilike.${like}`).join(",")) as Q;
}

/** Reads every row of a query in pages of 1,000 (the API's row cap), in a stable order. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, limit = 100_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await page(from, Math.min(from + 999, limit - 1));
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// =================================================================================================
// Clients
// =================================================================================================

export type ReconClient = {
  id: string;
  name: string;
  code: string;
  gstin: string | null;
  gstRegistration: string;
  entityType: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
};

export async function getReconClient(supabase: ServerSupabase, clientId: string): Promise<ReconClient | null> {
  if (!UUID.test(clientId)) return null;
  const { data, error } = await supabase
    .from("clients")
    .select("id, display_name, client_code, gstin, gst_registration, entity_type, phone, whatsapp, email")
    .eq("id", clientId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.display_name,
    code: String(data.client_code),
    gstin: data.gstin ? String(data.gstin) : null,
    gstRegistration: data.gst_registration,
    entityType: data.entity_type,
    phone: data.phone,
    whatsapp: data.whatsapp,
    email: data.email ? String(data.email) : null,
  };
}

/** Clients the caller can see, for the workpaper pickers (Employees: their own, §4.1). */
export async function searchWorkpaperClients(supabase: ServerSupabase, q: string, opts: { gstOnly?: boolean } = {}): Promise<ComboOption[]> {
  let query = supabase
    .from("clients")
    .select("id, client_code, display_name, gstin, status, gst_registration")
    .is("deleted_at", null)
    .neq("status", "inactive")
    .order("display_name")
    .limit(20);
  if (opts.gstOnly) query = query.eq("gst_registration", "registered");
  const text = q.trim();
  if (text) {
    const like = `%${escapeLike(text).replace(/[,()]/g, " ")}%`;
    query = query.or(`display_name.ilike.${like},client_code.ilike.${like},legal_name.ilike.${like},gstin.ilike.${like},pan.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((c) => ({
    value: c.id,
    label: c.display_name,
    description: [String(c.client_code), c.gstin ? String(c.gstin) : null].filter(Boolean).join(" · "),
  }));
}

// =================================================================================================
// Runs
// =================================================================================================

export type RunListRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  client_gstin: string | null;
  period: string;
  portal_gstin: string | null;
  gstin_mismatch: boolean;
  created_by_name: string | null;
  created_at: string;
  matched_count: number;
  mismatch_count: number;
  missing_in_books_count: number;
  missing_in_2b_count: number;
  itc_per_2b_paise: number;
  itc_per_books_paise: number;
  itc_at_risk_paise: number;
  unclaimed_itc_paise: number;
  open_count: number;
  follow_up_count: number;
  carried_count: number;
  ims_pending_count: number;
  is_latest: boolean;
};

const RUN_COLUMNS =
  "id, client_id, client_name, client_code, client_gstin, period, portal_gstin, gstin_mismatch, created_by_name, created_at, matched_count, mismatch_count, missing_in_books_count, missing_in_2b_count, itc_per_2b_paise, itc_per_books_paise, itc_at_risk_paise, unclaimed_itc_paise, open_count, follow_up_count, carried_count, ims_pending_count, is_latest";

function toRunRow(r: Record<string, unknown>): RunListRow {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: String(r.id),
    client_id: String(r.client_id),
    client_name: String(r.client_name ?? ""),
    client_code: String(r.client_code ?? ""),
    client_gstin: (r.client_gstin as string | null) ?? null,
    period: String(r.period ?? ""),
    portal_gstin: (r.portal_gstin as string | null) ?? null,
    gstin_mismatch: Boolean(r.gstin_mismatch),
    created_by_name: (r.created_by_name as string | null) ?? null,
    created_at: String(r.created_at),
    matched_count: n(r.matched_count),
    mismatch_count: n(r.mismatch_count),
    missing_in_books_count: n(r.missing_in_books_count),
    missing_in_2b_count: n(r.missing_in_2b_count),
    itc_per_2b_paise: n(r.itc_per_2b_paise),
    itc_per_books_paise: n(r.itc_per_books_paise),
    itc_at_risk_paise: n(r.itc_at_risk_paise),
    unclaimed_itc_paise: n(r.unclaimed_itc_paise),
    open_count: n(r.open_count),
    follow_up_count: n(r.follow_up_count),
    carried_count: n(r.carried_count),
    ims_pending_count: n(r.ims_pending_count),
    is_latest: Boolean(r.is_latest),
  };
}

/**
 * The runs list (§7.8.1 "Runs are saved, with history per client and period"): the latest run of
 * each client and month unless `history=1`; filters for client, month, open lines and a GSTIN that
 * doesn't match the client's.
 */
export async function listRuns(supabase: ServerSupabase, t: TableParams<string, string>, opts: { clientId?: string | null } = {}): Promise<Page<RunListRow>> {
  let query = supabase.from("gst_recon_runs_list").select(RUN_COLUMNS, { count: "exact" });
  const client = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (client && UUID.test(client)) query = query.eq("client_id", client);
  const period = t.filters.period?.[0];
  if (period && isPeriod(period)) query = query.eq("period", period);
  if (!t.filters.history) query = query.eq("is_latest", true);
  if (t.filters.open) query = query.gt("open_count", 0);
  if (t.filters.gstin) query = query.eq("gstin_mismatch", true);
  query = search(query, t.q, ["client_name", "client_code", "client_gstin", "portal_gstin"]);
  const sort = t.sort ?? "period_start";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "created_at") query = query.order("created_at", { ascending: false });
  const { data, error, count } = await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toRunRow), total: count ?? 0 };
}

export type MonthTotals = {
  period: string;
  /** Clients reconciled for the month (their latest run). */
  reconciled: number;
  /** GST-registered clients the caller looks after (active, pending or on hold). */
  gstClients: number;
  itcAtRisk: number;
  unclaimedItc: number;
  openLines: number;
  gstinMismatch: number;
};

/**
 * The month's headline figures over the latest run of every client the caller can see (§7.8.1):
 * ITC at risk and unclaimed, open lines, how many GST clients are reconciled. Summed here from at
 * most one run per client and month.
 */
export async function monthTotals(supabase: ServerSupabase, period: string): Promise<MonthTotals> {
  const [runs, clients] = await Promise.all([
    fetchAll<{ itc_at_risk_paise: number | null; unclaimed_itc_paise: number | null; open_count: number | null; gstin_mismatch: boolean | null }>(
      (from, to) =>
        supabase
          .from("gst_recon_runs_list")
          .select("itc_at_risk_paise, unclaimed_itc_paise, open_count, gstin_mismatch")
          .eq("period", period)
          .eq("is_latest", true)
          .order("id")
          .range(from, to) as unknown as PromiseLike<{ data: never[] | null; error: unknown }>,
      20_000,
    ),
    supabase.from("clients").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("gst_registration", "registered").neq("status", "inactive"),
  ]);
  if (clients.error) throw clients.error;
  let itcAtRisk = 0;
  let unclaimedItc = 0;
  let openLines = 0;
  let gstinMismatch = 0;
  for (const r of runs) {
    itcAtRisk += Number(r.itc_at_risk_paise ?? 0);
    unclaimedItc += Number(r.unclaimed_itc_paise ?? 0);
    openLines += Number(r.open_count ?? 0);
    if (r.gstin_mismatch) gstinMismatch++;
  }
  return { period, reconciled: runs.length, gstClients: clients.count ?? 0, itcAtRisk, unclaimedItc, openLines, gstinMismatch };
}

/** A client's latest runs, newest month first (Client 360 → Workpapers). */
export async function listClientRuns(supabase: ServerSupabase, clientId: string, limit = 6): Promise<Page<RunListRow>> {
  const { data, error, count } = await supabase
    .from("gst_recon_runs_list")
    .select(RUN_COLUMNS, { count: "exact" })
    .eq("client_id", clientId)
    .eq("is_latest", true)
    .order("period_start", { ascending: false })
    .order("created_at", { ascending: false })
    .range(0, limit - 1);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toRunRow), total: count ?? 0 };
}

export type SourceFiles = {
  gstr2b: { bucket: string; path: string; fileName: string; size: number; sha256: string } | null;
  register: { documentId: string | null; fileName: string | null; sheet: string | null; headerRow: number | null } | null;
  mapping: Record<string, string | null> | null;
};

function readSourceFiles(value: unknown): SourceFiles {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const g = v.gstr2b && typeof v.gstr2b === "object" ? (v.gstr2b as Record<string, unknown>) : null;
  const r = v.register && typeof v.register === "object" ? (v.register as Record<string, unknown>) : null;
  return {
    gstr2b: g && typeof g.path === "string" ? { bucket: String(g.bucket ?? "task-files"), path: g.path, fileName: String(g.fileName ?? "GSTR-2B.json"), size: Number(g.size ?? 0), sha256: String(g.sha256 ?? "") } : null,
    register: r
      ? {
          documentId: typeof r.documentId === "string" ? r.documentId : null,
          fileName: typeof r.fileName === "string" ? r.fileName : null,
          sheet: typeof r.sheet === "string" ? r.sheet : null,
          headerRow: typeof r.headerRow === "number" ? r.headerRow : null,
        }
      : null,
    mapping: v.mapping && typeof v.mapping === "object" ? (v.mapping as Record<string, string | null>) : null,
  };
}

export type RunDiagnostics = {
  gstr2b: Array<{ level: string; code: string; message: string; ref: string | null }>;
  register: Array<{ row: number; level: string; field: string | null; message: string }>;
  truncated: { gstr2b: number; register: number };
};

function readDiagnostics(value: unknown): RunDiagnostics {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const t = v.truncated && typeof v.truncated === "object" ? (v.truncated as Record<string, unknown>) : {};
  return {
    gstr2b: Array.isArray(v.gstr2b) ? (v.gstr2b as RunDiagnostics["gstr2b"]) : [],
    register: Array.isArray(v.register) ? (v.register as RunDiagnostics["register"]) : [],
    truncated: { gstr2b: Number(t.gstr2b ?? 0), register: Number(t.register ?? 0) },
  };
}

export type RunDetail = {
  run: RunListRow;
  summary: StoredRunSummary;
  diagnostics: RunDiagnostics;
  sources: SourceFiles;
  previousRunId: string | null;
  previousPeriod: string | null;
  registerDocumentId: string | null;
  client: ReconClient;
  /** Other runs of the same client and month, newest first (history). */
  history: Array<{ id: string; created_at: string; created_by_name: string | null; is_latest: boolean }>;
};

export async function getRunDetail(supabase: ServerSupabase, runId: string): Promise<RunDetail | null> {
  if (!UUID.test(runId)) return null;
  const [listed, raw] = await Promise.all([
    supabase.from("gst_recon_runs_list").select(RUN_COLUMNS).eq("id", runId).maybeSingle(),
    supabase.from("gst_recon_runs").select("id, summary, diagnostics, source_files, previous_run_id, register_document_id").eq("id", runId).maybeSingle(),
  ]);
  if (listed.error) throw listed.error;
  if (raw.error) throw raw.error;
  if (!listed.data || !raw.data) return null;
  const run = toRunRow(listed.data as Record<string, unknown>);
  const [client, history, previous] = await Promise.all([
    getReconClient(supabase, run.client_id),
    supabase
      .from("gst_recon_runs_list")
      .select("id, created_at, created_by_name, is_latest")
      .eq("client_id", run.client_id)
      .eq("period", run.period)
      .order("created_at", { ascending: false })
      .limit(20),
    raw.data.previous_run_id
      ? supabase.from("gst_recon_runs").select("period").eq("id", raw.data.previous_run_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (history.error) throw history.error;
  if (previous.error) throw previous.error;
  if (!client) return null;
  return {
    run,
    summary: readRunSummary(raw.data.summary),
    diagnostics: readDiagnostics(raw.data.diagnostics),
    sources: readSourceFiles(raw.data.source_files),
    previousRunId: raw.data.previous_run_id,
    previousPeriod: previous.data ? String((previous.data as { period: string }).period) : null,
    registerDocumentId: raw.data.register_document_id,
    client,
    history: ((history.data ?? []) as Array<{ id: string; created_at: string; created_by_name: string | null; is_latest: boolean }>).map((h) => ({ ...h, is_latest: Boolean(h.is_latest) })),
  };
}

/** The latest run of a client and month, if there is one (the wizard warns before running it again). */
export async function latestRunOf(supabase: ServerSupabase, clientId: string, period: string): Promise<{ id: string; created_at: string; created_by_name: string | null; open_count: number } | null> {
  const { data, error } = await supabase
    .from("gst_recon_runs_list")
    .select("id, created_at, created_by_name, open_count")
    .eq("client_id", clientId)
    .eq("period", period)
    .eq("is_latest", true)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: String(data.id), created_at: String(data.created_at), created_by_name: data.created_by_name ?? null, open_count: Number(data.open_count ?? 0) } : null;
}

/**
 * The run whose open lines carry into this month (§6.12): the latest run of the latest month
 * before `period` for the client. Null when the client has no earlier run.
 */
export async function previousRunOf(supabase: ServerSupabase, clientId: string, period: string): Promise<{ id: string; period: string; open_count: number } | null> {
  const { data, error } = await supabase
    .from("gst_recon_runs_list")
    .select("id, period, open_count, period_start")
    .eq("client_id", clientId)
    .eq("is_latest", true)
    .lt("period_start", `${period.slice(2)}-${period.slice(0, 2)}-01`)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data || !isPeriod(String(data.period)) || periodSortKey(String(data.period)) >= periodSortKey(period)) return null;
  return { id: String(data.id), period: String(data.period), open_count: Number(data.open_count ?? 0) };
}

export type CarryLine = {
  id: string;
  entry_key: string | null;
  bucket: string;
  first_seen_period: string | null;
  supplier_gstin: string;
  supplier_name: string | null;
  data: unknown;
  resolution: string;
  cleared_by_run_id: string | null;
};

/**
 * The previous run's lines still open for this month: open or being followed up, plus the ones an
 * earlier run of this same month cleared (a re-run decides again).
 */
export async function openLinesForCarryForward(supabase: ServerSupabase, previousRunId: string, clientId: string, period: string): Promise<CarryLine[]> {
  const { data: sameMonth, error } = await supabase.from("gst_recon_runs").select("id").eq("client_id", clientId).eq("period", period).limit(200);
  if (error) throw error;
  const sameMonthIds = new Set((sameMonth ?? []).map((r) => r.id));
  const rows = await fetchAll<CarryLine>((from, to) =>
    supabase
      .from("gst_recon_entries")
      .select("id, entry_key, bucket, first_seen_period, supplier_gstin, supplier_name, data, resolution, cleared_by_run_id")
      .eq("run_id", previousRunId)
      .neq("bucket", "matched")
      .order("id")
      .range(from, to) as unknown as PromiseLike<{ data: CarryLine[] | null; error: unknown }>,
  );
  return rows
    .filter((r) => {
      const res = r.resolution ?? "open";
      if (res === "open" || res === "follow_up_supplier") return true;
      return r.cleared_by_run_id !== null && sameMonthIds.has(r.cleared_by_run_id);
    })
    // An import (IMPG bill of entry) has no supplier GSTIN: NULL in the table (0234), '' to the engine.
    .map((r) => ({ ...r, supplier_gstin: r.supplier_gstin ?? "" }));
}

export type PriorDecision = { bucket: string; resolution: string; resolution_note: string | null; ims_action: string | null; ims_reason: string | null; ims_decided: boolean };

/** Decisions made on the latest earlier run of the same month, by line key (a re-run keeps them). */
export async function decisionsOfRun(supabase: ServerSupabase, runId: string): Promise<Map<string, PriorDecision>> {
  const rows = await fetchAll<{ entry_key: string | null; bucket: string; resolution: string | null; resolution_note: string | null; ims_action: string | null; ims_reason: string | null; ims_decided_by: string | null; cleared_by_run_id: string | null }>(
    (from, to) =>
      supabase
        .from("gst_recon_entries")
        .select("entry_key, bucket, resolution, resolution_note, ims_action, ims_reason, ims_decided_by, cleared_by_run_id")
        .eq("run_id", runId)
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: never[] | null; error: unknown }>,
  );
  const out = new Map<string, PriorDecision>();
  for (const r of rows) {
    if (!r.entry_key) continue;
    const decided = (r.resolution ?? "open") !== "open" || r.ims_decided_by !== null;
    if (!decided) continue;
    out.set(r.entry_key, {
      bucket: r.bucket,
      resolution: r.resolution ?? "open",
      resolution_note: r.resolution_note,
      ims_action: r.ims_action,
      ims_reason: r.ims_reason,
      ims_decided: r.ims_decided_by !== null,
    });
  }
  return out;
}

// =================================================================================================
// Lines
// =================================================================================================

export type LineRow = {
  id: string;
  run_id: string;
  entry_key: string | null;
  bucket: string;
  match_tier: string | null;
  origin: string;
  first_seen_period: string | null;
  supplier_gstin: string;
  supplier_name: string | null;
  doc_type: string | null;
  portal_section: string | null;
  portal_doc_number: string | null;
  portal_doc_date: string | null;
  books_doc_number: string | null;
  books_doc_date: string | null;
  doc_number: string | null;
  doc_date: string | null;
  portal_taxable_paise: number | null;
  books_taxable_paise: number | null;
  itc_portal_paise: number;
  itc_books_paise: number;
  itc_difference_paise: number;
  itc_paise: number;
  resolution: string;
  resolution_note: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  ims_action: string | null;
  ims_reason: string | null;
  ims_decided_by: string | null;
  ims_decided_by_name: string | null;
  ims_decided_at: string | null;
  is_open: boolean;
  data: unknown;
  updated_at: string;
};

const LINE_COLUMNS =
  "id, run_id, entry_key, bucket, match_tier, origin, first_seen_period, supplier_gstin, supplier_name, doc_type, portal_section, portal_doc_number, portal_doc_date, books_doc_number, books_doc_date, doc_number, doc_date, portal_taxable_paise, books_taxable_paise, itc_portal_paise, itc_books_paise, itc_difference_paise, itc_paise, resolution, resolution_note, resolved_by_name, resolved_at, ims_action, ims_reason, ims_decided_by, ims_decided_by_name, ims_decided_at, is_open, data, updated_at";

function toLine(r: Record<string, unknown>): LineRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...(r as unknown as LineRow),
    portal_taxable_paise: num(r.portal_taxable_paise),
    books_taxable_paise: num(r.books_taxable_paise),
    itc_portal_paise: Number(r.itc_portal_paise ?? 0),
    itc_books_paise: Number(r.itc_books_paise ?? 0),
    itc_difference_paise: Number(r.itc_difference_paise ?? 0),
    itc_paise: Number(r.itc_paise ?? 0),
    is_open: Boolean(r.is_open),
    resolution: String(r.resolution ?? "open"),
  };
}

export type LineScope =
  | { kind: "bucket"; bucket: string }
  | { kind: "ims" }
  | { kind: "carried" };

/** One tab of a run's lines (§7.8.1 "tabs per bucket with sortable tables"), paged in SQL. */
export async function listRunLines(supabase: ServerSupabase, runId: string, scope: LineScope, t: TableParams<string, string>): Promise<Page<LineRow>> {
  let query = supabase.from("gst_recon_entry_list").select(LINE_COLUMNS, { count: "exact" }).eq("run_id", runId);
  if (scope.kind === "bucket") query = query.eq("bucket", scope.bucket).eq("origin", "current");
  if (scope.kind === "ims") query = query.not("ims_action", "is", null);
  if (scope.kind === "carried") query = query.eq("origin", "carried");
  if (t.filters.resolution?.length) query = query.in("resolution", t.filters.resolution);
  if (t.filters.ims?.length) query = query.in("ims_action", t.filters.ims);
  if (t.filters.decided?.[0] === "yes") query = query.not("ims_decided_by", "is", null);
  if (t.filters.decided?.[0] === "no") query = query.is("ims_decided_by", null);
  const supplier = t.filters.supplier?.[0];
  if (supplier) query = query.eq("supplier_gstin", supplier.toUpperCase());
  query = search(query, t.q, ["supplier_name", "supplier_gstin", "portal_doc_number", "books_doc_number"]);
  const sort = t.sort ?? "itc_paise";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "supplier_name") query = query.order("supplier_name", { ascending: true, nullsFirst: false });
  query = query.order("id", { ascending: true });
  const { data, error, count } = await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toLine), total: count ?? 0 };
}

/** Lines of this month that close an open line of an earlier month (the carried-forward tab). */
export async function listClearedLines(supabase: ServerSupabase, runId: string, limit = 100): Promise<LineRow[]> {
  const { data, error } = await supabase
    .from("gst_recon_entry_list")
    .select(LINE_COLUMNS)
    .eq("run_id", runId)
    .eq("origin", "current")
    .not("data->cleared", "is", null)
    .order("supplier_name", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(toLine);
}

/** Every line of a run (the Excel export), in supplier and bucket order. */
export async function allRunLines(supabase: ServerSupabase, runId: string): Promise<LineRow[]> {
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
    supabase
      .from("gst_recon_entry_list")
      .select(LINE_COLUMNS)
      .eq("run_id", runId)
      .order("supplier_gstin")
      .order("bucket")
      .order("doc_date", { ascending: true, nullsFirst: false })
      .order("id")
      .range(from, to) as unknown as PromiseLike<{ data: Array<Record<string, unknown>> | null; error: unknown }>,
  );
  return rows.map(toLine);
}

export type SupplierRow = {
  supplier_gstin: string;
  supplier_name: string | null;
  line_count: number;
  matched_count: number;
  mismatch_count: number;
  missing_in_books_count: number;
  missing_in_2b_count: number;
  carried_count: number;
  open_count: number;
  chase_count: number;
  following_up_count: number;
  itc_at_risk_paise: number;
  unclaimed_itc_paise: number;
  mismatch_difference_paise: number;
  last_follow_up_at: string | null;
};

const SUPPLIER_COLUMNS =
  "supplier_gstin, supplier_name, line_count, matched_count, mismatch_count, missing_in_books_count, missing_in_2b_count, carried_count, open_count, chase_count, following_up_count, itc_at_risk_paise, unclaimed_itc_paise, mismatch_difference_paise, last_follow_up_at";

function toSupplier(r: Record<string, unknown>): SupplierRow {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    supplier_gstin: String(r.supplier_gstin ?? ""),
    supplier_name: (r.supplier_name as string | null) ?? null,
    line_count: n(r.line_count),
    matched_count: n(r.matched_count),
    mismatch_count: n(r.mismatch_count),
    missing_in_books_count: n(r.missing_in_books_count),
    missing_in_2b_count: n(r.missing_in_2b_count),
    carried_count: n(r.carried_count),
    open_count: n(r.open_count),
    chase_count: n(r.chase_count),
    following_up_count: n(r.following_up_count),
    itc_at_risk_paise: n(r.itc_at_risk_paise),
    unclaimed_itc_paise: n(r.unclaimed_itc_paise),
    mismatch_difference_paise: n(r.mismatch_difference_paise),
    last_follow_up_at: (r.last_follow_up_at as string | null) ?? null,
  };
}

/** The supplier roll-up (§6.12 "whom to chase"), live from the lines, paged in SQL. */
export async function listRunSuppliers(supabase: ServerSupabase, runId: string, t: TableParams<string, string>): Promise<Page<SupplierRow>> {
  let query = supabase.from("gst_recon_supplier_rollup").select(SUPPLIER_COLUMNS, { count: "exact" }).eq("run_id", runId);
  if (t.filters.chase) query = query.gt("chase_count", 0);
  query = search(query, t.q, ["supplier_name", "supplier_gstin"]);
  const sort = t.sort ?? "itc_at_risk_paise";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("supplier_gstin");
  const { data, error, count } = await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toSupplier), total: count ?? 0 };
}

export async function allRunSuppliers(supabase: ServerSupabase, runId: string): Promise<SupplierRow[]> {
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
    supabase
      .from("gst_recon_supplier_rollup")
      .select(SUPPLIER_COLUMNS)
      .eq("run_id", runId)
      .order("itc_at_risk_paise", { ascending: false })
      .order("supplier_gstin")
      .range(from, to) as unknown as PromiseLike<{ data: Array<Record<string, unknown>> | null; error: unknown }>,
  );
  return rows.map(toSupplier);
}

/** A supplier's open lines to chase (not in 2B, or mismatched), for the follow-up draft. */
export async function followUpLines(supabase: ServerSupabase, runId: string, supplierGstin: string): Promise<{ supplierName: string | null; lines: FollowUpLine[]; lineIds: Array<{ id: string; updatedAt: string }> }> {
  const { data, error } = await supabase
    .from("gst_recon_entry_list")
    .select("id, bucket, doc_type, books_doc_number, portal_doc_number, books_doc_date, portal_doc_date, books_taxable_paise, itc_books_paise, itc_portal_paise, supplier_name, updated_at")
    .eq("run_id", runId)
    .eq("supplier_gstin", supplierGstin.toUpperCase())
    .eq("is_open", true)
    .in("bucket", ["missing_in_2b", "mismatch"])
    .order("doc_date", { ascending: true, nullsFirst: false })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    supplierName: (rows.find((r) => r.supplier_name)?.supplier_name as string | null) ?? null,
    lines: rows.map((r) => ({
      bucket: r.bucket as FollowUpLine["bucket"],
      docType: String(r.doc_type ?? "invoice"),
      docNumber: String(r.books_doc_number ?? r.portal_doc_number ?? ""),
      docDate: (r.books_doc_date as string | null) ?? (r.portal_doc_date as string | null) ?? null,
      taxable: Number(r.books_taxable_paise ?? 0),
      itcBooks: Number(r.itc_books_paise ?? 0),
      itcPortal: Number(r.itc_portal_paise ?? 0),
    })),
    lineIds: rows.map((r) => ({ id: String(r.id), updatedAt: String(r.updated_at) })),
  };
}

// =================================================================================================
// Hand-off context (§7.13.2 "The handles field picks the right contact for a service")
// =================================================================================================

export type FollowUpRecipient = { contactId: string | null; name: string | null; email: string | null; phone: string | null; whatsapp: string | null };

export type FollowUpContext = {
  recipient: FollowUpRecipient | null;
  client: { phone: string | null; whatsapp: string | null; email: string | null };
  messaging: MessagingContext;
};

/** The client's contact who handles GST, the client's own numbers and the firm's templates. */
export async function getFollowUpContext(supabase: ServerSupabase, user: CurrentUser, client: ReconClient): Promise<FollowUpContext> {
  const [contacts, messaging] = await Promise.all([
    supabase.from("client_contacts").select("id, name, email, phone, whatsapp, is_primary, handles, email_bounced").eq("client_id", client.id).order("is_primary", { ascending: false }).order("created_at").limit(50),
    getMessagingContext(supabase, user),
  ]);
  if (contacts.error) throw contacts.error;
  const list = (contacts.data ?? []).map((c) => ({
    contactId: c.id,
    name: c.name,
    email: c.email && !c.email_bounced ? String(c.email) : null,
    phone: c.phone,
    whatsapp: c.whatsapp,
    isPrimary: c.is_primary,
    handles: c.handles as string[],
  }));
  const picked = pickContactForService(list, "gst");
  return {
    recipient: picked ? { contactId: picked.contactId, name: picked.name, email: picked.email, phone: picked.phone, whatsapp: picked.whatsapp } : null,
    client: { phone: client.phone, whatsapp: client.whatsapp, email: client.email },
    messaging,
  };
}

// =================================================================================================
// Remembered mappings (register_portal_mappings)
// =================================================================================================

export async function rememberedMapping(supabase: ServerSupabase, clientId: string, kind: "purchase_register" | "trial_balance" | "ledger_buckets"): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from("register_portal_mappings").select("mapping").eq("client_id", clientId).eq("kind", kind).maybeSingle();
  if (error) throw error;
  const m = data?.mapping;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

/** The saved column choices inside a remembered mapping ({version, columns, sheet, headerRow}). */
export function savedColumns(mapping: Record<string, unknown> | null): { columns: Record<string, string | null> | null; sheet: string | null; headerRow: number | null } {
  if (!mapping) return { columns: null, sheet: null, headerRow: null };
  const columns = mapping.columns && typeof mapping.columns === "object" ? (mapping.columns as Record<string, string | null>) : null;
  return {
    columns,
    sheet: typeof mapping.sheet === "string" ? mapping.sheet : null,
    headerRow: typeof mapping.headerRow === "number" ? mapping.headerRow : null,
  };
}

// =================================================================================================
// Stored files, read back as the caller
// =================================================================================================

export class SourceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFileError";
  }
}

const MAX_BYTES = 25 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";

/** The GSTR-2B JSON a person uploaded for this client (task-files/<client>/gstr2b/…), as text. */
export async function readGstr2bFile(supabase: ServerSupabase, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from("task-files").download(path);
  if (error || !data) throw new SourceFileError("The GSTR-2B file isn't there any more. Upload it again.");
  if (data.size > MAX_BYTES) throw new SourceFileError("The GSTR-2B file is larger than 25 MB.");
  return decodeText(new Uint8Array(await data.arrayBuffer()));
}

export type VaultFile = { id: string; clientId: string; fileName: string; mimeType: string; storagePath: string; title: string };

/** A document of the client's vault the caller can see (RLS), with its stored file's details. */
export async function getVaultFile(supabase: ServerSupabase, clientId: string, documentId: string): Promise<VaultFile | null> {
  if (!UUID.test(documentId)) return null;
  const { data, error } = await supabase
    .from("documents")
    .select("id, client_id, file_name, mime_type, storage_path, title")
    .eq("id", documentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.client_id !== clientId) return null;
  return { id: data.id, clientId: data.client_id, fileName: data.file_name, mimeType: data.mime_type, storagePath: data.storage_path, title: data.title };
}

export type SheetFile = {
  file: VaultFile;
  sheets: string[];
  sheet: string | null;
  matrix: CellMatrix;
};

function worksheetMatrix(ws: ExcelJS.Worksheet): CellMatrix {
  const matrix: CellMatrix = [];
  const limit = MAX_SHEET_ROWS + HEADER_SCAN_ROWS + 1;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber > limit) return;
    const values = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
    matrix[rowNumber - 1] = values.map(plainCell);
  });
  for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = [];
  return matrix;
}

/**
 * Reads a CSV or XLSX from the client's vault as the caller (Storage RLS: staff who can see the
 * client). `sheet` picks a worksheet; by default the first visible one with data.
 */
export async function readVaultSheet(supabase: ServerSupabase, clientId: string, documentId: string, sheet: string | null): Promise<SheetFile> {
  const file = await getVaultFile(supabase, clientId, documentId);
  if (!file) throw new SourceFileError("That file isn't in this client's documents, or it was deleted. Upload it again.");
  if (file.mimeType === XLS_MIME) throw new SourceFileError("Old Excel files (.xls) can't be read. Save it as .xlsx or .csv and upload it again.");
  if (file.mimeType !== XLSX_MIME && file.mimeType !== "text/csv") throw new SourceFileError("Upload the register as a CSV or Excel (.xlsx) file.");
  const { data, error } = await supabase.storage.from(CLIENT_DOCUMENTS_BUCKET).download(objectNameOf(file.storagePath));
  if (error || !data) throw new SourceFileError("The file couldn't be read from the vault. Upload it again.");
  if (data.size > MAX_BYTES) throw new SourceFileError("Files can be at most 25 MB.");
  const bytes = new Uint8Array(await data.arrayBuffer());

  if (file.mimeType === "text/csv") {
    return { file, sheets: [], sheet: null, matrix: csvToMatrix(decodeText(bytes)) };
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new SourceFileError("This Excel file couldn't be opened. Save it again as .xlsx (or .csv) and upload it.");
  }
  const visible = wb.worksheets.filter((ws) => ws.state !== "hidden" && ws.state !== "veryHidden");
  const names = visible.map((ws) => ws.name);
  const chosen = (sheet ? visible.find((ws) => ws.name === sheet) : undefined) ?? visible.find((ws) => ws.actualRowCount > 1) ?? visible[0];
  if (!chosen) throw new SourceFileError("This workbook has no sheets with data.");
  return { file, sheets: names, sheet: chosen.name, matrix: worksheetMatrix(chosen) };
}

export type InspectedSheet = {
  documentId: string;
  fileName: string;
  sheets: string[];
  sheet: string | null;
  records: SheetRecords;
};

/** A stored sheet with its header row found (or the one a person chose, 1-based). */
export async function inspectVaultSheet<F extends string>(
  supabase: ServerSupabase,
  input: { clientId: string; documentId: string; sheet: string | null; headerRow: number | null },
  specs: readonly FieldSpec<F>[],
): Promise<InspectedSheet> {
  const read = await readVaultSheet(supabase, input.clientId, input.documentId, input.sheet);
  if (read.matrix.length === 0) throw new SourceFileError("The file is empty.");
  const headerIndex = input.headerRow ? input.headerRow - 1 : detectHeaderRow(read.matrix, specs);
  const records = matrixToRecords(read.matrix, headerIndex);
  return { documentId: read.file.id, fileName: read.file.fileName, sheets: read.sheets, sheet: read.sheet, records };
}
