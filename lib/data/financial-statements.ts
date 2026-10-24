import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { isFinancialYear, previousFinancialYear, type FinancialYear } from "@/lib/domain/fy";
import { isBucketCode, type BucketCode, type RememberedMappings } from "@/lib/domain/buckets";
import type { StatementFigures } from "@/lib/domain/schedule3";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { getReconClient, rememberedMapping, type ReconClient } from "@/lib/data/gst-recon";
import { isFsStatus, readFigures, readInputs, readLedgers, readStatements, type FsInputs, type FsStatus, type StoredLedger } from "@/lib/schemas/financial-statements";
import type { Statements } from "@/lib/domain/schedule3";

/**
 * Reads for the financial statements workpaper (§6.13, §7.8.3), under the caller's RLS: Employees
 * see their own clients' statements only (§4.1). The list is searched, sorted and paged in SQL on
 * financial_statements_list (0203). Statements are client workpapers, not fee data.
 */

export type Page<T> = { rows: T[]; total: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StatementListRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  entity_type: string | null;
  financial_year: string;
  status: FsStatus;
  prepared_by: string | null;
  prepared_by_name: string | null;
  updated_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  finalised_by_name: string | null;
  finalised_at: string | null;
  ledger_count: number;
  unmapped_count: number;
  all_checks_passed: boolean;
  failed_checks: number;
  profit_paise: number | null;
  total_assets_paise: number | null;
  updated_at: string;
};

const LIST_COLUMNS =
  "id, client_id, client_name, client_code, entity_type, financial_year, status, prepared_by, prepared_by_name, updated_by_name, reviewed_by_name, reviewed_at, finalised_by_name, finalised_at, ledger_count, unmapped_count, all_checks_passed, failed_checks, profit_paise, total_assets_paise, updated_at";

function toListRow(r: Record<string, unknown>): StatementListRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    client_id: String(r.client_id),
    client_name: String(r.client_name ?? ""),
    client_code: String(r.client_code ?? ""),
    entity_type: (r.entity_type as string | null) ?? null,
    financial_year: String(r.financial_year ?? ""),
    status: isFsStatus(r.status) ? r.status : "draft",
    prepared_by: (r.prepared_by as string | null) ?? null,
    prepared_by_name: (r.prepared_by_name as string | null) ?? null,
    updated_by_name: (r.updated_by_name as string | null) ?? null,
    reviewed_by_name: (r.reviewed_by_name as string | null) ?? null,
    reviewed_at: (r.reviewed_at as string | null) ?? null,
    finalised_by_name: (r.finalised_by_name as string | null) ?? null,
    finalised_at: (r.finalised_at as string | null) ?? null,
    ledger_count: Number(r.ledger_count ?? 0),
    unmapped_count: Number(r.unmapped_count ?? 0),
    all_checks_passed: Boolean(r.all_checks_passed),
    failed_checks: Number(r.failed_checks ?? 0),
    profit_paise: num(r.profit_paise),
    total_assets_paise: num(r.total_assets_paise),
    updated_at: String(r.updated_at),
  };
}

/** The statements list: the FY chosen in the top bar (or every year), status, checks and client. */
export async function listStatements(
  supabase: ServerSupabase,
  t: TableParams<string, string>,
  opts: { fy: FinancialYear | null; clientId?: string | null },
): Promise<Page<StatementListRow>> {
  let query = supabase.from("financial_statements_list").select(LIST_COLUMNS, { count: "exact" });
  if (opts.fy && isFinancialYear(opts.fy)) query = query.eq("financial_year", opts.fy);
  const client = opts.clientId ?? t.filters.client?.[0] ?? null;
  if (client && UUID.test(client)) query = query.eq("client_id", client);
  if (t.filters.status?.length) query = query.in("status", t.filters.status);
  if (t.filters.checks?.[0] === "failing") query = query.eq("all_checks_passed", false);
  if (t.filters.checks?.[0] === "passing") query = query.eq("all_checks_passed", true);
  const text = t.q.trim();
  if (text) {
    const like = `%${escapeLike(text).replace(/[,()]/g, " ")}%`;
    query = query.or(`client_name.ilike.${like},client_code.ilike.${like}`);
  }
  const sort = t.sort ?? "updated_at";
  query = query.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "client_name") query = query.order("client_name", { ascending: true });
  const { data, error, count } = await query.range(t.from, t.to);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toListRow), total: count ?? 0 };
}

export type YearCounts = { fy: FinancialYear; total: number; final: number; reviewed: number; failing: number };

/** The year's headline counts (§7.8.3): statements, Final, Reviewed, and those whose checks fail. */
export async function statementCounts(supabase: ServerSupabase, fy: FinancialYear): Promise<YearCounts> {
  const head = () => supabase.from("financial_statements_list").select("id", { count: "exact", head: true }).eq("financial_year", fy);
  const [total, final, reviewed, failing] = await Promise.all([head(), head().eq("status", "final"), head().eq("status", "reviewed"), head().neq("status", "final").eq("all_checks_passed", false)]);
  for (const r of [total, final, reviewed, failing]) if (r.error) throw r.error;
  return { fy, total: total.count ?? 0, final: final.count ?? 0, reviewed: reviewed.count ?? 0, failing: failing.count ?? 0 };
}

