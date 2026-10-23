"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatDate } from "@/lib/format";
import { formatWhatsAppNumber } from "@/lib/domain/messaging";
import { reminderSlotLabel } from "@/lib/domain/collections";
import { MESSAGE_CHANNEL_LABEL } from "@/lib/handoff";
import {
  DismissReminderSchema,
  FOLLOW_UP_CHANNEL_LABEL,
  FollowUpSchema,
  ReminderHandoffSchema,
  followUpTimestamp,
} from "@/lib/schemas/collections";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * Collections (§7.9.5). Partners and Managers only (§4.1); RLS refuses anyone else (0034).
 *
 *   logFollowUp              one entry in an invoice's follow-up log: channel, notes, the payment
 *                            date promised (it feeds the collection forecast) and the next follow-up
 *   completeReminderHandoff  a payment reminder the job couldn't email, sent by hand: logs the
 *                            WhatsApp / Gmail hand-off in the client's messages ("Handed off", never
 *                            "delivered", §7.13.1) and closes the reminder
 *   dismissReminder          a waiting reminder that isn't needed (paid by hand, spoke to them), with why
 *
 * Each writes an audit row; the invoice history, the client's timeline (money side: "payment_…",
 * which Employees never see) and the person's activity run after the save and never fail it.
 */

const MONEY_ROLES = ["partner", "manager"] as const;

type InvoiceFacts = { id: string; invoice_number: string | null; status: string; cancelled_at: string | null; client_id: string };

async function invoiceFacts(ctx: ActionContext, id: string): Promise<InvoiceFacts> {
  const { data, error } = await ctx.supabase.from("invoices").select("id, invoice_number, status, cancelled_at, client_id").eq("id", id).is("deleted_at", null).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That invoice no longer exists. It may have been deleted.", { code: "not_found" });
  return data as InvoiceFacts;
}

