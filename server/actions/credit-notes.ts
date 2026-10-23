"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatINR, toPaise } from "@/lib/domain/money";
import { formatDate } from "@/lib/format";
import type { Json } from "@/lib/database.types";
import { IssueCreditNoteSchema, creditNotePayload } from "@/lib/schemas/credit-notes";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * Credit notes (§7.9.7). Partner only (§4.1); issue_credit_note (0153) enforces the remaining
 * taxable value, the invoice's GST split and the s.34 deadline (§6.4: a tax-reducing note is refused
 * after it; a commercial credit is allowed), and numbers it from the credit-note series. The
 * settlement trigger reduces the outstanding amount.
 */

export type IssuedCreditNote = {
  creditNoteId: string;
  creditNoteNumber: string;
  totalAmount: number;
  outstanding: number;
  status: string;
};

export const issueCreditNote = defineAction(
  { name: "credit_notes.issue", schema: IssueCreditNoteSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<IssuedCreditNote>> => {
    const { data, error } = await ctx.supabase.rpc("issue_credit_note", { p_payload: creditNotePayload(input) as unknown as Json });
    if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
    throwIfDbError(error);
    const r = (data ?? {}) as {
      credit_note_id: string;
      credit_note_number: string;
      total_amount: number;
      reduces_gst: boolean;
      s34_deadline: string | null;
      invoice_id: string;
      invoice_number: string;
      client_id: string;
      status: string;
      outstanding_amount: number;
    };
    const total = formatINR(toPaise(r.total_amount));
    await ctx.audit({
      event: "data_create",
      resourceType: "credit_note",
      resourceId: r.credit_note_id,
      action: "credit_notes.issue",
      details: {
        invoice_id: r.invoice_id,
        credit_note_number: r.credit_note_number,
        reason_code: input.reasonCode,
        reason: input.reason,
        taxable_amount: input.taxableAmount,
        tax_rate: input.reducesGst ? input.taxRate : null,
        reduces_gst: r.reduces_gst,
        s34_deadline: r.s34_deadline,
        annual_return_filed_on: input.annualReturnFiledOn || null,
      },
    });
    const kind = r.reduces_gst ? "Credit note" : "Commercial credit note";
    ctx.after("Add the credit note to the client's timeline", () =>
      addTimelineEvent({
        clientId: r.client_id,
        eventType: "credit_note_issued",
        title: `${kind} ${r.credit_note_number} for ${total} against ${r.invoice_number}: ${input.reason}`,
        metadata: { invoice_id: r.invoice_id, credit_note_id: r.credit_note_id },
      }),
    );
    ctx.after("Record the credit note in the invoice's history", () =>
      logActivity({
        entityType: "invoice",
        entityId: r.invoice_id,
        action: "invoice_credit_note_issued",
        description: `${kind} ${r.credit_note_number}: ${total}${r.reduces_gst && r.s34_deadline ? ` (s.34 deadline ${formatDate(r.s34_deadline)})` : ""}`,
        metadata: { credit_note_id: r.credit_note_id },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "invoice_updated", description: `Issued credit note ${r.credit_note_number} on ${r.invoice_number}`, entityType: "invoice", entityId: r.invoice_id, entityName: r.invoice_number }),
    );
    return ok({ creditNoteId: r.credit_note_id, creditNoteNumber: r.credit_note_number, totalAmount: Number(r.total_amount), outstanding: Number(r.outstanding_amount), status: r.status });
  },
);
