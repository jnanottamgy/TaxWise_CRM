import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { fetchAll } from "@/server/compliance/engine";
import { compareDates, istDateOf, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { toPaise, type Paise } from "@/lib/domain/money";
import { tdsStatementDueDate, type MatchableReceipt, type TdsCreditStatus, type TdsMatchStatus } from "@/lib/domain/collections";

/**
 * Reads for TDS credits (§7.9.9), under the caller's session (Partners and Managers only, RLS):
 * the register of receipts with TDS, its totals by status, the 26AS / AIS lines that didn't match,
 * the credits that should have shown by now and haven't, and what the matcher needs.
 */

export type TdsCreditRow = {
  id: string;
  receipt_number: string;
  payment_date: DateString;
  amount_received: number;
  tds_amount: number;
  tds_section: string | null;
  quarter: string;
  financial_year: string;
  tds_status: TdsCreditStatus;
  tds_reflected_on: DateString | null;
  tds_claimed_on: DateString | null;
  tds_claimed_in: string | null;
  tds_status_note: string | null;
  deductor_tan: string | null;
  receipt_deductor_tan: string | null;
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: DateString;
  client_id: string;
  client_name: string;
  client_code: string;
  matched_entry_id: string | null;
  updated_at: string;
};

const COLUMNS =
  "id, receipt_number, payment_date, amount_received, tds_amount, tds_section, quarter, financial_year, tds_status, tds_reflected_on, tds_claimed_on, tds_claimed_in, tds_status_note, deductor_tan, receipt_deductor_tan, invoice_id, invoice_number, invoice_date, client_id, client_name, client_code, matched_entry_id, updated_at";

const SORTS: Record<string, string> = {
  payment_date: "payment_date",
  client_name: "client_name",
  tds_amount: "tds_amount",
  quarter: "quarter",
  invoice_number: "invoice_number",
};

export async function listTdsCredits(supabase: ServerSupabase, t: TableParams, opts: { fy: FinancialYear }): Promise<{ rows: TdsCreditRow[]; total: number }> {
  let q = supabase.from("tds_credit_register").select(COLUMNS, { count: "exact" }).eq("financial_year", opts.fy);
  const status = t.filters.status;
  if (status?.length) q = q.in("tds_status", status);
  const quarter = t.filters.quarter;
  if (quarter?.length) q = q.in("quarter", quarter);
  if (t.filters.tan?.includes("missing")) q = q.is("deductor_tan", null);
  if (t.q) {
    const p = `%${escapeLike(t.q)}%`;
    q = q.or(`client_name.ilike.${p},client_code.ilike.${p},invoice_number.ilike.${p},receipt_number.ilike.${p},deductor_tan.ilike.${p}`);
  }
  const sort = SORTS[t.sort ?? ""] ?? "payment_date";
  const { data, error, count } = await q.order(sort, { ascending: t.dir === "asc" }).order("id").range(t.from, t.to);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as TdsCreditRow[], total: count ?? 0 };
}

export type TdsSummary = Record<TdsCreditStatus, { count: number; paise: Paise }> & { quarters: string[]; missingTan: number };

export async function getTdsSummary(supabase: ServerSupabase, fy: FinancialYear): Promise<TdsSummary> {
  const rows = await fetchAll<{ tds_amount: number | null; tds_status: string | null; quarter: string | null; deductor_tan: string | null }>((a, b) =>
    supabase.from("tds_credit_register").select("tds_amount, tds_status, quarter, deductor_tan").eq("financial_year", fy).order("id").range(a, b),
  );
  const out: TdsSummary = { expected: { count: 0, paise: 0 }, reflected: { count: 0, paise: 0 }, claimed: { count: 0, paise: 0 }, quarters: [], missingTan: 0 };
  const quarters = new Set<string>();
  for (const r of rows) {
    const s = (r.tds_status ?? "expected") as TdsCreditStatus;
    if (out[s]) {
      out[s].count += 1;
      out[s].paise += toPaise(r.tds_amount ?? 0);
    }
    if (r.quarter) quarters.add(r.quarter);
    if (!r.deductor_tan) out.missingTan += 1;
  }
  out.quarters = [...quarters].sort();
  return out;
}

export type StatementIssue = {
  id: string;
  deductorTan: string;
  deductorName: string | null;
  section: string | null;
  transactionDate: DateString | null;
  tdsPaise: Paise;
  status: TdsMatchStatus;
  note: string | null;
  bookingStatus: string | null;
  clientId: string | null;
  clientName: string | null;
  importedOn: DateString;
};

