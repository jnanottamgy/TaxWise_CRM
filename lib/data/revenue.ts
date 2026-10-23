import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { toPaise, type Paise } from "@/lib/domain/money";
import type { DateString } from "@/lib/domain/fy";
import type { RevenueKind } from "@/lib/schemas/collections";

/**
 * The revenue ledger (§7.9.10): one call to revenue_ledger (0163), which searches, sorts, pages and
 * totals in SQL. Totals arrive as decimal strings and become paise.
 */

export type LedgerInvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_kind: string;
  issue_date: DateString;
  due_date: DateString;
  status: string;
  display_status: string;
  client_id: string;
  client_name: string;
  client_code: string;
  client_gstin: string | null;
  place_of_supply_code: string;
  billing_period_label: string | null;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  gst_amount: number;
  reimbursement_amount: number;
  round_off: number;
  total_amount: number;
  amount_received: number;
  tds_credited: number;
  credit_noted: number;
  written_off: number;
  outstanding_amount: number;
  cancelled_at: string | null;
};

export type LedgerReceiptRow = {
  id: string;
  receipt_number: string;
  payment_date: DateString;
  amount_received: number;
  tds_amount: number;
  settled: number;
  tds_section: string | null;
  method: string;
  reference: string | null;
  deposited_to: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  invoice_id: string;
  invoice_number: string | null;
  client_id: string;
  client_name: string;
  client_code: string;
};

export type LedgerCreditNoteRow = {
  id: string;
  credit_note_number: string;
  issue_date: DateString;
  reason_code: string;
  reason: string;
  reduces_gst: boolean;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  gst_amount: number;
  total_amount: number;
  tax_rate: number | null;
  place_of_supply_code: string | null;
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: DateString;
  client_id: string;
  client_name: string;
  client_code: string;
  client_gstin: string | null;
};

export type LedgerRowOf<K extends RevenueKind> = K extends "invoices" ? LedgerInvoiceRow : K extends "receipts" ? LedgerReceiptRow : LedgerCreditNoteRow;

export type LedgerPage<K extends RevenueKind> = {
  kind: K;
  total: number;
  rows: Array<LedgerRowOf<K>>;
  /** Paise for every money total; counts as numbers. */
  totals: Record<string, Paise>;
  counts: Record<string, number>;
};

export async function getRevenueLedger<K extends RevenueKind>(
  supabase: ServerSupabase,
  params: { kind: K; from: DateString; to: DateString; q?: string; sort?: string | null; dir?: "asc" | "desc"; offset?: number; limit?: number; clientId?: string | null },
): Promise<LedgerPage<K>> {
  const { data, error } = await supabase.rpc("revenue_ledger", {
    p_params: {
      kind: params.kind,
      from: params.from,
      to: params.to,
      q: params.q ?? "",
      sort: params.sort ?? "date",
      dir: params.dir ?? "desc",
      offset: params.offset ?? 0,
      limit: params.limit ?? 25,
      client_id: params.clientId ?? null,
    },
  });
  if (error) throw error;
  const r = (data ?? {}) as { total?: number; rows?: unknown[]; totals?: Record<string, string | number> };
  const totals: Record<string, Paise> = {};
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.totals ?? {})) {
    if (typeof v === "string") totals[k] = toPaise(v);
    else counts[k] = v;
  }
  return { kind: params.kind, total: r.total ?? 0, rows: (r.rows ?? []) as Array<LedgerRowOf<K>>, totals, counts };
}
