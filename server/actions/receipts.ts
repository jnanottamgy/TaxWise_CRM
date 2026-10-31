"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatINR, toPaise } from "@/lib/domain/money";
import { PAYMENT_METHOD_LABELS, isEnumValue } from "@/lib/domain/enums";
import type { Json } from "@/lib/database.types";
import { RecordReceiptSchema, RejectPaymentClaimSchema, ReverseReceiptSchema, receiptPayload, storedTdsSection } from "@/lib/schemas/receipts";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * Receipts (§7.9.4, §6.5). Partners and Managers (§4.1); record_receipt / reverse_receipt (0152) do
 * the work in one transaction, and the settlement trigger derives Partially paid / Paid (§7.9.3).
 *
 *   recordReceipt   a receipt with TDS, numbered from the receipt series. Owner and Partners are told
 *                   (§9 "Payment received"). The receipt PDF goes to the client on WhatsApp from the
 *                   invoice page (its hand-off is logged with logHandoff, related to the receipt).
 *   reverseReceipt  with a reason; receipts are never deleted.
 *   rejectPaymentClaim  a portal "I've paid" the firm can't find in its bank: closed as not received;
 *                   the reason is kept in the invoice's history and the audit log, never on the
 *                   claim the client can read (a claim the bank confirms is closed by recordReceipt
 *                   with its claimId instead).
 */

const MONEY_ROLES = ["partner", "manager"] as const;

function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

export type RecordedReceipt = {
  receiptId: string;
  receiptNumber: string;
  status: string;
  outstanding: number;
  invoiceUpdatedAt: string;
};

export const recordReceipt = defineAction(
  { name: "receipts.record", schema: RecordReceiptSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<RecordedReceipt>> => {
    const payload = receiptPayload(input);
    if (toPaise(String(payload.tds_amount)) > 0) payload.tds_section = storedTdsSection(input.tdsSection);
    const { data, error } = await ctx.supabase.rpc("record_receipt", { p_payload: payload as unknown as Json });
    throwDb(error);
    const r = (data ?? {}) as {
      receipt_id: string;
      receipt_number: string;
      invoice_id: string;
      invoice_number: string;
      client_id: string;
      status: string;
      outstanding_amount: number;
      updated_at: string;
    };
    const received = formatINR(toPaise(String(payload.amount_received)));
    const tdsPaise = toPaise(String(payload.tds_amount));
    const what = tdsPaise > 0 ? `${received} + TDS ${formatINR(tdsPaise)}` : received;

    await ctx.audit({
      event: "data_create",
      resourceType: "payment_receipt",
      resourceId: r.receipt_id,
      action: "receipts.record",
      details: { invoice_id: r.invoice_id, receipt_number: r.receipt_number, amount_received: payload.amount_received, tds_amount: payload.tds_amount, tds_section: payload.tds_section, method: input.method, claim_id: input.claimId },
    });

    ctx.after("Add the payment to the client's timeline", () =>
      addTimelineEvent({
        clientId: r.client_id,
        eventType: "payment_received",
        title: `Payment received: ${what} against ${r.invoice_number} (receipt ${r.receipt_number})`,
        metadata: { invoice_id: r.invoice_id, receipt_id: r.receipt_id },
      }),
    );
    ctx.after("Record the payment in the invoice's history", () =>
      logActivity({
        entityType: "invoice",
        entityId: r.invoice_id,
        action: "invoice_payment_recorded",
        description: `Receipt ${r.receipt_number}: ${what} by ${isEnumValue("payment_method", input.method) ? PAYMENT_METHOD_LABELS[input.method] : input.method}`,
        metadata: { receipt_id: r.receipt_id },
      }),
    );
    ctx.after(
      "Tell the client's owner and the Partners",
      async () => {
        const { data: c } = await ctx.supabase.from("clients").select("display_name, owner_employee_id").eq("id", r.client_id).maybeSingle();
        await notify({
          to: { roles: ["partner"], employeeIds: c?.owner_employee_id ? [c.owner_employee_id] : [] },
          type: "payment_received",
          title: "Payment received",
          body: `${c?.display_name ?? "A client"} paid ${what} against invoice ${r.invoice_number}.`,
          linkUrl: `/invoices/${r.invoice_id}`,
          entity: { type: "invoice", id: r.invoice_id },
          clientId: r.client_id,
          dedupeKey: `payment_received:${r.receipt_id}`,
        });
      },
      "The owner and Partners weren't notified of the payment.",
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "payment_recorded", description: `Recorded receipt ${r.receipt_number} on ${r.invoice_number}`, entityType: "invoice", entityId: r.invoice_id, entityName: r.invoice_number }),
    );
    return ok({ receiptId: r.receipt_id, receiptNumber: r.receipt_number, status: r.status, outstanding: Number(r.outstanding_amount), invoiceUpdatedAt: r.updated_at });
  },
);

