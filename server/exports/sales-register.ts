import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { fetchAll } from "@/server/compliance/engine";
import { fromPaise, toPaise } from "@/lib/domain/money";
import { lineTax } from "@/lib/domain/gstr1";
import { stateName } from "@/lib/domain/india-validators";
import { CREDIT_NOTE_REASON_LABELS, isEnumValue } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";
import type { DateString } from "@/lib/domain/fy";
import { writeXlsx, type XlsxSheet } from "@/server/exports/revenue-ledger";

/**
 * The sales register for TaxWise's own books (§7.9.8): one row per invoice line (taxable value, GST
 * rate, CGST / SGST or IGST worked out per line exactly as the invoice did, reimbursements on their
 * own lines) for every invoice and debit note issued in the period, and one negative row per credit
 * note. Cancelled invoices are listed with zero values and the cancellation noted, so the series
 * has no gaps. Read under the caller's session (Partners and Managers, RLS); paise maths.
 */

type InvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_kind: string;
  issue_date: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  client_gstin_snapshot: string | null;
  client_name_snapshot: string | null;
  place_of_supply_code: string;
  round_off: number;
  total_amount: number;
  clients: { display_name: string; client_code: string } | null;
  invoice_items: Array<{ description: string; sac_code: string; quantity: number; rate: number; amount: number; tax_rate: number; is_reimbursement: boolean; sort_order: number }>;
};

type CreditRow = {
  credit_note_number: string;
  issue_date: string;
  reason_code: string;
  reason: string;
  reduces_gst: boolean;
  taxable_amount: number;
  tax_rate: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  total_amount: number;
  place_of_supply_code: string | null;
  clients: { display_name: string; client_code: string } | null;
  invoices: { invoice_number: string | null; client_gstin_snapshot: string | null; client_name_snapshot: string | null; place_of_supply_code: string } | null;
};

const HEADERS = [
  "Date",
  "Document",
  "Number",
  "Against",
  "Client",
  "Code",
  "GSTIN",
  "Place of supply",
  "Description",
  "SAC",
  "Qty",
  "Rate (₹)",
  "Taxable value (₹)",
  "GST %",
  "CGST (₹)",
  "SGST (₹)",
  "IGST (₹)",
  "Reimbursement (₹)",
  "Line total (₹)",
  "Document total (₹)",
  "Note",
];

