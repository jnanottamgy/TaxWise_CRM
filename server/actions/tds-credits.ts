"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatDate } from "@/lib/format";
import { formatINR, paiseToDecimalString, toPaise, type Paise } from "@/lib/domain/money";
import { matchTdsStatement, parseTdsStatement, TDS_CREDIT_STATUS_INFO, tdsQuarterOf, type TdsLineMatch, type TdsParseResult } from "@/lib/domain/collections";
import { DeductorTanSchema, TDS_SOURCE_LABEL, TdsEntryStatusSchema, TdsImportSchema, TdsStatusSchema } from "@/lib/schemas/collections";
import { clientsByTan, loadMatchableReceipts } from "@/lib/data/tds-credits";
import { addTimelineEvent } from "@/server/timeline";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * TDS credits (§6.5, §7.9.9). Partners and Managers only (§4.1); the database functions (0164) and
 * RLS are the real control.
 *
 *   setTdsCreditStatus    mark credits Expected → Reflected (26AS / AIS, Form 168) → Claimed by hand,
 *                         or undo a step; all or nothing, with the concurrency check (§13)
 *   previewTdsImport      read a 26AS text / AIS or Form 168 CSV and show how it would match, without
 *                         saving anything
 *   importTdsStatement    the same, saved: matched receipts become Reflected; amount mismatches and
 *                         lines not in our books are listed for follow-up with the client
 *   setDeductorTan        the TAN a client deducted under, for a receipt that has none
 *   setTdsEntryStatus     set a statement line aside (with why) or bring it back
 *
 * The matching runs here on the server from the file itself and the receipts as they are now
 * (lib/domain/collections.ts); the database checks every match again before applying it.
 */

const MONEY_ROLES = ["partner", "manager"] as const;

export const setTdsCreditStatus = defineAction(
  { name: "tds_credits.set_status", schema: TdsStatusSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ updated: number }>> => {
    const { data, error } = await ctx.supabase.rpc("set_tds_credit_status", {
      p_items: input.items.map((i) => ({ id: i.id, updated_at: i.updatedAt })),
      p_status: input.status,
      p_on: input.on,
      p_note: input.note,
      p_claimed_in: input.claimedIn,
    });
    if (error?.message?.includes("changed since you loaded")) throw new ActionError(error.message.replace(/^USER: /, ""), { code: "conflict" });
    throwIfDbError(error);
    const r = (data ?? {}) as { updated: number; receipts: Array<{ receipt_id: string; client_id: string; receipt_number: string; from: string }> };
    await ctx.audit({
      event: "data_update",
      resourceType: "payment_receipt",
      action: "tds_credits.set_status",
      details: { receipt_ids: input.items.map((i) => i.id), status: input.status, on: input.on, claimed_in: input.claimedIn, updated: r.updated },
    });
    const label = TDS_CREDIT_STATUS_INFO[input.status].label;
    const byClient = new Map<string, string[]>();
    for (const x of r.receipts ?? []) byClient.set(x.client_id, [...(byClient.get(x.client_id) ?? []), x.receipt_number]);
    for (const [clientId, numbers] of byClient) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId,
          eventType: "tds_credit_updated",
          title: numbers.length === 1 ? `TDS credit on receipt ${numbers[0]} marked ${label}` : `TDS credits on ${numbers.length} receipts marked ${label}`,
          metadata: { receipt_numbers: numbers, status: input.status },
        }),
      );
    }
    return ok({ updated: r.updated ?? 0 });
  },
);

export type TdsPreviewLine = {
  lineNo: number;
  tan: string;
  deductorName: string | null;
  clientName: string | null;
  section: string | null;
  transactionDate: string | null;
  bookingStatus: string | null;
  tdsPaise: Paise;
  status: TdsLineMatch["status"];
  receiptCount: number;
  note: string | null;
};

export type TdsPreview = {
  format: TdsParseResult["format"];
  detectedFy: string | null;
  lines: TdsPreviewLine[];
  counts: { lines: number; matched: number; mismatches: number; unmatched: number; problems: number };
  problems: Array<{ lineNo: number; message: string }>;
};

async function readAndMatch(supabase: ServerSupabase, text: string, fy: string) {
  const parsed = parseTdsStatement(text);
  if (!parsed.lines.length) {
    throw new ActionError(
      parsed.format === "unknown"
        ? "This doesn't look like a 26AS or AIS export: no TAN and TDS columns were found. Download the 26AS as text from TRACES, or the AIS TDS details as CSV."
        : "The file has no TDS lines we could read. Check that it is the statement for the right year.",
      { code: "validation", fieldErrors: { text: ["No TDS lines found in this file."] } },
    );
  }
  if (parsed.lines.length > 5000) throw new ActionError("The file has more than 5,000 TDS lines. Import one financial year at a time.", { code: "validation" });
  const receipts = await loadMatchableReceipts(supabase, fy);
  const matches = matchTdsStatement(parsed.lines, receipts);
  return { parsed, matches };
}

