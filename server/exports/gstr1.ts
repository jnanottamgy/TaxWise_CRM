import "server-only";

import ExcelJS from "exceljs";
import type { ServerSupabase } from "@/lib/supabase/server";
import { fetchAll } from "@/server/compliance/engine";
import { toPaise } from "@/lib/domain/money";
import { readParameterNumber } from "@/lib/domain/gst";
import { buildGstr1, GSTR1_DEFAULTS, gstr1Json, gstr1Sheets, type Gstr1CreditNote, type Gstr1Invoice, type Gstr1Period, type Gstr1Return } from "@/lib/domain/gstr1";
import { safeCell } from "@/server/exports/revenue-ledger";

/**
 * TaxWise's own GSTR-1 for a month or quarter (§7.9.8): the period's issued invoices, debit notes
 * and credit notes, read under the caller's session (Partners and Managers, RLS), sorted into the
 * portal's tables by lib/domain/gstr1.ts, and written as the offline tool's Excel workbook (summary
 * rows 1–3, headings on row 4) or the GSTR-1 JSON. The B2CL threshold is the law parameter
 * gst.gstr1_b2cl_threshold in force at the period's end.
 */

export type Gstr1Data = { firmGstin: string | null; firmStateCode: string; ret: Gstr1Return };

type InvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_kind: string;
  issue_date: string;
  cancelled_at: string | null;
  client_gstin_snapshot: string | null;
  client_name_snapshot: string | null;
  place_of_supply_code: string;
  reverse_charge: boolean;
  total_amount: number;
  clients: { display_name: string } | null;
  invoice_items: Array<{ sac_code: string; description: string; amount: number; tax_rate: number; is_reimbursement: boolean; sort_order: number }>;
  original: { invoice_number: string | null; issue_date: string; total_amount: number; place_of_supply_code: string } | null;
};

type CreditRow = {
  id: string;
  credit_note_number: string;
  issue_date: string;
  reduces_gst: boolean;
  taxable_amount: number;
  tax_rate: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  total_amount: number;
  place_of_supply_code: string | null;
  invoices: {
    invoice_number: string | null;
    issue_date: string;
    total_amount: number;
    place_of_supply_code: string;
    client_gstin_snapshot: string | null;
    client_name_snapshot: string | null;
    invoice_items: Array<{ sac_code: string; amount: number; is_reimbursement: boolean }>;
  } | null;
};

