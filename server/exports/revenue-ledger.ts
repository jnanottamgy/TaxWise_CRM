import "server-only";

import ExcelJS from "exceljs";
import type { ServerSupabase } from "@/lib/supabase/server";
import { fromPaise, toPaise, type Paise } from "@/lib/domain/money";
import { PAYMENT_METHOD_LABELS, CREDIT_NOTE_REASON_LABELS, isEnumValue } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";
import { getStatus } from "@/lib/status";
import { getRevenueLedger, type LedgerCreditNoteRow, type LedgerInvoiceRow, type LedgerReceiptRow } from "@/lib/data/revenue";
import type { DateString } from "@/lib/domain/fy";

/**
 * The revenue ledger workbook (§7.9.10, §11 "revenue ledger … Excel"): a summary sheet, then the
 * invoice ledger (invoice-level, with the GST split, what was received, deducted, credited and
 * written off), every receipt (reversed ones marked and kept out of the totals) and every credit
 * note, for a period. Read under the caller's session (RLS); summed in paise.
 *
 * writeXlsx is shared by the GSTR-1 and sales-register exports: cells that start like a formula
 * are quoted so a spreadsheet never runs them, money columns are numbers formatted 0.00.
 */

export type XlsxSheet = {
  name: string;
  /** Rows above the header (titles, summaries). */
  preamble?: Array<Array<string | number>>;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  /** 0-based columns holding rupees. */
  moneyColumns?: number[];
  /** Freeze the header (and the first column). */
  freeze?: boolean;
  widths?: number[];
};

export function safeCell(v: string | number | null): string | number | null {
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return `'${v}`;
  return v;
}

