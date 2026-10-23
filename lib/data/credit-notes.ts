import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Reads for credit notes (§7.9.7), under the caller's session (RLS: Partners and Managers; portal
 * users read the credit notes on their own invoices through portal_credit_notes, 0154).
 */

export type ClientCreditNoteRow = {
  id: string;
  credit_note_number: string;
  invoice_id: string;
  invoice_number: string | null;
  issue_date: string;
  reason_code: string;
  reason: string;
  reduces_gst: boolean;
  taxable_amount: number;
  total_amount: number;
};

/** A client's credit notes, newest first (Client 360 → Billing). */
export async function listClientCreditNotes(supabase: ServerSupabase, clientId: string, opts: { limit?: number } = {}): Promise<ClientCreditNoteRow[]> {
  const { data, error } = await supabase
    .from("credit_notes")
    .select("id, credit_note_number, invoice_id, issue_date, reason_code, reason, reduces_gst, taxable_amount, total_amount, invoices!inner(invoice_number)")
    .eq("client_id", clientId)
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 10);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<ClientCreditNoteRow & { invoices: { invoice_number: string | null } | null }>).map(({ invoices, ...r }) => ({
    ...r,
    invoice_number: invoices?.invoice_number ?? null,
  }));
}

export type CreditNoteDocument = {
  id: string;
  credit_note_number: string;
  issue_date: string;
  reason: string;
  reason_code: string | null;
  reduces_gst: boolean;
  taxable_amount: number;
  tax_rate: number | null;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
  place_of_supply_code: string | null;
  notes: string | null;
  issued_by: string | null;
  invoice: {
    id: string;
    invoice_number: string | null;
    issue_date: string;
    client_name: string;
    client_address: string | null;
    client_gstin: string | null;
    client_state_code: string | null;
    firm_gstin: string | null;
  };
};

/**
 * The data for a credit-note PDF (§11, §7.9.7): through the session for staff (RLS), or the portal
 * views for the client it belongs to (§7.22). Null when the caller can't see it.
 */
export async function getCreditNoteDocument(supabase: ServerSupabase, id: string, audience: "staff" | "client"): Promise<CreditNoteDocument | null> {
  if (audience === "staff") {
    const { data, error } = await supabase
      .from("credit_notes")
      .select(
        "id, credit_note_number, issue_date, reason, reason_code, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, notes, issued_by, invoices!inner(id, invoice_number, issue_date, client_name_snapshot, client_address_snapshot, client_gstin_snapshot, client_state_snapshot, firm_gstin_snapshot, clients!inner(display_name, legal_name))",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const d = data as unknown as Omit<CreditNoteDocument, "invoice"> & {
      invoices: {
        id: string;
        invoice_number: string | null;
        issue_date: string;
        client_name_snapshot: string | null;
        client_address_snapshot: string | null;
        client_gstin_snapshot: string | null;
        client_state_snapshot: string | null;
        firm_gstin_snapshot: string | null;
        clients: { display_name: string; legal_name: string | null };
      };
    };
    const inv = d.invoices;
    return {
      ...d,
      cgst_amount: Number(d.cgst_amount ?? 0),
      sgst_amount: Number(d.sgst_amount ?? 0),
      igst_amount: Number(d.igst_amount ?? 0),
      invoice: {
        id: inv.id,
        invoice_number: inv.invoice_number,
        issue_date: inv.issue_date,
        client_name: inv.client_name_snapshot ?? inv.clients.legal_name ?? inv.clients.display_name,
        client_address: inv.client_address_snapshot,
        client_gstin: inv.client_gstin_snapshot,
        client_state_code: inv.client_state_snapshot,
        firm_gstin: inv.firm_gstin_snapshot,
      },
    };
  }
  const { data: c, error } = await supabase
    .from("portal_credit_notes")
    .select("id, credit_note_number, invoice_id, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, issue_date")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!c || !c.id || !c.invoice_id) return null;
  const { data: inv, error: invError } = await supabase
    .from("portal_invoices")
    .select("id, invoice_number, issue_date, client_name_snapshot, client_address_snapshot, client_gstin_snapshot, firm_gstin_snapshot")
    .eq("id", c.invoice_id)
    .maybeSingle();
  if (invError) throw invError;
  if (!inv || !inv.id) return null;
  return {
    id: c.id,
    credit_note_number: c.credit_note_number ?? "",
    issue_date: c.issue_date ?? "",
    reason: c.reason ?? "",
    reason_code: null,
    reduces_gst: Boolean(c.reduces_gst),
    taxable_amount: Number(c.taxable_amount ?? 0),
    tax_rate: c.tax_rate === null ? null : Number(c.tax_rate),
    cgst_amount: Number(c.cgst_amount ?? 0),
    sgst_amount: Number(c.sgst_amount ?? 0),
    igst_amount: Number(c.igst_amount ?? 0),
    total_amount: Number(c.total_amount ?? 0),
    place_of_supply_code: c.place_of_supply_code,
    notes: null,
    issued_by: null,
    invoice: {
      id: inv.id,
      invoice_number: inv.invoice_number,
      issue_date: inv.issue_date ?? "",
      client_name: inv.client_name_snapshot ?? "",
      client_address: inv.client_address_snapshot,
      client_gstin: inv.client_gstin_snapshot,
      client_state_code: null,
      firm_gstin: inv.firm_gstin_snapshot,
    },
  };
}
