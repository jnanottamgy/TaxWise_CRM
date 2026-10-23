"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { handoffMoneyKind } from "@/lib/handoff";
import { PortalReplySchema, ThreadClientSchema } from "@/lib/schemas/inbox";
import { addTimelineEvent } from "@/server/timeline";
import { notify } from "@/server/notify";
import { getFirmProfile } from "@/server/firm";

/**
 * Staff side of a client's message thread (§7.13.1, §7.22):
 *
 *   sendPortalReply  a message to the client in their portal: a messages row (channel portal,
 *                    direction outbound, status sent), the client's portal login is told in-app,
 *                    and the thread counts as read by the sender (they've replied). Staff only;
 *                    an Employee writes only for clients they can see and never from a payment
 *                    reminder or quotation template (RLS on messages refuses it too, 0043).
 *   markThreadRead   opening a thread: the client's unread portal messages are read (the firm's
 *                    read receipt) and the person's "last opened" is stamped (0173).
 */

const MONEY_REFUSAL = "Messages about fees, invoices or quotations are sent by a Manager or a Partner.";

export const sendPortalReply = defineAction(
  { name: "threads.portal_reply", schema: PortalReplySchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: client, error: clientError } = await ctx.supabase
      .from("clients")
      .select("id, display_name, portal_user_id, status, deleted_at")
      .eq("id", input.clientId)
      .maybeSingle();
    throwIfDbError(clientError);
    if (!client || client.deleted_at) return fail("Not one of your clients.", { code: "not_found" });
    if (!client.portal_user_id) {
      return fail(`${client.display_name} isn't on the portal yet. Invite them from the Overview tab, or send this on WhatsApp or Gmail.`, { code: "blocked" });
    }

    let templateType: string | null = null;
    if (input.templateId) {
      const { data: tpl, error: tplError } = await ctx.supabase.from("message_templates").select("type").eq("id", input.templateId).maybeSingle();
      throwIfDbError(tplError);
      if (!tpl) throw new ActionError("That template isn't available any more. Pick another or write the message yourself.", { code: "validation", fieldErrors: { templateId: ["Pick another template."] } });
      templateType = tpl.type;
    }
    const moneyKind = handoffMoneyKind(null, templateType);
    if (ctx.user.role === "employee" && moneyKind) throw new ActionError(MONEY_REFUSAL, { code: "forbidden" });

    const now = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: input.clientId,
        channel: "portal",
        direction: "outbound",
        body: input.body,
        template_id: input.templateId,
        status: "sent",
        sent_by: ctx.user.id,
        sent_at: now,
      })
      .select("id")
      .single();
    if (error?.code === "42501") throw new ActionError(ctx.user.role === "employee" ? MONEY_REFUSAL : "You can't message this client.", { code: "forbidden" });
    throwIfDbError(error);
    const id = (data as { id: string }).id;

    await ctx.audit({
      event: "data_create",
      resourceType: "message",
      resourceId: id,
      action: "threads.portal_reply",
      details: { channel: "portal", client_id: input.clientId, template_id: input.templateId },
    });

    const portalUserId = client.portal_user_id;
    ctx.after("Record the message as sent", async () => {
      const { error: evError } = await ctx.supabase.from("message_events").insert({ message_id: id, status: "sent", details: { channel: "portal" } });
      if (evError) throw evError;
    });
    ctx.after(
      "Tell the client in their portal",
      async () => {
        const firm = await getFirmProfile(ctx.supabase);
        const preview = input.body.replace(/\s+/g, " ").trim();
        await notify({
          to: { userIds: [portalUserId] },
          type: "info",
          title: `New message from ${firm.firmName}`,
          body: preview.length > 160 ? `${preview.slice(0, 159)}…` : preview,
          linkUrl: "/portal/messages",
          entity: { type: "message", id },
          clientId: input.clientId,
        });
      },
      "The message is in the client's portal, but they weren't alerted. Let them know on WhatsApp or by phone.",
    );
    ctx.after("Mark the thread read", async () => {
      const { error: readError } = await ctx.supabase.rpc("mark_thread_read", { p_client_id: input.clientId });
      if (readError) throw readError;
    });
    ctx.after("Add the message to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: moneyKind ? `${moneyKind}_message_sent` : "message_sent",
        title: `Portal message sent to ${client.display_name}`,
        metadata: { channel: "portal", message_id: id },
      }),
    );
    return ok({ id });
  },
);

export const markThreadRead = defineAction(
  { name: "threads.mark_read", schema: ThreadClientSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ marked: number; lastReadAt: string | null }>> => {
    const { data, error } = await ctx.supabase.rpc("mark_thread_read", { p_client_id: input.clientId });
    throwIfDbError(error);
    const r = (data ?? {}) as { marked?: number; last_read_at?: string };
    const marked = typeof r.marked === "number" ? r.marked : 0;
    if (marked > 0) {
      await ctx.audit({ event: "data_update", resourceType: "message_thread", resourceId: input.clientId, action: "threads.mark_read", details: { client_id: input.clientId, marked } });
    }
    return ok({ marked, lastReadAt: r.last_read_at ?? null });
  },
);