export async function writeXlsx(sheets: XlsxSheet[], meta: { title: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TaxWise Consultants";
  wb.created = new Date();
  wb.title = meta.title;
  for (const s of sheets) {
    const pre = s.preamble ?? [];
    const ws = wb.addWorksheet(s.name.slice(0, 31), s.freeze === false ? {} : { views: [{ state: "frozen", xSplit: 0, ySplit: pre.length + 1 }] });
    for (const row of pre) ws.addRow(row.map((c) => safeCell(c)));
    const h = ws.addRow(s.headers);
    h.font = { bold: true };
    for (const r of s.rows) ws.addRow(r.map((c) => safeCell(c)));
    s.headers.forEach((header, i) => {
      const col = ws.getColumn(i + 1);
      col.width = s.widths?.[i] ?? Math.min(48, Math.max(10, header.length + 2));
      if (s.moneyColumns?.includes(i)) col.numFmt = "#,##,##0.00";
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

const r = (v: number | string | null | undefined): number => fromPaise(toPaise(v ?? 0));

function invoiceStatusLabel(row: LedgerInvoiceRow): string {
  if (row.cancelled_at) return "Cancelled";
  return getStatus("invoice_status", row.display_status).label;
}

export async function buildRevenueLedgerWorkbook(supabase: ServerSupabase, range: { from: DateString; to: DateString }, opts: { q?: string; clientId?: string | null } = {}): Promise<{ bytes: Buffer; counts: Record<string, number> }> {
  const base = { from: range.from, to: range.to, q: opts.q ?? "", clientId: opts.clientId ?? null, sort: "date", dir: "asc" as const, offset: 0, limit: 20000 };
  const [inv, rec, cn] = await Promise.all([
    getRevenueLedger(supabase, { ...base, kind: "invoices" }),
    getRevenueLedger(supabase, { ...base, kind: "receipts" }),
    getRevenueLedger(supabase, { ...base, kind: "credit_notes" }),
  ]);
  const t = (m: Record<string, Paise>, k: string) => fromPaise(m[k] ?? 0);

  const summary: XlsxSheet = {
    name: "Summary",
    freeze: false,
    preamble: [
      [`Revenue ledger, ${formatDate(range.from)} to ${formatDate(range.to)}`],
      [`${inv.counts.count ?? 0} invoices and debit notes issued (${inv.counts.cancelled ?? 0} cancelled), ${rec.counts.count ?? 0} receipts (${rec.counts.reversed ?? 0} reversed), ${cn.counts.count ?? 0} credit notes.`],
      ["Cancelled invoices and reversed receipts are listed but left out of these totals. A waiver is a write-off, not a reversal of revenue."],
      [],
    ],
    headers: ["Figure", "Amount (₹)"],
    rows: [
      ["Taxable value", t(inv.totals, "taxable")],
      ["CGST", t(inv.totals, "cgst")],
      ["SGST", t(inv.totals, "sgst")],
      ["IGST", t(inv.totals, "igst")],
      ["Reimbursements (pure agent)", t(inv.totals, "reimbursement")],
      ["Round-off", t(inv.totals, "round_off")],
      ["Invoice total", t(inv.totals, "total")],
      ["Credit notes issued in the period (total)", t(cn.totals, "total")],
      ["Credit notes: taxable value", t(cn.totals, "taxable")],
      ["Written off on the period's invoices", t(inv.totals, "written_off")],
      ["Received in the period", t(rec.totals, "received")],
      ["TDS deducted in the period", t(rec.totals, "tds")],
      ["Still outstanding on the period's invoices", t(inv.totals, "outstanding")],
    ],
    moneyColumns: [1],
    widths: [48, 18],
  };

  const invoices: XlsxSheet = {
    name: "Invoices",
    headers: ["Date", "Number", "Type", "Client", "Code", "GSTIN", "Place of supply", "Period", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Reimbursements (₹)", "Round-off (₹)", "Total (₹)", "Received (₹)", "TDS (₹)", "Credit notes (₹)", "Written off (₹)", "Outstanding (₹)", "Status"],
    rows: (inv.rows as LedgerInvoiceRow[]).map((x) => [
      formatDate(x.issue_date),
      x.invoice_number,
      x.invoice_kind === "debit_note" ? "Debit note" : "Tax invoice",
      x.client_name,
      x.client_code,
      x.client_gstin ?? "",
      x.place_of_supply_code,
      x.billing_period_label ?? "",
      r(x.taxable_amount),
      r(x.cgst_amount),
      r(x.sgst_amount),
      r(x.igst_amount),
      r(x.reimbursement_amount),
      r(x.round_off),
      r(x.total_amount),
      r(x.amount_received),
      r(x.tds_credited),
      r(x.credit_noted),
      r(x.written_off),
      r(x.outstanding_amount),
      invoiceStatusLabel(x),
    ]),
    moneyColumns: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    widths: [13, 16, 12, 32, 12, 18, 10, 14],
  };

  const receipts: XlsxSheet = {
    name: "Receipts",
    headers: ["Payment date", "Receipt", "Invoice", "Client", "Code", "Received (₹)", "TDS (₹)", "TDS section", "Settled (₹)", "Method", "Reference", "Deposited to", "Status"],
    rows: (rec.rows as LedgerReceiptRow[]).map((x) => [
      formatDate(x.payment_date),
      x.receipt_number,
      x.invoice_number ?? "",
      x.client_name,
      x.client_code,
      r(x.amount_received),
      r(x.tds_amount),
      x.tds_section ?? "",
      r(x.settled),
      isEnumValue("payment_method", x.method) ? PAYMENT_METHOD_LABELS[x.method] : x.method,
      x.reference ?? "",
      x.deposited_to ?? "",
      x.reversed_at ? `Reversed ${formatDate(x.reversed_at)}${x.reversal_reason ? `: ${x.reversal_reason}` : ""}` : "Recorded",
    ]),
    moneyColumns: [5, 6, 8],
    widths: [13, 18, 16, 32, 12],
  };

  const notes: XlsxSheet = {
    name: "Credit notes",
    headers: ["Date", "Credit note", "Invoice", "Invoice date", "Client", "Code", "GSTIN", "Reason", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Total (₹)", "Reduces GST"],
    rows: (cn.rows as LedgerCreditNoteRow[]).map((x) => [
      formatDate(x.issue_date),
      x.credit_note_number,
      x.invoice_number ?? "",
      formatDate(x.invoice_date),
      x.client_name,
      x.client_code,
      x.client_gstin ?? "",
      `${isEnumValue("credit_note_reason", x.reason_code) ? CREDIT_NOTE_REASON_LABELS[x.reason_code] : x.reason_code}: ${x.reason}`,
      r(x.taxable_amount),
      r(x.cgst_amount),
      r(x.sgst_amount),
      r(x.igst_amount),
      r(x.total_amount),
      x.reduces_gst ? "Yes" : "No (commercial credit)",
    ]),
    moneyColumns: [8, 9, 10, 11, 12],
    widths: [13, 18, 16, 13, 32, 12, 18, 36],
  };

  const bytes = await writeXlsx([summary, invoices, receipts, notes], { title: "Revenue ledger" });
  return { bytes, counts: { invoices: inv.total, receipts: rec.total, credit_notes: cn.total } };
}