export const previewTdsImport = defineAction(
  { name: "tds_credits.preview_import", schema: TdsImportSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<TdsPreview>> => {
    const { parsed, matches } = await readAndMatch(ctx.supabase, input.text, input.financialYear);
    const clients = await clientsByTan(ctx.supabase, parsed.lines.map((l) => l.tan));
    const lines: TdsPreviewLine[] = parsed.lines.map((l, i) => ({
      lineNo: l.lineNo,
      tan: l.tan,
      deductorName: l.deductorName,
      clientName: clients.get(l.tan)?.name ?? null,
      section: l.section,
      transactionDate: l.transactionDate,
      bookingStatus: l.bookingStatus,
      tdsPaise: l.tdsPaise,
      status: matches[i].status,
      receiptCount: matches[i].receiptIds.length,
      note: matches[i].note,
    }));
    return ok({
      format: parsed.format,
      detectedFy: parsed.financialYear,
      lines: lines.slice(0, 500),
      counts: {
        lines: lines.length,
        matched: matches.filter((m) => m.status === "matched").length,
        mismatches: matches.filter((m) => m.status === "amount_mismatch").length,
        unmatched: matches.filter((m) => m.status === "unmatched").length,
        problems: parsed.problems.length,
      },
      problems: parsed.problems.slice(0, 50),
    });
  },
);

export const importTdsStatement = defineAction(
  { name: "tds_credits.import", schema: TdsImportSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ importId: string; rows: number; matched: number; mismatches: number; unmatched: number; duplicates: number; reflected: number }>> => {
    const { parsed, matches } = await readAndMatch(ctx.supabase, input.text, input.financialYear);
    if (parsed.financialYear && parsed.financialYear !== input.financialYear) {
      throw new ActionError(`This file is for FY ${parsed.financialYear}, not FY ${input.financialYear}. Choose FY ${parsed.financialYear} and import it again.`, {
        code: "validation",
        fieldErrors: { financialYear: [`The file is for FY ${parsed.financialYear}.`] },
      });
    }
    const entries = parsed.lines.map((l, i) => ({
      tan: l.tan,
      name: l.deductorName,
      section: l.section,
      transaction_date: l.transactionDate,
      amount_paid: l.amountPaidPaise === null ? null : paiseToDecimalString(l.amountPaidPaise),
      tds_amount: paiseToDecimalString(l.tdsPaise),
      booking_status: l.bookingStatus,
      booking_date: l.bookingDate,
      quarter: l.transactionDate ? tdsQuarterOf(l.transactionDate) : null,
      match: { status: matches[i].status, receipt_ids: matches[i].receiptIds, note: matches[i].note },
    }));
    const { data, error } = await ctx.supabase.rpc("import_tds_statement", {
      p_payload: { financial_year: input.financialYear, source: input.source, file_name: input.fileName || null, entries },
    });
    throwIfDbError(error);
    const r = data as { import_id: string; rows: number; matched: number; amount_mismatches: number; unmatched: number; duplicates: number; receipts_reflected: number };

    await ctx.audit({
      event: "data_create",
      resourceType: "tds_statement_import",
      resourceId: r.import_id,
      details: { financial_year: input.financialYear, source: input.source, file_name: input.fileName, rows: r.rows, matched: r.matched, mismatches: r.amount_mismatches, unmatched: r.unmatched, duplicates: r.duplicates },
    });

    const reflectedIds = matches.flatMap((m) => (m.status === "matched" ? m.receiptIds : []));
    if (reflectedIds.length) {
      ctx.after("Add the reflected credits to the clients' timelines", async () => {
        const { data: rows, error: rErr } = await ctx.supabase.from("tds_credit_register").select("id, client_id, tds_amount, tds_status").in("id", reflectedIds);
        if (rErr) throw rErr;
        const byClient = new Map<string, Paise>();
        for (const x of rows ?? []) if (x.client_id && x.tds_status === "reflected") byClient.set(x.client_id, (byClient.get(x.client_id) ?? 0) + toPaise(x.tds_amount ?? 0));
        for (const [clientId, paise] of byClient) {
          await addTimelineEvent({
            clientId,
            eventType: "tds_credit_reflected",
            title: `TDS of ${formatINR(paise)} reflected in ${TDS_SOURCE_LABEL[input.source]} (imported ${formatDate(new Date())})`,
            metadata: { import_id: r.import_id },
          });
        }
      });
    }
    return ok({ importId: r.import_id, rows: r.rows, matched: r.matched, mismatches: r.amount_mismatches, unmatched: r.unmatched, duplicates: r.duplicates, reflected: r.receipts_reflected });
  },
);

export const setDeductorTan = defineAction(
  { name: "tds_credits.set_tan", schema: DeductorTanSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ tan: string; updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("set_receipt_deductor_tan", { p_receipt_id: input.receiptId, p_tan: input.tan, p_updated_at: input.updatedAt });
    if (error?.message?.includes("changed since you loaded")) throw new ActionError(error.message.replace(/^USER: /, ""), { code: "conflict" });
    throwIfDbError(error);
    const r = data as { deductor_tan: string; updated_at: string };
    await ctx.audit({ event: "data_update", resourceType: "payment_receipt", resourceId: input.receiptId, action: "tds_credits.set_tan", details: { deductor_tan: r.deductor_tan } });
    return ok({ tan: r.deductor_tan, updatedAt: r.updated_at });
  },
);

export const setTdsEntryStatus = defineAction(
  { name: "tds_credits.entry_status", schema: TdsEntryStatusSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ status: string }>> => {
    const { data, error } = await ctx.supabase.rpc("set_tds_entry_status", { p_entry_id: input.entryId, p_status: input.status, p_note: input.note });
    throwIfDbError(error);
    await ctx.audit({ event: "data_update", resourceType: "tds_statement_entry", resourceId: input.entryId, details: { status: input.status, note: input.note } });
    return ok({ status: (data as { match_status: string }).match_status });
  },
);