export const logFollowUp = defineAction(
  { name: "collections.follow_up", schema: FollowUpSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const inv = await invoiceFacts(ctx, input.invoiceId);
    if (!inv.invoice_number || inv.status === "draft" || inv.status === "awaiting_approval") {
      throw new ActionError("Follow-ups are for issued invoices. Issue this one first.", { code: "blocked" });
    }
    if (inv.cancelled_at) throw new ActionError("This invoice was cancelled and reissued. Follow up on the new invoice.", { code: "blocked" });

    const { data, error } = await ctx.supabase
      .from("invoice_follow_ups")
      .insert({
        invoice_id: input.invoiceId,
        channel: input.channel,
        notes: input.notes,
        promised_payment_date: input.promisedPaymentDate,
        next_follow_up_at: input.nextFollowUpOn ? followUpTimestamp(input.nextFollowUpOn) : null,
        by_user: ctx.user.id,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;

    await ctx.audit({
      event: "data_create",
      resourceType: "invoice_follow_up",
      resourceId: id,
      details: { invoice_id: input.invoiceId, channel: input.channel, promised_payment_date: input.promisedPaymentDate, next_follow_up_on: input.nextFollowUpOn },
    });

    const how = FOLLOW_UP_CHANNEL_LABEL[input.channel];
    const promise = input.promisedPaymentDate ? `; payment promised for ${formatDate(input.promisedPaymentDate)}` : "";
    const next = input.nextFollowUpOn ? `; next follow-up ${formatDate(input.nextFollowUpOn)}` : "";
    ctx.after("Add the follow-up to the invoice's history", () =>
      logActivity({ entityType: "invoice", entityId: input.invoiceId, action: "invoice_follow_up", description: `Follow-up (${how.toLowerCase()})${promise}${next}` }),
    );
    ctx.after("Add the follow-up to the client's timeline", () =>
      addTimelineEvent({
        clientId: inv.client_id,
        eventType: "payment_follow_up",
        title: `Payment follow-up on invoice ${inv.invoice_number} (${how.toLowerCase()})${promise}`,
        description: input.notes,
        metadata: { invoice_id: input.invoiceId, follow_up_id: id },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "invoice_updated", description: `Logged a payment follow-up on invoice ${inv.invoice_number}`, entityType: "invoice", entityId: input.invoiceId, entityName: inv.invoice_number }),
    );
    return ok({ id });
  },
);

type ReminderFacts = { id: string; invoice_id: string; reminder_key: string | null; status: string };

async function waitingReminder(ctx: ActionContext, id: string): Promise<ReminderFacts> {
  const { data, error } = await ctx.supabase.from("invoice_reminders").select("id, invoice_id, reminder_key, status").eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That reminder no longer exists.", { code: "not_found" });
  if (data.status !== "handoff_pending") {
    throw new ActionError(data.status === "handed_off" ? "This reminder has already been sent." : "This reminder isn't waiting any more. Reload to see it.", { code: "conflict" });
  }
  return data as ReminderFacts;
}

export const completeReminderHandoff = defineAction(
  { name: "collections.reminder_handoff", schema: ReminderHandoffSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ messageId: string }>> => {
    const reminder = await waitingReminder(ctx, input.reminderId);
    const inv = await invoiceFacts(ctx, reminder.invoice_id);
    let contactName: string | null = null;
    if (input.contactId) {
      const { data: c, error: cErr } = await ctx.supabase.from("client_contacts").select("name, client_id").eq("id", input.contactId).maybeSingle();
      throwIfDbError(cErr);
      if (!c || c.client_id !== inv.client_id) throw new ActionError("That contact isn't one of this client's contacts.", { code: "validation", fieldErrors: { contactId: ["Choose one of this client's contacts."] } });
      contactName = c.name;
    }

    const now = new Date().toISOString();
    const { data: msg, error: mErr } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: inv.client_id,
        contact_id: input.contactId,
        channel: input.channel,
        direction: "outbound",
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        template_id: input.templateId,
        status: "handed_off",
        related_entity_type: "invoice",
        related_entity_id: inv.id,
        sent_by: ctx.user.id,
        sent_at: now,
      })
      .select("id")
      .single();
    throwIfDbError(mErr);
    const messageId = (msg as { id: string }).id;

    const { data: closed, error: uErr } = await ctx.supabase
      .from("invoice_reminders")
      .update({ status: "handed_off", channel: input.channel, handed_off_at: now, handed_off_by: ctx.user.id, message_id: messageId, recipient: input.recipient.slice(0, 320) })
      .eq("id", reminder.id)
      .eq("status", "handoff_pending")
      .select("id");
    throwIfDbError(uErr);
    if (!closed?.length) throw new ActionError("Someone else sent this reminder a moment ago. Reload to see it.", { code: "conflict" });

    await ctx.audit({
      event: "data_update",
      resourceType: "invoice_reminder",
      resourceId: reminder.id,
      details: { invoice_id: inv.id, reminder_key: reminder.reminder_key, channel: input.channel, message_id: messageId },
    });

    const channelName = MESSAGE_CHANNEL_LABEL[input.channel];
    const who = input.channel === "whatsapp_handoff" && /^\d{8,15}$/.test(input.recipient) ? formatWhatsAppNumber(input.recipient) : input.recipient;
    const to = contactName ? `${contactName} (${who})` : who;
    const slot = reminderSlotLabel(reminder.reminder_key).toLowerCase();
    ctx.after("Record the hand-off event", async () => {
      const { error } = await ctx.supabase.from("message_events").insert({ message_id: messageId, status: "handed_off", details: { channel: input.channel } });
      if (error) throw error;
    });
    ctx.after("Add the reminder to the invoice's history", () =>
      logActivity({ entityType: "invoice", entityId: inv.id, action: "invoice_reminder_handed_off", description: `Payment reminder (${slot}) handed off by ${channelName} to ${to}` }),
    );
    ctx.after("Add the reminder to the client's timeline", () =>
      addTimelineEvent({
        clientId: inv.client_id,
        eventType: "payment_message_sent",
        title: `Payment reminder for invoice ${inv.invoice_number} handed off by ${channelName} to ${to}`,
        metadata: { invoice_id: inv.id, message_id: messageId, channel: input.channel },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({
        activityType: input.channel === "whatsapp_handoff" ? "whatsapp_sent" : "email_sent",
        description: `Payment reminder for invoice ${inv.invoice_number} handed off by ${channelName}`,
        entityType: "invoice",
        entityId: inv.id,
        entityName: inv.invoice_number,
      }),
    );
    return ok({ messageId });
  },
);

export const dismissReminder = defineAction(
  { name: "collections.dismiss_reminder", schema: DismissReminderSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const reminder = await waitingReminder(ctx, input.reminderId);
    const { data, error } = await ctx.supabase
      .from("invoice_reminders")
      .update({ status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_by: ctx.user.id, dismiss_reason: input.reason })
      .eq("id", reminder.id)
      .eq("status", "handoff_pending")
      .select("id");
    throwIfDbError(error);
    if (!data?.length) throw new ActionError("Someone else dealt with this reminder a moment ago. Reload to see it.", { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "invoice_reminder", resourceId: reminder.id, details: { invoice_id: reminder.invoice_id, reminder_key: reminder.reminder_key, dismissed: true, reason: input.reason } });
    ctx.after("Add to the invoice's history", () =>
      logActivity({ entityType: "invoice", entityId: reminder.invoice_id, action: "invoice_reminder_dismissed", description: `Payment reminder (${reminderSlotLabel(reminder.reminder_key).toLowerCase()}) not sent: ${input.reason}` }),
    );
    return ok({ id: reminder.id });
  },
);