export async function buildSalesRegister(supabase: ServerSupabase, range: { from: DateString; to: DateString }, firmStateCode: string): Promise<{ sheet: XlsxSheet; rows: number }> {
  const [invoices, credits] = await Promise.all([
    fetchAll<InvoiceRow>((a, b) =>
      supabase
        .from("invoices")
        .select(
          "id, invoice_number, invoice_kind, issue_date, cancelled_at, cancel_reason, client_gstin_snapshot, client_name_snapshot, place_of_supply_code, round_off, total_amount, clients(display_name, client_code), invoice_items(description, sac_code, quantity, rate, amount, tax_rate, is_reimbursement, sort_order)",
        )
        .is("deleted_at", null)
        .not("invoice_number", "is", null)
        .not("status", "in", "(draft,awaiting_approval)")
        .gte("issue_date", range.from)
        .lte("issue_date", range.to)
        .order("issue_date")
        .order("invoice_number")
        .range(a, b) as never,
    ),
    fetchAll<CreditRow>((a, b) =>
      supabase
        .from("credit_notes")
        .select(
          "credit_note_number, issue_date, reason_code, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, clients(display_name, client_code), invoices(invoice_number, client_gstin_snapshot, client_name_snapshot, place_of_supply_code)",
        )
        .gte("issue_date", range.from)
        .lte("issue_date", range.to)
        .order("issue_date")
        .order("credit_note_number")
        .range(a, b) as never,
    ),
  ]);

  const pos = (code: string | null | undefined) => (code ? `${code}-${stateName(code) ?? ""}` : "");
  const out: Array<{ date: string; key: string; row: Array<string | number | null> }> = [];

  for (const inv of invoices) {
    const doc = inv.invoice_kind === "debit_note" ? "Debit note" : "Tax invoice";
    const client = inv.client_name_snapshot ?? inv.clients?.display_name ?? "";
    const code = inv.clients?.client_code ? String(inv.clients.client_code) : "";
    const gstin = inv.client_gstin_snapshot ? String(inv.client_gstin_snapshot) : "";
    const intra = inv.place_of_supply_code === firmStateCode;
    const lines = [...(inv.invoice_items ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const total = fromPaise(toPaise(inv.total_amount));
    if (inv.cancelled_at) {
      out.push({
        date: inv.issue_date,
        key: inv.invoice_number,
        row: [formatDate(inv.issue_date), doc, inv.invoice_number, "", client, code, gstin, pos(inv.place_of_supply_code), "Cancelled", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, `Cancelled on ${formatDate(inv.cancelled_at)}${inv.cancel_reason ? `: ${inv.cancel_reason}` : ""}`],
      });
      continue;
    }
    lines.forEach((l, i) => {
      const amount = toPaise(l.amount);
      const t = l.is_reimbursement ? { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 } : lineTax(amount, l.tax_rate, intra);
      out.push({
        date: inv.issue_date,
        key: `${inv.invoice_number}#${i}`,
        row: [
          formatDate(inv.issue_date),
          doc,
          inv.invoice_number,
          "",
          client,
          code,
          gstin,
          pos(inv.place_of_supply_code),
          l.description,
          l.sac_code,
          Number(l.quantity),
          fromPaise(toPaise(l.rate)),
          l.is_reimbursement ? 0 : fromPaise(amount),
          l.is_reimbursement ? 0 : Number(l.tax_rate),
          fromPaise(t.cgstPaise),
          fromPaise(t.sgstPaise),
          fromPaise(t.igstPaise),
          l.is_reimbursement ? fromPaise(amount) : 0,
          fromPaise(amount + t.taxPaise),
          i === 0 ? total : null,
          l.is_reimbursement ? "Reimbursement of expenses incurred as pure agent (Rule 33)" : i === 0 && toPaise(inv.round_off) !== 0 ? `Round-off ${fromPaise(toPaise(inv.round_off)).toFixed(2)} in the total` : "",
        ],
      });
    });
  }

  for (const c of credits) {
    const client = c.invoices?.client_name_snapshot ?? c.clients?.display_name ?? "";
    const neg = (v: number | null | undefined) => -fromPaise(toPaise(v ?? 0));
    out.push({
      date: c.issue_date,
      key: c.credit_note_number,
      row: [
        formatDate(c.issue_date),
        "Credit note",
        c.credit_note_number,
        c.invoices?.invoice_number ?? "",
        client,
        c.clients?.client_code ? String(c.clients.client_code) : "",
        c.invoices?.client_gstin_snapshot ? String(c.invoices.client_gstin_snapshot) : "",
        pos(c.place_of_supply_code ?? c.invoices?.place_of_supply_code),
        `${isEnumValue("credit_note_reason", c.reason_code) ? CREDIT_NOTE_REASON_LABELS[c.reason_code] : c.reason_code}: ${c.reason}`,
        "",
        1,
        neg(c.taxable_amount),
        neg(c.taxable_amount),
        c.tax_rate === null ? 0 : Number(c.tax_rate),
        neg(c.cgst_amount),
        neg(c.sgst_amount),
        neg(c.igst_amount),
        0,
        neg(c.total_amount),
        neg(c.total_amount),
        c.reduces_gst ? "" : "Commercial credit: GST not reduced",
      ],
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key, "en", { numeric: true }));
  return {
    rows: out.length,
    sheet: {
      name: "Sales register",
      preamble: [[`Sales register, ${formatDate(range.from)} to ${formatDate(range.to)}`], []],
      headers: HEADERS,
      rows: out.map((o) => o.row),
      moneyColumns: [11, 12, 14, 15, 16, 17, 18, 19],
      widths: [13, 12, 16, 16, 30, 12, 18, 18, 40, 9, 6, 12, 14, 7],
    },
  };
}

export async function salesRegisterWorkbook(supabase: ServerSupabase, range: { from: DateString; to: DateString }, firmStateCode: string): Promise<{ bytes: Buffer; rows: number }> {
  const { sheet, rows } = await buildSalesRegister(supabase, range, firmStateCode);
  return { bytes: await writeXlsx([sheet], { title: "Sales register" }), rows };
}

/** CSV of the same register (UTF-8 with a BOM, formula-safe). */
export async function salesRegisterCsv(supabase: ServerSupabase, range: { from: DateString; to: DateString }, firmStateCode: string): Promise<{ bytes: Buffer; rows: number }> {
  const { sheet, rows } = await buildSalesRegister(supabase, range, firmStateCode);
  const field = (v: string | number | null) => {
    if (v === null) return "";
    const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = `﻿${[sheet.headers, ...sheet.rows].map((r) => r.map(field).join(",")).join("\r\n")}\r\n`;
  return { bytes: Buffer.from(text, "utf8"), rows };
}
