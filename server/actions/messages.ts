"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ok, ActionError, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { CallNoteSchema, HandoffSchema, MESSAGE_CHANNEL_LABEL, handoffMoneyKind } from "@/lib/handoff";
import { formatWhatsAppNumber } from "@/lib/domain/messaging";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Logging contact that happens outside the app (§7.13.1 "Every channel writes to messages … so the
 * Communication tab shows one complete history"):
 *
 *   logHandoff   a WhatsApp hand-off the person just opened (§7.13.2): a messages row with status
 *                handed_off, linked to the record it sent (`related`: an invoice, a receipt, a
 *                computation …). The app never claims it was delivered.
 *   logCallNote  "Log a call" on the Communication tab: a call, a meeting or a note (channel
 *                call_log / internal_note, status logged as sent).
 *
 * Staff only. Employees log for the clients they can see and never about fees, invoices or
 * quotations (RLS on messages refuses it too, 0043). Each writes an audit row and a timeline entry.
 */

const MONEY_REFUSAL = "Hand-offs about fees, invoices or quotations are logged by a Manager or a Partner.";

async function checkContact(supabase: ServerSupabase, clientId: string, contactId: string | null): Promise<{ name: string; phone: string | null; email: string | null } | null> {
  if (!contactId) return null;
  const { data, error } = await supabase.from("client_contacts").select("name, phone, email, client_id").eq("id", contactId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.client_id !== clientId) {
    throw new ActionError("That contact isn't one of this client's contacts.", { code: "validation", fieldErrors: { contactId: ["Choose one of this client's contacts."] } });
  }
  return { name: data.name, phone: data.phone, email: data.email };
}

/** The template's type (payment_reminder, quotation, document_reminder …), or null. */
async function templateType(supabase: ServerSupabase, templateId: string | null): Promise<string | null> {
  if (!templateId) return null;
  const { data, error } = await supabase.from("message_templates").select("type").eq("id", templateId).maybeSingle();
  throwIfDbError(error);
  return data?.type ?? null;
}

function recipientLabel(channel: string, recipient: string, contactName: string | null): string {
  const who = channel === "whatsapp_handoff" && /^\d{8,15}$/.test(recipient) ? formatWhatsAppNumber(recipient) : recipient;
  return contactName ? `${contactName} (${who})` : who;
}

export const logHandoff = defineAction(
  { name: "messages.handoff", schema: HandoffSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    // About money when the record is money-side or the template is a payment reminder / quotation
    // (is_money_message, 0043): then its timeline entry is money-side too, so Employees never see it.
    const moneyKind = handoffMoneyKind(input.related?.type, await templateType(ctx.supabase, input.templateId));
    if (ctx.user.role === "employee" && moneyKind) throw new ActionError(MONEY_REFUSAL, { code: "forbidden" });
    const contact = await checkContact(ctx.supabase, input.clientId, input.contactId);

    const now = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: input.clientId,
        contact_id: input.contactId,
        channel: input.channel,
        direction: "outbound",
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        template_id: input.templateId,
        status: "handed_off",
        related_entity_type: input.related?.type ?? null,
        related_entity_id: input.related?.id ?? null,
        sent_by: ctx.user.id,
        sent_at: now,
      })
      .select("id")
      .single();
    // An Employee's hand-off from a payment-reminder or quotation template is refused by RLS (0043).
    if (error?.code === "42501") throw new ActionError(MONEY_REFUSAL, { code: "forbidden" });
    throwIfDbError(error);
    const id = (data as { id: string }).id;

    await ctx.audit({
      event: "data_create",
      resourceType: "message",
      resourceId: id,
      action: "messages.handoff",
      details: { channel: input.channel, client_id: input.clientId, related: input.related, template_id: input.templateId },
    });

    const channelName = MESSAGE_CHANNEL_LABEL[input.channel];
    const to = recipientLabel(input.channel, input.recipient, contact?.name ?? null);
    ctx.after("Record the hand-off event", async () => {
      const { error: evError } = await ctx.supabase.from("message_events").insert({ message_id: id, status: "handed_off", details: { channel: input.channel } });
      if (evError) throw evError;
    });
    ctx.after("Add the hand-off to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: moneyKind ? `${moneyKind}_message_sent` : "message_sent",
        title: input.subject ? `${channelName} handed off to ${to}: ${input.subject}` : `${channelName} handed off to ${to}`,
        metadata: { channel: input.channel, message_id: id },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({
        activityType: "whatsapp_sent",
        description: `${channelName} handed off to ${to}`,
        entityType: "client",
        entityId: input.clientId,
      }),
    );
    return ok({ id });
  },
);

export const logCallNote = defineAction(
  { name: "messages.log_call", schema: CallNoteSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const moneyKind = handoffMoneyKind(input.related?.type, null);
    if (ctx.user.role === "employee" && moneyKind) throw new ActionError("Notes about fees, invoices or quotations are logged by a Manager or a Partner.", { code: "forbidden" });
    const contact = await checkContact(ctx.supabase, input.clientId, input.contactId);

    const isNote = input.kind === "note";
    const who = contact?.name ?? null;
    const subject =
      input.subject ??
      (isNote ? null : input.kind === "meeting" ? `Meeting${who ? ` with ${who}` : ""}` : input.kind === "call_in" ? `Call from ${who ?? "the client"}` : `Call to ${who ?? "the client"}`);

    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: input.clientId,
        contact_id: input.contactId,
        channel: isNote ? "internal_note" : "call_log",
        direction: input.kind === "call_in" ? "inbound" : "outbound",
        recipient: isNote ? null : (contact?.phone ?? contact?.email ?? who),
        subject,
        body: input.body,
        status: "sent",
        related_entity_type: input.related?.type ?? null,
        related_entity_id: input.related?.id ?? null,
        sent_by: ctx.user.id,
        sent_at: input.occurredAt ?? new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error?.code === "42501") throw new ActionError("You can't log notes for this client.", { code: "forbidden" });
    throwIfDbError(error);
    const id = (data as { id: string }).id;

    await ctx.audit({
      event: "data_create",
      resourceType: "message",
      resourceId: id,
      action: "messages.log_call",
      details: { kind: input.kind, client_id: input.clientId, contact_id: input.contactId, related: input.related },
    });

    ctx.after("Add the call to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: moneyKind ? `${moneyKind}_note_added` : "note_added",
        title: isNote
          ? subject
            ? `Note: ${subject}`
            : "Note added"
          : input.subject
            ? `${input.kind === "meeting" ? "Meeting" : "Call"}: ${input.subject}`
            : `${subject} logged`,
        metadata: { kind: input.kind, message_id: id },
      }),
    );
    return ok({ id });
  },
);