export async function loadGstr1(supabase: ServerSupabase, period: Gstr1Period): Promise<Gstr1Data> {
  const [firm, param, invoices, credits] = await Promise.all([
    supabase.from("firm_settings").select("gstin, state_code").eq("id", 1).maybeSingle(),
    supabase
      .from("statutory_parameters")
      .select("value, effective_from")
      .eq("key", "gst.gstr1_b2cl_threshold")
      .lte("effective_from", period.to)
      .or(`effective_to.is.null,effective_to.gte.${period.to}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetchAll<InvoiceRow>((a, b) =>
      supabase
        .from("invoices")
        .select(
          "id, invoice_number, invoice_kind, issue_date, cancelled_at, client_gstin_snapshot, client_name_snapshot, place_of_supply_code, reverse_charge, total_amount, clients(display_name), invoice_items(sac_code, description, amount, tax_rate, is_reimbursement, sort_order), original:invoices!invoices_original_invoice_id_fkey(invoice_number, issue_date, total_amount, place_of_supply_code)",
        )
        .is("deleted_at", null)
        .not("invoice_number", "is", null)
        .not("status", "in", "(draft,awaiting_approval)")
        .gte("issue_date", period.from)
        .lte("issue_date", period.to)
        .order("id")
        .range(a, b) as never,
    ),
    fetchAll<CreditRow>((a, b) =>
      supabase
        .from("credit_notes")
        .select(
          "id, credit_note_number, issue_date, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, invoices(invoice_number, issue_date, total_amount, place_of_supply_code, client_gstin_snapshot, client_name_snapshot, invoice_items(sac_code, amount, is_reimbursement))",
        )
        .gte("issue_date", period.from)
        .lte("issue_date", period.to)
        .order("id")
        .range(a, b) as never,
    ),
  ]);
  if (firm.error) throw firm.error;
  if (param.error) throw param.error;
  const stateCode = firm.data?.state_code ?? "29";
  const v = param.data?.value as { amount?: unknown; inclusive?: unknown } | null | undefined;
  const amount = readParameterNumber(v ?? null);
  const threshold = amount !== null ? toPaise(String(amount)) : GSTR1_DEFAULTS.b2clThresholdPaise;
  const inclusive = typeof v?.inclusive === "boolean" ? v.inclusive : GSTR1_DEFAULTS.b2clInclusive;

  const inv: Gstr1Invoice[] = invoices.map((i) => ({
    id: i.id,
    number: i.invoice_number,
    date: i.issue_date,
    kind: i.invoice_kind === "debit_note" ? "debit_note" : "tax_invoice",
    cancelled: Boolean(i.cancelled_at),
    recipientGstin: i.client_gstin_snapshot ? String(i.client_gstin_snapshot) : null,
    recipientName: i.client_name_snapshot ?? i.clients?.display_name ?? "",
    placeOfSupply: i.place_of_supply_code,
    reverseCharge: i.reverse_charge,
    totalPaise: toPaise(i.total_amount),
    lines: [...(i.invoice_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({ sac: l.sac_code, description: l.description, amountPaise: toPaise(l.amount), taxRate: l.tax_rate, isReimbursement: l.is_reimbursement })),
    original: i.original ? { number: i.original.invoice_number ?? "", date: i.original.issue_date, totalPaise: toPaise(i.original.total_amount), placeOfSupply: i.original.place_of_supply_code } : null,
  }));

  const cns: Gstr1CreditNote[] = credits.map((c) => {
    const o = c.invoices;
    const lines = (o?.invoice_items ?? []).filter((l) => !l.is_reimbursement);
    const main = [...lines].sort((a, b) => toPaise(b.amount) - toPaise(a.amount))[0];
    return {
      id: c.id,
      number: c.credit_note_number,
      date: c.issue_date,
      reducesGst: c.reduces_gst,
      recipientGstin: o?.client_gstin_snapshot ? String(o.client_gstin_snapshot) : null,
      recipientName: o?.client_name_snapshot ?? "",
      placeOfSupply: c.place_of_supply_code ?? o?.place_of_supply_code ?? stateCode,
      taxablePaise: toPaise(c.taxable_amount),
      taxRate: c.tax_rate ?? 0,
      cgstPaise: toPaise(c.cgst_amount ?? 0),
      sgstPaise: toPaise(c.sgst_amount ?? 0),
      igstPaise: toPaise(c.igst_amount ?? 0),
      totalPaise: toPaise(c.total_amount),
      sac: main?.sac_code ?? "9982",
      original: { number: o?.invoice_number ?? "", date: o?.issue_date ?? c.issue_date, totalPaise: toPaise(o?.total_amount ?? 0), placeOfSupply: o?.place_of_supply_code ?? stateCode },
    };
  });

  return { firmGstin: firm.data?.gstin ? String(firm.data.gstin) : null, firmStateCode: stateCode, ret: buildGstr1({ invoices: inv, creditNotes: cns }, { firmStateCode: stateCode, b2clThresholdPaise: threshold, b2clInclusive: inclusive }) };
}

/** The offline tool's workbook: rows 1–3 the sheet's summary, row 4 the headings, data from row 5. */
export async function gstr1Workbook(data: Gstr1Data, period: Gstr1Period): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TaxWise Consultants";
  wb.created = new Date();
  wb.title = `GSTR-1 ${period.label}${data.firmGstin ? ` · ${data.firmGstin}` : ""}`;
  for (const s of gstr1Sheets(data.ret)) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 4 }] });
    const width = s.headers.length;
    const titleRow = new Array<string | number>(width).fill("");
    titleRow[0] = s.title;
    const labels = new Array<string | number>(width).fill("");
    const values = new Array<string | number>(width).fill("");
    for (const x of s.summary) {
      labels[x.column] = x.label;
      values[x.column] = x.value;
    }
    ws.addRow(titleRow).font = { bold: true };
    ws.addRow(labels).font = { bold: true };
    ws.addRow(values);
    const h = ws.addRow(s.headers);
    h.font = { bold: true };
    for (const r of s.rows) ws.addRow(r.map((c) => safeCell(c)));
    s.headers.forEach((header, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(44, Math.max(12, header.length + 2));
      if (s.moneyColumns.includes(i)) col.numFmt = "0.00";
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export function gstr1JsonFile(data: Gstr1Data, period: Gstr1Period): Buffer {
  return Buffer.from(JSON.stringify(gstr1Json(data.ret, { gstin: data.firmGstin ?? "", fp: period.fp }), null, 2), "utf8");
}
