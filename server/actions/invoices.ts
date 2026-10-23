"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { formatINR, toPaise } from "@/lib/domain/money";
import { formatDate } from "@/lib/format";
import { firstNameOf } from "@/lib/domain/messaging";
import { MESSAGE_CHANNEL_LABEL, type EmailSendOutcome } from "@/lib/handoff";
import {
  CancelReissueSchema,
  ExportInvoicesSchema,
  INVOICE_EXPORT_MAX_ROWS,
  INVOICE_LIST_FILTERS,
  INVOICE_LIST_SORTABLE,
  invoiceExportTable,
  listFinancialYear,
  toCsv,
  ClientContextSchema,
  ClientSearchSchema,
  DebitNoteSchema,
  DisputeSchema,
  EInvoiceSchema,
  InvoiceHandoffSchema,
  InvoiceRefSchema,
  IssueInvoiceSchema,
  ReturnInvoiceSchema,
  SEND_CHANNEL_LABEL,
  SaveInvoiceSchema,
  SendInvoiceEmailSchema,
  WaiveSchema,
  draftPayload,
  type SendChannel,
} from "@/lib/schemas/invoices";
import { getBillingSettings, getClientBillingFacts, getInvoiceDocument, listInvoices, searchBillableClients, type ClientBillingFacts, type InvoiceListRow } from "@/lib/data/invoices";
import { parseTableParams, readParam } from "@/components/app/data-table/params";
import { getSelectedFy } from "@/lib/fy-context";
import { todayIST } from "@/lib/domain/fy";
import type { ComboOption } from "@/components/app/form/combobox";
import type { Json } from "@/lib/database.types";
import { getFirmProfile } from "@/server/firm";
import { sendEmail } from "@/server/email/send";
import { emailFirm } from "@/server/email/templates/layout";
import { invoiceEmail } from "@/server/email/templates/invoice";
import { buildInvoicePdf } from "@/server/pdf/invoice";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * Invoices (§7.9.2, §7.9.3). Partners and Managers only (§4.1); RLS and the database functions
 * (0151–0153) are the real control, and the approval gate lives in the database (invoices_role_guard).
 *
 *   saveInvoice           the editor's save: autosave (server draft, §3.4), Save, or Submit for
 *                         approval (a Manager's invoice over the limit; Partners are notified, §9)
 *   deleteInvoiceDraft    soft delete of a draft
 *   approveInvoice        Partner: a held invoice can be sent; the raiser is told (§9)
 *   returnInvoice         Partner: back to the raiser with a note (§9)
 *   issueInvoice          Draft → Sent with its number, then the first send: email with the PDF and
 *                         the portal "View & pay" link, a WhatsApp / Gmail hand-off, or by hand
 *   sendInvoiceEmail      email it again; recordInvoiceHandoff logs a WhatsApp / Gmail hand-off
 *   cancelAndReissue      before GSTR-1 reporting; a new draft copy opens
 *   createDebitNote       a draft debit note / supplementary invoice against an issued invoice
 *   markDisputed / resolveDispute / waiveInvoice (Partner) / saveEInvoiceDetails
 *
 * Each writes an audit row; the client timeline, the invoice history, notifications and the
 * person's activity run after the save (ctx.after) and never fail it (§0.1 rule 5). Money events go
 * on the money side of the timeline (invoice_*, payment_*), which Employees never see (§4.1).
 */

const MONEY_ROLES = ["partner", "manager"] as const;

/** DB errors, with the concurrency refusal ("Changed by … at …") as a conflict (§13). */
function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

function appBase(): string {
  return env.appUrl().replace(/\/+$/, "");
}

/** The portal page the client views and pays the invoice from (§7.9.3 "portal 'View & pay' link"). */
function portalInvoiceUrl(id: string): string {
  return `${appBase()}/portal/invoices/${id}`;
}

type InvoiceHead = {
  id: string;
  invoice_number: string | null;
  invoice_kind: string;
  client_id: string;
  status: string;
  created_by: string;
  total_amount: number;
  outstanding_amount: number;
  issue_date: string;
  due_date: string;
  billing_period_label: string | null;
  updated_at: string;
  clients: { display_name: string; owner_employee_id: string | null } | null;
};

async function invoiceHead(ctx: ActionContext, id: string): Promise<InvoiceHead> {
  const { data, error } = await ctx.supabase
    .from("invoices")
    .select("id, invoice_number, invoice_kind, client_id, status, created_by, total_amount, outstanding_amount, issue_date, due_date, billing_period_label, updated_at, clients!inner(display_name, owner_employee_id)")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That invoice no longer exists. It may have been deleted.", { code: "not_found" });
  return data as unknown as InvoiceHead;
}

function history(id: string, action: string, description: string, metadata?: Record<string, unknown>) {
  return () => logActivity({ entityType: "invoice", entityId: id, action, description, metadata: metadata ?? null });
}

// =================================================================================================
// Lookups for the editor
// =================================================================================================

export const searchInvoiceClients = defineAction(
  { name: "invoices.search_clients", schema: ClientSearchSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchBillableClients(ctx.supabase, input.q)),
);

export const getInvoiceClientContext = defineAction(
  { name: "invoices.client_context", schema: ClientContextSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<ClientBillingFacts>> => {
    const facts = await getClientBillingFacts(ctx.supabase, input.clientId, { invoiceId: input.invoiceId });
    if (!facts) return fail("That client doesn't exist, or is in the recycle bin.", { code: "not_found" });
    return ok(facts);
  },
);

// =================================================================================================
// Save (§7.9.2)
// =================================================================================================

export type SavedInvoice = {
  id: string;
  status: string;
  updatedAt: string;
  requiresApproval: boolean;
  submitted: boolean;
  totalAmount: number;
};

export const saveInvoice = defineAction(
  { name: "invoices.save", schema: SaveInvoiceSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<SavedInvoice>> => {
    const creating = !input.id;
    const { data, error } = await ctx.supabase.rpc("save_invoice_draft", { p_payload: draftPayload(input) as unknown as Json });
    throwDb(error);
    const r = (data ?? {}) as { id: string; status: string; updated_at: string; requires_approval: boolean; submitted: boolean; total_amount: number; client_id: string };

    await ctx.audit({
      event: creating ? "data_create" : "data_update",
      resourceType: "invoice",
      resourceId: r.id,
      action: input.intent === "autosave" ? "invoices.autosave" : input.intent === "submit" ? "invoices.submit_for_approval" : "invoices.save",
      details: { client_id: r.client_id, status: r.status, total_amount: r.total_amount, lines: input.lines.length },
    });

    if (input.intent !== "autosave") {
      ctx.after("Record the change in the invoice's history", history(r.id, r.submitted ? "invoice_submitted" : creating ? "invoice_created" : "invoice_updated", r.submitted ? "Sent to the Partners for approval" : creating ? "Draft created" : "Draft saved", { total_amount: r.total_amount }));
      if (creating) {
        ctx.after("Add to your activity", () =>
          logEmployeeActivity({ activityType: "invoice_created", description: "Started a draft invoice", entityType: "invoice", entityId: r.id }),
        );
      }
    }
    if (r.submitted) {
      ctx.after(
        "Tell the Partners the invoice needs approval",
        async () => {
          const head = await invoiceHead(ctx, r.id);
          await notify({
            to: { roles: ["partner"] },
            type: "invoice_awaiting_approval",
            title: "Invoice awaiting your approval",
            body: `${ctx.user.fullName} raised an invoice for ${head.clients?.display_name ?? "a client"} of ${formatINR(toPaise(head.total_amount))}, over the approval limit.`,
            linkUrl: `/invoices/${r.id}`,
            entity: { type: "invoice", id: r.id },
            clientId: head.client_id,
            dedupeKey: `invoice_awaiting_approval:${r.id}:${r.updated_at}`,
          });
        },
        "The Partners weren't notified. Tell a Partner the invoice is waiting for approval.",
      );
    }
    return ok({
      id: r.id,
      status: r.status,
      updatedAt: r.updated_at,
      requiresApproval: Boolean(r.requires_approval),
      submitted: Boolean(r.submitted),
      totalAmount: Number(r.total_amount),
    });
  },
);

export const deleteInvoiceDraft = defineAction(
  { name: "invoices.delete_draft", schema: InvoiceRefSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ clientId: string }>> => {
    const { data, error } = await ctx.supabase.rpc("delete_invoice_draft", { p_invoice_id: input.invoiceId, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { client_id: string };
    await ctx.audit({ event: "data_delete", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.delete_draft", details: { client_id: r.client_id } });
    ctx.after("Record the deletion in the invoice's history", history(input.invoiceId, "invoice_deleted", "Draft moved to the recycle bin"));
    return ok({ clientId: r.client_id });
  },
);

// =================================================================================================
// Approval (§7.9.2, §9)
// =================================================================================================

export const approveInvoice = defineAction(
  { name: "invoices.approve", schema: InvoiceRefSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("approve_invoice", { p_invoice_id: input.invoiceId, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; created_by: string; client_id: string; total_amount: number };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.approve", details: { total_amount: r.total_amount } });
    ctx.after("Record the approval in the invoice's history", history(input.invoiceId, "invoice_approved", `Approved by ${ctx.user.fullName}`));
    ctx.after(
      "Tell the person who raised it",
      () =>
        notify({
          to: { userIds: [r.created_by] },
          type: "info",
          title: "Invoice approved",
          body: `${ctx.user.fullName} approved your invoice of ${formatINR(toPaise(r.total_amount))}. You can issue and send it now.`,
          linkUrl: `/invoices/${input.invoiceId}`,
          entity: { type: "invoice", id: input.invoiceId },
          clientId: r.client_id,
          dedupeKey: `invoice_approved:${input.invoiceId}:${r.updated_at}`,
        }),
      "The person who raised it wasn't notified. Tell them it's approved.",
    );
    return ok({ updatedAt: r.updated_at });
  },
);

export const returnInvoice = defineAction(
  { name: "invoices.return", schema: ReturnInvoiceSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("return_invoice", { p_invoice_id: input.invoiceId, p_note: input.note, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; created_by: string; client_id: string };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.return", details: { note: input.note } });
    ctx.after("Record the return in the invoice's history", history(input.invoiceId, "invoice_returned", `Returned by ${ctx.user.fullName}: ${input.note}`));
    ctx.after(
      "Tell the person who raised it",
      () =>
        notify({
          to: { userIds: [r.created_by] },
          type: "info",
          title: "Invoice returned to you",
          body: `${ctx.user.fullName} returned your invoice: ${input.note}`,
          linkUrl: `/invoices/${input.invoiceId}`,
          entity: { type: "invoice", id: input.invoiceId },
          clientId: r.client_id,
          dedupeKey: `invoice_returned:${input.invoiceId}:${r.updated_at}`,
        }),
      "The person who raised it wasn't notified. Tell them it was returned, and why.",
    );
    return ok({ updatedAt: r.updated_at });
  },
);

// =================================================================================================
// Issue and send (§7.9.3, §10.8)
// =================================================================================================

export type IssueResult = {
  invoiceNumber: string;
  updatedAt: string;
  channel: SendChannel;
  email: EmailSendOutcome | null;
};

/** Emails the invoice with its PDF and the portal link (§10.8). Never throws: the outcome says what happened. */
async function emailInvoice(
  ctx: ActionContext,
  p: { invoiceId: string; to: string[]; cc: string; contactId: string | null; note: string; key: string },
): Promise<EmailSendOutcome> {
  try {
    const [doc, firmProfile, settings] = await Promise.all([getInvoiceDocument(ctx.supabase, p.invoiceId, "staff"), getFirmProfile(ctx.supabase), getBillingSettings(ctx.supabase)]);
    if (!doc || !doc.invoice_number) return { status: "failed", error: "The invoice isn't issued yet." };
    let recipientName = doc.recipient.name;
    if (p.contactId) {
      const { data: contact } = await ctx.supabase.from("client_contacts").select("name, client_id").eq("id", p.contactId).maybeSingle();
      if (contact && contact.client_id === doc.client_id) recipientName = contact.name;
    }
    const firm = emailFirm(firmProfile);
    const mail = invoiceEmail(
      {
        recipientName: firstNameOf(recipientName) || recipientName,
        clientName: doc.recipient.name,
        invoiceNumber: doc.invoice_number,
        invoiceDate: doc.issue_date,
        dueDate: doc.due_date,
        periodLabel: doc.billing_period_label,
        totalPaise: toPaise(doc.totals.total_amount),
        outstandingPaise: toPaise(doc.totals.outstanding_amount),
        viewPayUrl: portalInvoiceUrl(doc.id),
        note: p.note || null,
        senderName: ctx.user.fullName,
        bank: firmProfile.bank,
        upi: firmProfile.upi ? { id: firmProfile.upi.id, payeeName: firmProfile.upi.payeeName } : null,
      },
      firm,
    );
    const pdf = await buildInvoicePdf({ firm: firmProfile, doc, firmStateCode: settings.firmStateCode, eInvoicing: settings.eInvoicingApplies });
    const recipients = p.cc ? [...p.to, p.cc] : p.to;
    const r = await sendEmail({
      to: [...new Set(recipients)],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "invoice",
      clientId: doc.client_id,
      contactId: p.contactId,
      related: { type: "invoice", id: doc.id },
      attachments: [{ filename: pdf.fileName, content: pdf.bytes, contentType: "application/pdf" }],
      idempotencyKey: p.key,
    });
    if (r.status === "sent") {
      const { error } = await ctx.supabase.rpc("record_invoice_send", { p_invoice_id: doc.id, p_channel: "email" });
      if (error) log("error", "invoice email not recorded on the invoice", { source: "action:invoices.email", userId: ctx.user.id, invoiceId: doc.id, err: error });
    }
    return { status: r.status, error: r.error };
  } catch (err) {
    log("error", "invoice email failed", { source: "action:invoices.email", userId: ctx.user.id, invoiceId: p.invoiceId, err });
    return { status: "failed", error: "The invoice email couldn't be prepared. Send it from your own mailbox or WhatsApp instead." };
  }
}

export const issueInvoice = defineAction(
  { name: "invoices.issue", schema: IssueInvoiceSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<IssueResult>> => {
    const { data, error } = await ctx.supabase.rpc("issue_invoice", {
      p_invoice_id: input.invoiceId,
      p_updated_at: input.updatedAt,
      p_channel: input.channel === "in_person" ? "in_person" : null,
    });
    throwDb(error);
    const r = (data ?? {}) as { invoice_number: string; updated_at: string; client_id: string; total_amount: number; time_entries_billed: number };

    await ctx.audit({
      event: "data_update",
      resourceType: "invoice",
      resourceId: input.invoiceId,
      action: "invoices.issue",
      details: { invoice_number: r.invoice_number, channel: input.channel, total_amount: r.total_amount, time_entries_billed: r.time_entries_billed },
    });

    let email: EmailSendOutcome | null = null;
    if (input.channel === "email" && input.email) {
      email = await emailInvoice(ctx, {
        invoiceId: input.invoiceId,
        to: input.email.to,
        cc: input.email.cc,
        contactId: input.email.contactId,
        note: input.email.note,
        key: `invoice:${input.invoiceId}:issue`,
      });
    }

    const via =
      input.channel === "email" ? (email?.status === "sent" ? "by email" : "(email not sent)") : input.channel === "in_person" ? "by hand" : `for a ${SEND_CHANNEL_LABEL[input.channel]} hand-off`;
    ctx.after("Add the invoice to the client's timeline", () =>
      addTimelineEvent({
        clientId: r.client_id,
        eventType: "invoice_sent",
        title: `Invoice ${r.invoice_number} issued ${via}: ${formatINR(toPaise(r.total_amount))}`,
        metadata: { invoice_id: input.invoiceId, channel: input.channel },
      }),
    );
    ctx.after("Record the issue in the invoice's history", history(input.invoiceId, "invoice_issued", `Issued as ${r.invoice_number} ${via}`, { channel: input.channel }));
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "invoice_updated", description: `Issued invoice ${r.invoice_number}`, entityType: "invoice", entityId: input.invoiceId, entityName: r.invoice_number }),
    );
    return ok({ invoiceNumber: r.invoice_number, updatedAt: r.updated_at, channel: input.channel, email });
  },
);

export const sendInvoiceEmail = defineAction(
  { name: "invoices.send_email", schema: SendInvoiceEmailSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ email: EmailSendOutcome }>> => {
    const head = await invoiceHead(ctx, input.invoiceId);
    if (!head.invoice_number || head.status === "draft" || head.status === "awaiting_approval") {
      throw new ActionError("Issue the invoice before sending it.", { code: "blocked" });
    }
    const email = await emailInvoice(ctx, { invoiceId: input.invoiceId, to: input.to, cc: input.cc, contactId: input.contactId, note: input.note, key: `invoice:${input.invoiceId}:send:${input.nonce}` });
    await ctx.audit({
      event: "data_update",
      resourceType: "invoice",
      resourceId: input.invoiceId,
      action: "invoices.send_email",
      details: { invoice_number: head.invoice_number, to: input.to, outcome: email.status },
      success: email.status === "sent",
      error: email.status === "sent" ? undefined : email.error,
    });
    if (email.status === "sent") {
      ctx.after("Record the email in the invoice's history", history(input.invoiceId, "invoice_emailed", `Emailed to ${input.to.join(", ")}`));
    }
    return ok({ email });
  },
);

export const recordInvoiceHandoff = defineAction(
  { name: "invoices.handoff", schema: InvoiceHandoffSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ messageId: string }>> => {
    const head = await invoiceHead(ctx, input.invoiceId);
    if (!head.invoice_number) throw new ActionError("Issue the invoice before sending it.", { code: "blocked" });
    if (input.contactId) {
      const { data: c, error: cErr } = await ctx.supabase.from("client_contacts").select("client_id").eq("id", input.contactId).maybeSingle();
      throwIfDbError(cErr);
      if (!c || c.client_id !== head.client_id) throw new ActionError("That contact isn't one of this client's contacts.", { code: "validation" });
    }
    const now = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: head.client_id,
        contact_id: input.contactId,
        channel: input.channel,
        direction: "outbound",
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        status: "handed_off",
        related_entity_type: "invoice",
        related_entity_id: head.id,
        sent_by: ctx.user.id,
        sent_at: now,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const messageId = (data as { id: string }).id;
    const channel = input.channel === "whatsapp_handoff" ? "whatsapp" : "gmail";
    const { error: sendError } = await ctx.supabase.rpc("record_invoice_send", { p_invoice_id: head.id, p_channel: channel });
    throwDb(sendError);

    await ctx.audit({ event: "data_create", resourceType: "message", resourceId: messageId, action: "invoices.handoff", details: { channel: input.channel, invoice_id: head.id, invoice_number: head.invoice_number } });
    const name = MESSAGE_CHANNEL_LABEL[input.channel];
    ctx.after("Record the hand-off event", async () => {
      const { error: evError } = await ctx.supabase.from("message_events").insert({ message_id: messageId, status: "handed_off", details: { channel: input.channel } });
      if (evError) throw evError;
    });
    ctx.after("Add the hand-off to the client's timeline", () =>
      addTimelineEvent({ clientId: head.client_id, eventType: "invoice_message_sent", title: `Invoice ${head.invoice_number} handed off on ${name}`, metadata: { message_id: messageId, invoice_id: head.id } }),
    );
    ctx.after("Record the hand-off in the invoice's history", history(head.id, "invoice_handed_off", `${name} handed off to ${input.recipient}`));
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: channel === "whatsapp" ? "whatsapp_sent" : "email_sent", description: `${name} handed off for invoice ${head.invoice_number}`, entityType: "invoice", entityId: head.id }),
    );
    return ok({ messageId });
  },
);

// =================================================================================================
// Corrections and states (§7.9.3)
// =================================================================================================

export const cancelAndReissue = defineAction(
  { name: "invoices.cancel_reissue", schema: CancelReissueSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ newId: string; cancelledNumber: string }>> => {
    const { data, error } = await ctx.supabase.rpc("cancel_and_reissue", { p_invoice_id: input.invoiceId, p_reason: input.reason, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { new_id: string; cancelled_number: string; client_id: string; time_entries_released: number };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.cancel_reissue", details: { reason: input.reason, new_invoice_id: r.new_id, time_entries_released: r.time_entries_released } });
    await ctx.audit({ event: "data_create", resourceType: "invoice", resourceId: r.new_id, action: "invoices.reissue_draft", details: { revised_from_id: input.invoiceId } });
    ctx.after("Add the cancellation to the client's timeline", () =>
      addTimelineEvent({ clientId: r.client_id, eventType: "invoice_cancelled", title: `Invoice ${r.cancelled_number} cancelled to be reissued: ${input.reason}`, metadata: { invoice_id: input.invoiceId, new_invoice_id: r.new_id } }),
    );
    ctx.after("Record the cancellation in the invoice's history", history(input.invoiceId, "invoice_cancelled", `Cancelled and reissued: ${input.reason}`, { new_invoice_id: r.new_id }));
    ctx.after("Record the reissue in the new invoice's history", history(r.new_id, "invoice_created", `Draft reissue of ${r.cancelled_number}`, { revised_from_id: input.invoiceId }));
    return ok({ newId: r.new_id, cancelledNumber: r.cancelled_number });
  },
);

export const createDebitNote = defineAction(
  { name: "invoices.debit_note", schema: DebitNoteSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.rpc("create_debit_note", { p_original_id: input.invoiceId, p_reason: input.reason });
    throwDb(error);
    const r = (data ?? {}) as { id: string; original_invoice_number: string };
    await ctx.audit({ event: "data_create", resourceType: "invoice", resourceId: r.id, action: "invoices.debit_note", details: { original_invoice_id: input.invoiceId, reason: input.reason } });
    ctx.after("Record the debit note in the invoice's history", history(input.invoiceId, "invoice_debit_note", `Debit note started: ${input.reason}`, { debit_note_id: r.id }));
    ctx.after("Record the debit note's history", history(r.id, "invoice_created", `Debit note against ${r.original_invoice_number}`));
    return ok({ id: r.id });
  },
);

export const markDisputed = defineAction(
  { name: "invoices.dispute", schema: DisputeSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("mark_invoice_disputed", { p_invoice_id: input.invoiceId, p_reason: input.reason, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; client_id: string; invoice_number: string };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.dispute", details: { reason: input.reason } });
    ctx.after("Add the dispute to the client's timeline", () =>
      addTimelineEvent({ clientId: r.client_id, eventType: "invoice_disputed", title: `Invoice ${r.invoice_number} disputed: ${input.reason}`, metadata: { invoice_id: input.invoiceId } }),
    );
    ctx.after("Record the dispute in the invoice's history", history(input.invoiceId, "invoice_disputed", `Marked disputed: ${input.reason}`));
    return ok({ updatedAt: r.updated_at });
  },
);

export const resolveDispute = defineAction(
  { name: "invoices.resolve_dispute", schema: InvoiceRefSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; status: string }>> => {
    const { data, error } = await ctx.supabase.rpc("resolve_invoice_dispute", { p_invoice_id: input.invoiceId, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; status: string };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.resolve_dispute", details: { status: r.status } });
    ctx.after("Record the resolution in the invoice's history", history(input.invoiceId, "invoice_dispute_resolved", "Dispute resolved; reminders resume"));
    return ok({ updatedAt: r.updated_at, status: r.status });
  },
);

export const waiveInvoice = defineAction(
  { name: "invoices.waive", schema: WaiveSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("waive_invoice", { p_invoice_id: input.invoiceId, p_reason: input.reason, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; client_id: string; invoice_number: string; waived_amount: number };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.waive", details: { reason: input.reason, waived_amount: r.waived_amount } });
    ctx.after("Add the waiver to the client's timeline", () =>
      addTimelineEvent({ clientId: r.client_id, eventType: "invoice_waived", title: `Invoice ${r.invoice_number} waived: ${formatINR(toPaise(r.waived_amount))} written off. ${input.reason}`, metadata: { invoice_id: input.invoiceId } }),
    );
    ctx.after("Record the waiver in the invoice's history", history(input.invoiceId, "invoice_waived", `Waived by ${ctx.user.fullName}: ${input.reason}`, { waived_amount: r.waived_amount }));
    return ok({ updatedAt: r.updated_at });
  },
);

export const saveEInvoiceDetails = defineAction(
  { name: "invoices.e_invoice", schema: EInvoiceSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const ackDate = input.ackDate ? `${input.ackDate}T00:00:00+05:30` : null;
    const { data, error } = await ctx.supabase.rpc("set_invoice_e_invoice", {
      p_invoice_id: input.invoiceId,
      p_irn: input.irn || null,
      p_ack_no: input.ackNo || null,
      p_ack_date: ackDate,
      p_signed_qr: input.signedQr || null,
      p_updated_at: input.updatedAt,
    } as never);
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string };
    await ctx.audit({ event: "data_update", resourceType: "invoice", resourceId: input.invoiceId, action: "invoices.e_invoice", details: { irn: input.irn || null, ack_no: input.ackNo || null } });
    ctx.after("Record the e-invoice details in the invoice's history", history(input.invoiceId, "invoice_e_invoice", input.irn ? `IRN recorded (ack ${input.ackNo || "—"}, ${input.ackDate ? formatDate(input.ackDate) : "no date"})` : "E-invoice details cleared"));
    return ok({ updatedAt: r.updated_at });
  },
);

// =================================================================================================
// Export of the current view (§3.4, §11)
// =================================================================================================

export type InvoiceExportFile = { fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean };

export const exportInvoices = defineAction(
  { name: "invoices.export", schema: ExportInvoicesSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<InvoiceExportFile>> => {
    const sp = new URLSearchParams(input.query);
    const t = parseTableParams(sp, { sortable: INVOICE_LIST_SORTABLE, defaultSort: { sort: "issue_date", dir: "desc" }, filters: INVOICE_LIST_FILTERS });
    const fy = listFinancialYear(readParam(sp, "fy"), t.filters.status, await getSelectedFy());
    const today = todayIST();
    const rows: InvoiceListRow[] = [];
    let total = 0;
    for (let offset = 0; offset < INVOICE_EXPORT_MAX_ROWS; offset += 100) {
      const page = await listInvoices(ctx.supabase, t, { fy, today, offset, limit: 100 });
      total = page.total;
      rows.push(...page.rows);
      if (page.rows.length < 100 || rows.length >= total) break;
    }
    const truncated = total > rows.length;
    const table = invoiceExportTable(rows);
    let base64: string;
    let mimeType: string;
    let fileName: string;
    if (input.format === "xlsx") {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "TaxWise Consultants";
      wb.created = new Date();
      const ws = wb.addWorksheet("Invoices", { views: [{ state: "frozen", ySplit: 1 }] });
      ws.addRow(table.header);
      ws.getRow(1).font = { bold: true };
      for (const r of table.rows) ws.addRow(r.map((v, i) => (table.header[i]?.endsWith("(₹)") && v !== "" ? Number(v) : v)));
      ws.columns.forEach((col, i) => {
        const h = table.header[i] ?? "";
        col.width = Math.min(40, Math.max(10, h.length + 2));
        if (h.endsWith("(₹)")) col.numFmt = "#,##,##0.00";
      });
      const buf = await wb.xlsx.writeBuffer();
      base64 = Buffer.from(buf as ArrayBuffer).toString("base64");
      mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      fileName = `taxwise-invoices-${today}.xlsx`;
    } else {
      base64 = Buffer.from(toCsv(table.header, table.rows), "utf8").toString("base64");
      mimeType = "text/csv;charset=utf-8";
      fileName = `taxwise-invoices-${today}.csv`;
    }
    await ctx.audit({ event: "export_run", resourceType: "invoices", details: { format: input.format, rows: rows.length, truncated, query: input.query, fy } });
    return ok({ fileName, mimeType, base64, rows: rows.length, truncated });
  },
);
