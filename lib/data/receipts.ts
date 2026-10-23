import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { tdsRulesOn, type TdsRule } from "@/lib/domain/tds";
import { todayIST, type DateString } from "@/lib/domain/fy";
import { toPaise, type Paise } from "@/lib/domain/money";

/**
 * Reads for receipts (§7.9.4, §7.9.9), under the caller's session (RLS: Partners and Managers;
 * portal users read their own through portal_payment_receipts, 0034).
 */

/**
 * Every TDS parameter row up to a date (§6.5), plain data: the receipt form picks the rules in force
 * on whatever payment date is typed (tdsRulesOn), so a back-dated payment uses the rates of its day.
 */
export async function getTdsParameterRows(supabase: ServerSupabase, upTo: DateString = todayIST()): Promise<StatutoryParameterRow[]> {
  const { data, error } = await supabase
    .from("statutory_parameters")
    .select("key, value, effective_from, effective_to, statute, source_ref, verified")
    .like("key", "tds.%")
    .lte("effective_from", upTo)
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    key: r.key,
    value: r.value,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    statute: r.statute,
    sourceRef: r.source_ref,
    verified: r.verified,
  }));
}

/** The TDS rules in force on a payment date (§6.5: data, looked up by the payment date). */
export async function getTdsRules(supabase: ServerSupabase, paymentDate: DateString = todayIST()): Promise<TdsRule[]> {
  return tdsRulesOn(paymentDate, await getTdsParameterRows(supabase, paymentDate));
}

export type ClientReceiptRow = {
  id: string;
  receipt_number: string;
  invoice_id: string;
  invoice_number: string | null;
  payment_date: string;
  amount_received: number;
  tds_amount: number;
  tds_section: string | null;
  tds_status: string;
  tds_quarter: string | null;
  method: string;
  reference: string | null;
  reversed_at: string | null;
};

/** A client's receipts, newest first (Client 360 → Billing). */
export async function listClientReceipts(supabase: ServerSupabase, clientId: string, opts: { limit?: number } = {}): Promise<ClientReceiptRow[]> {
  const { data, error } = await supabase
    .from("payment_receipts")
    .select("id, receipt_number, invoice_id, payment_date, amount_received, tds_amount, tds_section, tds_status, tds_quarter, method, reference, reversed_at, invoices!inner(invoice_number, client_id)")
    .eq("invoices.client_id", clientId)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 10);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<ClientReceiptRow & { invoices: { invoice_number: string | null } | null }>).map(({ invoices, ...r }) => ({
    ...r,
    invoice_number: invoices?.invoice_number ?? null,
  }));
}

export type TdsCreditSummaryRow = { quarter: string; status: string; count: number; amountPaise: Paise };

/** TDS deducted by the client on TaxWise's fees, by quarter and status (§7.9.9), live receipts only. Summed in paise. */
export async function getClientTdsSummary(supabase: ServerSupabase, clientId: string): Promise<{ rows: TdsCreditSummaryRow[]; totalPaise: Paise }> {
  const { data, error } = await supabase
    .from("payment_receipts")
    .select("tds_amount, tds_quarter, tds_status, payment_date, invoices!inner(client_id)")
    .eq("invoices.client_id", clientId)
    .is("reversed_at", null)
    .gt("tds_amount", 0)
    .order("payment_date", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const map = new Map<string, TdsCreditSummaryRow>();
  let totalPaise = 0;
  for (const r of (data ?? []) as Array<{ tds_amount: number; tds_quarter: string | null; tds_status: string }>) {
    const quarter = r.tds_quarter ?? "Quarter not recorded";
    const k = `${quarter}|${r.tds_status}`;
    const cur = map.get(k) ?? { quarter, status: r.tds_status, count: 0, amountPaise: 0 };
    const paise = toPaise(r.tds_amount);
    cur.count += 1;
    cur.amountPaise += paise;
    totalPaise += paise;
    map.set(k, cur);
  }
  return { rows: [...map.values()], totalPaise };
}

export type ReceiptDocument = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount_received: number;
  tds_amount: number;
  tds_section: string | null;
  method: string;
  reference: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  created_at: string;
  invoice: {
    id: string;
    invoice_number: string | null;
    issue_date: string;
    total_amount: number;
    outstanding_amount: number;
    client_id: string;
    client_name: string;
    client_address: string | null;
    client_gstin: string | null;
  };
};

/**
 * The data for a receipt PDF (§11 "payment receipt"): through the session for staff (RLS), or the
 * portal views for the client the receipt belongs to (§7.22). Null when the caller can't see it.
 */
export async function getReceiptDocument(supabase: ServerSupabase, id: string, audience: "staff" | "client"): Promise<ReceiptDocument | null> {
  if (audience === "staff") {
    const { data, error } = await supabase
      .from("payment_receipts")
      .select(
        "id, receipt_number, payment_date, amount_received, tds_amount, tds_section, method, reference, reversed_at, reversal_reason, created_at, invoices!inner(id, invoice_number, issue_date, total_amount, outstanding_amount, client_id, client_name_snapshot, client_address_snapshot, client_gstin_snapshot, clients!inner(display_name, legal_name))",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const d = data as unknown as Omit<ReceiptDocument, "invoice"> & {
      invoices: {
        id: string;
        invoice_number: string | null;
        issue_date: string;
        total_amount: number;
        outstanding_amount: number;
        client_id: string;
        client_name_snapshot: string | null;
        client_address_snapshot: string | null;
        client_gstin_snapshot: string | null;
        clients: { display_name: string; legal_name: string | null };
      };
    };
    const inv = d.invoices;
    return {
      ...d,
      invoice: {
        id: inv.id,
        invoice_number: inv.invoice_number,
        issue_date: inv.issue_date,
        total_amount: inv.total_amount,
        outstanding_amount: inv.outstanding_amount,
        client_id: inv.client_id,
        client_name: inv.client_name_snapshot ?? inv.clients.legal_name ?? inv.clients.display_name,
        client_address: inv.client_address_snapshot,
        client_gstin: inv.client_gstin_snapshot,
      },
    };
  }
  const { data: r, error } = await supabase
    .from("portal_payment_receipts")
    .select("id, receipt_number, invoice_id, payment_date, amount_received, tds_amount, method, reference, reversed_at, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!r || !r.id || !r.invoice_id) return null;
  const { data: inv, error: invError } = await supabase
    .from("portal_invoices")
    .select("id, invoice_number, issue_date, total_amount, outstanding_amount, client_id, client_name_snapshot, client_address_snapshot, client_gstin_snapshot")
    .eq("id", r.invoice_id)
    .maybeSingle();
  if (invError) throw invError;
  if (!inv || !inv.id) return null;
  return {
    id: r.id,
    receipt_number: r.receipt_number ?? "",
    payment_date: r.payment_date ?? "",
    amount_received: Number(r.amount_received ?? 0),
    tds_amount: Number(r.tds_amount ?? 0),
    tds_section: null,
    method: r.method ?? "other",
    reference: r.reference,
    reversed_at: r.reversed_at,
    reversal_reason: null,
    created_at: r.created_at ?? "",
    invoice: {
      id: inv.id,
      invoice_number: inv.invoice_number,
      issue_date: inv.issue_date ?? "",
      total_amount: Number(inv.total_amount ?? 0),
      outstanding_amount: Number(inv.outstanding_amount ?? 0),
      client_id: inv.client_id ?? "",
      client_name: inv.client_name_snapshot ?? "",
      client_address: inv.client_address_snapshot,
      client_gstin: inv.client_gstin_snapshot,
    },
  };
}