export const reverseReceipt = defineAction(
  { name: "receipts.reverse", schema: ReverseReceiptSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ status: string; outstanding: number }>> => {
    const { data, error } = await ctx.supabase.rpc("reverse_receipt", { p_receipt_id: input.receiptId, p_reason: input.reason });
    throwDb(error);
    const r = (data ?? {}) as { receipt_number: string; invoice_id: string; invoice_number: string; client_id: string; status: string; outstanding_amount: number; amount_received: number; tds_amount: number; tds_status: string };
    await ctx.audit({
      event: "data_update",
      resourceType: "payment_receipt",
      resourceId: input.receiptId,
      action: "receipts.reverse",
      details: { reason: input.reason, invoice_id: r.invoice_id, amount_received: r.amount_received, tds_amount: r.tds_amount },
    });
    ctx.after("Add the reversal to the client's timeline", () =>
      addTimelineEvent({
        clientId: r.client_id,
        eventType: "payment_reversed",
        title: `Receipt ${r.receipt_number} reversed on ${r.invoice_number}: ${input.reason}`,
        metadata: { invoice_id: r.invoice_id, receipt_id: input.receiptId },
      }),
    );
    ctx.after("Record the reversal in the invoice's history", () =>
      logActivity({ entityType: "invoice", entityId: r.invoice_id, action: "invoice_receipt_reversed", description: `Receipt ${r.receipt_number} reversed: ${input.reason}`, metadata: { receipt_id: input.receiptId } }),
    );
    const warnings = r.tds_status === "claimed" ? [`The TDS on receipt ${r.receipt_number} was marked claimed. Check the TDS credit register.`] : undefined;
    return ok({ status: r.status, outstanding: Number(r.outstanding_amount) }, warnings);
  },
);

export const rejectPaymentClaim = defineAction(
  { name: "receipts.reject_claim", schema: RejectPaymentClaimSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ invoiceId: string }>> => {
    const { data, error } = await ctx.supabase
      .from("portal_payment_claims")
      // The reason goes to the invoice's history and the audit row, not review_note: a portal user
      // can read their own claim rows, and the firm's notes stay internal.
      .update({ status: "rejected", verified_by: ctx.user.id, verified_at: new Date().toISOString() })
      .eq("id", input.claimId)
      .eq("status", "pending")
      .eq("updated_at", input.updatedAt)
      .select("id, invoice_id, client_id, reference, paid_on")
      .maybeSingle();
    throwIfDbError(error);
    if (!data) {
      throw new ActionError("Someone already dealt with this payment report, or it changed since you loaded the page. Reload to see it.", { code: "conflict" });
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "portal_payment_claim",
      resourceId: data.id,
      action: "receipts.reject_claim",
      details: { invoice_id: data.invoice_id, reference: data.reference, paid_on: data.paid_on, reason: input.reason },
    });
    ctx.after("Record it in the invoice's history", () =>
      logActivity({
        entityType: "invoice",
        entityId: data.invoice_id,
        action: "invoice_claim_rejected",
        description: `Client's payment report${data.reference ? ` (ref ${data.reference})` : ""} not found in the bank: ${input.reason}`,
        metadata: { claim_id: data.id },
      }),
    );
    return ok({ invoiceId: data.invoice_id });
  },
);