/** A client's statements, latest year first (Client 360 → Workpapers). */
export async function listClientStatements(supabase: ServerSupabase, clientId: string, limit = 6): Promise<Page<StatementListRow>> {
  const { data, error, count } = await supabase
    .from("financial_statements_list")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("client_id", clientId)
    .order("financial_year", { ascending: false })
    .range(0, limit - 1);
  if (error) throw error;
  return { rows: ((data ?? []) as Array<Record<string, unknown>>).map(toListRow), total: count ?? 0 };
}

/** The statement a client already has for a year, if any (one per client and FY). */
export async function findStatement(supabase: ServerSupabase, clientId: string, fy: FinancialYear): Promise<{ id: string; status: FsStatus } | null> {
  const { data, error } = await supabase.from("financial_statements").select("id, status").eq("client_id", clientId).eq("financial_year", fy).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, status: isFsStatus(data.status) ? data.status : "draft" } : null;
}

export type PreviousStatement = { id: string; financialYear: FinancialYear; status: FsStatus; figures: Partial<StatementFigures> | null };

/** Last year's saved statement for the comparatives (§6.13), when there is one with figures. */
export async function previousStatementFor(supabase: ServerSupabase, clientId: string, fy: FinancialYear): Promise<PreviousStatement | null> {
  const prev = previousFinancialYear(fy);
  const { data, error } = await supabase.from("financial_statements").select("id, financial_year, status, statements").eq("client_id", clientId).eq("financial_year", prev).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, financialYear: data.financial_year, status: isFsStatus(data.status) ? data.status : "draft", figures: readFigures(data.statements) };
}

/** The client's remembered ledger → bucket choices (§6.13). */
export async function rememberedBuckets(supabase: ServerSupabase, clientId: string): Promise<RememberedMappings> {
  const m = await rememberedMapping(supabase, clientId, "ledger_buckets");
  if (!m) return {};
  const out: Record<string, BucketCode> = {};
  for (const [k, v] of Object.entries(m)) if (isBucketCode(v)) out[k] = v;
  return out;
}

export type StatementDetail = {
  row: StatementListRow;
  client: ReconClient;
  ledgers: StoredLedger[];
  inputs: FsInputs;
  statements: Statements | null;
  reviewNote: string | null;
  createdByName: string | null;
  sourceDocument: { id: string; title: string; fileName: string } | null;
  previous: { id: string; financialYear: FinancialYear; status: FsStatus } | null;
  /** Saved figures of the previous statement, for live previews (the server recomputes on save). */
  previousFigures: Partial<StatementFigures> | null;
  previousStatementId: string | null;
  /** The raw statements JSON's build time, for the "built" stamp. */
  updatedAt: string;
};

export async function getStatementDetail(supabase: ServerSupabase, id: string): Promise<StatementDetail | null> {
  if (!UUID.test(id)) return null;
  const [listed, raw] = await Promise.all([
    supabase.from("financial_statements_list").select(`${LIST_COLUMNS}, review_note, source_document_id, previous_statement_id, created_by_name`).eq("id", id).maybeSingle(),
    supabase.from("financial_statements").select("id, client_id, financial_year, ledgers, statements, inputs, updated_at").eq("id", id).maybeSingle(),
  ]);
  if (listed.error) throw listed.error;
  if (raw.error) throw raw.error;
  if (!listed.data || !raw.data) return null;
  const l = listed.data as Record<string, unknown>;
  const row = toListRow(l);
  const client = await getReconClient(supabase, row.client_id);
  if (!client) return null;
  const sourceId = (l.source_document_id as string | null) ?? null;
  const [doc, previous] = await Promise.all([
    sourceId ? supabase.from("documents").select("id, title, file_name").eq("id", sourceId).is("deleted_at", null).maybeSingle() : Promise.resolve({ data: null, error: null }),
    previousStatementFor(supabase, row.client_id, row.financial_year),
  ]);
  if (doc.error) throw doc.error;
  const d = doc.data as { id: string; title: string; file_name: string } | null;
  return {
    row,
    client,
    ledgers: readLedgers(raw.data.ledgers),
    inputs: readInputs(raw.data.inputs, client.entityType),
    statements: readStatements(raw.data.statements),
    reviewNote: (l.review_note as string | null) ?? null,
    createdByName: (l.created_by_name as string | null) ?? null,
    sourceDocument: d ? { id: d.id, title: d.title, fileName: d.file_name } : null,
    previous: previous ? { id: previous.id, financialYear: previous.financialYear, status: previous.status } : null,
    previousFigures: previous?.figures ?? null,
    previousStatementId: (l.previous_statement_id as string | null) ?? null,
    updatedAt: String(raw.data.updated_at),
  };
}