/** Statement lines that didn't match (amount differs, not in our books) for an FY, newest import first. */
export async function listStatementIssues(supabase: ServerSupabase, fy: FinancialYear, opts: { includeIgnored?: boolean } = {}): Promise<StatementIssue[]> {
  const statuses = opts.includeIgnored ? ["amount_mismatch", "unmatched", "ignored"] : ["amount_mismatch", "unmatched"];
  const { data, error } = await supabase
    .from("tds_statement_entries")
    .select("id, deductor_tan, deductor_name, section, transaction_date, tds_amount, match_status, match_note, booking_status, client_id, created_at, clients(display_name)")
    .eq("financial_year", fy)
    .in("match_status", statuses)
    .order("match_status")
    .order("transaction_date", { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []).map((e) => ({
    id: e.id,
    deductorTan: String(e.deductor_tan),
    deductorName: e.deductor_name,
    section: e.section,
    transactionDate: e.transaction_date,
    tdsPaise: toPaise(e.tds_amount),
    status: e.match_status as TdsMatchStatus,
    note: e.match_note,
    bookingStatus: e.booking_status,
    clientId: e.client_id,
    clientName: (e as unknown as { clients: { display_name: string } | null }).clients?.display_name ?? null,
    importedOn: istDateOf(e.created_at),
  }));
}

export type TdsImportRow = { id: string; source: string; fileName: string | null; createdAt: string; rows: number; matched: number; mismatches: number; unmatched: number; importedBy: string | null };

export async function listTdsImports(supabase: ServerSupabase, fy: FinancialYear, limit = 5): Promise<TdsImportRow[]> {
  const { data, error } = await supabase
    .from("tds_statement_imports")
    .select("id, source, file_name, created_at, rows_total, matched, amount_mismatches, unmatched, imported_by")
    .eq("financial_year", fy)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const ids = [...new Set((data ?? []).map((r) => r.imported_by))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people, error: pErr } = await supabase.from("profiles").select("id, full_name").in("id", ids);
    if (pErr) throw pErr;
    for (const p of people ?? []) names.set(p.id, p.full_name);
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    fileName: r.file_name,
    createdAt: r.created_at,
    rows: r.rows_total,
    matched: r.matched,
    mismatches: r.amount_mismatches,
    unmatched: r.unmatched,
    importedBy: names.get(r.imported_by) ?? null,
  }));
}

/** The TDS statement due-date rules (due_date_rules TDS_RETURN_Q1–Q4, §6.7). */
export async function getTdsReturnRules(supabase: ServerSupabase): Promise<Array<{ rule: unknown }>> {
  const { data, error } = await supabase.from("due_date_rules").select("code, rule").like("code", "TDS_RETURN_Q%");
  if (error) throw error;
  return (data ?? []).map((r) => ({ rule: r.rule }));
}

/**
 * Credits still Expected although the deductor's statement for their quarter was due before the
 * latest 26AS / AIS was imported: they should be showing, and aren't.
 */
export async function listNotReflected(
  supabase: ServerSupabase,
  fy: FinancialYear,
  latestImportOn: DateString | null,
  rules: ReadonlyArray<{ rule: unknown }>,
): Promise<TdsCreditRow[]> {
  if (!latestImportOn) return [];
  const rows = await fetchAll<TdsCreditRow>((a, b) =>
    supabase.from("tds_credit_register").select(COLUMNS).eq("financial_year", fy).eq("tds_status", "expected").order("payment_date").order("id").range(a, b) as never,
  2000);
  return rows.filter((r) => {
    const due = tdsStatementDueDate(r.quarter, rules);
    return due !== null && compareDates(due, latestImportOn) < 0;
  });
}

/** Every receipt with TDS in an FY, as the matcher reads them. */
export async function loadMatchableReceipts(supabase: ServerSupabase, fy: FinancialYear): Promise<MatchableReceipt[]> {
  const rows = await fetchAll<{ id: string; deductor_tan: string | null; tds_amount: number; quarter: string | null; payment_date: string; tds_status: string; matched_entry_id: string | null }>((a, b) =>
    supabase.from("tds_credit_register").select("id, deductor_tan, tds_amount, quarter, payment_date, tds_status, matched_entry_id").eq("financial_year", fy).order("id").range(a, b) as never,
  );
  return rows.map((r) => ({
    id: r.id,
    tan: r.deductor_tan ? String(r.deductor_tan).toUpperCase() : null,
    tdsPaise: toPaise(r.tds_amount),
    quarter: r.quarter,
    paymentDate: r.payment_date,
    status: (r.tds_status ?? "expected") as TdsCreditStatus,
    matched: Boolean(r.matched_entry_id),
  }));
}

/** The clients behind a set of TANs (statement lines name a TAN, not a client). */
export async function clientsByTan(supabase: ServerSupabase, tans: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  const list = [...new Set(tans.map((t) => t.toUpperCase()))];
  if (!list.length) return out;
  const { data, error } = await supabase.from("clients").select("id, display_name, tan").in("tan", list).is("deleted_at", null);
  if (error) throw error;
  for (const c of data ?? []) if (c.tan && !out.has(String(c.tan).toUpperCase())) out.set(String(c.tan).toUpperCase(), { id: c.id, name: c.display_name });
  return out;
}

export type TdsDraftClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  contacts: Array<{ id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null; isPrimary: boolean; handles: string[]; bounced: boolean }>;
};

/** The clients behind the mismatches, with their contacts, for the correction drafts. */
export async function getTdsDraftClients(supabase: ServerSupabase, clientIds: readonly string[]): Promise<Map<string, TdsDraftClient>> {
  const out = new Map<string, TdsDraftClient>();
  const ids = [...new Set(clientIds)].slice(0, 200);
  if (!ids.length) return out;
  const [clients, contacts] = await Promise.all([
    supabase.from("clients").select("id, display_name, email, phone, whatsapp").in("id", ids).is("deleted_at", null),
    supabase.from("client_contacts").select("id, client_id, name, email, phone, whatsapp, is_primary, handles, email_bounced").in("client_id", ids).order("is_primary", { ascending: false }).order("created_at", { ascending: true }),
  ]);
  if (clients.error) throw clients.error;
  if (contacts.error) throw contacts.error;
  for (const c of clients.data ?? []) out.set(c.id, { id: c.id, name: c.display_name, email: c.email ? String(c.email) : null, phone: c.phone, whatsapp: c.whatsapp, contacts: [] });
  for (const k of contacts.data ?? []) {
    out.get(k.client_id)?.contacts.push({ id: k.id, name: k.name, email: k.email ? String(k.email) : null, phone: k.phone, whatsapp: k.whatsapp, isPrimary: k.is_primary, handles: (k.handles ?? []) as string[], bounced: Boolean(k.email_bounced) });
  }
  return out;
}
